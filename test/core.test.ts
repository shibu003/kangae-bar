import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { LlmError, ask, buildPrompt, parseReply, type Mouth } from "../src/llm.ts";
import { CARD_RULE, EXT_ASK, NEXT_RULE, TAB_ASK, flush, makeHandler, needOf, outlineText, sendAll, splitCards, splitNext } from "../src/main.ts";
import { openStore } from "../src/store.ts";
const NOEXT = (CARD_RULE + NEXT_RULE).replace(TAB_ASK, EXT_ASK); // 拡張の繋がっていない常駐（ここの handler）では tab を頼む行が「拡張を入れて」に替わる（W16b）

// 画面なしの agent の代わり: 起こされた command を覚え、出力と終わりを試験から決める
function fakeSpawn() {
  const calls: { cmd: string[]; cwd: string; killed: boolean; finish: (lines: object[], code?: number) => void }[] = [];
  const spawn = (cmd: string[], cwd: string) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
    const exited = new Promise<number>((r) => (done = r));
    const call = {
      cmd, cwd, killed: false,
      finish: (lines: object[], code = 0) => { for (const l of lines) ctrl.enqueue(new TextEncoder().encode(JSON.stringify(l) + "\n")); ctrl.close(); done(code); },
    };
    calls.push(call);
    return { stdout, exited, kill: () => { call.killed = true; try { ctrl.close(); } catch {} done(143); } };
  };
  return { calls, spawn };
}


test("pickDiscard: 8 を超えた分だけ、古い順に。見ている・固定・音つき・捨て済みは数えるが捨てない", async () => {
  const { pickDiscard } = await import("../extension/tabs.js");
  const t = (id: number, o: object = {}) => ({ id, lastAccessed: id * 10, ...o });
  const tabs = [t(1), t(2), t(3, { pinned: true }), t(4), t(5, { audible: true }), t(6), t(7), t(8, { active: true }), t(9), t(10, { discarded: true })];
  expect(pickDiscard(tabs, 8)).toEqual([1]);
  expect(pickDiscard(tabs, 5)).toEqual([1, 2, 4, 6]);
  expect(pickDiscard(tabs, 20)).toEqual([]);
});

test("sendAll: 一度に入りきらない長い返事も、drain のたびに続きを書いて欠けずに届く", () => {
  const got: Buffer[] = [];
  let room = 8;
  const sock = { write: (d: Uint8Array | string) => { const b = Buffer.from(d); const n = Math.min(room, b.length); got.push(b.subarray(0, n)); return n; } };
  const text = "あいうえお".repeat(50) + "\n";
  sendAll(sock, text);
  for (let i = 0; i < 200; i++) flush(sock);
  expect(Buffer.concat(got).toString()).toBe(text);
});

test("stageExtension: 中身が変わると版が変わり（sw を登録し直させる）、同じなら写し直さない", async () => {
  const { stageExtension } = await import("../src/launch.ts");
  const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const d = mktmp("stage");
  const src = join(d, "src");
  mkdirSync(join(src, "sub"), { recursive: true });
  writeFileSync(join(src, "manifest.json"), JSON.stringify({ version: "0.0.2" }));
  writeFileSync(join(src, "sub/sw.js"), "a");
  const ver = () => JSON.parse(readFileSync(join(d, "out/manifest.json"), "utf8")).version as string;
  stageExtension(src, join(d, "out"));
  const v1 = ver();
  expect(v1).toMatch(/^0\.0\.2\.\d{1,5}$/);
  expect(Number(v1.split(".")[3])).toBeLessThanOrEqual(65535);
  const t1 = statSync(join(d, "out/sub/sw.js")).mtimeMs;
  stageExtension(src, join(d, "out"));
  expect(ver()).toBe(v1);
  expect(statSync(join(d, "out/sub/sw.js")).mtimeMs).toBe(t1);
  writeFileSync(join(src, "sub/sw.js"), "b");
  stageExtension(src, join(d, "out"));
  expect(ver()).not.toBe(v1);
  expect(readFileSync(join(d, "out/sub/sw.js"), "utf8")).toBe("b");
});

test("消す: その節と下の枝が一覧・木・AI の一覧から消え、元に戻すと同じ時に消した物だけ戻る", async () => {
  const s = openStore(":memory:");
  const plan = s.add(null, "user", "SNS を運営する", true);
  const a = s.add(plan.id, "user", "ギャルゴス", true);
  const b = s.add(plan.id, "user", "世界観", true);
  const u = s.add(a.id, "user", "混ぜたい", true);
  const k = s.add(u.id, "next", "甘辛");
  const h = makeHandler(s, async () => []);
  // 先に孫を消しておく → 後で親を消して戻しても、孫は戻らない
  await h({ op: "remove", nodeId: k.id });
  await Bun.sleep(2);
  const r: any = await h({ op: "remove", nodeId: a.id });
  expect(r.ok).toBe(true);
  expect(s.tree(plan.id).map((n) => n.id)).toEqual([plan.id, b.id]);
  expect(s.all().some((n) => [a.id, u.id, k.id].includes(n.id))).toBe(false);
  expect(outlineText(s.tree(plan.id), plan.id)).not.toContain("ギャルゴス");
  expect((await h({ op: "remove", nodeId: a.id })).ok).toBe(false);
  const back: any = await h({ op: "restore", nodeId: a.id });
  expect(back).toMatchObject({ ok: true, rootId: plan.id });
  expect(s.tree(plan.id).map((n) => n.id)).toEqual([plan.id, a.id, b.id, u.id]);
  // 木ごと消す
  await h({ op: "remove", nodeId: plan.id });
  expect(s.roots()).toEqual([]);
  await h({ op: "restore", nodeId: plan.id });
  expect(s.roots().map((n) => n.id)).toEqual([plan.id]);
});

test("節のタブ・作業場所・agent: タブは http(s) だけ重ねず保存する。作業場所に文脈を書き、agent は書き戻せる", async () => {
  const { mkdtempSync, readFileSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const s = openStore(":memory:");
  const root = s.add(null, "user", "マーケ", true);
  s.add(root.id, "next", "メール");
  const c = s.add(root.id, "conclusion", "メルマガから始める");
  s.add(c.id, "step", "登録フォームを作る");
  const dir = mktmp("ws");
  const opened: string[][] = [];
  const fs = fakeSpawn();
  const ws = { dir, bin: "/x/kangae", open: async (a: string[]) => (opened.push(a), true), clis: async () => [{ cli: "claude" as const, path: "/bin/claude", env: {} }], spawn: fs.spawn, browserUrl: async () => null };
  const h = makeHandler(s, async () => [], undefined, ws);
  const r: any = await h({ op: "addTabs", nodeId: root.id, tabs: [
    { title: "Gmail", url: "https://mail.google.com/" }, { title: "again", url: "https://mail.google.com/" },
    { title: "js", url: "javascript:alert(1)" }, { title: "", url: "http://example.com/a.csv" }, { title: "bad", url: "::" },
  ] });
  expect(r.added.map((t: any) => [t.text, t.url])).toEqual([["Gmail", "https://mail.google.com/"], ["example.com", "http://example.com/a.csv"]]);
  expect((await h({ op: "addTabs", nodeId: root.id, tabs: [{ title: "Gmail", url: "https://mail.google.com/" }] }) as any).added).toEqual([]);
  expect(s.children(root.id).filter((n) => n.kind === "tab").map((t) => t.text)).toEqual(["Gmail", "example.com"]);
  // ターミナル: 作業場所に AGENTS.md / CLAUDE.md を書いて Terminal で開く
  const t: any = await h({ op: "workspace", nodeId: root.id });
  expect(t.ok).toBe(true);
  expect(t.dir).toBe(join(dir, `${root.id} マーケ`));
  expect(opened[0]).toEqual(["-a", "Terminal", t.dir]);
  const md = readFileSync(join(t.dir, "AGENTS.md"), "utf8");
  for (const want of ["1. マーケ", "結論: メルマガから始める", "- [ ] 登録フォームを作る", "[Gmail](https://mail.google.com/)", `/x/kangae note ${root.id} "一言"`]) expect(md).toContain(want);
  expect(readFileSync(join(t.dir, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  // agent: ターミナルを開かず、節の作業場所で画面なしに起こす
  const a: any = await h({ op: "workspace", nodeId: root.id, agent: true });
  expect(a).toMatchObject({ ok: true, agent: "claude" });
  expect(fs.calls[0]!.cwd).toBe(t.dir);
  expect(fs.calls[0]!.cmd.slice(0, 2)).toEqual(["/bin/claude", "-p"]);
  expect(opened).toHaveLength(1);
  fs.calls[0]!.finish([{ type: "result", result: "済" }]);
  // 書き戻し: 節の下に一言。context は最新を返す
  const n: any = await h({ op: "note", nodeId: root.id, text: "  登録フォームを作った  " });
  expect([n.node.parentId, n.node.kind, n.node.text]).toEqual([root.id, "user", "🤖 メモ: 登録フォームを作った"]);
  expect(((await h({ op: "context", nodeId: root.id })) as any).text).toContain("一言: 🤖 メモ: 登録フォームを作った");
  expect((await h({ op: "note", nodeId: root.id, text: " " })).ok).toBe(false);
  expect((await h({ op: "workspace", nodeId: c.id })).ok).toBe(false);
  const none = makeHandler(s, async () => [], undefined, { ...ws, clis: async () => [] });
  expect(await none({ op: "workspace", nodeId: root.id, agent: true })).toMatchObject({ ok: false, code: "none" });
});

test("todo: 人と agent が同じ todo を動かし、文脈に入る（部品を AI に作らせる口は W3b で消した）", async () => {
  const s = openStore(":memory:");
  const root = s.add(null, "user", "SNS を運営する", true);
  const h = makeHandler(s, async () => []);
  await h({ op: "todo", nodeId: root.id, action: "add", text: "アカウントを作る" });
  await h({ op: "todo", nodeId: root.id, action: "add", text: "初投稿" });
  await h({ op: "todo", nodeId: root.id, action: "done", index: 1 });
  expect(outlineText(s.tree(root.id), root.id)).toContain("- [x] アカウントを作る");
  expect(outlineText(s.tree(root.id), root.id)).toContain("- [ ] 初投稿");
  // 消した口は知らない操作になる
  for (const op of ["component", "addComponent", "updateComponent"]) expect(await h({ op })).toMatchObject({ ok: false, hint: `知らない操作: ${op}` });
});

test("役割の agent: 役割ごとの作業場所に、自分の役割と他の役割を書いて起こす", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const s = openStore(":memory:");
  const root = s.add(null, "user", "SNS を運営する", true);
  const roles = s.addComponent(root.id, "役割", { type: "roles", roles: [{ name: "リサーチ役", job: "競合を調べる" }, { name: "投稿役", job: "投稿を作る" }] });
  const dir = mktmp("ws");
  const opened: string[][] = [];
  const fs = fakeSpawn();
  const h = makeHandler(s, async () => [], undefined, { dir, bin: "/x/kangae", open: async (a) => (opened.push(a), true), clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn: fs.spawn, browserUrl: async () => null });
  const r: any = await h({ op: "workspace", nodeId: roles.id, agent: true, role: 1 });
  expect(r.ok).toBe(true);
  expect(r.dir).toBe(join(dir, `${root.id} SNS を運営する`, "投稿役"));
  const md = readFileSync(join(r.dir, "AGENTS.md"), "utf8");
  expect(md).toContain("あなたは「投稿役」です。投稿を作る");
  expect(md).toContain("他の役割（その仕事には手を出さない）: リサーチ役");
  expect(md).toContain("役割「役割」");
  expect(opened).toHaveLength(0);
  expect(fs.calls[0]!.cwd).toBe(r.dir);
  expect(fs.calls[0]!.cmd[2]).toContain("あなたの役割（投稿役）の仕事を");
  expect(r.run.role).toBe("投稿役");
  expect((await h({ op: "workspace", nodeId: roles.id, agent: true, role: 5 })).ok).toBe(false);
});

test("画面なしの agent: 様子を 1 行ずつ残し、終わると節に🤖の一言。途中の指示は列に並び、同じ会話の続き（--resume）で頼む。止める・失敗・同時 2 本まで", async () => {
  const { mkdtempSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const s = openStore(":memory:");
  const root = s.add(null, "user", "競合を調べる", true);
  const other = s.add(null, "user", "別", true);
  const third = s.add(null, "user", "三つ目", true);
  const fs = fakeSpawn();
  const h = makeHandler(s, async () => [], undefined, { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn: fs.spawn, browserUrl: async () => null });
  const tick = () => Bun.sleep(20);
  const a: any = await h({ op: "workspace", nodeId: root.id, agent: true, text: "競合を 5 つ調べて" });
  expect(a.run.status).toBe("running");
  expect(fs.calls[0]!.cmd[2]).toBe("競合を 5 つ調べて");
  expect(fs.calls[0]!.cmd).toContain("--allowedTools");
  expect(fs.calls[0]!.cmd.join(" ")).toContain("Bash(/x/kangae note:*)");
  expect(fs.calls[0]!.cmd).not.toContain("--resume");
  // 動いている間の指示は列へ
  const q: any = await h({ op: "instruct", runId: a.run.id, text: "表にもして" });
  expect(q.run.queue).toBe(1);
  fs.calls[0]!.finish([
    { type: "system", subtype: "init", session_id: "S1" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "競合" } }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "5 社見つけました\n詳細…" }] } },
    { type: "result", result: "A社・B社・C社・D社・E社", session_id: "S1" },
  ]);
  await tick();
  const notes = s.children(root.id).filter((n) => n.kind === "user");
  expect(notes.map((n) => n.text)).toEqual(["🤖 claude: A社・B社・C社・D社・E社"]);
  // 列の指示が、同じ会話の続きとして起きている
  expect(fs.calls).toHaveLength(2);
  expect(fs.calls[1]!.cmd.slice(2, 5)).toEqual(["表にもして", "--resume", "S1"]);
  const v: any = await h({ op: "runs", nodeIds: [root.id] });
  expect(v.runs[0].status).toBe("running");
  expect(v.runs[0].log.join("\n")).toContain("🔧 WebSearch");
  expect(v.runs[0].log.join("\n")).toContain("5 社見つけました");
  expect(v.runs[0].log.join("\n")).not.toContain("詳細…");
  // 同時は 2 本まで
  const b: any = await h({ op: "workspace", nodeId: other.id, agent: true });
  expect(b.ok).toBe(true);
  expect(await h({ op: "workspace", nodeId: third.id, agent: true })).toMatchObject({ ok: false });
  // 止める: 列も捨て、節には何も足さない
  await h({ op: "instruct", runId: a.run.id, text: "まだある" });
  const st: any = await h({ op: "stopRun", runId: a.run.id });
  expect(st.run).toMatchObject({ status: "stopped", queue: 0 });
  expect(fs.calls[1]!.killed).toBe(true);
  await tick();
  expect(s.children(root.id).filter((n) => n.kind === "user")).toHaveLength(1);
  // 失敗しても、指示を出せば続きから
  fs.calls[2]!.finish([{ type: "system", session_id: "S2" }], 1);
  await tick();
  expect(((await h({ op: "runs", nodeIds: [other.id] })) as any).runs[0].status).toBe("failed");
  await h({ op: "instruct", runId: b.run.id, text: "もう一度" });
  expect(fs.calls[3]!.cmd.slice(2, 5)).toEqual(["もう一度", "--resume", "S2"]);
  fs.calls[3]!.finish([{ type: "result", result: "できた" }]);
  await tick();
  expect(readdirSync(b.run.dir).some((f) => f.startsWith("agent-"))).toBe(true);
});

test("todo: AI を使わず結論の次の一手（無ければその段の次の一手）から作り、人も agent も同じ一覧を足す・済にする・戻す", async () => {
  const s = openStore(":memory:");
  const root = s.add(null, "user", "SNS を運営する", true);
  ["投稿", "分析"].forEach((k) => s.add(root.id, "next", k));
  const never: Mouth = { name: "x", call: async () => { throw new Error("AI を呼んだ"); } };
  const h = makeHandler(s, async () => [never]);
  const a: any = await h({ op: "todo", nodeId: root.id, action: "make" });
  expect(a).toMatchObject({ ok: true, created: true, added: 2 });
  expect(a.node.data.items.map((i: any) => i.text)).toEqual(["投稿", "分析"]);
  const concl = s.add(root.id, "conclusion", "投稿から始める");
  ["アカウントを作る", "投稿"].forEach((t) => s.add(concl.id, "step", t));
  const b: any = await h({ op: "todo", nodeId: root.id, action: "make" });
  expect(b).toMatchObject({ created: false, added: 1 });
  expect(b.node.id).toBe(a.node.id);
  expect(b.node.data.items.map((i: any) => i.text)).toEqual(["投稿", "分析", "アカウントを作る"]);
  expect(((await h({ op: "todo", nodeId: root.id, action: "add", text: "競合を見る" })) as any).text).toContain("4. [ ] 競合を見る");
  expect(((await h({ op: "todo", nodeId: root.id, action: "done", index: 2 })) as any).text).toContain("2. [x] 分析");
  expect(((await h({ op: "todo", nodeId: root.id, action: "undo", index: 2 })) as any).text).toContain("2. [ ] 分析");
  expect(await h({ op: "todo", nodeId: root.id, action: "done", index: 9 })).toMatchObject({ ok: false });
  expect(((await h({ op: "todo", nodeId: root.id })) as any).text.split("\n")).toHaveLength(4);
  expect(((await h({ op: "context", nodeId: root.id })) as any).text).toContain("## やること");
  // 空の節でも持てる（人が後から足す）
  const empty = s.add(null, "user", "空", true);
  const e: any = await h({ op: "todo", nodeId: empty.id, action: "make" });
  expect(e.node.data.items).toEqual([]);
  expect(((await h({ op: "todo", nodeId: empty.id })) as any).text).toContain("まだ項目がありません");
});

test("色: 名前と #RGB/#RRGGBB だけ通し、{ } ; position display z-index とそれ以外は捨てる。保存は h1 { color } の 1 行、崩れた file は override 無し", async () => {
  const { parseColor, readUi, writeUi, clearUi, overridePath } = await import("../src/ui.ts");
  const { mkdtempSync, writeFileSync, readFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mktmp("kangae-ui");
  expect(parseColor("青")).toBe("blue");
  expect(parseColor("赤")).toBe("red");
  expect(parseColor("緑")).toBe("green");
  expect(parseColor("黄")).toBe("yellow");
  expect(parseColor("紫")).toBe("purple");
  expect(parseColor("橙")).toBe("orange");
  expect(parseColor("ピンク")).toBe("pink");
  expect(parseColor("黒")).toBe("black");
  expect(parseColor("白")).toBe("white");
  expect(parseColor("灰")).toBe("gray");
  expect(parseColor("Blue")).toBe("blue");
  expect(parseColor("grey")).toBe("gray");
  expect(parseColor("#F00")).toBe("#f00");
  expect(parseColor("#00ff00")).toBe("#00ff00");
  expect(parseColor("#ffff")).toBeNull();
  expect(parseColor("#ggg")).toBeNull();
  expect(parseColor("navy")).toBeNull();
  expect(parseColor("blue;")).toBeNull();
  expect(parseColor("red }")).toBeNull();
  expect(parseColor("{ color: red")).toBeNull();
  expect(parseColor("red position")).toBeNull();
  expect(parseColor("blue display")).toBeNull();
  expect(parseColor("red z-index")).toBeNull();
  expect(writeUi(home, "青")).toEqual({ color: "blue", hasOverride: true });
  expect(readFileSync(overridePath(home), "utf8")).toBe("h1 { color: blue; }\n");
  expect(readUi(home)).toEqual({ color: "blue", hasOverride: true });
  expect(writeUi(home, "navy")).toBeNull();
  expect(readUi(home)).toEqual({ color: "blue", hasOverride: true });
  expect(clearUi(home)).toEqual({ color: null, hasOverride: false });
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(overridePath(home), "h1 { color: red; }\nbody { display: none; }\n");
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });
  writeFileSync(overridePath(home), "body { color: blue; }\n");
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });
  writeFileSync(overridePath(home), "h1 { color: expression(alert(1)); }\n");
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });
  writeFileSync(overridePath(home), "");
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });
});

test("口 add/chat: 根を LLM 無しで作り、空は拒む。chat は根から下の kind=user を古い順に 1 本。roots は新しい順", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const never: Mouth = { name: "x", call: async () => { throw new Error("LLM を呼んだ"); } };
  const s = openStore(":memory:");
  const h = makeHandler(s, async () => [never], undefined, undefined, { uiHome: mktmp("kangae-ui") });
  expect(await h({ op: "add", text: "  " })).toMatchObject({ ok: false, hint: "一言を入れてください" });
  const a: any = await h({ op: "add", text: " 課題 " });
  expect([a.ok, a.node.parentId, a.node.kind, a.node.text]).toEqual([true, null, "user", "課題"]);
  const b: any = await h({ op: "add", text: "研究" });
  expect(((await h({ op: "roots" })) as any).roots.map((n: any) => n.text)).toEqual(["研究", "課題"]);
  const u1 = s.add(a.node.id, "user", "一つ目", true);
  const nested = s.add(u1.id, "user", "入れ子", true);
  s.add(a.node.id, "user", "二つ目", true);
  const chat: any = await h({ op: "chat", rootId: a.node.id });
  expect(chat.ok).toBe(true);
  expect(chat.rows.map((r: any) => r.text)).toEqual(["一つ目", "入れ子", "二つ目"]);
  expect(chat.rows[0]).toMatchObject({ id: u1.id, text: "一つ目" });
  expect(chat.rows[0].createdAt).toBeGreaterThan(0);
  expect(chat.rows[1].id).toBe(nested.id);
  expect(await h({ op: "chat", rootId: 999 })).toMatchObject({ ok: false });
  expect(b.node.id).toBeGreaterThan(a.node.id);
});

test("口 setUi/clearUi/ui: 色を保存し、繋がっている全部の socket に id 無し type:ui を配る。壊れた色は配らない", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fanout } = await import("../src/main.ts");
  const home = mktmp("kangae-ui");
  const got: string[][] = [[], []];
  const socks = [0, 1].map((i) => ({ write: (d: Uint8Array | string) => { got[i]!.push(Buffer.from(d).toString()); return Buffer.from(d).length; } }));
  const h = makeHandler(openStore(":memory:"), async () => [], undefined, undefined, {
    uiHome: home,
    broadcast: (msg) => fanout(socks, JSON.stringify(msg) + "\n"),
  });
  expect(await h({ op: "ui" })).toMatchObject({ ok: true, ui: { color: null, hasOverride: false } });
  const set: any = await h({ id: "s1", op: "setUi", color: "青" });
  expect(set).toMatchObject({ ok: true, id: "s1", ui: { color: "blue", hasOverride: true } });
  expect(await h({ op: "ui" })).toMatchObject({ ok: true, ui: { color: "blue", hasOverride: true } });
  expect(await h({ op: "setUi", color: "navy" })).toMatchObject({ ok: false });
  expect(await h({ op: "setUi", color: "blue;" })).toMatchObject({ ok: false });
  expect(await h({ op: "ui" })).toMatchObject({ ui: { color: "blue", hasOverride: true } });
  const lines = got.map((g) => g.join("").trim().split("\n").map((l) => JSON.parse(l)));
  expect(lines[0]).toEqual([{ type: "ui", ui: { color: "blue", hasOverride: true } }]);
  expect(lines[1]).toEqual(lines[0]);
  expect(lines[0]![0]).not.toHaveProperty("id");
  const clr: any = await h({ op: "clearUi" });
  expect(clr.ui).toEqual({ color: null, hasOverride: false });
  const after = got.map((g) => g.join("").trim().split("\n").map((l) => JSON.parse(l)));
  expect(after[0]!.at(-1)).toEqual({ type: "ui", ui: { color: null, hasOverride: false } });
  expect(after[1]).toEqual(after[0]);
  fanout(socks, JSON.stringify({ type: "ui", ui: { color: "red", hasOverride: true } }) + "\n");
  expect(got[0]!.join("")).toContain('"color":"red"');
  expect(got[1]!.join("")).toContain('"color":"red"');
});

test("口 send: 見出しの色は setUi で run を起こさない。長い形の失敗は row を残して拒む。仕事は run があれば instruct、無ければ workspace", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readUi } = await import("../src/ui.ts");
  const home = mktmp("kangae-ui");
  const dir = mktmp("ws");
  const fs = fakeSpawn();
  const s = openStore(":memory:");
  const never: Mouth = { name: "x", call: async () => { throw new Error("LLM を呼んだ"); } };
  const notes: unknown[] = [];
  const h = makeHandler(s, async () => [never], undefined, { dir, bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn: fs.spawn, browserUrl: async () => null }, { uiHome: home, broadcast: (msg) => { if (msg.type === "ui") notes.push(msg); } });
  expect(await h({ op: "send", text: "課題" })).toMatchObject({ ok: false, hint: "session が見つかりません" });
  const root: any = await h({ op: "add", text: "課題" });
  expect(await h({ op: "send", rootId: root.node.id, text: "  " })).toMatchObject({ ok: false });
  const painted: any = await h({ op: "send", rootId: root.node.id, text: "新しいタブの見出しを青くして" });
  expect(painted).toMatchObject({ ok: true, ui: { color: "blue", hasOverride: true } });
  expect([painted.row.parentId, painted.row.kind, painted.row.text]).toEqual([root.node.id, "user", "新しいタブの見出しを青くして"]);
  expect(readUi(home)).toEqual({ color: "blue", hasOverride: true });
  expect(painted.runId).toBeUndefined();
  expect(notes).toEqual([{ type: "ui", ui: { color: "blue", hasOverride: true } }]);
  const miss: any = await h({ op: "send", rootId: root.node.id, text: "新しいタブの見出しを大きくして" });
  expect(miss).toMatchObject({ ok: false, gate: "ui", hint: "見出しは「新しいタブの見出しを青にして」か「新しいタブの見出しを『今週の募集』にして」のように、文ごと書いてください" });
  expect(miss.row.text).toBe("新しいタブの見出しを大きくして");
  expect(miss.runId).toBeUndefined();
  expect(readUi(home)).toEqual({ color: "blue", hasOverride: true });
  expect(fs.calls).toHaveLength(0);
  const job: any = await h({ op: "send", rootId: root.node.id, text: "競合を 5 つ調べて" });
  expect(job.ok).toBe(true);
  expect(job.runId).toBeTruthy();
  expect(job.row.text).toBe("競合を 5 つ調べて");
  expect(fs.calls[0]!.cmd[2]).toBe("競合を 5 つ調べて" + NOEXT);
  const again: any = await h({ op: "send", rootId: root.node.id, text: "表にもして" });
  expect(again.runId).toBe(job.runId);
  expect(again.ok).toBe(true);
  expect(fs.calls).toHaveLength(1);
  const runs: any = await h({ op: "runs", nodeIds: [root.node.id] });
  expect(runs.runs[0].queue).toBe(1);
  const none = makeHandler(s, async () => [never], undefined, { dir, bin: "/x/kangae", open: async () => true, clis: async () => [], spawn: fs.spawn, browserUrl: async () => null }, { uiHome: home });
  const other: any = await h({ op: "add", text: "別" });
  const fail: any = await none({ op: "send", rootId: other.node.id, text: "調べて" });
  expect(fail).toMatchObject({ ok: false, row: { text: "調べて" } });
  expect(fail.hint.length).toBeGreaterThan(5);
  const chat: any = await h({ op: "chat", rootId: root.node.id });
  expect(chat.rows.map((r: any) => r.text)).toEqual(["新しいタブの見出しを青くして", "新しいタブの見出しを大きくして", "競合を 5 つ調べて", "表にもして"]);
});

test("resetWorkers: 拡張の版が前の起動と違う時だけ、Chromium が止まっている間に sw の登録を消す", async () => {
  const { resetWorkers } = await import("../src/launch.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const prof = mktmp("prof");
  const sw = join(prof, "Default", "Service Worker");
  const put = () => { mkdirSync(join(sw, "ScriptCache"), { recursive: true }); writeFileSync(join(sw, "ScriptCache", "x"), "old"); };
  put();
  expect(resetWorkers(prof, "0.0.2.1")).toBe(true);
  expect(existsSync(sw)).toBe(false);
  expect(readFileSync(join(prof, "kangae-sw-version"), "utf8")).toBe("0.0.2.1");
  put();
  expect(resetWorkers(prof, "0.0.2.1")).toBe(false);
  expect(existsSync(join(sw, "ScriptCache", "x"))).toBe(true);
  // Chromium が動いている間は消さない（この試験の process を Chromium と見なせないので、動いていない時の分岐だけ見る）
  symlinkSync(`host-${process.pid}`, join(prof, "SingletonLock"));
  expect(resetWorkers(prof, "0.0.2.2")).toBe(true);
  expect(existsSync(sw)).toBe(false);
});

test("文の門: 長い形は色・引用・色と引用の失敗、短い形の非色は仕事。部分一致は色にしない", async () => {
  const { planUi } = await import("../src/ui.ts");
  const cases: [string, ReturnType<typeof planUi>][] = [
    ["新しいタブの見出しを青くして", { kind: "color", color: "blue" }],
    ["新しいタブの見出しを青にして", { kind: "color", color: "blue" }],
    ["  新しいタブの見出しを青くしてください  ", { kind: "color", color: "blue" }],
    ["新しいタブの見出しを青くして下さい。", { kind: "color", color: "blue" }],
    ["新しいタブの見出しをピンクにして", { kind: "color", color: "pink" }],
    ["新しいタブの見出しを#F00にして", { kind: "color", color: "#f00" }],
    ["新しいタブの見出しを『今週の募集』にして", { kind: "text", text: "今週の募集" }],
    ["新しいタブの見出しを「青」にして", { kind: "text", text: "青" }],
    ["新しいタブの見出しを「" + "あ".repeat(40) + "」にして", { kind: "text", text: "あ".repeat(40) }],
    ["新しいタブの見出しを青く『今週の募集』にして", { kind: "fail" }],
    ["新しいタブの見出しを『今週の募集』青くして", { kind: "fail" }],
    ["新しいタブの見出しを大きくして", { kind: "fail" }],
    ["新しいタブの見出しを青春にして", { kind: "fail" }],
    ["新しいタブの見出しを白紙にして", { kind: "fail" }],
    ["新しいタブの見出しをして", { kind: "fail" }],
    ["新しいタブの見出しを「」にして", { kind: "fail" }],
    ["新しいタブの見出しを『』にして", { kind: "fail" }],
    ["新しいタブの見出しを「a{b}」にして", { kind: "fail" }],
    ["新しいタブの見出しを「<b>今週</b>」にして", { kind: "fail" }],
    ["新しいタブの見出しを「" + "あ".repeat(41) + "」にして", { kind: "fail" }],
    ["新しいタブの見出しを『今週の募集』ですにして", { kind: "fail" }],
    ["新しいタブの見出しを青く『今週の募集』ですにして", { kind: "fail" }],
    ["新しいタブの見出しを青く", { kind: "work" }],
    ["新しいタブの見出しを青くして。追加", { kind: "work" }],
    ["新しいタブの見出しを青くしてくださいください", { kind: "work" }],
    ["新しいタブの見出しを『今週の募集。』にして", { kind: "text", text: "今週の募集。" }],
    ["新しいタブの見出しを「今週。来週」にして。", { kind: "text", text: "今週。来週" }],
    ["新しいタブの見出しを『今週の募集』にして。追加", { kind: "work" }],
    ["新しいタブの見出しを青くして。。", { kind: "work" }],
    ["新しいタブの見出しを『a; } b』にして", { kind: "text", text: "a; } b" }],
    ["新しいタブの見出しを『 今週 』にして", { kind: "text", text: "今週" }],
    ["新しいタブの見出しを『 』にして", { kind: "fail" }],
    ["新しいタブの見出しを『今週\n来週』にして", { kind: "fail" }],
    ["新しいタブの見出しを『a』『b』にして", { kind: "fail" }],
    ["新しいタブの見出しを『a』「b」にして", { kind: "fail" }],
    ["新しいタブの見出しを『今週』」にして", { kind: "fail" }],
    ["新しいタブの見出しを『今週にして", { kind: "fail" }],
    ["新しいタブの見出しを 『今週』 にして", { kind: "fail" }],
    ["新しいタブの見出しを 青 にして", { kind: "fail" }],
    ["新しいタブの見出しをにして", { kind: "fail" }],
    ["新しいタブの見出しを下さい", { kind: "work" }],
    ["新しいタブの見出しを青くしてください", { kind: "color", color: "blue" }],
    ["新しいタブの見出しを赤にして下さい。", { kind: "color", color: "red" }],
    ["新しいタブの見出しを『" + "𠮷".repeat(40) + "』にして", { kind: "text", text: "𠮷".repeat(40) }],
    ["新しいタブを青くして", { kind: "color", color: "blue" }],
    ["新しいタブをピンクにして", { kind: "color", color: "pink" }],
    ["新しいタブを大きくして", { kind: "work" }],
    ["新しいタブを投稿の下書きを3本出して", { kind: "work" }],
    ["新しいタブを『今週の募集』にして", { kind: "work" }],
    ["設問3を青で書いて", { kind: "work" }],
    ["新しいタブで LMS を開いて", { kind: "work" }],
    ["投稿の見出しを3案出して", { kind: "work" }],
    ["黒い服の投稿を3本", { kind: "work" }],
    ["青春向けの文案", { kind: "work" }],
    ["答えは『光合成』だ", { kind: "work" }],
    ["白紙に戻して設問3を解いて", { kind: "work" }],
  ];
  expect(cases.map(([s]) => [s, planUi(s)])).toEqual(cases.map(([s, want]) => [s, want]));
});

test("override の 1 行: 色だけ・文字だけ・両方。区切りの空白と末尾改行は文字に含めず、{ だけでは none にしない", async () => {
  const { readUi, writeUi, clearUi, overridePath } = await import("../src/ui.ts");
  const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mktmp("kangae-ui");
  expect(writeUi(home, null, "今週の募集")).toEqual({ text: "今週の募集", hasOverride: true });
  expect(writeUi(home, null, "今週の募集")).not.toHaveProperty("color");
  expect(readFileSync(overridePath(home), "utf8")).toBe("h1 { } 今週の募集\n");
  expect(readUi(home)).toEqual({ text: "今週の募集", hasOverride: true });
  expect(readUi(home).text).toBe("今週の募集");
  expect(writeUi(home, "青")).toEqual({ color: "blue", text: "今週の募集", hasOverride: true });
  expect(readFileSync(overridePath(home), "utf8")).toBe("h1 { color: blue; } 今週の募集\n");
  expect(readUi(home)).toEqual({ color: "blue", text: "今週の募集", hasOverride: true });
  expect(writeUi(home, null, "別の見出し")).toEqual({ color: "blue", text: "別の見出し", hasOverride: true });
  expect(readFileSync(overridePath(home), "utf8")).toBe("h1 { color: blue; } 別の見出し\n");
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(overridePath(home), "h1 { color: blue; } 今週の募集\n");
  expect(readUi(home).color).toBe("blue");
  expect(readUi(home).text).toBe("今週の募集");
  writeFileSync(overridePath(home), "h1 { } 今週の募集\n");
  const only = readUi(home);
  expect(only).toEqual({ text: "今週の募集", hasOverride: true });
  expect(only).not.toHaveProperty("color");
  expect(writeUi(home, null, "Kangae")).toEqual({ color: null, hasOverride: false });
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });
  expect(writeUi(home, "青")).toEqual({ color: "blue", hasOverride: true });
  expect(readFileSync(overridePath(home), "utf8")).toBe("h1 { color: blue; }\n");
  expect(writeUi(home, null, "{")).toBeNull();
  expect(readFileSync(overridePath(home), "utf8")).toBe("h1 { color: blue; }\n");
  expect(clearUi(home)).toEqual({ color: null, hasOverride: false });
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });
});

test("口 send: 見た目は run を起こさず失敗は書かない。仕事の rowId は走っている間動かさず、始まりと停止でない送信で移す", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { UI_HINT, readUi, overridePath } = await import("../src/ui.ts");
  const home = mktmp("kangae-ui");
  const dir = mktmp("ws");
  const fs = fakeSpawn();
  const s = openStore(":memory:");
  const notes: { type: "ui"; ui: { color?: string | null; text?: string | null; hasOverride: boolean } }[] = [];
  const h = makeHandler(s, async () => [], undefined, { dir, bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn: fs.spawn, browserUrl: async () => null }, { uiHome: home, broadcast: (msg) => { if (msg.type === "ui") notes.push(msg); } });
  const root: any = await h({ op: "add", text: "課題" });
  const id = root.node.id;
  const tick = () => Bun.sleep(20);

  const painted: any = await h({ op: "send", rootId: id, text: "新しいタブの見出しを青くして" });
  expect(painted.runId).toBeUndefined();
  expect(painted.ui).toEqual({ color: "blue", hasOverride: true });
  expect(painted.ui).not.toHaveProperty("text");
  expect(notes[0]).toEqual({ type: "ui", ui: { color: "blue", hasOverride: true } });
  expect(fs.calls).toHaveLength(0);

  const titled: any = await h({ op: "send", rootId: id, text: "新しいタブの見出しを『今週の募集』にして" });
  expect(titled.runId).toBeUndefined();
  expect(titled.ui).toEqual({ color: "blue", text: "今週の募集", hasOverride: true });
  expect(readFileSync(overridePath(home), "utf8")).toBe("h1 { color: blue; } 今週の募集\n");
  expect(readUi(home).text).toBe("今週の募集");

  const job: any = await h({ op: "send", rootId: id, text: "設問3を解いて" });
  expect(job.ok).toBe(true);
  expect(job.runId).toBeTruthy();
  expect(fs.calls[0]!.cmd[2]).toBe("設問3を解いて" + NOEXT);
  const live: any = await h({ op: "runs", nodeIds: [id] });
  expect(live.runs[0]).toMatchObject({ status: "running", queue: 0, rowId: job.row.id });

  const again: any = await h({ op: "send", rootId: id, text: "表にもして" });
  expect(again.runId).toBe(job.runId);
  const queued: any = await h({ op: "runs", nodeIds: [id] });
  expect(queued.runs[0]).toMatchObject({ queue: 1, rowId: job.row.id });
  expect(fs.calls).toHaveLength(1);

  const recolor: any = await h({ op: "send", rootId: id, text: "新しいタブの見出しを青くしてください" });
  expect(recolor.runId).toBeUndefined();
  expect(recolor.ui).toEqual({ color: "blue", text: "今週の募集", hasOverride: true });
  expect(((await h({ op: "runs", nodeIds: [id] })) as any).runs[0].rowId).toBe(job.row.id);

  const miss: any = await h({ op: "send", rootId: id, text: "新しいタブの見出しを青春にして" });
  expect(miss).toMatchObject({ ok: false, gate: "ui", hint: UI_HINT });
  expect(miss.runId).toBeUndefined();
  expect(readFileSync(overridePath(home), "utf8")).toBe("h1 { color: blue; } 今週の募集\n");
  expect(((await h({ op: "runs", nodeIds: [id] })) as any).runs[0].rowId).toBe(job.row.id);

  const both: any = await h({ op: "send", rootId: id, text: "新しいタブの見出しを青く『今週の募集』にして" });
  expect(both).toMatchObject({ ok: false, gate: "ui", hint: UI_HINT });
  expect(readUi(home)).toEqual({ color: "blue", text: "今週の募集", hasOverride: true });

  const short: any = await h({ op: "send", rootId: id, text: "新しいタブを大きくして" });
  expect(short.ok).toBe(true);
  expect(short.runId).toBe(job.runId);
  expect(short.hint).toBeUndefined();
  const lms: any = await h({ op: "send", rootId: id, text: "新しいタブで LMS を開いて" });
  expect(lms.ok).toBe(true);
  expect(lms.hint).toBeUndefined();
  expect(((await h({ op: "runs", nodeIds: [id] })) as any).runs[0]).toMatchObject({ queue: 3, rowId: job.row.id });
  expect(fs.calls).toHaveLength(1);

  fs.calls[0]!.finish([{ type: "result", result: "できた", session_id: "S1" }]);
  await tick();
  expect(fs.calls).toHaveLength(2);
  expect(fs.calls[1]!.cmd[2]).toBe("表にもして" + NOEXT);
  expect(((await h({ op: "runs", nodeIds: [id] })) as any).runs[0]).toMatchObject({ status: "running", queue: 2, rowId: again.row.id });

  const st: any = await h({ op: "stopRun", runId: job.runId });
  expect(st.run).toMatchObject({ status: "stopped", queue: 0 });
  await tick();
  expect(fs.calls).toHaveLength(2);
  expect(fs.calls[1]!.killed).toBe(true);

  const moved: any = await h({ op: "send", rootId: id, text: "続きを頼む" });
  expect(fs.calls[2]!.cmd[2]).toBe("続きを頼む" + NOEXT);
  expect(((await h({ op: "runs", nodeIds: [id] })) as any).runs[0].rowId).toBe(moved.row.id);

  const set: any = await h({ op: "setUi", color: "赤" });
  expect(set.ui).toEqual({ color: "red", text: "今週の募集", hasOverride: true });
  expect(readFileSync(overridePath(home), "utf8")).toBe("h1 { color: red; } 今週の募集\n");
  const clr: any = await h({ op: "clearUi" });
  expect(clr.ui).toEqual({ color: null, hasOverride: false });
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });

  const bare = makeHandler(s, async () => [], undefined, { dir, bin: "/x/kangae", open: async () => true, clis: async () => [], spawn: fs.spawn, browserUrl: async () => null }, { uiHome: home });
  const other: any = await h({ op: "add", text: "別" });
  const fail: any = await bare({ op: "send", rootId: other.node.id, text: "新しいタブで LMS を開いて" });
  expect(fail.ok).toBe(false);
  expect(fail.gate).toBeUndefined();
  expect(fail.hint).not.toBe(UI_HINT);
  expect(fail.row.text).toBe("新しいタブで LMS を開いて");
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });
});

test("visit: 足した時だけ {type:history, rootId} を配る（同じ url の続き・消えた根では配らない）", async () => {
  const s = openStore(":memory:");
  const sent: unknown[] = [];
  const h = makeHandler(s, async () => [], undefined, undefined, { broadcast: (m) => sent.push(m) });
  const root = s.add(null, "user", "課題", true);
  await h({ op: "visit", rootId: root.id, url: "https://ex.example/1", title: "a" });
  await h({ op: "visit", rootId: root.id, url: "https://ex.example/1", title: "a" });
  await h({ op: "visit", rootId: 999, url: "https://ex.example/2", title: "b" });
  expect(sent).toEqual([{ type: "history", rootId: root.id }]);
});

test("visit: 根の子に足す。同じ url の続きは足さない。消えた根と根でない節には足さない。history は新しい順", async () => {
  const s = openStore(":memory:");
  const h = makeHandler(s, async () => []);
  const root = s.add(null, "user", "課題", true);
  const child = s.add(root.id, "user", "下", true);
  const visits = () => s.children(root.id).filter((n) => n.kind === "visit");
  const a: any = await h({ op: "visit", rootId: root.id, url: "https://insta.example/p/1", title: "投稿" });
  expect([a.node.parentId, a.node.kind, a.node.text, a.node.url]).toEqual([root.id, "visit", "投稿", "https://insta.example/p/1"]);
  expect(await h({ op: "visit", rootId: root.id, url: "https://insta.example/p/1", title: "もう一度" })).toMatchObject({ ok: true, node: null });
  expect(visits()).toHaveLength(1);
  const host: any = await h({ op: "visit", rootId: root.id, url: "https://insta.example/p/2", title: "  " });
  expect(host.node.text).toBe("insta.example");
  expect(await h({ op: "visit", rootId: root.id, url: "https://insta.example/p/2", title: "同じ" })).toMatchObject({ node: null });
  expect(visits()).toHaveLength(2);
  const back: any = await h({ op: "visit", rootId: root.id, url: "https://insta.example/p/1", title: "戻った" });
  expect(back.node.text).toBe("戻った");
  expect(visits()).toHaveLength(3);
  expect(await h({ op: "visit", rootId: root.id, url: "javascript:alert(1)", title: "js" })).toMatchObject({ node: null });
  expect(await h({ op: "visit", rootId: child.id, url: "https://insta.example/p/9", title: "子" })).toMatchObject({ node: null });
  expect(await h({ op: "visit", rootId: 999, url: "https://insta.example/p/9", title: "無い" })).toMatchObject({ node: null });
  s.remove(root.id);
  expect(await h({ op: "visit", rootId: root.id, url: "https://insta.example/gone", title: "消えた" })).toMatchObject({ node: null });
  expect(await h({ op: "history", rootId: root.id })).toMatchObject({ ok: true, visits: [] });

  const live = s.add(null, "user", "研究", true);
  for (let i = 1; i <= 21; i++) await h({ op: "visit", rootId: live.id, url: `https://ex.example/${i}`, title: `t${i}` });
  const page: any = await h({ op: "history", rootId: live.id, limit: 2 });
  expect(page.visits.map((v: any) => v.url)).toEqual(["https://ex.example/21", "https://ex.example/20"]);
  const all: any = await h({ op: "history", rootId: live.id });
  expect(all.visits).toHaveLength(20);
  expect(all.visits[0].url).toBe("https://ex.example/21");
  expect(all.visits.some((v: any) => v.url === "https://ex.example/1")).toBe(false);
  expect(await h({ op: "history", rootId: live.id, limit: 0 })).toMatchObject({ visits: [] });
  expect(outlineText(s.tree(live.id), live.id)).toContain("履歴: t21");
});

test("prepare: パスワードの 2 つを Preferences に入れる。debugPort のときだけ remote debugging を付け、本番は mock keychain を付けない", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { prepare, chromiumArgs } = await import("../src/launch.ts");
  const { cdpPort, openLaunchOpts } = await import("../src/main.ts");
  const dir = mktmp("kangae-prefs");
  prepare({ app: "/no/app", profile: dir, hostBinary: "/x/kangae", extensionDir: "/no/ext" });
  const prefs = JSON.parse(readFileSync(join(dir, "Default/Preferences"), "utf8"));
  expect(prefs.credentials_enable_service).toBe(true);
  expect(prefs.profile.password_manager_enabled).toBe(true);
  const base = { app: "/no/app", profile: dir, hostBinary: "/x/kangae", extensionDir: "/no/ext" };
  const plain = chromiumArgs(base, "ext");
  expect(plain.some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
  expect(plain).not.toContain("--use-mock-keychain");
  expect(chromiumArgs({ ...base, debugPort: 9339 }, "ext")).toContain("--remote-debugging-port=9339");
  const trial = chromiumArgs({ ...base, mockKeychain: true, extraArgs: ["--remote-debugging-port=9400"] }, "ext");
  expect(trial).toContain("--use-mock-keychain");
  expect(trial).toContain("--remote-debugging-port=9400");
  expect(trial.filter((a) => a.startsWith("--remote-debugging-port"))).toEqual(["--remote-debugging-port=9400"]);
  expect(cdpPort("")).toBe(9339);
  expect(cdpPort("9444")).toBe(9444);
  expect(cdpPort("no")).toBe(9339);
  expect(cdpPort("0")).toBe(9339);
  expect(cdpPort("65536")).toBe(9339);
  const opened = openLaunchOpts("/h", "/r", false, "/x", {});
  expect(opened.debugPort).toBe(9339);
  expect(opened.profile).toBe(join("/h", "profile"));
  expect(opened.hostBinary).toBe(join("/r", "dist/kangae"));
  expect(opened.extensionDir).toBe(join("/r", "extension"));
  expect("mockKeychain" in opened).toBe(false);
  expect(openLaunchOpts("/h", "/r", true, "/x/kangae", { KANGAE_CDP_PORT: "9444", CHROMIUM_APP: "/Chromium.app" })).toMatchObject({
    app: "/Chromium.app", debugPort: 9444, hostBinary: "/x/kangae",
  });
});

test("browserUrl: /json/version が返ればその origin、失敗と 1 秒で返らない時は null", async () => {
  const { probeBrowser } = await import("../src/headless.ts");
  const ok = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      return new URL(req.url).pathname === "/json/version" ? Response.json({ Browser: "test" }) : new Response("no", { status: 404 });
    },
  });
  expect(await probeBrowser(ok.port!)).toBe(`http://127.0.0.1:${ok.port}`);
  ok.stop(true);
  const bad = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return new Response("no", { status: 500 }); } });
  expect(await probeBrowser(bad.port!)).toBeNull();
  bad.stop(true);
  const hung = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return new Promise(() => {}); } });
  expect(await probeBrowser(hung.port!)).toBeNull();
  hung.stop(true);
}, 15000);

test("claude の turn: browserUrl がある時だけ mcp とブラウザの決まり。null と codex と gemini には入らない", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const s = openStore(":memory:");
  const root = s.add(null, "user", "課題", true);
  const child = s.add(root.id, "next", "メール");
  const h0 = makeHandler(s, async () => []);
  await h0({ op: "addTabs", nodeId: root.id, tabs: Array.from({ length: 11 }, (_, i) => ({ title: `t${i}`, url: `https://tab.example/${i}` })) });
  for (let i = 0; i < 11; i++) await h0({ op: "visit", rootId: root.id, url: `https://hist.example/${i}`, title: `h${i}` });
  const dir = mktmp("ws");
  const url = "http://127.0.0.1:9339";
  const base = { dir, bin: "/x/kangae", open: async () => true, browserUrl: async () => null as string | null };
  const off = fakeSpawn();
  const none = makeHandler(s, async () => [], undefined, { ...base, clis: async () => [{ cli: "claude" as const, path: "/bin/claude", env: {} }], spawn: off.spawn });
  const quiet: any = await none({ op: "context", nodeId: child.id });
  expect(quiet.text).not.toContain("このブラウザを操作する");
  const noAgent: any = await none({ op: "workspace", nodeId: root.id, agent: true, text: "見て" });
  expect(off.calls[0]!.cmd).not.toContain("--mcp-config");
  expect(off.calls[0]!.cmd.join(" ")).not.toContain("mcp__browser");
  expect(readFileSync(join(noAgent.dir, "AGENTS.md"), "utf8")).not.toContain("このブラウザを操作する");

  const blockOf = (md: string) => {
    const head = "## このブラウザを操作する";
    const i = md.indexOf(head);
    const rest = md.slice(i + head.length);
    const j = rest.indexOf("\n## ");
    return j < 0 ? rest : rest.slice(0, j);
  };
  const on = fakeSpawn();
  const live = makeHandler(s, async () => [], undefined, { ...base, browserUrl: async () => url, clis: async () => [{ cli: "claude" as const, path: "/bin/claude", env: {} }], spawn: on.spawn });
  const ctx: any = await live({ op: "context", nodeId: child.id });
  const block = blockOf(ctx.text);
  expect(block).toContain("あなた専用のブラウザ");
  expect(block).toContain("https://tab.example/0");
  expect(block).toContain("https://tab.example/9");
  expect(block).not.toContain("https://tab.example/10");
  expect(block).toContain("h10 https://hist.example/10");
  expect(block).not.toContain("https://hist.example/0");
  expect(block).toContain("list_pages で探し、無ければ new_page");
  expect(block).toContain(`/x/kangae note ${child.id} "確認してください: …"`);
  expect(block).toContain("パスワードを文字で読まない・書かない・書き戻さない");
  const run: any = await live({ op: "workspace", nodeId: root.id, agent: true, text: "開いて" });
  const cmd = on.calls[0]!.cmd;
  expect(cmd).toContain("--mcp-config");
  const cfg = cmd[cmd.indexOf("--mcp-config") + 1];
  expect(cfg).toBe(join(run.dir, "browser-mcp.json"));
  expect(cmd.join(" ")).toContain("mcp__browser");
  const allowed = cmd[cmd.indexOf("--allowedTools") + 1]!;
  expect(allowed).toContain("Write(//"); // 書込みは作業場所の中だけ（無印の Write / Edit は外にも書ける）
  expect(cmd.slice(cmd.indexOf("--setting-sources"), cmd.indexOf("--setting-sources") + 2)).toEqual(["--setting-sources", "project"]);
  expect(allowed.split(",")).not.toContain("Write");
  expect(allowed.split(",")).not.toContain("Edit");
  expect(JSON.parse(readFileSync(cfg!, "utf8"))).toEqual({
    mcpServers: { browser: { command: "npx", args: ["-y", "chrome-devtools-mcp@1.10.1", "--browserUrl", url, "--usageStatistics", "false"] } },
  });
  expect(blockOf(readFileSync(join(run.dir, "AGENTS.md"), "utf8"))).toContain("あなた専用のブラウザ");
  expect(readFileSync(join(run.dir, "AGENTS.md"), "utf8")).toContain("自分で GUI の app や窓を open / osascript などで開かない");
  expect(readFileSync(join(run.dir, "AGENTS.md"), "utf8")).toContain("自分で GUI の app や窓を open / osascript などで開かない");

  const codex = fakeSpawn();
  await makeHandler(s, async () => [], undefined, { ...base, browserUrl: async () => url, clis: async () => [{ cli: "codex" as const, path: "/bin/codex", env: {} }], spawn: codex.spawn })({ op: "workspace", nodeId: root.id, agent: true, text: "codex" });
  expect(codex.calls[0]!.cmd).not.toContain("--mcp-config");
  expect(codex.calls[0]!.cmd.join(" ")).not.toContain("mcp__browser");
  const gemini = fakeSpawn();
  await makeHandler(s, async () => [], undefined, { ...base, browserUrl: async () => url, clis: async () => [{ cli: "gemini" as const, path: "/bin/gemini", env: {} }], spawn: gemini.spawn })({ op: "workspace", nodeId: root.id, agent: true, text: "gemini" });
  expect(gemini.calls[0]!.cmd.slice(gemini.calls[0]!.cmd.indexOf("/bin/gemini"))).toEqual(["/bin/gemini", "-p", "gemini", "--approval-mode", "auto_edit", "--admin-policy", expect.stringContaining("kangae-gemini-policy-")]); // W5: file の編集だけ自動で許す・OS の sandbox と stderr の受け皿が前に付く
  expect(gemini.calls[0]!.cmd[0]).toBe("/usr/bin/sandbox-exec");
});

test("--session の url", async () => {
  const { sessionUrl, EXT_ORIGIN } = await import("../src/main.ts");
  expect(sessionUrl(["bun", "--open"])).toBeUndefined();
  expect(sessionUrl(["--open", "--session", "12"])).toBe(`${EXT_ORIGIN}panel.html?session=12`);
  expect(sessionUrl(["--open", "--session", "1;x"])).toBeUndefined();
  expect(sessionUrl(["--open", "--session"])).toBeUndefined();
});

test("v1.4 デスクトップ: session と tab を置く・同じ物は 2 枚にならない・空き位置・動かす・外す・消えた根は出ない・壊れた file は空から", async () => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { freeSpot } = await import("../src/desktop.ts");
  const home = mktmp("kangae-desk");
  try {
    const s = openStore(":memory:");
    const gal = s.add(null, "user", "ギャル", true);
    const goth = s.add(null, "user", "ゴス", true);
    const gone = s.add(null, "user", "消す", true);
    s.remove(gone.id);
    const kid = s.add(gal.id, "next", "子");
    const sent: any[] = [];
    const h = makeHandler(s, async () => [], undefined, undefined, { uiHome: home, broadcast: (m) => sent.push(m) });
    const list = async () => ((await h({ op: "desktopList" })) as any).cards as any[];

    expect(await list()).toEqual([]);
    const a: any = await h({ op: "desktopPlace", kind: "session", rootId: gal.id });
    expect(a).toMatchObject({ ok: true, key: `s:${gal.id}`, name: "ギャル" });
    expect(sent).toEqual([{ type: "desktop" }]);
    const again: any = await h({ op: "desktopPlace", kind: "session", rootId: gal.id });
    expect(again).toMatchObject({ ok: true, already: true });
    expect(sent.length).toBe(1); // 同じ物は 2 枚にならず、配りもしない
    await h({ op: "desktopPlace", kind: "session", rootId: goth.id });
    const t: any = await h({ op: "desktopPlace", kind: "tab", url: "https://www.instagram.com/", title: "Instagram", icon: "https://www.instagram.com/f.ico" });
    expect(t.key).toBe("t:https://www.instagram.com/");
    await h({ op: "desktopPlace", kind: "tab", url: "https://example.com/a", title: "  " });
    expect(await h({ op: "desktopPlace", kind: "terminal", rootId: gal.id })).toMatchObject({ ok: true, key: `x:${gal.id}`, name: "ギャル のターミナル" });
    expect(await h({ op: "desktopPlace", kind: "terminal", rootId: gal.id })).toMatchObject({ ok: true, already: true });
    expect(await h({ op: "desktopPlace", kind: "terminal", rootId: kid.id })).toMatchObject({ ok: false });
    const cards = await list();
    expect(cards.map((c) => c.name)).toEqual(["ギャル", "ゴス", "Instagram", "example.com", "ギャル のターミナル"]);
    expect(cards[4]).toMatchObject({ kind: "terminal", rootId: gal.id });
    expect(cards[2]).toMatchObject({ kind: "tab", url: "https://www.instagram.com/", icon: "https://www.instagram.com/f.ico" });
    // 空き位置: 4 枚とも別の場所
    expect(new Set(cards.map((c) => `${c.x},${c.y}`)).size).toBe(5);
    expect(freeSpot([{ key: "s:1", kind: "session", rootId: 1, x: 0.03, y: 0.04 }])).not.toEqual({ x: 0.03, y: 0.04 });

    expect(await h({ op: "desktopPlace", kind: "session", rootId: gone.id })).toMatchObject({ ok: false, hint: "その session は無い" });
    expect(await h({ op: "desktopPlace", kind: "session", rootId: kid.id })).toMatchObject({ ok: false });
    expect(await h({ op: "desktopPlace", kind: "tab", url: "chrome://settings" })).toMatchObject({ ok: false });
    expect(await h({ op: "desktopPlace", kind: "tab", url: "javascript:alert(1)" })).toMatchObject({ ok: false });
    expect(await h({ op: "desktopPlace" })).toMatchObject({ ok: false });
    expect((await list()).length).toBe(5);

    // 動かす（0〜1 に丸める）・存在しない札・数でない値
    sent.length = 0;
    await h({ op: "desktopMove", key: `s:${goth.id}`, x: 0.5, y: 1.7 });
    expect((await list()).find((c) => c.name === "ゴス")).toMatchObject({ x: 0.5, y: 1 });
    expect(sent).toEqual([{ type: "desktop" }]);
    expect(await h({ op: "desktopMove", key: "s:999", x: 0.1, y: 0.1 })).toMatchObject({ ok: false });
    expect(await h({ op: "desktopMove", key: `s:${goth.id}`, x: "a" as any, y: 0.1 })).toMatchObject({ ok: false });
    // 開き直し（別の handler）でも同じ位置
    const h2 = makeHandler(s, async () => [], undefined, undefined, { uiHome: home });
    expect(((await h2({ op: "desktopList" })) as any).cards.find((c: any) => c.name === "ゴス")).toMatchObject({ x: 0.5, y: 1 });

    // 窓の保存: 札が無ければ失敗・形が違えば失敗・開き直しても同じ・動かしても窓は消えない
    sent.length = 0;
    const win = { x: 40, y: 60, w: 520, h: 400, open: true };
    expect(await h({ op: "desktopWindow", key: `s:${goth.id}`, win })).toMatchObject({ ok: true });
    expect(sent).toEqual([{ type: "desktop" }]);
    expect(await h({ op: "desktopWindow", key: "s:999", win })).toMatchObject({ ok: false, hint: "その札は無い" });
    expect(await h({ op: "desktopWindow", key: `s:${goth.id}`, win: { ...win, w: "a" } })).toMatchObject({ ok: false });
    expect(await h({ op: "desktopWindow", key: `s:${goth.id}`, win: { ...win, open: 1 } })).toMatchObject({ ok: false });
    await h({ op: "desktopMove", key: `s:${goth.id}`, x: 0.5, y: 0.5 });
    const h3 = makeHandler(s, async () => [], undefined, undefined, { uiHome: home });
    expect(((await h3({ op: "desktopList" })) as any).cards.find((c: any) => c.name === "ゴス").win).toEqual(win);
    await h({ op: "desktopMove", key: `s:${goth.id}`, x: 0.5, y: 1.7 });

    // 名前は今の名前を引く・消した根の札は出ない・戻すと札も戻る・外しても session は消えない
    s.remove(goth.id);
    expect((await list()).some((c) => c.rootId === goth.id)).toBe(false);
    s.restore(goth.id);
    expect((await list()).some((c) => c.rootId === goth.id)).toBe(true);
    await h({ op: "desktopRemove", key: `s:${gal.id}` });
    expect((await list()).some((c) => c.key === `s:${gal.id}`)).toBe(false);
    expect((await list()).some((c) => c.key === `x:${gal.id}`)).toBe(true); // terminal の札は別の札
    expect(s.get(gal.id)!.deletedAt).toBeNull();

    // 壊れた file・形の違う札は空から始める
    writeFileSync(join(home, "desktop.json"), "{not json");
    expect(await list()).toEqual([]);
    writeFileSync(join(home, "desktop.json"), JSON.stringify([{ key: "x", kind: "session", rootId: goth.id, x: 0.2, y: 0.2 }, { kind: "tab", url: "file:///etc/passwd", x: 0, y: 0 }, { kind: "session", rootId: goth.id, x: "a", y: 0 }]));
    expect((await list()).map((c) => c.name)).toEqual(["ゴス"]);
    await h({ op: "desktopPlace", kind: "session", rootId: gal.id });
    expect(JSON.parse(readFileSync(join(home, "desktop.json"), "utf8")).length).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("v1.4 terminal の窓: ptyOpen は session の作業場所で shell を起こす・書く→出力が流れる→resize→閉じると process が残らない・4 本まで・口が切れたら全部止まる・shell が終われば exit が流れる", async () => {
  const { mkdtempSync, rmSync, existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { defaultWorkspace } = await import("../src/main.ts");
  const dir = mktmp("kangae-pty");
  const shell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const until = async (f: () => boolean, ms = 15_000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await Bun.sleep(20); return f(); };
  try {
    const s = openStore(":memory:");
    const gal = s.add(null, "user", "ギャル", true);
    const sent: any[] = [];
    const h = makeHandler(s, async () => [], undefined, { ...defaultWorkspace(), dir, browserUrl: async () => null }, { broadcast: (m) => sent.push(m) });
    const out = (id: number) => sent.filter((m) => m.type === "pty" && m.ptyId === id && m.data).map((m) => m.data).join("");
    const owner = {};

    const o: any = await h({ op: "ptyOpen", rootId: gal.id, cols: 80, rows: 24 }, owner);
    expect(o).toMatchObject({ ok: true });
    expect(o.dir.startsWith(dir) && existsSync(join(o.dir, "AGENTS.md"))).toBe(true);
    expect(await h({ op: "ptyWrite", ptyId: o.ptyId, data: "echo kangae-$((40+2)); pwd\n" })).toMatchObject({ ok: true });
    expect(await until(() => out(o.ptyId).includes("kangae-42"))).toBe(true);
    expect(await until(() => out(o.ptyId).includes(realpathSync(o.dir)))).toBe(true);
    await h({ op: "ptyResize", ptyId: o.ptyId, cols: 100, rows: 30 });
    await h({ op: "ptyWrite", ptyId: o.ptyId, data: "stty size\n" });
    expect(await until(() => out(o.ptyId).includes("30 100"))).toBe(true);

    expect(await h({ op: "ptyClose", ptyId: o.ptyId })).toMatchObject({ ok: true });
    expect(await until(() => gone(o.pid))).toBe(true);
    expect(await h({ op: "ptyClose", ptyId: o.ptyId })).toMatchObject({ ok: false });
    expect(await h({ op: "ptyWrite", ptyId: 999, data: "x" })).toMatchObject({ ok: false });
    expect(await h({ op: "ptyOpen", rootId: 9999 })).toMatchObject({ ok: false });

    // 4 本まで。口（owner）が切れたら、その口の物は全部止まる
    const four: any[] = [];
    for (let i = 0; i < 4; i++) four.push(await h({ op: "ptyOpen", rootId: gal.id, from: i < 2 ? 1 : 2 }, owner));
    expect(four.every((x) => x.ok)).toBe(true);
    expect(await h({ op: "ptyOpen", rootId: gal.id }, owner)).toMatchObject({ ok: false });
    // 窓の持ち主（from）が落ちたら、その持ち主の物だけ止まる
    await h({ op: "ptyDrop", from: 1 }, owner);
    expect(await until(() => gone(four[0].pid) && gone(four[1].pid))).toBe(true);
    expect(gone(four[2].pid) || gone(four[3].pid)).toBe(false);
    h.dropOwner(owner);
    for (const x of four) expect(await until(() => gone(x.pid))).toBe(true);

    // shell が自分で終われば exit が流れ、枠が空く
    const e: any = await h({ op: "ptyOpen", rootId: gal.id }, owner);
    await h({ op: "ptyWrite", ptyId: e.ptyId, data: "exit\n" });
    expect(await until(() => sent.some((m) => m.type === "pty" && m.ptyId === e.ptyId && m.exit === true))).toBe(true);
    expect(await h({ op: "ptyWrite", ptyId: e.ptyId, data: "x" })).toMatchObject({ ok: false });
  } finally {
    if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell;
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000); // 待ちを 1 つずつ締切で測る作り。test 全体の 5 秒既定で先に落とさない

test("hint の 1 文: SPEC §2-1 の文そのまま。中の 2 文は、欄にそのまま打てばどちらも失敗にならず h1 が変わる", async () => {
  const { UI_HINT, planUi } = await import("../src/ui.ts");
  expect(UI_HINT).toBe("見出しは「新しいタブの見出しを青にして」か「新しいタブの見出しを『今週の募集』にして」のように、文ごと書いてください");
  const examples = [...UI_HINT.matchAll(/「([^」]*)」/g)].map((m) => m[1]!);
  expect(examples).toEqual(["新しいタブの見出しを青にして", "新しいタブの見出しを『今週の募集』にして"]);
  expect(planUi(examples[0]!)).toEqual({ kind: "color", color: "blue" });
  expect(planUi(examples[1]!)).toEqual({ kind: "text", text: "今週の募集" });
  // 「青」だけは門の外で仕事になるので、hint の例には使わない
  expect(planUi("青")).toEqual({ kind: "work" });
});

test("§3 色ありのまま『a; } b』: X は最初の ; で止まり、色と文字が読み戻せる。U+2028 を含む文字も読み戻せる", async () => {
  const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readUi, writeUi, overridePath } = await import("../src/ui.ts");
  const home = mktmp("kangae-ui");
  expect(writeUi(home, "青")).toEqual({ color: "blue", hasOverride: true });
  expect(writeUi(home, null, "a; } b")).toEqual({ color: "blue", text: "a; } b", hasOverride: true });
  expect(readFileSync(overridePath(home), "utf8")).toBe("h1 { color: blue; } a; } b\n");
  expect(readUi(home)).toEqual({ color: "blue", text: "a; } b", hasOverride: true });
  expect(writeUi(home, null, "a\u2028b")?.text).toBe("a\u2028b");
  expect(readUi(home)).toEqual({ color: "blue", text: "a\u2028b", hasOverride: true });
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(overridePath(home), "h1 { } \n");
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });
  writeFileSync(overridePath(home), "h1 { color: ; } x\n");
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });
  writeFileSync(overridePath(home), "h1 { color: blue; } x\ny\n");
  expect(readUi(home)).toEqual({ color: null, hasOverride: false });
});

test("manifest: minimum_chrome_version は 121、key と newtab.html の行は動かさない", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8");
  const m = JSON.parse(raw);
  expect(m.minimum_chrome_version).toBe("121");
  expect(m.chrome_url_overrides).toEqual({ newtab: "newtab.html" });
  expect(raw.split("\n")[10]).toContain("newtab.html");
  expect(m.key).toMatch(/^MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsyoYhjXkD3zRUZuphhqeqzsEqdwqTnJxG/);
});

test("v1.3 operator: 色ありで文字を同梱へ戻すと、配る形に text: null（開いている新しいタブの h1 も戻る）・保存の行に文字は残らない", async () => {
  const { writeUi, readUi } = await import("../src/ui.ts");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mktmp("kangae-ui13");
  writeUi(home, "blue");
  writeUi(home, null, "今週の募集");
  const back = writeUi(home, null, "Kangae");
  expect(back).toEqual({ color: "blue", text: null, hasOverride: true });
  expect(readUi(home)).toEqual({ color: "blue", hasOverride: true });
  expect(writeUi(home, "red")).toEqual({ color: "red", hasOverride: true }); // 色だけの時は text のキーを付けない
});

test("v2 改名: 根の名前だけ変わる・空/根でない/消えた根は失敗・作業場所の folder は新しい名前へ移る・roots と desktop を配る・デスクトップの札は新しい名前", async () => {
  const { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { defaultWorkspace } = await import("../src/main.ts");
  const dir = mktmp("kangae-ren");
  try {
    const s = openStore(":memory:");
    const gal = s.add(null, "user", "ギャル", true);
    const kid = s.add(gal.id, "user", "子", true);
    const gone = s.add(null, "user", "消す", true);
    s.remove(gone.id);
    const sent: any[] = [];
    const h = makeHandler(s, async () => [], undefined, { ...defaultWorkspace(), dir, browserUrl: async () => null }, { uiHome: dir, broadcast: (m) => sent.push(m) });
    await h({ op: "desktopPlace", kind: "session", rootId: gal.id });
    mkdirSync(join(dir, `${gal.id} ギャル`));
    writeFileSync(join(dir, `${gal.id} ギャル`, "memo.txt"), "作業");
    sent.length = 0;

    expect(await h({ op: "rename", rootId: gal.id, text: "  " })).toMatchObject({ ok: false });
    expect(await h({ op: "rename", rootId: kid.id, text: "x" })).toMatchObject({ ok: false });
    expect(await h({ op: "rename", rootId: gone.id, text: "x" })).toMatchObject({ ok: false });
    expect(await h({ op: "rename", rootId: 9999, text: "x" })).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
    expect(s.get(kid.id)!.text).toBe("子");

    const r: any = await h({ op: "rename", rootId: gal.id, text: " 黒ギャル " });
    expect(r).toMatchObject({ ok: true, node: { id: gal.id, text: "黒ギャル" } });
    expect(s.roots().map((n) => n.text)).toEqual(["黒ギャル"]);
    expect(sent).toEqual([{ type: "roots" }, { type: "desktop" }]);
    expect(existsSync(join(dir, `${gal.id} ギャル`))).toBe(false);
    expect(readFileSync(join(dir, `${gal.id} 黒ギャル`, "memo.txt"), "utf8")).toBe("作業");
    expect(((await h({ op: "desktopList" })) as any).cards[0].name).toBe("黒ギャル");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attach: 囲んだ画面を今の会話に貼り、次の send で agent に画像の path と文脈を渡す。PNG でない物・session 無しは断る", async () => {
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const s = openStore(":memory:");
  const root = s.add(null, "user", "画面", true);
  const fs = fakeSpawn();
  const home = mktmp("ws");
  const h = makeHandler(s, async () => [], undefined, { dir: home, bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn: fs.spawn, browserUrl: async () => null }, { uiHome: home });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  expect((await h({ op: "attach", image: Buffer.from("GIF89a....").toString("base64"), text: "x" })).ok).toBe(false);
  expect((await h({ op: "attach", rootId: 999, image: png, text: "x" })).ok).toBe(false);
  const a: any = await h({ op: "attach", image: png, text: "前面の app: Finder" });
  expect(a.ok).toBe(true);
  expect(existsSync(a.file)).toBe(true);
  expect(s.children(root.id).at(-1)!.text).toContain("前面の app: Finder");
  expect(fs.calls).toHaveLength(0); // 貼るだけでは agent を起こさない
  await h({ op: "send", rootId: root.id, text: "これ何？" });
  expect(fs.calls[0]!.cmd[2]).toContain(a.file);
  expect(fs.calls[0]!.cmd[2]).toContain("これ何？");
  expect(fs.calls[0]!.cmd).toContain("--add-dir");
});

test("attach: 見ている会話（rootId）に貼る。session が 1 つも無ければ「囲んだ画面」を作って貼る", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const s = openStore(":memory:");
  const home = mktmp("ws");
  const sent: any[] = [];
  const h = makeHandler(s, async () => [], undefined, { dir: home, bin: "/x/kangae", open: async () => true, clis: async () => [], spawn: fakeSpawn().spawn, browserUrl: async () => null }, { uiHome: home, broadcast: (m: any) => sent.push(m) });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  const first: any = await h({ op: "attach", image: png, text: "x" });
  expect(first.ok).toBe(true);
  expect(s.roots()[0]!.text).toBe("囲んだ画面");
  expect(sent.some((m) => m.type === "roots")).toBe(true);
  const old = s.roots()[0]!;
  s.add(null, "user", "新しい方", true);
  const a: any = await h({ op: "attach", rootId: old.id, image: png, text: "y" });
  expect(a.rootId).toBe(old.id); // 最新ではなく見ている方
  expect(s.children(old.id).at(-1)!.text).toContain("y");
});

test("splitNext: 返事を本文と次の一手に分ける。3 つ未満・0・崩れた形でも壊れず、4 つ目以降は捨てる", () => {
  const body = "答えです。\n二行目。";
  expect(splitNext(`${body}\n\n次の一手:\n1. A を調べる\n2. B を比べる\n3. C を決める`)).toEqual({ body, next: ["A を調べる", "B を比べる", "C を決める"] });
  expect(splitNext(`${body}\n---\n**次の一手**\n- 一つだけ`)).toEqual({ body, next: ["一つだけ"] });
  expect(splitNext(`${body}\n次の一手：\n1) a\n2) b\n3) c\n4) d`).next).toEqual(["a", "b", "c"]);
  expect(splitNext(body)).toEqual({ body, next: [] });
  expect(splitNext(`${body}\n次の一手:\n`)).toEqual({ body, next: [] });
  expect(splitNext("次の一手を考える人の話。\n本文")).toEqual({ body: "次の一手を考える人の話。\n本文", next: [] });
  expect(NEXT_RULE).toContain("次の一手:");
});

test("W3a 次の一手: send は規則つきで agent に頼み、返事の次の一手 3 つが返事にぶら下がり、chat は最新の行の押していない物だけ返す。押すとその一手が一言になり出し直さない", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const s = openStore(":memory:");
  const fs = fakeSpawn();
  const dir = mktmp("ws");
  const ws = { dir, bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude" as const, path: "/bin/claude", env: {} }], spawn: fs.spawn, browserUrl: async () => null };
  const h = makeHandler(s, async () => [], undefined, ws, { uiHome: mktmp("kangae-ui") });
  const root: any = await h({ op: "add", text: "副業" });
  const r1: any = await h({ op: "send", rootId: root.node.id, text: "副業を始めたい" });
  expect(r1.ok).toBe(true);
  expect(fs.calls[0]!.cmd[2]).toContain("副業を始めたい");
  expect(fs.calls[0]!.cmd[2]).toContain("次の一手:");
  expect(((await h({ op: "chat", rootId: root.node.id })) as any).next).toEqual([]); // 返事はまだ
  fs.calls[0]!.finish([{ type: "result", result: "まず小さく試す。\n\n次の一手:\n1. 時間を測る\n2. 案を 3 つ書く\n3. 一人に話す" }]);
  await Bun.sleep(30);
  const c1: any = await h({ op: "chat", rootId: root.node.id });
  expect(c1.rows.map((r: any) => r.text)).toEqual(["副業を始めたい", "🤖 claude: まず小さく試す。"]);
  expect(c1.next.map((n: any) => n.text)).toEqual(["時間を測る", "案を 3 つ書く", "一人に話す"]);
  s.choose(c1.next[2].id); // 押した物は、同じ返事の下でも出し直さない
  expect(((await h({ op: "chat", rootId: root.node.id })) as any).next.map((n: any) => n.text)).toEqual(["時間を測る", "案を 3 つ書く"]);
  // 1 つ押す = その文が次の一言として送られ（規則つき）、押した一手と、その回の残りは出し直さない
  const r2: any = await h({ op: "send", rootId: root.node.id, text: "案を 3 つ書く", nodeId: c1.next[1].id });
  expect(r2.ok).toBe(true);
  expect(s.get(c1.next[1].id)!.chosen).toBe(true);
  const c2: any = await h({ op: "chat", rootId: root.node.id });
  expect(c2.rows.at(-1).text).toBe("案を 3 つ書く");
  expect(c2.next).toEqual([]);
  // 3 つ出ない返事（0 個）も壊れない
  fs.calls[1]!.finish([{ type: "result", result: "了解です。" }]);
  await Bun.sleep(30);
  const c3: any = await h({ op: "chat", rootId: root.node.id });
  expect(c3.rows.at(-1).text).toBe("🤖 claude: 了解です。");
  expect(c3.next).toEqual([]);
});

test("W3a 移行: keyword の木だった前の会話は、移行の後も同じ一言・返事のまま読め、前の枝は次の一手として残る", async () => {
  const { Database } = await import("bun:sqlite");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(mktmp("mig"), "old.sqlite");
  // 移行前の形（user_version 5）を作る: 根 → 枝 3 つ → 選んだ枝の下に一言 → その下に枝
  const db = new Database(path);
  db.run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES nodes(id), kind TEXT NOT NULL, text TEXT NOT NULL, chosen INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, from_id INTEGER, deleted_at INTEGER, url TEXT, data TEXT)`);
  const ins = db.query("INSERT INTO nodes (id, parent_id, kind, text, chosen, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  [[1, null, "user", "副業したい", 1, 1], [2, 1, "keyword", "時間", 1, 2], [3, 1, "keyword", "お金", 0, 3], [4, 2, "user", "眠い", 1, 4], [5, 4, "keyword", "朝", 0, 5]].forEach((r) => ins.run(...(r as [number, number | null, string, string, number, number])));
  db.run("PRAGMA user_version = 5");
  db.close();
  const s = openStore(path);
  const h = makeHandler(s, async () => []);
  const chat: any = await h({ op: "chat", rootId: 1 });
  expect(chat.rows.map((r: any) => r.text)).toEqual(["眠い"]); // 根（副業したい）は会話の名前
  expect(s.get(1)!.text).toBe("副業したい");
  expect(chat.next.map((n: any) => n.text)).toEqual(["朝"]);
  expect(s.children(1).map((n) => [n.kind, n.text])).toEqual([["next", "時間"], ["next", "お金"]]);
  expect(s.all().some((n) => (n.kind as string) === "keyword")).toBe(false);
  s.close();
});

test("W3b splitCards: 🤖 の返事の印を本文から外して card にする。形が崩れても壊れず、人が打った印は見ない", () => {
  const bot = (t: string) => `🤖 claude: ${t}`;
  const a = splitCards(bot("どちらにしますか。\n[[ask: 表の形は？ | 1 枚に | 別の表に]]\n続き"));
  expect(a.body).toBe("🤖 claude: どちらにしますか。\n\n続き");
  expect(a.cards).toEqual([{ kind: "ask", title: "表の形は？", options: ["1 枚に", "別の表に"], detail: "" }]);
  expect(splitCards(bot("[[ask: 進めますか]]")).cards[0]!.options).toEqual(["進める", "やめる"]); // 選択肢が無い承認の既定
  expect(splitCards(bot("[[handoff: 変更を外に送る | git push origin main]]")).cards[0]).toEqual({ kind: "handoff", title: "変更を外に送る", options: ["やりました", "やめる"], detail: "git push origin main" });
  expect(splitCards(bot("できた [[done: 終わりました | 売上.csv]]")).cards[0]).toEqual({ kind: "done", title: "終わりました", options: [], detail: "売上.csv" });
  expect(splitCards(bot("[[ask: a | 1 | 2 | 3 | 4 | 5]]")).cards[0]!.options).toEqual(["1", "2", "3"]); // 押せるのは 3 つまで
  // 崩れた形・知らない印・題が空の印: 落ちない（崩れた印は本文に残る）
  expect(splitCards(bot("[[ask: 閉じていない")).cards).toEqual([]);
  expect(splitCards(bot("[[unknown: x]]")).body).toContain("[[unknown: x]]");
  expect(splitCards(bot("[[ask:]]")).cards).toEqual([]);
  // 人が打った印は card にしない
  expect(splitCards("[[ask: 偽の承認 | はい]]")).toEqual({ body: "[[ask: 偽の承認 | はい]]", cards: [] });
  expect(CARD_RULE).toContain("[[ask:");
});

test("W3b needOf: 足りない物を 1 つの型で返す（agent が無い・同時に動ける数・login）。関係ない失敗は null", () => {
  expect(needOf("none", "agent がいません。…")).toMatchObject({ kind: "agent", what: "agent がいません" });
  expect(needOf(undefined, "同時に動ける agent は 2 つまでです")).toMatchObject({ kind: "limit" });
  expect(needOf(undefined, "Invalid API key · Please run /login")).toMatchObject({ kind: "login" });
  expect(needOf(undefined, "ただの失敗")).toBeNull();
  expect(needOf("failed", "")).toBeNull();
});

test("W3b card と一覧: chat は印を本文から外して cards を返し、roots は最後の行と「あなたの番」を返し、足りない物は send / run が 1 つの型で返す", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const s = openStore(":memory:");
  const fs = fakeSpawn();
  const dir = mktmp("ws");
  const ws = { dir, bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude" as const, path: "/bin/claude", env: {} }], spawn: fs.spawn, browserUrl: async () => null };
  const h = makeHandler(s, async () => [], undefined, ws, { uiHome: mktmp("kangae-ui") });
  const a: any = await h({ op: "add", text: "承認の会話" });
  const b: any = await h({ op: "add", text: "ふつうの会話" });
  expect(((await h({ op: "roots" })) as any).roots.map((r: any) => r.last)).toEqual([null, null]); // 何も話していない会話
  await h({ op: "send", rootId: a.node.id, text: "表を作って" });
  expect(fs.calls[0]!.cmd[2]).toContain("[[ask:"); // agent に印の書き方を渡している
  fs.calls[0]!.finish([{ type: "result", result: "形を選んでください。\n[[ask: 表の形は？ | 1 枚に | 別の表に]]\n\n次の一手:\n1. 任せる" }]);
  await Bun.sleep(30);
  const c: any = await h({ op: "chat", rootId: a.node.id });
  expect(c.rows.at(-1).text).toBe("🤖 claude: 形を選んでください。");
  expect(c.rows.at(-1).text).not.toContain("[[");
  expect(c.rows.at(-1).cards).toEqual([{ kind: "ask", title: "表の形は？", options: ["1 枚に", "別の表に"], detail: "" }]);
  expect(s.children(a.node.id).at(-1)!.text).toContain("[[ask:"); // 保存は生のまま（外すのは見せる時）
  await h({ op: "send", rootId: b.node.id, text: "雑談" });
  fs.calls[1]!.finish([{ type: "result", result: "はい。" }]);
  await Bun.sleep(30);
  const roots: any = (await h({ op: "roots" })) as any;
  const byText = (t: string) => roots.roots.find((r: any) => r.text === t).last;
  expect(byText("承認の会話")).toMatchObject({ text: "形を選んでください。", mine: false, turn: true });
  expect(byText("ふつうの会話")).toMatchObject({ text: "はい。", mine: false, turn: false });
  expect(typeof byText("承認の会話").at).toBe("number");
  // 足りない物: agent が居ない時、send は need を返す（1 つの型）
  const none = makeHandler(s, async () => [], undefined, { ...ws, clis: async () => [] });
  const r: any = await none({ op: "send", rootId: b.node.id, text: "こんにちは" });
  expect(r.ok).toBe(false);
  expect(r.need).toMatchObject({ kind: "agent" });
  // run が login 切れで落ちると、run の view が need を持つ（次に成功すれば消える）
  await h({ op: "send", rootId: b.node.id, text: "もう一度" });
  fs.calls[2]!.finish([{ type: "result", is_error: true, result: "Invalid API key · Please run /login" }], 1);
  await Bun.sleep(30);
  const runs: any = await h({ op: "runs", nodeIds: [b.node.id] });
  expect(runs.runs[0]).toMatchObject({ status: "failed", need: { kind: "login" } });
  await h({ op: "send", rootId: b.node.id, text: "続き" });
  fs.calls[3]!.finish([{ type: "result", result: "戻りました" }]);
  await Bun.sleep(30);
  expect(((await h({ op: "runs", nodeIds: [b.node.id] })) as any).runs[0].need).toBeUndefined();
});

// 拡張の native host が常駐に繋がる前（Chrome を起こした直後）の web の依頼は、捨てずに繋がるまで待つ。繋がらなければ「繋がっていない」と理由を言う
test("web: webHello が来るまで web の依頼は送らず待ち、来たら送る（繋がる前の依頼を捨てない）", async () => {
  const s = openStore(":memory:");
  const sent: { type: string; id?: string; tool?: string }[] = [];
  const h = makeHandler(s, async () => [], undefined, undefined, { awaitWebPeer: true, isExtension: () => true, webPeerMs: 2000, broadcast: (m) => sent.push(m as any) });
  const root = s.add(null, "user", "課題", true);
  const ext = {};
  const give = h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" });
  await new Promise((r) => setTimeout(r, 100));
  expect(sent.filter((m) => m.type === "web")).toEqual([]); // 拡張が居ない間は投げっぱなしにしない
  await h({ op: "webHello" }, ext);
  await new Promise((r) => setTimeout(r, 50));
  const w = sent.find((m) => m.type === "web")!;
  expect(w.tool).toBe("tab_info");
  await h({ op: "webResult", callId: w.id, text: "", data: { docId: "d1", title: "頁", url: "https://ex.example/" } }, ext);
  expect(await give).toMatchObject({ ok: true });
});

test("web: 拡張が繋がらないまま待ちが切れたら、繋がっていない理由を言って 0 件送る・繋がった後に host が切れたら、また待つ", async () => {
  const s = openStore(":memory:");
  const sent: { type: string }[] = [];
  const h = makeHandler(s, async () => [], undefined, undefined, { awaitWebPeer: true, isExtension: () => true, webPeerMs: 80, broadcast: (m) => sent.push(m as any) });
  const root = s.add(null, "user", "課題", true);
  const r = await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" });
  expect(r).toMatchObject({ ok: false, hint: expect.stringContaining("拡張がまだ常駐に繋がっていません") });
  expect(sent.filter((m) => m.type === "web")).toEqual([]);
  const ext = {};
  await h({ op: "webHello" }, ext);
  h.dropOwner(ext); // host が切れた
  const r2 = await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" });
  expect(r2).toMatchObject({ ok: false });
  expect(sent.filter((m) => m.type === "web")).toEqual([]);
});

test("画面: 試験が起こす Chrome / Chromium は headless にする（人の Space に窓を出さない）。窓を測るのが目的の物だけ許可表に載せる", async () => {
  const { readFileSync } = await import("node:fs");
  const { Glob } = await import("bun");
  // 許可表 = 窓・Dock・前面を「測る」ために headed で起こす物（win-count と front-watch で数える）。ここに足す時は理由を 1 行書く
  const MEASURES = new Set(["test/w3c.e2e.ts", "test/w3c-probe.e2e.ts", "test/w3c-launch.ts", "test/front-probe.e2e.ts", "test/holes1-h4-windows.e2e.ts", "docs/verify/holes1/uc-bar-web.ts", "test/cold.e2e.ts" /* KANGAE_ALLOW_WINDOW 無しでは回らない */]);
  const root = new URL("..", import.meta.url).pathname;
  const bad: string[] = [];
  for (const g of ["test/*.ts", "docs/verify/**/*.ts", "tools/*.ts"]) for (const f of new Glob(g).scanSync({ cwd: root })) {
    if (MEASURES.has(f) || f === "test/core.test.ts") continue;
    const src = readFileSync(root + f, "utf8");
    if (/"open",\s*"-g"/.test(src) && /CHROMIUM_APP|Google Chrome/.test(src) && !src.includes("--headless=new")) bad.push(f);
  }
  expect(bad).toEqual([]);
});

test("画面: launchScratchPad の既定の引数は --ghost --accessory（人の画面に的の窓を出さない・前にもキーの先にもならない）。見える窓が要る probe だけ [] を明示する", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("..", import.meta.url).pathname;
  expect(readFileSync(root + "tools/scratch-pad.ts", "utf8")).toMatch(/launchScratchPad\([^)]*extraArgs: string\[\] = \["--ghost", "--accessory"\]\)/);
  const sw = readFileSync(root + "tools/scratch-pad.swift", "utf8");
  expect(sw).toMatch(/class GhostPanel: NSPanel[\s\S]*canBecomeKey: Bool \{ false \}[\s\S]*canBecomeMain: Bool \{ false \}/);
  expect(sw).toContain(".nonactivatingPanel");
  expect(readFileSync(root + "docs/verify/w4h/probe.ts", "utf8")).toMatch(/launchScratchPad\(.*, p, \[\]\)/);
});

// H7: 拡張が冷えている / 混んでいる時の最初の tab_info は 8 秒で「応答しません」になる。応答が無かった時だけ 3 回まで打ち直す（他の失敗は 1 回で返す）
test("web: tab を渡す時、tab_info が応答しなかった時だけ打ち直す", async () => {
  const mk = (replies: { text: string; data: any }[]) => {
    const calls: string[] = [];
    const s = openStore(":memory:");
    const driver = { call: async (tool: string) => { calls.push(tool); const r = replies[Math.min(calls.length - 1, replies.length - 1)]!; return { text: r.text, isError: !r.data, data: r.data }; }, close() {} };
    return { calls, s, h: makeHandler(s, async () => [], undefined, undefined, { webDriver: driver as any }) };
  };
  const timeout = { text: "ブラウザが応答しません", data: null };
  const ok = { text: "", data: { docId: "d1", title: "頁", url: "https://ex.example/" } };
  const a = mk([timeout, timeout, ok]);
  const root = a.s.add(null, "user", "課題", true);
  expect(await a.h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" })).toMatchObject({ ok: true });
  expect(a.calls.filter((c) => c !== "gate_on").length).toBe(3); // gate_on = W8b-2 の WebAuthn の見張り（渡した tab に 1 回）。tab_info の打ち直しではない
  const b = mk([{ text: "文書の印を読めませんでした", data: null }]); // 応答はあった（読めない tab）= 打ち直さない
  const root2 = b.s.add(null, "user", "課題", true);
  expect(await b.h({ op: "leaseGive", rootId: root2.id, tabId: 7, title: "t" })).toMatchObject({ ok: false });
  expect(b.calls.length).toBe(1);
});
