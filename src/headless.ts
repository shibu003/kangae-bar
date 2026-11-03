// agent 専用のブラウザ（E5・W4c）。画面に出ない（--headless=new）自前の profile の Chromium を 1 つ、必要になった時に起こす。
// 人のブラウザ（--open が起こす物・人の Chrome）の profile にも port にも触らない。agent は chrome-devtools-mcp --browserUrl でこれに繋ぐ。
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pollUntil } from "./wait.ts";

const CANDIDATES = (home: string) => [
  join(home, "Chromium.app/Contents/MacOS/Chromium"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export const headlessArgs = (profile: string) =>
  ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--use-mock-keychain", "--password-store=basic", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "about:blank"];

// /json/version が 1 秒で返ればその origin。だめなら null。外のアドレスは見ない
export const probeBrowser = (port: number) => fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).then((r) => (r.ok ? `http://127.0.0.1:${port}` : null), () => null);

// profile/DevToolsActivePort の 1 行目 = Chromium が選んだ port。生きていればそのまま使う（前の常駐が残した物でも）
async function alive(profile: string): Promise<string | null> {
  try {
    const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
    return port > 0 ? await probeBrowser(port) : null;
  } catch { return null; }
}

const chromeBin = (home: string, env: NodeJS.ProcessEnv) => env.KANGAE_HEADLESS_CHROME ?? CANDIDATES(home).find(existsSync);
// 起こさずに「起こせるか」だけ（AGENTS.md に書くか決める時。context 1 回で Chromium を起こさない）
export const headlessAvailable = (home: string, env: NodeJS.ProcessEnv = process.env) => !!chromeBin(home, env);

// 使われなくなった Chrome は止める（8GB の Mac で常駐の間ずっと食い続けない・2026-10-07）。最後に使ってから KANGAE_HEADLESS_IDLE_MS（既定 5 分）。
// turn の間は headlessHold で止めない。次の turn は headlessUrl が起こし直す（DevToolsActivePort が生きていれば、前の常駐が残した Chrome をそのまま使う）。
const memos = new Map<string, Promise<string | null>>(); // profile ごと（home が違えば別の Chrome）
const idles = new Map<string, { ms: number; busy: number; timer?: ReturnType<typeof setTimeout> }>(); // profile ごと
const arm = (profile: string) => {
  const i = idles.get(profile);
  if (!i) return;
  clearTimeout(i.timer);
  if (i.busy === 0) { i.timer = setTimeout(() => stopHeadless(profile), i.ms); i.timer.unref?.(); }
};
export function headlessHold(home: string): () => void {
  const profile = join(home, "agent-browser");
  const i = idles.get(profile) ?? idles.set(profile, { ms: 300_000, busy: 0 }).get(profile)!;
  i.busy++; clearTimeout(i.timer);
  let done = false;
  return () => { if (!done) { done = true; i.busy--; arm(profile); } };
}
// leak1: 試験が起こした Chrome の印 = user-data-dir が preload の一時 home（…/kangae-test-<6 字>/…）の下。人の Chrome・製品の agent-browser の profile には当たらない
export const isTestChromeCmd = (cmd: string): boolean => /--user-data-dir=\S*\/kangae-test-[A-Za-z0-9]{6}\//.test(cmd);

// 試験の process が SIGKILL・timeout で落ちて残した Chrome（親が launchd = ppid 1 で、印の profile）だけを刈る。生きている試験の Chrome は親が居る（ppid ≠ 1）ので対象外。名前での pkill はしない
export function reapTestChromes(ps: string = Bun.spawnSync(["ps", "-axww", "-o", "pid=,ppid=,command="]).stdout.toString()): number[] {
  const pids: number[] = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m && m[2] === "1" && Number(m[1]) !== process.pid && isTestChromeCmd(m[3]!)) {
      try { process.kill(Number(m[1])); pids.push(Number(m[1])); } catch {}
    }
  }
  return pids;
}

// 親（この process）が死んだら profile の Chrome を止める見張り（試験の下だけ）。process.once("exit") は SIGKILL・SIGTERM では走らない。
// 製品の常駐は対象外: 常駐が落ちても Chrome を残し、次の常駐が DevToolsActivePort から使い直す設計（alive）。見張りは Chrome が先に終われば何もせず抜ける。2 秒間隔 → 親の死から数秒で消える
const watchParent = (chromePid: number, profile: string) =>
  Bun.spawn(["sh", "-c", 'while kill -0 "$PARENT" 2>/dev/null && kill -0 "$CHROME" 2>/dev/null; do sleep 2; done; kill -0 "$PARENT" 2>/dev/null || pkill -f -- "--user-data-dir=$PROFILE"'], // profile は env で渡す＝見張り自身の引数に印を含めない
    { env: { ...process.env, PARENT: String(process.pid), CHROME: String(chromePid), PROFILE: profile }, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();

// この profile を user-data-dir に持つ Chrome（本体・子）だけを止める。人の Chrome の profile とは混ざらない
function stopHeadless(profile: string) {
  memos.delete(profile);
  for (const p of Bun.spawnSync(["pgrep", "-f", "--", `--user-data-dir=${profile}`]).stdout.toString().split("\n")) if (Number(p) > 0) try { process.kill(Number(p)); } catch {}
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
}
// 起こせない（Chrome が無い・すぐ落ちた）は null。締切を越えたら人に分かる 1 行の Error を投げる
export function headlessUrl(home: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const profile = join(home, "agent-browser");
  const i = idles.get(profile) ?? idles.set(profile, { ms: 0, busy: 0 }).get(profile)!;
  i.ms = Number(env.KANGAE_HEADLESS_IDLE_MS) || 300_000;
  arm(profile);
  if (!memos.has(profile)) {
    // 起こしている間に idle の timer が鳴って、起きかけの Chrome を殺さない（混雑で起動が idle より長いと永久に起きない）
    i.busy++; clearTimeout(i.timer);
    const done = () => { i.busy--; arm(profile); };
    memos.set(profile, start(home, env).then((u) => { done(); if (!u) memos.delete(profile); return u; }, (e) => { done(); memos.delete(profile); throw e; }));
  }
  return memos.get(profile)!;
}

async function start(home: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const bin = chromeBin(home, env);
  if (!bin) return null;
  const profile = join(home, "agent-browser");
  mkdirSync(profile, { recursive: true });
  const running = await alive(profile);
  if (running) return running;
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
  const underTest = process.env.NODE_ENV === "test" || isTestChromeCmd(`--user-data-dir=${profile}/`);
  if (underTest) reapTestChromes(); // 前の試験の孤児（親が launchd）を、自分を起こす前に刈る
  const p = Bun.spawn([bin, ...headlessArgs(profile)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  process.once("exit", () => { try { p.kill(); } catch {} });
  if (underTest) watchParent(p.pid, profile);
  // 混んだ機械（8GB・load 数百）では Chrome の起動が 10 秒を越える。回数でなく実の時間（Date.now）の締切で待つ
  const wait = Number(env.KANGAE_HEADLESS_WAIT_MS) || 45_000;
  const u = await pollUntil(async () => (await alive(profile)) ?? (p.exitCode !== null ? "dead" : null), wait, 200);
  if (u === "dead") return null;
  if (u) return u;
  p.kill();
  throw new Error(`agent 用の browser が起きませんでした（${Math.round(wait / 1000)} 秒待った・混んでいる時はもう一度）`);
}
