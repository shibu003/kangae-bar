// W46（review26 の分岐 3 件・CEO の境界 surface.md）: A 面と面のクリップボードは禁止 / B api call は貸した tab の中だけ / C open_tab の path を絞る
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipKeys, clipMenu, makeLeases, openUrlOf, tokenOf, type Driver } from "../src/lease.ts";

let dir: string, calls: { tool: string; args: Record<string, unknown> }[];
beforeEach(() => { dir = mktmp("w46"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const card = async (L: ReturnType<typeof makeLeases>) => { for (let i = 0; i < 300 && !L.approvals().length; i++) await tick(); return L.approvals()[0]!; };

// ---- A ----
const app: Driver = { call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : tool === "get_window_state" ? { elements: [{ element_token: "m1", role: "AXMenuItem", label: "Paste" }, { element_token: "m2", role: "AXMenuItem", label: "ペーストしてスタイルを合わせる" }, { element_token: "m3", role: "AXMenuItem", label: "Save" }, { element_token: "m4", role: "AXMenuItem", label: "Copy Link" }, { element_token: "t1", role: "AXTextField", label: "Copy of notes" }] } : null }; }, close() {} };
const tabDrv: Driver = { call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "tab_state" ? { exists: true, docId: "D1" } : tool === "tab_info" ? { url: "https://a.test/", docId: "D1" } : null }; }, close() {} };
const sent = () => calls.filter((c) => !["list_windows", "tab_state", "tab_info", "get_window_state"].includes(c.tool));

test("W46-A clipKeys: copy / cut / paste の key の書き方（大文字・別名・'+' 連結・key+modifiers・insert 系）は全部当たり、普通の hotkey は当たらない", () => {
  for (const a of [{ keys: ["cmd", "c"] }, { keys: ["CMD", "X"] }, { keys: ["ctrl", "v"] }, { keys: ["control", "insert"] }, { keys: ["shift", "insert"] }, { keys: ["cmd+c"] }, { keys: ["Command", "V"] }, { key: "v", modifiers: ["cmd"] }, { key: "c", modifier: "super" }, { keys: ["meta", "x"] }]) expect(clipKeys(a)).toBe(true);
  for (const a of [{ keys: ["cmd", "s"] }, { keys: ["shift", "tab"] }, { keys: ["cmd", "a"] }, { keys: ["c"] }, { keys: ["cmd", "shift", "z"] }, {}]) expect(clipKeys(a)).toBe(false);
});

test("W46-A 門: app の面でも tab の面でも、copy / cut / paste の hotkey は断り driver に届かない・普通の hotkey は通る", async () => {
  const L = makeLeases(dir, { driver: () => app, web: tabDrv, defaultMode: "allow", onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) });
  const ga = L.give({ pid: 10, windowId: 1, app: "Pad", title: "" }, "s:1"), gt = L.give({ tabId: 7, docId: "D1", app: "Chrome", title: "t", url: "https://a.test/" }, "s:2");
  if (!ga.ok || !gt.ok) throw new Error();
  for (const t of [tokenOf(ga.lease), tokenOf(gt.lease)]) {
    for (const keys of [["cmd", "c"], ["cmd", "x"], ["cmd", "v"], ["ctrl", "V"], ["shift", "insert"]]) {
      calls = [];
      expect(await L.act(t, "hotkey", { keys })).toMatchObject({ ok: false, why: "tool", hint: expect.stringContaining("クリップボード") });
      expect(sent()).toEqual([]);
    }
  }
  calls = [];
  expect((await L.act(tokenOf(ga.lease), "hotkey", { keys: ["cmd", "s"] })).ok).toBe(true);
  expect(sent().map((c) => c.tool)).toEqual(["hotkey"]);
});

test("W46-A 門: menu の Copy / Cut / Paste（英語・日本語・Paste and Match Style・Copy Link）の click は断る・Save や、menu でない欄の名前に Copy が入っても通る", async () => {
  expect(clipMenu("AXMenuItem", "Paste")).toBe(true);
  expect(clipMenu("AXMenuBarItem", "切り取り")).toBe(true);
  expect(clipMenu("AXTextField", "Paste")).toBe(false);
  const L = makeLeases(dir, { driver: () => app, defaultMode: "allow", onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) });
  const g = L.give({ pid: 10, windowId: 1, app: "Pad", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  const t = tokenOf(g.lease);
  await L.act(t, "get_window_state", {});
  for (const el of ["m1", "m2", "m4"]) {
    calls = [];
    expect(await L.act(t, "click", { element_token: el })).toMatchObject({ ok: false, why: "tool", hint: expect.stringContaining("クリップボード") });
    expect(sent()).toEqual([]);
  }
  for (const el of ["m3", "t1"]) { calls = []; expect((await L.act(t, "click", { element_token: el })).ok).toBe(true); expect(sent().map((c) => c.tool)).toEqual(["click"]); }
});

// ---- C ----
test("W46-C open_tab: path 全体が 256 字超・1 区切りが 64 字超は断る（ちょうどの長さは通る）・card は path をそのまま強調して見せる", async () => {
  const seg = (n: number) => "a".repeat(n);
  expect(openUrlOf(`https://a.test/${seg(64)}`).ok).toBe(true);
  expect(openUrlOf(`https://a.test/${seg(65)}`).ok).toBe(false);
  const p256 = "/" + Array.from({ length: 4 }, () => seg(63)).join("/"); // 1 + 63*4 + 3 = 256
  expect(p256.length).toBe(256);
  expect(openUrlOf(`https://a.test${p256}`).ok).toBe(true);
  expect(openUrlOf(`https://a.test${p256}/x`).ok).toBe(false);
  expect(openUrlOf(`https://a.test/${seg(30)}/${seg(30)}/${seg(30)}/${seg(30)}/${seg(30)}/${seg(30)}/${seg(30)}/${seg(30)}/${seg(30)}`).ok).toBe(false); // 区切りは短くても全体が超える
  expect(openUrlOf(`https://a.test/${"%41".repeat(30)}`).ok).toBe(false); // 符号化で伸びた分も数える（90 字）
  const web: Driver = { call: async (tool, args) => { calls.push({ tool, args }); return { text: "", isError: false, data: tool === "open_tab" ? { tabId: 9, docId: "D9", title: "x", url: "https://a.test/deep/path" } : null }; }, close() {} };
  const L = makeLeases(dir, { web, defaultMode: "ask", approvalMs: 2000 });
  const p = L.openTabFree("s:1", { url: "https://a.test/deep/path" });
  const c = await card(L);
  expect(c.note).toContain("【頁: /deep/path】");
  L.answer(c.id, false);
  await p;
});

// ---- B ----
const NOFACE = "s:1";
const apiWeb = (found: { tabId: number; docId: string; title: string; url: string } | null): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "", isError: false, data: tool === "tab_find" ? found : tool === "gate_on" ? null : null }; }, close() {} });
const SITE = { tabId: 5, docId: "D5", title: "Site", url: "https://site.example/home" };

test("W46-B apiTab: 貸していない site の tab は最初の 1 回だけ card で聞く・許すと面になり以後 card 無し・断ると面は増えず tab_find 以外は何も呼ばない", async () => {
  const L = makeLeases(dir, { web: apiWeb(SITE), defaultMode: "ask", approvalMs: 2000 });
  const p = L.apiTab(NOFACE, "https://site.example");
  const c = await card(L);
  expect(c.tool).toBe("api_tab");
  expect(c.what).toContain("site.example");
  expect(L.facesOf(NOFACE)).toEqual([]); // 許す前は面ではない
  L.answer(c.id, true);
  expect(await p).toEqual({ ok: true, tabId: 5 });
  expect(L.facesOf(NOFACE).map((l) => (l.surface as { tabId: number }).tabId)).toEqual([5]);
  expect(await L.apiTab(NOFACE, "https://site.example")).toEqual({ ok: true, tabId: 5 }); // 2 回目は card 無し
  expect(L.approvals()).toEqual([]);
  // 断る
  const dir2 = join(dir, "second"); mkdirSync(dir2); // 別の会話の表（同じ home だと前の会話が持つ tab は W60b1 で人に聞く前に断られる）
  const L2 = makeLeases(dir2, { web: apiWeb(SITE), defaultMode: "ask", approvalMs: 2000 });
  const q = L2.apiTab("s:2", "https://site.example");
  L2.answer((await card(L2)).id, false);
  expect(await q).toMatchObject({ ok: false });
  expect(L2.facesOf("s:2")).toEqual([]);
});

test("W46-B apiTab: 別の site の貸した tab では代用しない・別の会話の面は使えない・tab が無ければ card も出さずに断る・面が MAX_FACES なら借りない", async () => {
  const L = makeLeases(dir, { web: apiWeb(null), defaultMode: "ask", approvalMs: 500 });
  const g = L.give({ tabId: 1, docId: "d", app: "web", title: "o", url: "https://other.example/" }, NOFACE);
  if (!g.ok) throw new Error();
  const r = await L.apiTab(NOFACE, "https://site.example");
  expect(r).toMatchObject({ ok: false, hint: expect.stringContaining("開いている tab がありません") }); // other.example の面を使わず、card も出ない
  expect(L.approvals()).toEqual([]);
  // 別の会話が持つ面
  const g2 = L.give({ tabId: 2, docId: "d", app: "web", title: "s", url: "https://site.example/x" }, "s:9");
  if (!g2.ok) throw new Error();
  expect((await L.apiTab(NOFACE, "https://site.example")).ok).toBe(false);
  // 面が満杯
  const L3 = makeLeases(join(dir), { web: apiWeb(SITE), defaultMode: "ask", approvalMs: 500 });
  L3.give({ tabId: 11, docId: "d", app: "web", title: "a", url: "https://a.example/" }, "s:3");
  L3.give({ tabId: 12, docId: "d", app: "web", title: "b", url: "https://b.example/" }, "s:3");
  expect(await L3.apiTab("s:3", "https://site.example")).toMatchObject({ ok: false, hint: expect.stringContaining("面を 2 枚") });
  expect(L3.approvals()).toEqual([]);
});

test("W46-B 取り戻されたら貸した tab は使えない（世代で死ぬ）: 面を取り戻した後の apiTab は、また card から", async () => {
  const L = makeLeases(dir, { web: apiWeb(SITE), defaultMode: "ask", approvalMs: 2000 });
  const p = L.apiTab(NOFACE, "https://site.example");
  L.answer((await card(L)).id, true);
  await p;
  L.takeback("tab:5");
  const q = L.apiTab(NOFACE, "https://site.example");
  const c = await card(L);
  expect(c.tool).toBe("api_tab");
  L.answer(c.id, false);
  await q;
});
