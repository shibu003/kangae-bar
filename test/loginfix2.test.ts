// loginfix-2: 混雑（load 338）で「応答がありません」が誤報で出る → 待ちを load で延ばす・出た後に返れば「遅れていました」に置き換える
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_REPLY_MS, makeHandler, noReplyWait } from "../src/main.ts";
import { openStore } from "../src/store.ts";

test("loginfix-2 待ちは load / CPU 数の倍率（空いていれば 60 秒・上限 10 倍）", () => {
  expect(noReplyWait(2, 8)).toBe(NO_REPLY_MS);
  expect(noReplyWait(338, 10)).toBe(NO_REPLY_MS * 10);
  expect(noReplyWait(30, 10)).toBe(NO_REPLY_MS * 3);
});

test("loginfix-2 文を出した後に 1 行返ったら、文は「遅れていました」に置き換わる（返らなければ残る）", async () => {
  const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 400 && !(await f()); i++) await Bun.sleep(25); }; // 混んだ機械でも時刻に頼らず状態を待つ
  const run = async (reply: boolean) => {
    const s = openStore(":memory:");
    const root = s.add(null, "user", "頼み", true);
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const spawn = () => {
      let done!: (c: number) => void;
      const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
      const exited = new Promise<number>((r) => (done = r));
      return { stdout, exited, kill: () => { try { ctrl.close(); } catch {} done(143); } };
    };
    const h = makeHandler(s, async () => [], undefined, { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => null }, { noReplyMs: 30 });
    const log = async () => JSON.stringify(((await h({ op: "runs", nodeIds: [root.id] })) as any).runs.at(-1));
    await h({ op: "workspace", nodeId: root.id, agent: true, text: "頼み" });
    await until(async () => (await log()).includes("応答がありません"));
    const mid = await log(); // 文が出て、まだ返っていない
    if (reply) { ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ type: "system" }) + "\n")); await until(async () => !(await log()).includes("応答がありません")); }
    return { mid, after: await log() };
  };
  const late = await run(true);
  expect(late.mid).toContain("応答がありません");
  expect(late.after).not.toContain("応答がありません");
  expect(late.after).toContain("遅れていました");
  expect((await run(false)).after).toContain("応答がありません"); // 返らないままなら消さない
});
