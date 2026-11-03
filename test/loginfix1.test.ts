// loginfix-1（EXP-1 再走 A）: bar 経由の常駐が「claude の login が切れています」と誤判定 → 使えない gemini に替え → 9 分「考え中…」のまま人に返った
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureUserEnv, geminiPersonal, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

const src = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");

test("loginfix-1 USER / LOGNAME が無い env に足す・在れば触らない（claude は Keychain を $USER で探す）", () => {
  const e: NodeJS.ProcessEnv = { HOME: "/Users/x", PATH: "/bin" };
  ensureUserEnv(e, "alice");
  expect(e).toMatchObject({ USER: "alice", LOGNAME: "alice" });
  const f: NodeJS.ProcessEnv = { USER: "bob", LOGNAME: "carol" };
  ensureUserEnv(f, "alice");
  expect(f).toEqual({ USER: "bob", LOGNAME: "carol" });
  expect(src.slice(src.indexOf("export async function startDaemon"), src.indexOf("export async function startDaemon") + 1500)).toContain("ensureUserEnv();"); // 常駐の入口で呼ぶ
});

test("loginfix-1 実物: USER の無い env の claude は loggedIn:false・足すと true（偽の claude が $USER を見る）", () => {
  const dir = mktmp("lf");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\n[ -n "$USER" ] && echo '{"loggedIn":true}' || echo '{"loggedIn":false}'\n`, { mode: 0o755 });
  const run = (env: Record<string, string>) => JSON.parse(Bun.spawnSync([bin, "auth", "status", "--json"], { env }).stdout.toString()).loggedIn;
  expect(run({ HOME: dir, PATH: "/usr/bin:/bin" })).toBe(false); // bar 経由の常駐の env
  const fixed: Record<string, string> = { HOME: dir, PATH: "/usr/bin:/bin" };
  ensureUserEnv(fixed as NodeJS.ProcessEnv, "alice");
  expect(run(fixed)).toBe(true);
}, 120_000); // 混んだ機械では process を起こすだけで 5 秒を超える（load 600 で実測 32 秒）

test("loginfix-1 起こして N 秒 1 行も返らなければ「応答がありません・原因・次の一手」を出す（返れば出さない）", async () => {
  const mk = (noReplyMs: number, reply: boolean) => {
    const s = openStore(":memory:");
    const root = s.add(null, "user", "頼み", true);
    const spawn = () => {
      let ctrl!: ReadableStreamDefaultController<Uint8Array>; let done!: (c: number) => void;
      const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; if (reply) c.enqueue(new TextEncoder().encode(JSON.stringify({ type: "system" }) + "\n")); } });
      const exited = new Promise<number>((r) => (done = r));
      return { stdout, exited, kill: () => { try { ctrl.close(); } catch {} done(143); } };
    };
    const h = makeHandler(s, async () => [], undefined, { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => null }, { noReplyMs });
    return { s, root, h };
  };
  const a = mk(30, false);
  await a.h({ op: "workspace", nodeId: a.root.id, agent: true, text: "頼み" });
  await Bun.sleep(120);
  const log = JSON.stringify(((await a.h({ op: "runs", nodeIds: [a.root.id] })) as any).runs.at(-1));
  expect(log).toContain("応答がありません");
  expect(log).toContain("次の一手");
  const b = mk(30, true);
  await b.h({ op: "workspace", nodeId: b.root.id, agent: true, text: "頼み" });
  await Bun.sleep(120);
  expect(JSON.stringify(((await b.h({ op: "runs", nodeIds: [b.root.id] })) as any).runs.at(-1))).not.toContain("応答がありません");
});

test("loginfix-1 gemini の個人向け login（oauth-personal）は終わっている＝替え先にしない（settings の見分け）", () => {
  const d = mktmp("gem");
  expect(geminiPersonal(d)).toBe(false); // settings が無い
  writeFileSync(join(d, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
  expect(geminiPersonal(d)).toBe(true);
  writeFileSync(join(d, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }));
  expect(geminiPersonal(d)).toBe(false); // API key / Workspace は終わっていない
  mkdirSync(join(d, "x"));
  expect(src).toContain('geminiPersonal()) dead.set("gemini", GEMINI_ENDED)');
});
