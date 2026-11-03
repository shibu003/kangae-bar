// W11d: 人が見ている面を任されたら、人が離れてから書き換える（vision §11-D）。読むだけは待たない
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";

let dir: string;
let calls: { tool: string }[];
const fake = (): Driver => ({
  call: async (tool) => {
    calls.push({ tool });
    return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : tool === "tab_state" ? { exists: true, docId: "d" } : null };
  },
  close() {},
});
const mk = (leaveMs = 60_000) => makeLeases(dir, { driver: fake, web: fake(), defaultMode: "allow", leaveMs });
const A = { pid: 10, windowId: 1, app: "Calc", title: "" };
const T = { tabId: 5, docId: "d", app: "web", title: "t" };
const writes = () => calls.filter((c) => c.tool === "type_text").length;
const tick = () => new Promise((r) => setTimeout(r, 20));
beforeEach(() => { dir = mktmp("w11d"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("UC-d1 相当: 前面の app を任せる → 書き換えは 0 件で待つ → 人が別の app へ移ると始まる", async () => {
  const L = mk();
  L.seeFront(10);
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  expect(g.lease.hold).toBe(true);
  const p = L.act(tokenOf(g.lease), "type_text", { text: "a" });
  await tick();
  expect(writes()).toBe(0);
  expect(L.list()[0]!.waitSince).toBeGreaterThan(0); // 一望の「まだ始めていません」
  L.seeFront(99); // 人が別の app へ
  expect((await p).ok).toBe(true);
  expect(writes()).toBe(1);
  expect(L.list()[0]!.hold).toBeFalsy();
});

test("UC-d2 相当: 読むだけは hold 中でも待たない", async () => {
  const L = mk();
  L.seeFront(10);
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const r = await L.act(tokenOf(g.lease), "get_window_state", {});
  expect(r.ok).toBe(true);
  expect(L.list()[0]!.hold).toBe(true); // 読んでも始めた事にならない
});

test("UC-d3 相当: 人が離れない → 書き換え 0 件のまま waiting（hold は残る・勝手に始めない）", async () => {
  const L = mk(30);
  L.seeFront(10);
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const r = await L.act(tokenOf(g.lease), "type_text", { text: "a" });
  expect(r).toMatchObject({ ok: false, why: "waiting" });
  expect((r as any).hint).toContain("まだ始めていません");
  expect(writes()).toBe(0);
  expect(L.list()[0]!.hold).toBe(true);
});

test("面の上に人が居なければ hold しない（今まで通りすぐ始める）", async () => {
  const L = mk();
  L.seeFront(99);
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  expect(g.lease.hold).toBe(false);
  expect((await L.act(tokenOf(g.lease), "type_text", { text: "a" })).ok).toBe(true);
});

test("hold 中の接触は取り戻さない・始めた後の接触は今まで通り取り戻す", async () => {
  const L = mk();
  L.seeFront(10);
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  expect(L.touch(10)).toBe(0);
  expect(L.list().length).toBe(1);
  L.seeFront(99);
  await L.act(tokenOf(g.lease), "type_text", { text: "a" });
  expect(L.touch(10)).toBe(1);
});

test("③ 最後の入力: 移った後の入力は「居る」・移る前の入力は古い（①② が動いたら離れた）", async () => {
  const L = mk(30);
  L.seeFront(99);
  L.seeInput({ pid: 10 }); // 面に入力した（前面の記録は遅れている）
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  expect(g.lease.hold).toBe(true);
  L.seeFront(98); // 別の app へ移った＝入力は古くなる
  expect((await L.act(tokenOf(g.lease), "type_text", { text: "a" })).ok).toBe(true);
});

test("web の tab: 選択中の tab を任せる → 別の tab / browser 外に移ると始まる", async () => {
  const L = mk();
  const g = L.give(T, "s:1", true);
  if (!g.ok) throw new Error();
  const p = L.act(tokenOf(g.lease), "type_text", { text: "a" });
  await tick();
  expect(writes()).toBe(0);
  expect(L.touchTab(5)).toBe(0); // hold 中の touch は取り戻さない
  L.seeTab(null); // browser が前面でなくなった
  expect((await p).ok).toBe(true);
  expect(writes()).toBe(1);
});

test("待っている間に取り戻されたら実行しない", async () => {
  const L = mk();
  L.seeFront(10);
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const p = L.act(tokenOf(g.lease), "type_text", { text: "a" });
  await tick();
  L.takeback("10:1");
  expect(await p).toMatchObject({ ok: false, why: "gen" });
  expect(writes()).toBe(0);
});

// W49: 定時で起きた会話は、面を任された時に人が居なくても、書く時に人がその面を見ていれば離れるまで待つ（surface.md 7 つの 5）。定時でない会話は今まで通り待たない
test("W49 定時の会話: 任された時は離席・書く時に人が見ている → 離れるまで 0 件で待つ・離れると始まる／定時でない会話は待たない／読むだけは待たない", async () => {
  const sched = new Set<string>(["s:1"]);
  const L = makeLeases(dir, { driver: fake, web: fake(), defaultMode: "allow", leaveMs: 60_000, scheduled: (o) => sched.has(o) });
  const give = (o: string) => { const g = L.give(A, o); if (!g.ok) throw new Error(); return g.lease; };
  L.seeFront(99); // 人は別の app
  const a = give("s:1");
  expect(a.hold).toBeFalsy(); // 任された時は離席＝hold 無し
  L.seeFront(10); // 書く前に、人がこの面を見始めた
  expect((await L.act(tokenOf(a), "get_window_state", {})).ok).toBe(true); // 読むだけは待たない
  const p = L.act(tokenOf(a), "type_text", { text: "a" });
  await tick();
  expect(writes()).toBe(0);
  expect(L.list()[0]!.waitSince).toBeGreaterThan(0);
  L.seeFront(99);
  expect((await p).ok).toBe(true);
  expect(writes()).toBe(1);
  // 定時でない会話は、同じ状況でも待たない（今まで通り）
  L.stopAll();
  calls = [];
  sched.clear();
  L.seeFront(99);
  const b = give("s:2");
  L.seeFront(10);
  expect((await L.act(tokenOf(b), "type_text", { text: "b" })).ok).toBe(true);
  expect(writes()).toBe(1);
});
