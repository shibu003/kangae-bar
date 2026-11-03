// W42a（docs/design-no-fallback.md S1〜S3）: 下書き・読みの監査の凍結・記録 5 項目
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDraft, draftLine, dropDraft, readDrafts } from "../src/drafts.ts";
import { ALLOWED, makeLeases, tokenOf, type Driver, type OpRecord } from "../src/lease.ts";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

let dir: string, calls: { tool: string; args: Record<string, unknown> }[];
const fake = (): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : tool === "get_window_state" ? { elements: [{ element_token: "e1", role: "AXSecureTextField", label: "pw" }, { element_token: "e2", role: "AXTextField", label: "name" }] } : null }; }, close() {} });
beforeEach(() => { dir = mktmp("w42a"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const mk = (rec?: (e: OpRecord) => void) => { const L: ReturnType<typeof makeLeases> = makeLeases(dir, { driver: fake, defaultMode: "allow", record: rec, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) }); return L; };
const give = (L: ReturnType<typeof mk>) => { const g = L.give({ pid: 10, windowId: 1, app: "Calc", title: "" }, "s:1"); if (!g.ok) throw new Error(); return tokenOf(g.lease); };

// ---- S1 下書き ----
test("S1 下書き: 操作名・欄の名前・理由が残り、値は保存しない。形に合わない名前・理由なしは断り、何も書かない", () => {
  const r = addDraft(dir, { owner: "s:1", face: "Calc", gen: 3, op: "gift-wrap-toggle", fields: { enabled: "SECRET-VALUE" }, why: "包装の切替が要る" });
  expect(r.ok).toBe(true);
  const ds = readDrafts(dir);
  expect(ds).toHaveLength(1);
  expect(ds[0]).toMatchObject({ op: "gift-wrap-toggle", fields: ["enabled"], gen: 3 });
  expect(JSON.stringify(ds)).not.toContain("SECRET-VALUE");
  for (const bad of [{ op: "click the button\nnow" }, { op: "" }, { op: "x".repeat(41) }, { fields: { "a b": 1 } }, { why: "  " }]) {
    const o = addDraft(dir, { owner: "s:1", face: "Calc", gen: 3, op: "ok", fields: {}, why: "理由", ...bad });
    expect(o.ok).toBe(false);
  }
  expect(readDrafts(dir)).toHaveLength(1);
  expect(draftLine(ds[0]!)).toContain("画面を直接操作せず止まっています"); // 次の一手（手で済ませる / 別のやり方を頼む）も 1 行に入る（W53）
});

test("S1 下書きは 50 件まで（古い物から落ちる）・捨てるのは id が合う時だけ", () => {
  for (let i = 0; i < 52; i++) addDraft(dir, { owner: "s:1", face: "x", gen: 1, op: `op${i}`, fields: {}, why: "w" });
  const ds = readDrafts(dir);
  expect(ds).toHaveLength(50);
  expect(ds[0]!.op).toBe("op2");
  expect(dropDraft(dir, "nope")).toBe(false);
  expect(dropDraft(dir, ds[0]!.id)).toBe(true);
  expect(readDrafts(dir)).toHaveLength(49);
});

test("S1 常駐の draft: agent の頼みの外・動いていない頼みは断る。捨てる op は人（panel）だけ。下書きは実行 0（driver に何も届かない）", async () => {
  const ui = join(dir, "ui"); mkdirSync(ui);
  const H: any = makeHandler(openStore(":memory:"), async () => [], undefined, { ...defaultWorkspace(), dir: join(dir, "nodes") }, { uiHome: ui, leaseDriver: () => fake() });
  expect(await H({ op: "draft", op_name: "x", why: "w" }, { write() {} })).toMatchObject({ ok: false });
  expect(await H({ op: "draft", owner: "s:99", op_name: "x", why: "w" }, { write() {} })).toMatchObject({ ok: false, hint: expect.stringContaining("動いていません") });
  expect(readDrafts(ui)).toEqual([]);
  expect(calls).toEqual([]);
  addDraft(ui, { owner: "s:1", face: "x", gen: 1, op: "x", fields: {}, why: "w" });
  const id = readDrafts(ui)[0]!.id;
  expect(await H({ op: "draftDrop", draftId: id }, { write() {} })).toMatchObject({ ok: false }); // agent の CLI
  expect(await H({ op: "draftDrop", draftId: id, owner: "s:1" }, {})).toMatchObject({ ok: false });
  expect(readDrafts(ui)).toHaveLength(1);
  expect((await H({ op: "draftList" }, {})).drafts).toHaveLength(1);
  expect(await H({ op: "draftDrop", draftId: id }, {})).toMatchObject({ ok: true });
  expect(readDrafts(ui)).toEqual([]);
});

// ---- S2 読みの監査（凍結）----
test("S2 読み: 面の一覧・app 一覧・貸していない tab・画面全体の写真に届く道具は、門が driver を呼ばずに断る（ALLOWED に無い）", async () => {
  const L = mk(); const t = give(L);
  for (const tool of ["list_windows", "list_apps", "list_tabs", "tab_list", "tab_state", "tab_info", "screenshot", "screen_image", "get_screen", "capture_screen", "get_cursor_position"]) {
    calls = [];
    expect((await L.act(t, tool, { pid: 99, tabId: 99, window_id: 99 })).ok).toBe(false);
    expect(calls.filter((c) => c.tool !== "list_windows")).toEqual([]);
  }
  expect(ALLOWED).not.toContain("list_windows");
  expect(ALLOWED).not.toContain("list_apps");
});

test("S2 読み: window_image / get_window_state は貸した窓だけ（敵対的な pid・window_id・tabId・capture_id・保存先は捨てられ、driver へは貸した窓の番号が付く）", async () => {
  const L = mk(); const t = give(L);
  for (const tool of ["window_image", "get_window_state"]) {
    calls = [];
    await L.act(t, tool, { pid: 99, window_id: 99, tabId: 99, capture_id: "c", screenshot_out_file: "/tmp/x.png", scope: "desktop", target: { kind: "desktop" } });
    const c = calls.find((c) => c.tool === "get_window_state")!;
    expect(c.args).toMatchObject({ pid: 10, window_id: 1 });
    for (const bad of ["tabId", "capture_id", "screenshot_out_file", "scope", "target"]) expect(Object.keys(c.args)).not.toContain(bad);
  }
});

// ---- S3 記録 5 項目 ----
test("S3 記録: 面・世代・操作名・値・結果が残る。secure な欄への文字は伏せ、断られた操作も結果に出る。値は 80 字まで", async () => {
  const recs: OpRecord[] = [];
  const L = mk((e) => recs.push(e)); const t = give(L);
  await L.act(t, "click", { x: 5, y: 6 });
  await L.act(t, "get_window_state", {});
  await L.act(t, "type_text", { element_token: "e2", text: "x".repeat(200) });
  await L.act(t, "type_text", { element_token: "e1", text: "hunter2" });
  await L.act(t, "list_windows", {});
  const by = (op: string) => recs.filter((r) => r.op === op);
  expect(recs.every((r) => r.face === "10:1" && r.app === "Calc" && Number.isInteger(r.gen) && r.at > 0)).toBe(true);
  expect(by("type_text")[0]!.value).toHaveLength(80);
  expect(by("type_text")[1]!.value).toBe("〈伏せ〉");
  expect(JSON.stringify(recs)).not.toContain("hunter2");
  expect(by("click")[0]).toMatchObject({ value: '{"x":5,"y":6}', result: "ok" });
  expect(by("list_windows")[0]!.result).toBe("refused:tool");
});

test("S3 記録は ops.jsonl（0600）に 1 行ずつ。記録の失敗は操作に響かない", async () => {
  const L = makeLeases(dir, { driver: fake, defaultMode: "allow", record: () => { throw new Error("disk"); } });
  const g = L.give({ pid: 10, windowId: 1, app: "Calc", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  expect((await L.act(tokenOf(g.lease), "get_window_state", {})).ok).toBe(true);
  expect(existsSync(join(dir, "ops.jsonl"))).toBe(false);
  expect(readFileSync(join(import.meta.dir, "..", "src/main.ts"), "utf8")).toContain('appendOps(join(uiHome(), "ops.jsonl")');
});
