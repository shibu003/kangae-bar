// W60d: press_button は「見える文字」でも「aria-label」でも、1 つに決まれば押せる。ただし押す前に門（lease）が両方の名前で危険語を見る（review26: aria-label は頁が自由に付けられる）
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { installChrome, load } from "./fake-chrome";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

type B = { tagName: string; type?: string; value: string; innerText: string; attrs: Record<string, string>; clicked: number; getAttribute(n: string): string | null; getClientRects(): number[]; click(): void; disabled?: boolean };
const btn = (text: string, aria?: string): B => ({ tagName: "BUTTON", value: "", innerText: text, attrs: aria ? { "aria-label": aria } : {}, clicked: 0, getAttribute(n) { return this.attrs[n] ?? null; }, getClientRects: () => [1], click() { this.clicked++; } });
installChrome();
const { namedOp } = await load("web");
let dir: string, dom: B[], calls: string[];
beforeEach(() => { dir = mktmp("w60d"); mkdirSync(join(dir, "l")); calls = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete (globalThis as any).document; delete (globalThis as any).__kangae; });
const install = (els: B[]) => { dom = els; (globalThis as any).document = { querySelectorAll: () => dom, hasFocus: () => false }; (globalThis as any).__kangae = { doc: "D" }; };
// 偽の拡張: 本物の namedOp を、偽の DOM の上で動かす（lease → driver → namedOp の通し）
const web = (): Driver => ({ call: async (tool, args) => {
  calls.push(tool);
  if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: "D" } };
  if (tool === "tab_info") return { text: "", isError: false, data: { docId: "D", url: "https://app.example/" } };
  if (tool === "press_button" || tool === "button_names") { const r: any = namedOp(tool, { ...args, docId: "D" }); return { text: r.text ?? "", isError: !!r.error, data: r.data ?? null }; }
  return { text: "ok", isError: false, data: null };
}, close() {} });
const mk = (answer: boolean | null) => { const L: ReturnType<typeof makeLeases> = makeLeases(join(dir, "l"), { web: web(), driver: () => web(), defaultMode: "allow", approvalMs: 3000, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => { seen.push(a); if (answer !== null) L.answer(a.id, answer); })) }); return L; };
let seen: any[] = [];
beforeEach(() => { seen = []; });
const tab = (L: ReturnType<typeof mk>) => { const g = L.give({ tabId: 5, docId: "D", app: "web", title: "t", url: "https://app.example/" }, "s:1"); if (!g.ok) throw new Error(); return tokenOf(g.lease); };

test("W60d aria-label と見える文字が違う無害なボタン（保存 / Save changes）: どちらの名前でも押せる", async () => {
  const b = btn("保存", "Save changes"); install([b, btn("戻る")]);
  const L = mk(true); const t = tab(L);
  expect((await L.act(t, "press_button", { name: "Save changes" })).ok).toBe(true);
  expect((await L.act(t, "press_button", { name: "保存" })).ok).toBe(true);
  expect(b.clicked).toBe(2);
  expect(seen).toEqual([]); // 無害なので card なし
});

test("W60d 見える文字が危険語（アカウントを削除）で aria-label が無害（次へ）: 「次へ」で頼んでも card が出て、断れば押さない・許せば押す", async () => {
  const evil = btn("アカウントを削除", "次へ"); install([evil]);
  const no = mk(false); const r = await no.act(tab(no), "press_button", { name: "次へ" });
  expect(r).toMatchObject({ ok: false, why: "denied" });
  expect(evil.clicked).toBe(0);
  expect(seen[0].what).toContain("アカウントを削除"); // card に見える文字が出る
  const yes = mk(true); expect((await yes.act(tab(yes), "press_button", { name: "次へ" })).ok).toBe(true);
  expect(evil.clicked).toBe(1);
});

test("W60d 1 つに決まらない・見つからない: card の前に候補を返して押さない（見える文字の候補）", async () => {
  const a = btn("次へ"), b = btn("確認", "次へ"); install([a, b]);
  const L = mk(true); const t = tab(L);
  const r = await L.act(t, "press_button", { name: "次へ" });
  expect(r).toMatchObject({ ok: false, why: "tool" });
  expect((r as any).hint).toContain("2 個");
  const n = await L.act(t, "press_button", { name: "存在しない" });
  expect((n as any).hint).toContain("見つかりません");
  expect(a.clicked + b.clicked).toBe(0);
  expect(seen).toEqual([]);
});

test("W60d 確かめてから押すまでの間に頁が替わった（同じ aria-label の別のボタン）: expect が合わず押さない", () => {
  const b = btn("保存", "操作"); install([b]);
  const names = (namedOp("button_names", { docId: "D", name: "操作" }) as any).data.names;
  b.innerText = "アカウントを削除"; // 見た後で見える文字が替わった
  const r = namedOp("press_button", { docId: "D", name: "操作", expect: names }) as any;
  expect(r.error).toBe(true);
  expect(b.clicked).toBe(0);
  expect((namedOp("press_button", { docId: "D", name: "操作", expect: ["アカウントを削除", "操作"] }) as any).error).toBeUndefined();
});

test("W60d 古い拡張（button_names を知らず何も返さない）: 名前だけで見る今までの道・押す前の確認は出ない（試験の偽の拡張の外では押さない呼びが 1 回増えるだけ）", async () => {
  const b = btn("保存"); install([b]);
  const old: Driver = { call: async (tool) => tool === "button_names" ? { text: "", isError: false, data: null } : web().call(tool, { name: "保存" }), close() {} };
  const L = makeLeases(join(dir, "l"), { web: old, driver: () => old, defaultMode: "allow" });
  const g = L.give({ tabId: 5, docId: "D", app: "web", title: "t", url: "https://app.example/" }, "s:1"); if (!g.ok) throw new Error();
  expect((await L.act(tokenOf(g.lease), "press_button", { name: "保存" })).ok).toBe(true);
  expect(b.clicked).toBe(1);
});
