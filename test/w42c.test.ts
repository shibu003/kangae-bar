// W42c（docs/design-no-fallback.md S5・既定 off の切り替え）: 人が「名前つき操作だけ」にした tab では、名前つき操作（press_button / fill / select_option）で済む相手への生の click / type_text / set_value を断り、名前つき操作を案内する。
// 既定 off＝今の振る舞いは変わらない。切り替えは人の設定だけ（W39c の cursorOverlay と同じ門）。名前で指せない相手・他の道具・app の窓は断らない（行き止まりを作らない）
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { makeLeases, namedHint, tokenOf, type Driver } from "../src/lease.ts";
import { openStore } from "../src/store.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let top: string, ui: string, nodes: string, calls: { tool: string; args: Record<string, unknown> }[], on: boolean;
beforeEach(() => { top = realpathSync(mktmp("w42c")); ui = join(top, "ui"); nodes = join(top, "nodes"); for (const d of [ui, nodes, join(top, "lease")]) mkdirSync(d); calls = []; on = false; });
afterEach(() => rmSync(top, { recursive: true, force: true }));
const src = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");

// 偽の拡張: tab 5 の木（送信ボタン 1・「戻る」ボタン 2・名前の欄 1・「メモ」欄 2・国の select 1・名前の無いボタン 1・リンク 1）
const ELS = [
  { element_token: "e1", role: "button", label: "送信" }, { element_token: "e2", role: "button", label: "戻る" }, { element_token: "e3", role: "button", label: "戻る" },
  { element_token: "e4", role: "textbox", label: "名前" }, { element_token: "e5", role: "textbox", label: "メモ" }, { element_token: "e6", role: "textbox", label: "メモ" },
  { element_token: "e7", role: "select", label: "国" }, { element_token: "e8", role: "button", label: "" }, { element_token: "e9", role: "link", label: "ヘルプ" },
];
const web = (): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "tab_state" ? { exists: true, docId: "D" } : tool === "tab_info" ? { docId: "D", url: "https://app.example/form" } : tool === "get_window_state" ? { snapshot_id: "s", elements: ELS } : null }; }, close() {} });
const mk = () => { const L: ReturnType<typeof makeLeases> = makeLeases(join(top, "lease"), { web: web(), driver: () => ({ call: async (t, a) => { calls.push({ tool: t, args: a }); return { text: "ok", isError: false, data: t === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }; }, close() {} }), defaultMode: "allow", approvalMs: 3000, namedOnly: () => on, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) }); return L; }; // 「送信」「名前の無い要素」は毎回聞く card が出る＝試験が許す
const tab = (L: ReturnType<typeof mk>) => { const g = L.give({ tabId: 5, docId: "D", app: "web", title: "form", url: "https://app.example/form" }, "s:1"); if (!g.ok) throw new Error(); return tokenOf(g.lease); };
const rawSent = () => calls.filter((c) => ["click", "type_text", "set_value"].includes(c.tool)).length;

test("W42c 既定 off: 生の click / type_text / set_value はそのまま通る（今の振る舞いは変わらない）", async () => {
  const L = mk(); const t = tab(L);
  await L.act(t, "get_window_state", {});
  expect((await L.act(t, "click", { element_token: "e1" })).ok).toBe(true);
  expect((await L.act(t, "type_text", { element_token: "e4", text: "山田" })).ok).toBe(true);
  expect((await L.act(t, "set_value", { element_token: "e7", value: "日本" })).ok).toBe(true);
  expect(rawSent()).toBe(3);
});

test("W42c on: 名前つき操作で済む相手（名前が 1 つの button / textbox / select）への生の操作は断り、その名前つき操作を言う（送信 0）", async () => {
  const L = mk(); const t = tab(L);
  await L.act(t, "get_window_state", {});
  on = true;
  const c = await L.act(t, "click", { element_token: "e1" });
  expect(c).toMatchObject({ ok: false, why: "tool" });
  expect((c as any).hint).toContain("名前つき操作だけ");
  expect((c as any).hint).toContain(`act press_button ${JSON.stringify(JSON.stringify({ name: "送信" }))}`);
  const f = await L.act(t, "type_text", { element_token: "e4", text: "山田" });
  expect((f as any).hint).toContain(`act fill ${JSON.stringify(JSON.stringify({ field: "名前", value: "山田" }))}`);
  const s = await L.act(t, "set_value", { element_token: "e7", value: "日本" });
  expect((s as any).hint).toContain(`act select_option ${JSON.stringify(JSON.stringify({ field: "国", option: "日本" }))}`);
  expect(rawSent()).toBe(0); // 3 つとも driver に届いていない
});

test("W42c on でも断らない物: 名前が 1 つに決まらない・名前の無い・button / textbox / select でない・他の道具・app の窓（行き止まりを作らない）", async () => {
  const L = mk(); const t = tab(L);
  await L.act(t, "get_window_state", {});
  on = true;
  for (const [tool, a] of [["click", { element_token: "e2" }], ["type_text", { element_token: "e5", text: "x" }], ["click", { element_token: "e8" }], ["click", { element_token: "e9" }], ["set_value", { element_token: "e1", value: "x" }], ["press_key", { key: "return" }], ["double_click", { element_token: "e1" }]] as const)
    expect((await L.act(t, tool, a as any)).ok, `${tool} ${JSON.stringify(a)}`).toBe(true);
  // app の窓は断らない（S7 は別の段）
  const g = L.give({ pid: 10, windowId: 1, app: "Zed", title: "" }, "s:2"); if (!g.ok) throw new Error();
  expect((await L.act(tokenOf(g.lease), "click", { x: 3, y: 4 })).ok).toBe(true);
  // 名前つき操作そのものは通る
  expect((await L.act(t, "press_button", { name: "送信" })).ok).toBe(true);
});

test("W42c namedHint（純関数）: stale な要素・名前なし・役割の違いは空・同名が 2 つなら空・JSON の引用符が壊れない", () => {
  const els = { a: { role: "button", label: "A" }, b: { role: "button", label: 'He said "hi"' }, c: { role: "textbox", label: "A" } };
  expect(namedHint("click", {}, { role: "button", label: "A", stale: true }, els)).toBe("");
  expect(namedHint("click", {}, { role: "button", label: "A" }, els)).toContain("press_button");
  expect(namedHint("click", {}, { role: "textbox", label: "A" }, els)).toBe(""); // click は button だけ
  expect(namedHint("type_text", {}, { role: "button", label: "A" }, els)).toBe("");
  const q = namedHint("click", {}, { role: "button", label: 'He said "hi"' }, els);
  expect(JSON.parse(JSON.parse(q.split("press_button ")[1]!))).toEqual({ name: 'He said "hi"' }); // 案内した文字列をそのまま JSON として読める
});

test("W42c 切り替えは人の設定だけ（W39c と同じ門）: 既定 off・agent の CLI・owner つき・真偽でない値は断り、file は変わらない・lease の namedOnly と同じ file", async () => {
  const H: any = makeHandler(openStore(":memory:"), async () => [], undefined, { ...defaultWorkspace(), dir: nodes }, { uiHome: ui, leaseDriver: () => null });
  const f = join(ui, "named-only");
  expect(await H({ op: "namedOnly" }, {})).toMatchObject({ ok: true, on: false });
  expect(await H({ op: "namedOnly", on: true }, { write() {} })).toMatchObject({ ok: false });
  expect(await H({ op: "namedOnly", on: true, owner: "s:1" }, {})).toMatchObject({ ok: false });
  expect(await H({ op: "namedOnly", on: "yes" }, {})).toMatchObject({ ok: false });
  expect(existsSync(f)).toBe(false);
  expect(await H({ op: "namedOnly", on: true }, {})).toMatchObject({ ok: true, on: true });
  expect(existsSync(f)).toBe(true);
  expect(await H({ op: "namedOnly", on: false, owner: "s:1" }, {})).toMatchObject({ ok: false });
  expect(existsSync(f)).toBe(true); // agent は消せない
  expect(await H({ op: "namedOnly", on: false }, {})).toMatchObject({ ok: true, on: false });
  expect(existsSync(f)).toBe(false);
  expect(src("src/main.ts")).toContain('namedOnly: () => existsSync(join(uiHome(), "named-only"))');
});

test("W42c panel: 歯車の中に「tab では名前で指す操作だけ使わせる」（既定は off・内部の語なし）", () => {
  const html = src("extension/panel.html"), js = src("extension/panel.js");
  expect(html).toContain('<kg-toggle id="named-only"');
  expect(html).toContain("tab では名前で指す操作だけ使わせる");
  expect(js).toContain('call("namedOnly", { on: e.detail.on })');
  expect(js).toContain("void loadNamedOnly();");
  expect(html.match(/<kg-toggle id="named-only"[^>]*>[\s\S]*?<\/kg-toggle>/)![0]).not.toMatch(/lease|token|origin|op\b|常駐|操作権/);
});
