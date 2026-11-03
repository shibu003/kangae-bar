// review23: W31a（kangae launch）+ W32（一括承認）の攻撃審査。破れ = ① 常駐が SIGKILL で死ぬと起こした GUI が永久に残る ② 終わった turn の名残が owner の env で launch を呼べる
// 読む file を literal で名指す: "src/lease.ts" "src/cmds.ts" "src/main.ts"
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCmd, startCmd, sweepOrphans } from "../src/cmds.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (f: () => boolean, ms = 8000) => { for (const end = Date.now() + ms; !f() && Date.now() < end;) await tick(); return f(); };

test("review23-1 常駐が SIGKILL で死んで残った GUI（印つき・親が pid 1）は次の起動で止まる・生きている親の子は止めない", async () => {
  // 印つきの孤児を作る: sh が印つきの sleep を background で起こして先に終わる（sleep の親は launchd になる）
  const mark = `orphan${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  // 印は ps -E の env に出る事が前提（/bin/sleep のような system の実行 file は SIP で env が隠れる＝GUI の実物と同じ「第三者の実行 file」の bun を使う）
  const long = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},300000)"`;
  const o = Bun.spawnSync(["/bin/sh", "-c", `W17C_RUN=${mark} ${long} </dev/null >/dev/null 2>&1 & echo $!`], { stdin: "ignore" });
  const orphan = Number(o.stdout.toString().trim());
  // 生きている親の子（印つき）
  const kid = Bun.spawn(["/bin/sh", "-c", `W17C_RUN=kid${mark} ${long} & wait`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    expect(await waitFor(() => alive(orphan))).toBe(true);
    await tick(300);
    sweepOrphans();
    expect(await waitFor(() => !alive(orphan))).toBe(true); // 孤児は死んだ
    expect(alive(kid.pid)).toBe(true); // 親が居る子は残る（別の常駐の走りを巻き込まない）
  } finally {
    try { process.kill(orphan, "SIGKILL"); } catch {}
    try { process.kill(-kid.pid, "SIGKILL"); } catch {}
    kid.kill(9);
    Bun.spawnSync(["/bin/sh", "-c", `/bin/ps -axww -E -o pid=,command= | grep 'W17C_RUN=kid${mark}' | grep -v grep | awk '{print $1}' | xargs kill -9 2>/dev/null`]);
  }
}, 60_000);

test("review23-2 終わった turn の名残の process が env の owner で kangae launch を呼んでも起こさない（動いている turn だけ）", async () => {
  const s = openStore(":memory:");
  const root = s.add(null, "user", "頼み", true);
  const ui = mktmp("r23-ui");
  const spawn = () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>; let done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; c.enqueue(new TextEncoder().encode(JSON.stringify({ type: "result", result: "終わりました" }) + "\n")); try { c.close(); } catch {} } });
    const exited = new Promise<number>((r) => (done = r)); done(0);
    return { stdout, exited, kill: () => { try { ctrl.close(); } catch {} } };
  };
  const h = makeHandler(s, async () => [], undefined, { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => null }, { uiHome: ui });
  await h({ op: "workspace", nodeId: root.id, agent: true, text: "頼み" });
  await tick(150); // turn が終わる（idle）
  const runs: any = await h({ op: "runs", nodeIds: [root.id] });
  expect(runs.runs.at(-1).status).not.toBe("running");
  const r: any = await h({ op: "launchApp", owner: `s:${root.id}`, name: "gui" });
  expect(r).toMatchObject({ ok: false, code: "bad" }); // 動いていない頼み（修正前は「登録されていません」＝先まで進んでいた）
  rmSync(ui, { recursive: true, force: true });
});

test("review23-3 --app の経路でも sandbox の deny が効く: /private/tmp の読み・他の process への signal・cwd の外への書き（実際の sandbox-exec）", async () => {
  const top = realpathSync(mktmp("r23-sb"));
  const ui = join(top, "ui"), proj = join(top, "proj");
  mkdirSync(ui); mkdirSync(proj);
  const canary = join("/private/tmp", `r23-canary-${process.pid}-${Date.now()}`);
  writeFileSync(canary, "SECRET");
  const outside = join(top, "outside.txt"); // cwd の外
  const script = join(proj, "gui.sh"); // 実行 file は cwd の中（EXP-1 の build/er_triage_gui と同じ形）
  writeFileSync(script, `#!/bin/sh\ncat '${canary}' > got 2>/dev/null; echo "read=$?" > res\nkill -0 ${process.pid} 2>/dev/null; echo "sig=$?" >> res\necho x > '${outside}' 2>/dev/null; echo "write=$?" >> res\necho "cwd=$(echo ok > here; echo $?)" >> res\n`, { mode: 0o755 });
  try {
    const base = Bun.spawnSync(["/bin/sh", "-c", `cd '${proj}' && cat '${canary}' >/dev/null && kill -0 ${process.pid}`]); // sandbox 無しなら読めて signal も送れる＝比較の土台
    expect(base.exitCode).toBe(0);
    const reg = addCmd(ui, "gui", proj, [script], 600, 1, { app: true });
    if (!reg.ok) throw new Error(reg.hint);
    const r = startCmd(reg.cmd, join(top, "out.txt"), { timeoutMs: 20_000 });
    await r.done;
    const res = readFileSync(join(proj, "res"), "utf8");
    expect(res).toMatch(/read=[1-9]/); // /private/tmp は読めない
    expect(res).toMatch(/sig=[1-9]/); // 他の process へ signal を送れない
    expect(res).toMatch(/write=[1-9]/); // cwd の外へ書けない
    expect(res).toContain("cwd=0"); // cwd には書ける
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(proj, "got")) ? readFileSync(join(proj, "got"), "utf8") : "").not.toContain("SECRET");
  } finally { rmSync(canary, { force: true }); rmSync(top, { recursive: true, force: true }); }
}, 60_000);
