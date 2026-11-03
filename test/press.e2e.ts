// W67 押す操作の headless e2e（手で回す: tools/e2e-lock.sh bun test/press.e2e.ts）。隔離した home・socket で、本物の常駐 + headless Chromium + 本物の拡張を起こし、
// 偽の claude（dm.e2e.ts と同じ shell の stub）が kangae act で fill → press_button を打つ → 記録 → press list / save / run → 受領証、を本物の socket と CLI で通す。
// ④ まで = 今の本線で緑。⑤〜⑦ は W62（case "press"・runner）が入るまで赤でよい（名前に「W62」と付けてある）。本物の claude・本物の site は使わない（頁は自分の http server）。
import { mktmp } from "./tmp.ts";
import { humanAsk } from "./human-ask.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evalIn, findSw, swSession } from "./cdp-sw.ts";
import { rememberOurs } from "./front-judge.ts";
import { CHROMIUM_APP, launch } from "../src/launch.ts";
import { spawnDaemon } from "./spawn-daemon";
import { armExe } from "./exe";

const root = join(import.meta.dir, "..");
const D = mktmp("kangae-press");
const sock = join(D, "s.sock");
const bin = join(D, "kangae");
const home = join(D, "home");
const profile = join(D, "profile");
const cdpPort = 9300 + Math.floor(Math.random() * 500);
const env = { KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_BAR: join(D, "bar.json"), KANGAE_NODES_DIR: join(D, "nodes"), KANGAE_CDP_PORT: "1" };
const human = humanAsk(env.KANGAE_BAR); // sec1: 承認の表などは人が押す op＝unix socket（agent の口）では断られる。人の口（/ws）から送る
const fails: string[] = [];
const t0 = Date.now();
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const check = (name: string, ok: boolean, detail = "") => { say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) fails.push(name); };
const until = async (f: () => Promise<boolean> | boolean, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await Bun.sleep(400); } return false; };

// ---- 試験の頁: 欄「メモ」と button「保存」・押すと一覧に足される（値を読む口 = #saved）
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`<!doctype html><title>メモ帳</title><h1>メモ帳</h1><label>メモ <input id="q"></label><button id="send">保存</button><ul id="saved"></ul>
<script>document.getElementById("send").onclick=()=>{const q=document.getElementById("q");const li=document.createElement("li");li.textContent=q.value;document.getElementById("saved").append(li);q.value=""}</script>`, { headers: { "content-type": "text/html; charset=utf-8" } }) });
const pageUrl = `http://127.0.0.1:${server.port}/memo`;
const SECRET = "ひみつの値-PRESS67";

// ---- 偽の claude: 「TESTACT」の頼みなら kangae act で fill → press_button を 1 回ずつ打つ（KANGAE_LEASE は常駐が env に渡す）
const fakebin = join(D, "bin"); mkdirSync(fakebin, { recursive: true });
writeFileSync(join(fakebin, "claude"), `#!/bin/sh
case "$1" in auth) exit 0;; esac
export KANGAE_HOME="${home}" KANGAE_SOCK="${sock}"
case "$*" in
  *TESTACT*) "${bin}" act fill '{"field":"メモ","value":"${SECRET}"}' >/dev/null 2>&1; "${bin}" act press_button '{"name":"保存"}' >/dev/null 2>&1; printf '%s\\n' '{"type":"result","result":"メモを保存しました。"}' ;;
  *) printf '%s\\n' '{"type":"result","result":"はい。"}' ;;
esac
`);
armExe(join(fakebin, "claude"));
const shell = join(D, "shell.sh");
writeFileSync(shell, `#!/bin/sh\nprintf '%s' "${fakebin}:/usr/bin:/bin"\n`);
armExe(shell);

async function ask(m: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID(); let buf = "";
    Bun.connect({ unix: sock, socket: { data(s, c) { buf += new TextDecoder().decode(c); for (const l of buf.split("\n")) { try { const j = JSON.parse(l); if (j.id === id) { s.end(); resolve(j); } } catch {} } }, error() {} } }).then((s) => s.write(JSON.stringify({ id, ...m }) + "\n"), () => resolve(null));
  });
}
const jget = async (p: string) => (await fetch(`http://127.0.0.1:${cdpPort}${p}`)).json() as Promise<any>;
const kangae = async (...args: string[]) => { const p = Bun.spawn([bin, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { code, out: o + e }; };

// 起こした物の後始末: 自分の隔離 folder を持つ process だけ（pid を引く・共有名で pkill しない）
const cleanup = async () => {
  rememberOurs(D);
  for (const p of Bun.spawnSync(["pgrep", "-f", D]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  for (const p of Bun.spawnSync(["lsof", "-t", sock]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  await Bun.sleep(1500);
  server.stop(true);
  rmSync(D, { recursive: true, force: true });
};
const deadline = setTimeout(() => { say("TIMEOUT"); void cleanup().then(() => process.exit(2)); }, 420_000);

try {
  // ① 常駐を起こす
  const b = Bun.spawnSync(["bun", "build", "--compile", join(root, "src/main.ts"), "--outfile", bin], { cwd: root });
  if (b.exitCode !== 0) throw new Error("build 失敗: " + b.stderr.toString());
  mkdirSync(home, { recursive: true });
  spawnDaemon([bin, "--daemon"], { env: { ...process.env, ...env, SHELL: shell }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
  if (!(await until(async () => !!(await ask({ op: "ping" })), 150_000))) throw new Error("常駐が 150 秒で起きない（load が高いと遅い）");
  check("① 常駐が起きる", true);
  const rootId = (await ask({ op: "add", text: "メモを足して" })).node.id;

  // ② headless Chromium + 拡張 → 試験頁の tab を会話に渡す
  const ext = join(D, "extension"); // launch() が profile の隣に拡張を写す先
  launch({ app: CHROMIUM_APP, profile, hostBinary: bin, extensionDir: join(root, "extension"), mockKeychain: true, debugPort: cdpPort, env: { KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_PROFILE: profile }, extraArgs: ["--no-startup-window", "--headless=new", "--enable-unsafe-extension-debugging"] }); // 窓も前面も出さない（起こしは launch・open は使わない）
  let sw: any = await findSw({ port: cdpPort, extensionDir: ext, nudgeUrl: pageUrl });
  // W80: 掴んだ sw に WS を張り続ける（swSession・idle で止めさせない・sw の console と例外を出す）。それでも落ちたら掴んだ id と今の sw を原文で出し、探し直して 1 回だけやり直す
  const swIds = async () => (await jget("/json/list")).filter((t: any) => t.type === "service_worker").map((t: any) => t.id.slice(0, 8)).join(",") || "無し";
  const swLog = (s: string) => say(`  sw ${s}`);
  let ss = await swSession(sw.webSocketDebuggerUrl, swLog, 60_000);
  const swEval = async (expr: string) => {
    try { return await ss.ev(expr); } catch (e) {
      say(`sw の eval が落ちた（${(e as Error).message}・掴んだ ${sw.webSocketDebuggerUrl.split("/").pop().slice(0, 8)}・今の sw ${await swIds().catch(() => "取れない")}）→ 探し直して 1 回だけやり直す`);
      ss.close();
      sw = await findSw({ port: cdpPort, nudgeUrl: pageUrl });
      ss = await swSession(sw.webSocketDebuggerUrl, swLog, 60_000);
      return ss.ev(expr);
    }
  };
  // 頁は browser の CDP で開く（w3c.e2e.ts:123 と同じ）。sw の chrome.windows.create は load 458 で 60 秒返らなかった（docs/verify/w80/e2e.txt）
  await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURI(pageUrl)}`, { method: "PUT", signal: AbortSignal.timeout(60_000) });
  const tabId = await (async () => { let id: number | undefined; await until(async () => { id = JSON.parse(await swEval(`chrome.tabs.query({}).then(a=>JSON.stringify(a.find(t=>t.url.startsWith(${JSON.stringify(pageUrl)}))?.id))`)); return id != null; }, 30_000); return id; })();
  await human({ op: "leaseMode", app: "*", mode: "allow" }); // 承認の層は別の検査が持つ。ここは記録と press を測る
  const give = await human({ op: "leaseGive", rootId, tabId });
  check("② tab を会話に渡せる", give?.ok === true, JSON.stringify(give).slice(0, 120));
  const page = (await jget("/json/list")).find((t: any) => t.type === "page" && t.url.startsWith(pageUrl));
  const saved = async () => JSON.parse(await evalIn(page.webSocketDebuggerUrl, "JSON.stringify([...document.querySelectorAll('#saved li')].map(l=>l.textContent))")) as string[];

  // ③ 偽の claude が fill → press_button を打つ
  const sent = await ask({ op: "send", rootId, text: "TESTACT メモを足して保存して" });
  check("③ 頼みが通る", sent?.ok !== false, JSON.stringify(sent).slice(0, 100));
  const finished = await until(async () => { const r = await ask({ op: "runs", nodeIds: [rootId] }); const st = r?.runs?.[0]?.status; return !!st && st !== "running"; }, 90_000);
  check("③ 会話の仕事が終わる（実の秒の締切 90 秒）", finished);
  check("③ 頁に値が書かれ保存された（fill → press_button が門を通った）", (await saved()).includes(SECRET), JSON.stringify(await saved()));

  // ④ 記録: ops.jsonl に fill と press_button の 2 行（値は伏せられ、頁の値そのものは無い）
  const opsFile = join(home, "ops.jsonl");
  const recs = existsSync(opsFile) ? readFileSync(opsFile, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const mine = recs.filter((r: any) => r.owner === `s:${rootId}`);
  check("④ ops.jsonl に fill と press_button が 1 行ずつ在る", mine.some((r: any) => r.op === "fill") && mine.some((r: any) => r.op === "press_button"), mine.map((r: any) => r.op).join(","));
  check("④ 記録に入れた値の中身が無い", !readFileSync(opsFile, "utf8").includes(SECRET));

  // ⑤〜⑦ W62 待ち（case "press" と runner が本線に入るまで赤でよい）
  const list0 = await ask({ op: "press", action: "list", rootId });
  check("⑤ W62待ち press list: 保存済みは空・offer が出ている", list0?.ok === true && list0.presses?.length === 0 && !!list0.offer, JSON.stringify(list0).slice(0, 160));
  const sv = await ask({ op: "press", action: "save", rootId });
  check("⑤ W62待ち press save（offer から）", sv?.ok === true && typeof sv.press === "string", JSON.stringify(sv).slice(0, 160));
  const listed = await kangae("press", "list");
  check("⑤ W62待ち kangae press list（CLI の口）が保存した物を出す", listed.code === 0 && !!sv?.press && listed.out.includes(sv.press), listed.out.slice(0, 160));
  const names: string[] = (list0?.offer?.fields ?? []).map((f: any) => f.name);
  const fields = Object.fromEntries(names.map((n) => [n, "二度目の値-PRESS67"]));
  const run = sv?.press ? await ask({ op: "press", action: "run", press: sv.press, fields, rootId, wait: true }) : null;
  check("⑥ W62待ち press run が通る", run?.ok === true, JSON.stringify(run).slice(0, 200));
  const rj = sv?.press ? join(home, "presses", `${sv.press}.runs.jsonl`) : "";
  const lines = rj && existsSync(rj) ? readFileSync(rj, "utf8").split("\n").filter(Boolean) : [];
  check("⑦ W62待ち 受領証 runs.jsonl の 1 行目が ok", lines.length > 0 && JSON.parse(lines[0]!).result === "ok", lines[0] ?? "(file なし)");
  check("⑦ W62待ち 受領証に値が無い", lines.length > 0 && !lines.join("\n").includes("PRESS67"));
} catch (e) {
  fails.push("例外: " + String((e as Error)?.stack ?? e));
  console.log(String((e as Error)?.stack ?? e));
}
clearTimeout(deadline);
await cleanup();
const waits = fails.filter((f) => f.includes("W62待ち")), others = fails.filter((f) => !f.includes("W62待ち"));
say(`\n本線で緑のはずの段（①〜④）の FAIL ${others.length}${others.length ? ": " + others.join(" / ") : ""}・W62 待ちの赤 ${waits.length}`);
process.exit(others.length ? 1 : waits.length ? 3 : 0); // 3 = ④ まで緑・⑤〜⑦ は W62 待ちで赤
