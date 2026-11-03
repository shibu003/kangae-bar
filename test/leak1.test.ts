// leak1: 試験の process が SIGKILL・timeout で落ちても、その試験が起こした headless Chrome を残さない。
// 本物の Chrome は起こさない（fake = bun の script）。既に居る孤児には触らない（reapTestChromes には自分が起こした pid の行だけの ps を渡す）
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTestChromeCmd, reapTestChromes } from "../src/headless.ts";
import { pollUntil } from "../src/wait.ts";
import { armExe } from "./exe";
import { mktmp } from "./tmp.ts";

const root = join(import.meta.dir, "..");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = (pid: number, ms = 50_000) => pollUntil(async () => !alive(pid), ms, 300);
const ppidOf = (pid: number) => Number(Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout.toString().trim());
const psLine = (pid: number) => Bun.spawnSync(["ps", "-axww", "-o", "pid=,ppid=,command="]).stdout.toString().split("\n").filter((l) => new RegExp(`^\\s*${pid}\\s`).test(l)).join("\n");

// 本物の Chromium の代わり: pid を書き、port 0 で /json/version を返して profile/DevToolsActivePort を書く。試験より長く（100 秒）生きる＝自分では消えない
function fakeChrome(dir: string) {
  const fake = join(dir, "fake-chrome");
  writeFileSync(fake, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const profile = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice(16);
writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));
const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ Browser: "fake" }) });
writeFileSync(profile + "/DevToolsActivePort", s.port + "\\n/devtools/browser/x\\n");
setTimeout(() => process.exit(0), 100000);
`);
  armExe(fake);
  return { fake, pid: async () => Number(await pollUntil(async () => (existsSync(join(dir, "pid")) && readFileSync(join(dir, "pid"), "utf8")) || null, 30_000, 100)) };
}

test("印: 試験の一時 home の Chrome だけに当たり、人の Chrome・製品の agent-browser・似た名前には当たらない", () => {
  const T = "/var/folders/xx/T/kt1a2B3c/kangae-test-aB3dE9/kangae_home/agent-browser";
  expect(isTestChromeCmd(`/Applications/Chromium.app/Contents/MacOS/Chromium --headless=new --user-data-dir=${T} about:blank`)).toBe(true);
  expect(isTestChromeCmd(`Chromium Helper (Renderer) --type=renderer --user-data-dir=${T} --headless`)).toBe(true);
  for (const human of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/Google/Chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", // profile の指定が無い普通の起動
    "Chromium --headless=new --user-data-dir=/Users/me/Library/Application Support" + "/Kangae/agent-browser about:blank", // 製品の常駐の Chrome  rules-ok: ps の 1 行の見本の文字列（path を読み書きしない）
    "Chromium --user-data-dir=/Users/me/kangae-test-notes/profile", // 6 字でない
    "Chromium --user-data-dir=/Users/me/Documents/kangae-test-abcdef.bak/x", // 名前が続く
    "vim /var/folders/xx/T/kt1a2B3c/kangae-test-aB3dE9/kangae_home/notes.md", // --user-data-dir が無い
  ]) expect(isTestChromeCmd(human), human).toBe(false);
});

test("刈り取り: 親が launchd で印の profile の Chrome だけを落とす。生きている親が居る試験の Chrome と、人の profile の行は残す", async () => {
  // 生きている試験の Chrome: 印は同じで、親はこの process
  const dir2 = mktmp("leak1-live");
  const profile2 = join(dir2, "kangae-test-zZ9yY8", "kangae_home", "agent-browser");
  mkdirSync(profile2, { recursive: true });
  const f2 = fakeChrome(dir2);
  const live = Bun.spawn([f2.fake, `--user-data-dir=${profile2}`], { stdio: ["ignore", "ignore", "ignore"] });
  const livePid = await f2.pid();
  // 人の Chrome の印（親は launchd のつもりの行）: 実在の sleep の pid を借りて、落とされないことを見る
  const human = Bun.spawn(["sleep", "100"]);
  const humanLine = `${human.pid} 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/Google/Chrome`;
  const dir = mktmp("leak1-reap");
  const home = join(dir, "kangae-test-aB3dE9", "kangae_home"); // 印の形（mkdtemp の 6 字）
  const profile = join(home, "agent-browser");
  mkdirSync(profile, { recursive: true });
  const { fake, pid } = fakeChrome(dir);
  // 孤児: sh が背景で起こして先に抜ける → 親が launchd になる
  Bun.spawn(["sh", "-c", '"$0" "$@" </dev/null >/dev/null 2>&1 &', fake, `--user-data-dir=${profile}`], { stdio: ["ignore", "ignore", "ignore"] });
  const orphan = await pid();
  expect(orphan).toBeGreaterThan(0);
  expect(await pollUntil(async () => (ppidOf(orphan) === 1 ? true : null), 20_000, 100)).toBe(true);
  try {
    const killed = reapTestChromes([psLine(orphan), psLine(livePid), humanLine].join("\n"));
    expect(killed).toEqual([orphan]);
    expect(await gone(orphan, 20_000)).toBe(true);
    expect(alive(livePid)).toBe(true);
    expect(alive(human.pid)).toBe(true);
  } finally { live.kill(9); human.kill(9); if (alive(orphan)) process.kill(orphan, 9); }
}, 90_000);

// 試験の親になる process（headlessUrl を呼んで Chrome を起こし、待つ）。SIGKILL で落とす
async function runParent(home: string, env: Record<string, string>) {
  const dir = mktmp("leak1-par");
  const { fake, pid } = fakeChrome(dir);
  const script = join(dir, "parent.ts");
  writeFileSync(script, `import { headlessUrl } from ${JSON.stringify(join(root, "src/headless.ts"))};
await headlessUrl(${JSON.stringify(home)}, { KANGAE_HEADLESS_CHROME: ${JSON.stringify(fake)}, KANGAE_HEADLESS_WAIT_MS: "60000" });
console.log("up");
setTimeout(() => {}, 300000);
`);
  const parent = Bun.spawn([process.execPath, script], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "ignore" });
  const rd = parent.stdout.getReader();
  let out = "";
  while (!out.includes("up")) { const r = await rd.read(); if (r.done) break; out += new TextDecoder().decode(r.value); }
  expect(out).toContain("up");
  const chrome = await pid();
  expect(alive(chrome)).toBe(true);
  parent.kill(9); // exit handler も走らない死に方
  await parent.exited;
  return chrome;
}

test("親の死: 試験の process を SIGKILL しても、その process が起こした Chrome は 60 秒以内に消える（NODE_ENV=test でも、印の一時 home でも）", async () => {
  const a = mktmp("leak1-a");
  const b = join(mktmp("leak1-b"), "kangae-test-qQ1wW2", "kangae_home");
  const [ca, cb] = [await runParent(join(a, "home"), { NODE_ENV: "test" }), await runParent(b, { NODE_ENV: "" })];
  try {
    expect(await gone(ca)).toBe(true);
    expect(await gone(cb)).toBe(true);
  } finally { for (const c of [ca, cb]) if (alive(c)) process.kill(c, 9); }
}, 120_000);

test("製品の常駐は変えない: 試験でも印の home でもない親が SIGKILL で死んでも、Chrome は残る（次の常駐が DevToolsActivePort から使い直す）", async () => {
  const c = await runParent(join(mktmp("leak1-prod"), "home"), { NODE_ENV: "" });
  try {
    await Bun.sleep(7000); // 見張りの間隔（2 秒）の 3 周分
    expect(alive(c)).toBe(true);
  } finally { if (alive(c)) process.kill(c, 9); }
}, 60_000);
