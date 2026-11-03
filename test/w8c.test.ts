import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faceNames, makeLeases, pickLease, tokenOf, type Driver } from "../src/lease.ts";

// W8c: 1 つの会話が面を 2 枚（tab ＋ 窓）持つ。門は面ごと・1 枚だけ取り戻せる・面を指さない act は実行しない
let dir: string, calls: { tool: string; args: Record<string, unknown> }[];
beforeEach(() => { dir = mktmp("w8c"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const drv = (data: (t: string) => unknown): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: data(tool) }; }, close() {} });
const win = drv((t) => (t === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }, { pid: 11, window_id: 2 }] } : null));
const web = drv((t) => (t === "tab_state" ? { exists: true, docId: "d1" } : null));
const mk = (o: Parameters<typeof makeLeases>[1] = {}) => makeLeases(dir, { driver: () => win, web, defaultMode: "allow", ...o });
const W = { pid: 10, windowId: 1, app: "ScratchPad", title: "" }, W2 = { pid: 11, windowId: 2, app: "Other", title: "" };
const T = { tabId: 5, docId: "d1", app: "web", title: "表" }, T2 = { tabId: 6, docId: "d1", app: "web", title: "別" };
// gate_on / gate_off = W8b-2 の WebAuthn の見張りの入れ外し（act ではない）
const acted = () => calls.filter((c) => !["list_windows", "tab_state", "gate_on", "gate_off"].includes(c.tool));

test("2 枚持てる・3 枚目は断る・別の会話の面は取れない", () => {
  const L = mk();
  expect(L.give(T, "s:1").ok).toBe(true);
  expect(L.give(W, "s:1").ok).toBe(true);
  expect(L.give(W2, "s:1")).toMatchObject({ ok: false });
  expect(L.give(W, "s:2")).toMatchObject({ ok: false });
  expect(L.facesOf("s:1").length).toBe(2);
});

test("面ごとの門: tab だけ取り戻すと tab の act は gen で断られ、窓の act は続く・agent は止まらない", async () => {
  const revoked: string[] = [];
  const L = mk({ onRevoke: (o) => { revoked.push(o); } });
  const t = L.give(T, "s:1"), w = L.give(W, "s:1");
  if (!t.ok || !w.ok) throw new Error();
  expect(L.takeback("tab:5")).toBe(true);
  expect(revoked).toEqual([]); // 1 枚残る
  expect(await L.act(tokenOf(t.lease), "type_text", { text: "x" })).toMatchObject({ ok: false, why: "gen" });
  expect(await L.act(tokenOf(w.lease), "type_text", { text: "x" })).toMatchObject({ ok: true });
  expect(acted().map((c) => c.args)).toEqual([{ text: "x", pid: 10, window_id: 1 }]);
  L.takeback("10:1");
  expect(revoked).toEqual(["s:1"]); // 最後の 1 枚で止める
});

test("取り戻した後に面を 1 枚空けると、別の面をもう一度渡せる", () => {
  const L = mk();
  L.give(T, "s:1"); L.give(W, "s:1");
  expect(L.give(T2, "s:1").ok).toBe(false);
  L.takeback("tab:5");
  expect(L.give(T2, "s:1").ok).toBe(true);
});

test("面を指さない act は 2 枚の時だけ実行しない（1 枚なら今まで通り・名前違いも断る）", () => {
  const L = mk();
  const t = L.give(T, "s:1"), w = L.give(W, "s:1");
  if (!t.ok || !w.ok) throw new Error();
  const two = { KANGAE_LEASES: JSON.stringify(faceNames(L.facesOf("s:1"))) };
  expect(Object.keys(faceNames(L.facesOf("s:1")))).toEqual(["tab", "window"]);
  expect(pickLease(two)).toMatchObject({ ok: false });
  expect((pickLease(two) as { hint: string }).hint).toContain("--on tab");
  expect(pickLease(two, "window")).toEqual({ ok: true, token: tokenOf(w.lease) });
  expect(pickLease(two, "tab")).toEqual({ ok: true, token: tokenOf(t.lease) });
  expect(pickLease(two, "memo")).toMatchObject({ ok: false });
  expect(pickLease({ KANGAE_LEASE: "k" })).toEqual({ ok: true, token: "k" });
  expect(pickLease({ KANGAE_LEASES: JSON.stringify({ tab: "k" }) })).toEqual({ ok: true, token: "k" });
});

test("同種が 2 枚なら tab / tab2 と名前が付く", () => {
  const L = mk();
  L.give(T, "s:1"); L.give(T2, "s:1");
  expect(Object.keys(faceNames(L.facesOf("s:1")))).toEqual(["tab", "tab2"]);
});
