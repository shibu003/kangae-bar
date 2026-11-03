// review26: 今日入った面の通り道（W40・W41・W42a/b・W35c・W39）を、surface.md の境界（ログインを agent に渡さない・読みは貸した面だけ・人が触ると世代で死ぬ）に当てた攻撃
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver, type OpRecord } from "../src/lease.ts";
import { APP_OPS, scriptGate } from "../src/mods.ts";
import { installChrome, load } from "./fake-chrome";

let dir: string, calls: { tool: string; args: Record<string, unknown> }[];
beforeEach(() => { dir = mktmp("r26"); calls = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete (globalThis as any).document; delete (globalThis as any).__kangae; });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const first = async (L: ReturnType<typeof makeLeases>) => { for (let i = 0; i < 300 && !L.approvals().length; i++) await tick(); return L.approvals()[0]!; };

// ---- 攻撃 1（境界: 読みは貸した面だけ）: W41 の read は、貸していない前の Terminal を card 無しで読めた ----
// 自分の実装が落ちる点: 「read は card 無し」が AC だった（W41-1）。人の前の窓には他の会話・ssh・.env の出力が見えうる
test("R26-1 op read: 面を 1 枚も持たない agent が、card 無しで前の Terminal の中身を読めない（許すまで script 0）", async () => {
  const scripts: string[] = [];
  const L = makeLeases(dir, { defaultMode: "allow", approvalMs: 1000, osa: async (s) => { scripts.push(s); return /is running$/.test(s) ? { ok: true, text: "true" } : { ok: true, text: "SECRET=hunter2" }; } });
  const p = L.opRun("s:1", "Terminal", "read-front-tab", {});
  const c = await first(L);
  expect(c).toBeDefined();
  expect(scripts.filter((s) => !/is running$/.test(s))).toEqual([]);
  L.answer(c.id, false);
  expect(await p).toMatchObject({ ok: false, why: "denied" });
  expect(scripts.filter((s) => !/is running$/.test(s))).toEqual([]);
});

// ---- 攻撃 2（境界: 人が触ると世代で死ぬ）: W41 write の card を待つ間に面を取り戻されたら、許されても実行しない ----
test("R26-2 op write: card を待つ間に人が面を取り戻したら、許しても script は 0", async () => {
  const scripts: string[] = [];
  const L = makeLeases(dir, { defaultMode: "ask", approvalMs: 2000, osa: async (s) => { scripts.push(s); return { ok: true, text: /is running$/.test(s) ? "true" : "x" }; }, driver: () => ({ call: async () => ({ text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } }), close() {} }) });
  const g = L.give({ pid: 10, windowId: 1, app: "Calc", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  const p = L.opRun("s:1", "Terminal", "run-in-front-tab", { cmd: "ls" });
  const c = await first(L);
  L.takeback(`10:1`);
  L.answer(c.id, true);
  expect(await p).toMatchObject({ ok: false });
  expect(scripts.filter((s) => !/is running$/.test(s))).toEqual([]);
});

// ---- 攻撃 3: W41 の slot で script の骨格を変える（引用符・逆斜線・行区切りの Unicode・AppleScript の継続記号）----
// 実測（2026-10-13 osascript）: literal の中の U+2028 / U+2029 / U+0085 / ¬ / ¶ は文字のまま（行は切れない）
test("R26-3 op slot: どんな値でも、literal を除いた script の骨格は表の物から 1 文字も変わらない", () => {
  const op = APP_OPS.find((o) => o.name === "run-in-front-tab")!;
  const skeleton = (s: string) => s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const base = skeleton(op.build!({ cmd: "x" }));
  for (const v of ['" & (do shell script "id") & "', '\\"; quit', "a\\", "\\\\\"", " quit", " ", "\u0085", "¬", "¶", '"', "\\", '\\"\\"', "a\" to quit application \"Terminal"]) {
    const s = op.build!({ cmd: v });
    expect(skeleton(s)).toBe(base);
    expect(scriptGate(s)).toBeNull();
  }
});

// ---- 攻撃 4（境界: ログインを渡さない）: W42a の記録に、web の password 欄へ打った文字が平文で残った ----
// 自分の実装が落ちる点: web の password 欄の role は "textbox"（roleOf）で、記録の伏せは role が secure/password の時だけだった
test("R26-4 記録: web の password 欄（role は textbox・secure 印つき）へ type_text した文字は ops.jsonl に残らない", async () => {
  const recs: OpRecord[] = [];
  const web: Driver = { call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "tab_state" ? { exists: true, docId: "D1" } : tool === "tab_info" ? { url: "https://a.test/", docId: "D1" } : tool === "get_window_state" ? { elements: [{ element_token: "d1", role: "textbox", label: "pw", secure: true }, { element_token: "d2", role: "textbox", label: "name" }] } : null }; }, close() {} };
  const L = makeLeases(dir, { web, defaultMode: "allow", record: (e) => recs.push(e) });
  const g = L.give({ tabId: 7, docId: "D1", app: "Chrome", title: "t", url: "https://a.test/" }, "s:1");
  if (!g.ok) throw new Error();
  const t = tokenOf(g.lease);
  await L.act(t, "get_window_state", {});
  await L.act(t, "type_text", { element_token: "d1", text: "hunter2-web" });
  await L.act(t, "type_text", { element_token: "d2", text: "taro" });
  const ty = recs.filter((r) => r.op === "type_text");
  expect(ty[0]!.value).toBe("〈伏せ〉");
  expect(ty[1]!.value).toBe("taro");
  expect(JSON.stringify(recs)).not.toContain("hunter2-web");
});

// ---- 追い（review-press ③）: fill は element_token が無く role を見られないので、欄名が秘密っぽい時・断られた時は値を伏せる ----
test("R26-4b 記録: fill の値は、欄名が password / 断られた時は ops.jsonl に残らない（成功した普通の欄は残る）", async () => {
  const recs: OpRecord[] = [];
  const web: Driver = { call: async (tool, args) => { const pw = tool === "fill" && /pass/i.test(String((args as any).field ?? "")); return { text: pw ? "その欄には入れられません（password）" : "ok", isError: pw, data: tool === "get_window_state" ? { elements: [] } : tool === "tab_state" ? { exists: true, docId: "D2" } : tool === "tab_info" ? { url: "https://a.test/", docId: "D2" } : {} }; }, close: () => {} };
  const L = makeLeases(dir, { web, defaultMode: "allow", record: (e) => recs.push(e) });
  const g = L.give({ tabId: 8, docId: "D2", app: "Chrome", title: "t", url: "https://a.test/" }, "s:1");
  if (!g.ok) throw new Error();
  const t = tokenOf(g.lease);
  await L.act(t, "get_window_state", {});
  await L.act(t, "fill", { field: "password", value: "hunter2-fill" });   // 欄名が秘密っぽい → 伏せ
  await L.act(t, "fill", { field: "お名前", value: "taro-fill" });          // 普通の欄・成功 → 残る
  const fl = recs.filter((r) => r.op === "fill");
  expect(fl[0]!.value).toBe("〈伏せ〉");
  expect(fl[1]!.value).toBe("taro-fill");
  expect(JSON.stringify(recs)).not.toContain("hunter2-fill");
});

// ---- 攻撃 5（境界: 読みは貸した面だけ / 危険語の card）: W42b の press_button は aria-label を見える文字より先に見た ----
// 自分の実装が落ちる点: 頁が <button aria-label="次へ">アカウントを削除</button> と書くと、agent の name「次へ」は危険語に当たらず card 無しで削除が押された
type FE = { tagName: string; type?: string; value: string; innerText: string; attrs: Record<string, string>; clicked: number; getAttribute(n: string): string | null; getClientRects(): unknown[]; click(): void };
const btn = (o: Partial<FE>): FE => ({ tagName: "BUTTON", value: "", innerText: "", attrs: {}, clicked: 0, getAttribute(n) { return this.attrs[n] ?? null; }, getClientRects() { return [1]; }, click() { this.clicked++; }, ...o });
test("R26-5 press_button（W60d で更新）: aria-label の名前でも見つかるが、押す前に button_names が見える文字も返す＝門が両方の名前で危険語を見る（lease の試験は w60d）", async () => {
  installChrome();
  const { namedOp } = await load("web");
  const evil = btn({ innerText: "アカウントを削除", attrs: { "aria-label": "次へ" } });
  const icon = btn({ innerText: "", attrs: { "aria-label": "閉じる" } });
  (globalThis as any).document = { querySelectorAll: () => [evil, icon], hasFocus: () => false };
  (globalThis as any).__kangae = { doc: "D1" };
  const r = namedOp("button_names", { docId: "D1", name: "次へ" });
  expect(r.data.names).toEqual(["アカウントを削除", "次へ"]); // 見える文字が先
  expect(evil.clicked).toBe(0); // 名前を見ただけ・押していない
  expect(namedOp("press_button", { docId: "D1", name: "アカウントを削除" }).error).toBeUndefined(); // 見える名前なら押せる（門の card は agent の name＝この名前で判定される）
  expect(namedOp("press_button", { docId: "D1", name: "閉じる" }).error).toBeUndefined(); // 見える文字が無いアイコンだけは aria-label
});

// ---- 攻撃 6（境界: 人が触ると世代で死ぬ）: 名前つき操作も、取り戻された面には届かない ----
test("R26-6 fill / press_button / select_option: 面を取り戻された後は driver に 1 回も届かない", async () => {
  const web: Driver = { call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "tab_state" ? { exists: true, docId: "D1" } : tool === "tab_info" ? { url: "https://a.test/", docId: "D1" } : null }; }, close() {} };
  const L = makeLeases(dir, { web, defaultMode: "allow" });
  const g = L.give({ tabId: 7, docId: "D1", app: "Chrome", title: "t", url: "https://a.test/" }, "s:1");
  if (!g.ok) throw new Error();
  const t = tokenOf(g.lease);
  L.takeback("tab:7");
  calls = [];
  for (const [tool, a] of [["fill", { field: "x", value: "v" }], ["press_button", { name: "x" }], ["select_option", { field: "x", option: "y" }]] as const) {
    expect((await L.act(t, tool, a)).ok).toBe(false);
  }
  expect(calls.filter((c) => ["fill", "press_button", "select_option"].includes(c.tool))).toEqual([]);
});
