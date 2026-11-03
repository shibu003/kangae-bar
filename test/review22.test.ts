// review22: loginfix-1 の攻撃審査（ensureUserEnv・無応答の通知・geminiPersonal）
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureUserEnv, geminiPersonal, makeHandler } from "../src/main.ts";
import { startCmd } from "../src/cmds.ts";
import { openStore } from "../src/store.ts";

const PERSONAL = JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } });

test("① ensureUserEnv: 名前を引けない環境（passwd に無い uid）でも常駐を落とさない・在る時は名前を引きもしない・他の鍵に触らない", () => {
  const boom = () => { throw new Error("no passwd entry"); };
  const e: NodeJS.ProcessEnv = { HOME: "/h", TOKEN: "t" };
  expect(() => ensureUserEnv(e, boom)).not.toThrow();
  expect(e).toEqual({ HOME: "/h", TOKEN: "t" }); // 補わず進む
  const full: NodeJS.ProcessEnv = { USER: "u", LOGNAME: "l" };
  let called = 0;
  ensureUserEnv(full, () => { called++; return "x"; });
  expect(called).toBe(0); // 揃っていれば引かない
  const half: NodeJS.ProcessEnv = { USER: "u" };
  ensureUserEnv(half, "alice");
  expect(half).toEqual({ USER: "u", LOGNAME: "alice" });
  ensureUserEnv(e, "");
  expect(e.USER).toBeUndefined(); // 空の名前は補わない
});

test("① 補った USER / LOGNAME は run_cmd の sandbox の子に渡らない（固定の最小 env）・鍵も混ざらない", async () => {
  const was = { USER: process.env.USER, LOGNAME: process.env.LOGNAME, TOK: process.env.R22_TOKEN };
  process.env.USER = "alice-r22"; process.env.LOGNAME = "alice-r22"; process.env.R22_TOKEN = "tok-r22";
  const top = mktmp("r22"), proj = join(top, "p"), out = join(top, "o"); mkdirSync(proj); mkdirSync(out);
  try {
    const r = startCmd({ name: "t", cwd: proj, argv: ["/usr/bin/env"], timeoutSec: 30, at: 0, seal: "" }, join(out, "o.txt"));
    await r.done;
    const text = require("node:fs").readFileSync(join(out, "o.txt"), "utf8");
    for (const k of ["USER=", "LOGNAME=", "R22_TOKEN="]) expect(text, k).not.toContain(k);
    expect(text).not.toContain("alice-r22");
  } finally { for (const [k, v] of Object.entries({ USER: was.USER, LOGNAME: was.LOGNAME, R22_TOKEN: was.TOK })) v === undefined ? delete process.env[k] : (process.env[k] = v); }
}, 120_000);

test("② 無応答の通知の文は、環境変数・作業場所の path・鍵を出さない（cli 名と秒だけ）", async () => {
  const s = openStore(":memory:");
  const root = s.add(null, "user", "頼み", true);
  const spawn = () => { let ctrl!: ReadableStreamDefaultController<Uint8Array>; let done!: (c: number) => void; const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } }); const exited = new Promise<number>((r) => (done = r)); return { stdout, exited, kill: () => { try { ctrl.close(); } catch {} done(143); } }; };
  const ws = mktmp("ws-r22");
  const h = makeHandler(s, async () => [], undefined, { dir: ws, bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: { R22_SECRET: "sekret-r22" } }], spawn, browserUrl: async () => null }, { noReplyMs: 30 } as any);
  await h({ op: "workspace", nodeId: root.id, agent: true, text: "頼み" });
  await Bun.sleep(200);
  const run = ((await h({ op: "runs", nodeIds: [root.id] })) as any).runs.at(-1);
  const log = JSON.stringify(run.log); // 通知の行（run の全体には作業場所 dir などの別の欄がある）
  expect(log).toContain("応答がありません");
  expect(log).not.toContain("sekret-r22");
  expect(log).not.toContain("R22_SECRET");
  expect(log).not.toContain(ws);
  expect(log).not.toContain(process.env.HOME ?? "/nonexistent-home");
});

test("③ geminiPersonal: 読むだけ（file を変えない）・FIFO や大きい file で固まらない・symlink 先の中身は真偽にしか出ない", async () => {
  const d = mktmp("gem22"), f = join(d, "settings.json");
  writeFileSync(f, PERSONAL);
  const before = statSync(f).mtimeMs;
  expect(geminiPersonal(d)).toBe(true);
  expect(statSync(f).mtimeMs).toBe(before);
  // 1MB 超は読まない
  writeFileSync(f, JSON.stringify({ pad: "x".repeat(1_100_000), security: { auth: { selectedType: "oauth-personal" } } }));
  expect(geminiPersonal(d)).toBe(false);
  // FIFO（読むと戻らない）: 子 process で時間を測る＝固まれば 3 秒で切る
  const g = mktmp("gem22f");
  expect(Bun.spawnSync(["/usr/bin/mkfifo", join(g, "settings.json")]).exitCode).toBe(0);
  const p = Bun.spawn(["bun", "-e", `import { geminiPersonal } from ${JSON.stringify(join(import.meta.dir, "../src/main.ts"))}; console.log(geminiPersonal(${JSON.stringify(g)}))`], { env: { ...process.env, KANGAE_HOME: mktmp("r22h") }, stdout: "pipe", stderr: "ignore" });
  const t = setTimeout(() => p.kill(9), 20_000);
  const out = (await new Response(p.stdout).text()).trim();
  clearTimeout(t);
  expect(out.split("\n").at(-1)).toBe("false");
  // symlink で別の場所の settings を指しても、返るのは真偽だけ
  const other = mktmp("gem22o");
  writeFileSync(join(other, "real.json"), PERSONAL);
  const l = mktmp("gem22l");
  symlinkSync(join(other, "real.json"), join(l, "settings.json"));
  expect(typeof geminiPersonal(l)).toBe("boolean");
}, 60_000);

test("④ USER 補いは常駐の起動で 1 回・process 全体の同じ値＝会話ごとの env には入らない（turn の env は会話ごとの copy）", () => {
  const src = require("node:fs").readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  expect(src.split("ensureUserEnv()").length - 1).toBe(1); // 呼ぶのは startDaemon の 1 回だけ（turn ごとには呼ばない）
  const i = src.indexOf("const spawnEnv = {");
  expect(src.slice(i, i + 160)).toContain("{ ...f.env"); // turn ごとの新しい object（共有の env を書き換えない）
  expect(src.slice(i, i + 700)).not.toContain("process.env.USER");
});
