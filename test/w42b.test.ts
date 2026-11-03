// W42b（docs/design-no-fallback.md S4）: tab 面の名前つき DOM 操作（fill / press_button / select_option）。既存の click / type_text は外さない
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED, makeLeases, NAMED, tokenOf, type Driver } from "../src/lease.ts";
import { installChrome, load } from "./fake-chrome";

// ---- 偽の DOM（namedOp が使う口だけ）----
type FE = { tagName: string; type?: string; id?: string; value: string; innerText: string; disabled?: boolean; readOnly?: boolean; isContentEditable?: boolean; attrs: Record<string, string>; labels?: { innerText: string }[]; options?: { text: string; value: string }[]; visible: boolean; clicked: number; events: string[]; focused: boolean; getAttribute(n: string): string | null; getClientRects(): unknown[]; click(): void; focus(): void; dispatchEvent(e: { type: string }): void };
const fe = (o: Partial<FE> & { tagName: string }): FE => ({ value: "", innerText: "", attrs: {}, visible: true, clicked: 0, events: [], focused: false, getAttribute(n) { return this.attrs[n] ?? null; }, getClientRects() { return this.visible ? [1] : []; }, click() { this.clicked++; }, focus() { this.focused = true; }, dispatchEvent(e) { this.events.push(e.type); }, ...o });
let dom: FE[];
const install = (els: FE[], doc = "D1") => {
  dom = els;
  (globalThis as any).document = { querySelectorAll: () => dom, execCommand: () => true };
  (globalThis as any).Event = class { type: string; constructor(t: string) { this.type = t; } };
  (globalThis as any).__kangae = { doc };
};
afterEach(() => { delete (globalThis as any).document; delete (globalThis as any).__kangae; });

installChrome();
const { namedOp } = await load("web"); // namedOp は純粋（chrome を使わない）。web.js の import に偽の chrome が要る
const A = { docId: "D1" };

test("S4 fill: 見える名前（label / aria-label / placeholder）で 1 つに決まる時だけ入れる。値は返事に載せない", () => {
  const to = fe({ tagName: "INPUT", type: "text", labels: [{ innerText: "宛先" }] });
  const memo = fe({ tagName: "TEXTAREA", attrs: { placeholder: "メモ" } });
  install([to, memo]);
  const r = namedOp("fill", { ...A, field: " 宛先 ", value: "SECRET-ADDR" });
  expect(r.error).toBeUndefined();
  expect(to.value).toBe("SECRET-ADDR");
  expect(to.events).toEqual(["input", "change"]);
  expect(JSON.stringify(r)).not.toContain("SECRET-ADDR");
  expect(namedOp("fill", { ...A, field: "メモ", value: "x" }).error).toBeUndefined();
  expect(memo.value).toBe("x");
});

test("S4 推測しない: 名前が無い・同名が複数・見えない・無効・読み取り専用は何も変えず断る（候補の名前は返す）", () => {
  const a = fe({ tagName: "INPUT", type: "text", attrs: { "aria-label": "名前" } });
  const b = fe({ tagName: "INPUT", type: "text", attrs: { "aria-label": "名前" } });
  const hidden = fe({ tagName: "INPUT", type: "text", attrs: { "aria-label": "裏" }, visible: false });
  const off = fe({ tagName: "INPUT", type: "text", attrs: { "aria-label": "無効" }, disabled: true });
  const ro = fe({ tagName: "INPUT", type: "text", attrs: { "aria-label": "固定" }, readOnly: true });
  install([a, b, hidden, off, ro]);
  const dup = namedOp("fill", { ...A, field: "名前", value: "v" });
  expect(dup.error).toBe(true); expect(dup.text).toContain("2 個");
  const none = namedOp("fill", { ...A, field: "存在しない", value: "v" });
  expect(none.error).toBe(true); expect(none.text).toContain("見える名前");
  expect(none.text).not.toContain("裏"); // 見えない欄の名前は出さない
  expect(namedOp("fill", { ...A, field: "裏", value: "v" }).error).toBe(true);
  expect(namedOp("fill", { ...A, field: "無効", value: "v" }).error).toBe(true);
  expect(namedOp("fill", { ...A, field: "固定", value: "v" }).error).toBe(true);
  expect(namedOp("fill", { ...A, field: "", value: "v" }).error).toBe(true);
  expect([a, b, hidden, off, ro].map((e) => e.value)).toEqual(["", "", "", "", ""]);
});

test("S4 password 欄・確認コード欄・チェック類には fill で入れない（金庫の注入と人の確認だけ）", () => {
  const pw = fe({ tagName: "INPUT", type: "password", attrs: { "aria-label": "パスワード" } });
  const otp = fe({ tagName: "INPUT", type: "text", attrs: { "aria-label": "コード", autocomplete: "one-time-code" } });
  const cb = fe({ tagName: "INPUT", type: "checkbox", attrs: { "aria-label": "同意" } });
  install([pw, otp, cb]);
  expect(namedOp("fill", { ...A, field: "パスワード", value: "hunter2" }).error).toBe(true);
  expect(namedOp("fill", { ...A, field: "コード", value: "123456" }).error).toBe(true);
  expect(namedOp("fill", { ...A, field: "同意", value: "x" }).error).toBe(true);
  expect([pw.value, otp.value, cb.value]).toEqual(["", "", ""]);
});

test("S4 press_button: 見える名前（innerText / aria-label / submit の value）で 1 つに決まる時だけ押す・欄は押せない", () => {
  const save = fe({ tagName: "BUTTON", innerText: "保存" });
  const send = fe({ tagName: "INPUT", type: "submit", value: "送信" });
  const field = fe({ tagName: "INPUT", type: "text", attrs: { "aria-label": "保存" } });
  install([save, send, field]);
  expect(namedOp("press_button", { ...A, name: "保存" }).error).toBeUndefined();
  expect(save.clicked).toBe(1); expect(field.clicked).toBe(0);
  expect(namedOp("press_button", { ...A, name: "送信" }).error).toBeUndefined();
  expect(send.clicked).toBe(1);
  expect(namedOp("press_button", { ...A, name: "消す" }).error).toBe(true);
});

test("S4 select_option: 選択肢の見える名前か value が 1 つに決まる時だけ選ぶ", () => {
  const sel = fe({ tagName: "SELECT", attrs: { "aria-label": "支払い" }, options: [{ text: "カード", value: "card" }, { text: "振込", value: "bank" }] });
  install([sel]);
  expect(namedOp("select_option", { ...A, field: "支払い", option: "振込" }).error).toBeUndefined();
  expect(sel.value).toBe("bank");
  expect(sel.events).toEqual(["input", "change"]);
  const bad = namedOp("select_option", { ...A, field: "支払い", option: "現金" });
  expect(bad.error).toBe(true); expect(bad.text).toContain("カード");
  expect(sel.value).toBe("bank");
});

test("S4 文書が替わっていたら（docId 不一致・印なし）何もしない", () => {
  const b = fe({ tagName: "BUTTON", innerText: "保存" });
  install([b]);
  expect(namedOp("press_button", { docId: "OTHER", name: "保存" }).error).toBe(true);
  delete (globalThis as any).__kangae;
  expect(namedOp("press_button", { ...A, name: "保存" }).error).toBe(true);
  expect(b.clicked).toBe(0);
});

// ---- 拡張の道（webRun）----
test("S4 webRun: 名前つき操作は namedOp で走り（page ではない）、gen の古い物は executeScript の前に断る", async () => {
  const c = installChrome();
  const { webRun } = await load("web");
  await webRun("gate_off", { tabId: 1, minGen: 5 });
  const before = c.calls.length;
  expect((await webRun("press_button", { tabId: 1, docId: "d", name: "保存", gen: 4 })).error).toBe(true);
  expect(c.calls.length).toBe(before); // 何も送っていない
  expect((await webRun("press_button", { tabId: 1, docId: "d", name: "保存", gen: 5 })).error).toBe(false);
  expect(c.calls.filter((x) => x.fn === "namedOp").map((x) => x.args[0])).toEqual(["press_button"]);
  expect(c.calls.some((x) => x.fn === "page" && x.args[0] === "press_button")).toBe(false);
  expect((await webRun("fill", { tabId: 1, docId: "d", field: "x", value: "v", gen: 5 })).error).toBe(false);
  expect(c.calls.filter((x) => x.fn === "namedOp").map((x) => x.args[0])).toEqual(["press_button", "fill"]);
});

// ---- 門 ----
let dir: string, calls: { tool: string; args: Record<string, unknown> }[];
const web = (): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "tab_state" ? { exists: true, docId: "D1" } : tool === "tab_info" ? { url: "https://a.test/", docId: "D1" } : tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }; }, close() {} });
beforeEach(() => { dir = mktmp("w42b"); calls = []; });
afterEach2();
function afterEach2() { afterEach(() => rmSync(dir, { recursive: true, force: true })); }
const mkL = () => { const L: ReturnType<typeof makeLeases> = makeLeases(dir, { web: web(), driver: () => web(), defaultMode: "allow", onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) }); return L; };
const tabLease = (L: ReturnType<typeof mkL>) => { const g = L.give({ tabId: 7, docId: "D1", app: "Chrome", title: "t", url: "https://a.test/" }, "s:1"); if (!g.ok) throw new Error(); return tokenOf(g.lease); };

test("S4 門: 3 つは ALLOWED に在り、既存の click / type_text もまだ在る（外すのは S5）", () => {
  for (const t of NAMED) expect(ALLOWED).toContain(t);
  for (const t of ["click", "type_text", "set_value"]) expect(ALLOWED).toContain(t);
});

test("S4 門: tab の面では通り、敵対的な欄（tabId・selector・script）は捨てられて拡張に届く欄は名前と値だけ", async () => {
  const L = mkL(); const t = tabLease(L);
  const r = await L.act(t, "fill", { field: "宛先", value: "v", tabId: 99, selector: "#x", script: "alert(1)", element_token: "d1" });
  expect(r.ok).toBe(true);
  const c = calls.find((x) => x.tool === "fill")!;
  expect(c.args).toMatchObject({ field: "宛先", value: "v", tabId: 7, docId: "D1" });
  expect(Object.keys(c.args)).not.toContain("selector");
  expect(Object.keys(c.args)).not.toContain("script");
});

test("S4 門: app の窓の面では名前つき操作を断る（driver 0 回）", async () => {
  const L = makeLeases(dir, { driver: () => web(), defaultMode: "allow" });
  const g = L.give({ pid: 10, windowId: 1, app: "Calc", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  for (const tool of NAMED) { calls = []; const r = await L.act(tokenOf(g.lease), tool, { field: "a", name: "a" }); expect(r.ok).toBe(false); expect(calls.filter((c) => c.tool === tool)).toEqual([]); }
});

test("S4 門: press_button は名前そのものを危険語の判定に使う（「削除」「送信」は card を挟む・無害な名前は挟まない）", async () => {
  let asked = 0;
  const L: ReturnType<typeof makeLeases> = makeLeases(dir, { web: web(), defaultMode: "allow", onChange: () => queueMicrotask(() => L.approvals().forEach((a) => { asked++; L.answer(a.id, true); })) });
  const t = tabLease(L);
  await L.act(t, "press_button", { name: "次へ" });
  expect(asked).toBe(0);
  await L.act(t, "press_button", { name: "アカウントを削除" });
  expect(asked).toBeGreaterThan(0);
});
