// W60b1（CEO 10-14: 「裏で index を作って agent が同時に同じ画面を触らないようにすればいい」）: 貸す前に空きを見る。1 面 1 持ち主（同じ key）に加えて、ブラウザの窓と tab の重なりも使用中と数える。人に聞く前に断る
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeLeases, type Driver } from "../src/lease.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let dir: string;
beforeEach(() => { dir = mktmp("w60b1"); mkdirSync(join(dir, "l")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const web: Driver = { call: async (tool) => ({ text: "", isError: false, data: tool === "tab_find" ? { tabId: 5, docId: "D5", title: "Canvas", url: "https://school.example/" } : null }), close() {} };
let n = 0;
const mk = () => { const d = join(dir, `l${++n}`); mkdirSync(d); return makeLeases(d, { web, defaultMode: "ask", approvalMs: 500, nameOf: (o) => (o === "s:1" ? "sns" : undefined) }); };
const tab = (tabId: number) => ({ tabId, docId: `D${tabId}`, app: "web", title: "t", url: "https://school.example/" });
const win = (app: string, pid: number) => ({ pid, windowId: 1, app, title: "w" });

test("W60b1 同じ面は 1 つの担当だけ: 別の担当には貸さず、使っている担当の名前で断る・使い終わる（取り戻す）と貸せる", () => {
  const L = mk();
  expect(L.give(tab(5), "s:1").ok).toBe(true);
  const r = L.give(tab(5), "s:2");
  expect(r).toMatchObject({ ok: false }); expect((r as any).why).toContain("「sns」が使っています");
  expect(L.give(tab(5), "s:1").ok).toBe(true); // 同じ担当は更新できる
  L.takeback("tab:5");
  expect(L.give(tab(5), "s:2").ok).toBe(true);
  const w = mk(); w.give(win("Zed", 10), "s:3");
  expect((w.give(win("Zed", 10), "s:4") as any).why).toContain("別の担当が使っています"); // 名前が無ければ「別の担当」
});

test("W60b1 ブラウザの窓を持つ担当が居る間は、その中の tab を別の担当に貸さない・tab を持つ担当が居る間はブラウザの窓も貸さない（同じ画面に窓と tab の 2 つの道で入らない）", () => {
  const L = mk();
  expect(L.give(win("Google Chrome", 20), "s:1").ok).toBe(true);
  expect(L.give(tab(7), "s:2").ok).toBe(false);
  expect(L.give(tab(7), "s:1").ok).toBe(true); // 同じ担当は両方持てる
  const M = mk();
  expect(M.give(tab(8), "s:1").ok).toBe(true);
  expect(M.give(win("Google Chrome", 20), "s:2").ok).toBe(false);
  expect(M.give(win("Safari", 21), "s:2").ok).toBe(false);
  expect(M.give(win("Zed", 22), "s:2").ok).toBe(true); // ブラウザでない app は重ならない
});

test("W60b1 api の tab を借りる時は、人に聞く前に空きを見て断る（許された後で断らない・card は 1 枚も出ない）", async () => {
  const L = mk();
  expect(L.give(tab(5), "s:1").ok).toBe(true);
  const r = await L.apiTab("s:2", "https://school.example");
  expect(r).toMatchObject({ ok: false });
  expect((r as any).hint).toContain("「sns」が使っています");
  expect((r as any).hint).toContain("人に聞く前に断りました");
  expect(L.approvals()).toEqual([]);
});

test("W60b1 同時に 2 つの担当が同じ面を頼んでも、持てるのは 1 つだけ", async () => {
  const L = mk();
  const rs = await Promise.all(["s:1", "s:2", "s:3"].map(async (o) => L.give(win("Zed", 30), o)));
  expect(rs.filter((r) => r.ok)).toHaveLength(1);
});
