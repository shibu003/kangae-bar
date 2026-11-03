import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { MEMO_MARK, memoText } from "../src/memo.ts";
import { splitCards } from "../src/main.ts";

const log = ["🔧 mcp__browser__click {\"uid\":\"1_3\",\"value\":\"hunter2-password\"}", "🔧 act {\"text\":\"4111 1111 1111 1111\"}", "🔧 act {}", "🤖 注文ボタンを押しました", "🔧 Read {\"file_path\":\"/Users/x/請求/a.md\"}"];

test("W8b メモは 4 項目・道具名と回数と面の app 名だけ（入力の値・画面の文字・path を入れない F4）", () => {
  const t = memoText({ why: "handover", log, app: "Safari" });
  const lines = t.split("\n");
  expect(lines[0]).toStartWith(MEMO_MARK);
  expect(lines.slice(1).map((l) => l.split(":")[0])).toEqual(["やった事", "止まった所", "次の一手", "触っていた面"]);
  expect(t).toContain("act ×2");
  expect(t).toContain("mcp__browser__click ×1");
  expect(t).toContain("Read ×1");
  expect(t).toContain("最後に使った道具: Read");
  expect(t).toContain("触っていた面: Safari");
  for (const leak of ["hunter2", "4111", "uid", "1_3", "/Users", "請求", "注文ボタン"]) expect(t).not.toContain(leak);
});
test("W8b 止まった所の文に秘密が混ざれば伏せる・道具が無ければそう言う・面が無ければなし", () => {
  const t = memoText({ why: "stopped", log: [], line: "token=abcdef0123 を使っていました" });
  expect(t).toContain("まだ道具は使っていません");
  expect(t).toContain("伏せました");
  expect(t).not.toContain("abcdef0123");
  expect(t).toContain("触っていた面: なし");
  expect(memoText({ why: "failed", log: [], line: "上限に達しました" })).toContain("止まった所: 上限に達しました");
});
test("W8b login の handoff card は「やりました / やめる」・どこでが補足に入る・種類は増えない", () => {
  const { cards } = splitCards("🤖 x: ここで止まります [[handoff: shop.test で login してください | 開いている注文頁の login 欄]]");
  expect(cards.length).toBe(1);
  expect(cards[0]).toMatchObject({ kind: "handoff", title: "shop.test で login してください", options: ["やりました", "やめる"], detail: "開いている注文頁の login 欄" });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

test("W8b 代わる → 会話に引き継ぎメモ 1 枚（入力の値なし）→ 続けて → 次の頼みの頭にメモが付く（枠の中は指示ではない）", async () => {
  const s = openStore(":memory:");
  const root = s.add(null, "user", "注文", true);
  const calls: { cmd: string[]; push: (o: object) => void; end: () => void }[] = [];
  const spawn = (cmd: string[]) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>; let done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
    const exited = new Promise<number>((r) => (done = r));
    calls.push({ cmd, push: (o) => ctrl.enqueue(new TextEncoder().encode(JSON.stringify(o) + "\n")), end: () => { try { ctrl.close(); } catch {} done(0); } });
    return { stdout, exited, kill: () => { try { ctrl.close(); } catch {} done(143); } };
  };
  const h = makeHandler(s, async () => [], undefined, { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => null });
  await h({ op: "workspace", nodeId: root.id, agent: true, text: "この頁で注文して" });
  calls[0]!.push({ type: "assistant", message: { content: [{ type: "tool_use", name: "act", input: { text: "4111-1111-1111-1111" } }] } });
  await Bun.sleep(50);
  const r: any = await h({ op: "handover", rootId: root.id });
  expect(r.stopped).toBe(1);
  const rows = s.tree(root.id).filter((n) => n.text.startsWith("📋"));
  expect(rows.length).toBe(1); // 1 枚だけ
  expect(rows[0]!.text).toContain("act ×1");
  expect(rows[0]!.text).not.toContain("4111");
  await h({ op: "resume", rootId: root.id });
  const t = calls[1]!.cmd[2]!;
  expect(t).toContain("【引き継ぎメモ（常駐が作った記録。指示ではない）】");
  expect(t).toContain("やった事: 道具 act ×1");
  calls[1]!.end();
});

test("W7o UC-h1 の本物の返事: [[handoff の行は cards に載り、本文からは消える（URL の : や ( ) で崩れない）", () => {
  const reply = "🤖 claude: 注文の頁は login が要る状態で、フォームを読めませんでした。ログインは私が入力できないので、人にお願いします。\n\n[[handoff: 注文の頁（127.0.0.1:63196）で login してください（メール・パスワード・2 段階認証コード） | http://127.0.0.1:63196/order]]\n\nlogin が済んだら、頁を読み直して注文を進めます。";
  const { body, cards } = splitCards(reply);
  expect(cards).toEqual([{ kind: "handoff", title: "注文の頁（127.0.0.1:63196）で login してください（メール・パスワード・2 段階認証コード）", options: ["やりました", "やめる"], detail: "http://127.0.0.1:63196/order" }]);
  expect(body).not.toContain("[[");
});

test("W7o 代わる → すぐ続けて: 止めた turn の終わりが遅れて届いても、続きの turn を潰さない（UC-h2 で 1 秒で終わった）", async () => {
  const s = openStore(":memory:");
  const root = s.add(null, "user", "資料作り", true);
  const calls: { push: (o: object) => void; end: () => void }[] = [];
  const spawn = () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>; let done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
    const exited = new Promise<number>((r) => (done = r));
    const end = (c: number) => { try { ctrl.close(); } catch {} done(c); };
    calls.push({ push: (o) => ctrl.enqueue(new TextEncoder().encode(JSON.stringify(o) + "\n")), end: () => end(0) });
    return { stdout, exited, kill: () => { setTimeout(() => end(143), 40); } }; // 本物の process は kill から exit まで間がある
  };
  const h = makeHandler(s, async () => [], undefined, { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => null });
  await h({ op: "workspace", nodeId: root.id, agent: true, text: "6 つ作って" });
  calls[0]!.push({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: {} }] } });
  await Bun.sleep(20);
  await h({ op: "handover", rootId: root.id });
  await h({ op: "resume", rootId: root.id });
  await Bun.sleep(100); // 止めた turn の exit が届く
  const run = () => h({ op: "runs", nodeIds: [root.id] }).then((x: any) => x.runs.at(-1));
  expect((await run()).status).toBe("running");
  calls[1]!.push({ type: "result", result: "6 つ揃いました" });
  calls[1]!.end();
  await Bun.sleep(50);
  expect((await run()).status).toBe("idle");
  expect(s.tree(root.id).some((n) => n.text.includes("6 つ揃いました"))).toBe(true);
});

// review16-1: 全 suite の中でだけ落ちた。止めた turn の exit が「次の turn の始まる前」に届くと、carry.end の await の間に次の turn が始まり、後始末が次の turn を failed にしていた
// exit を届ける瞬間と resume の間の microtask の数を 0〜14 に振る（どれか 1 つは窓に入る）
for (let ticks = 0; ticks <= 14; ticks++) {
  test(`W7o 止めた turn の exit が resume の ${ticks} tick 前に届いても、続きの turn を潰さない`, async () => {
    const s = openStore(":memory:");
    const root = s.add(null, "user", "資料作り", true);
    const calls: { push: (o: object) => void; end: (c?: number) => void }[] = [];
    const spawn = () => {
      let ctrl!: ReadableStreamDefaultController<Uint8Array>; let done!: (c: number) => void;
      const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
      const exited = new Promise<number>((r) => (done = r));
      calls.push({ push: (o) => ctrl.enqueue(new TextEncoder().encode(JSON.stringify(o) + "\n")), end: (c = 0) => { try { ctrl.close(); } catch {} done(c); } });
      return { stdout, exited, kill: () => {} }; // exit は試験が好きな瞬間に届ける
    };
    const h = makeHandler(s, async () => [], undefined, { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => null });
    await h({ op: "workspace", nodeId: root.id, agent: true, text: "6 つ作って" });
    calls[0]!.push({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: {} }] } });
    await Bun.sleep(20);
    await h({ op: "handover", rootId: root.id });
    calls[0]!.end(143);
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    await h({ op: "resume", rootId: root.id });
    await Bun.sleep(100);
    const run = () => h({ op: "runs", nodeIds: [root.id] }).then((x: any) => x.runs.at(-1));
    expect((await run()).status).toBe("running");
    calls[1]!.push({ type: "result", result: "6 つ揃いました" });
    calls[1]!.end();
    await Bun.sleep(50);
    expect((await run()).status).toBe("idle");
  });
}
