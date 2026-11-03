// review2: W8c / W8e-2 / W8g-3 の破れを凍結する攻撃 test
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shapeHistory } from "../src/carry.ts";
import { makeHandler } from "../src/main.ts";
import { makeLeases, pickLease, tokenOf, type Driver } from "../src/lease.ts";
import { openStore } from "../src/store.ts";

let dir: string, ran: { tool: string; args: Record<string, unknown> }[];
beforeEach(() => { dir = mktmp("rv2"); ran = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const drv: Driver = { call: async (tool, args) => { ran.push({ tool, args }); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }, { pid: 10, window_id: 2 }, { pid: 11, window_id: 3 }] } : tool === "tab_state" ? { exists: true, docId: "d1" } : null }; }, close() {} };
const mk = (o: Parameters<typeof makeLeases>[1] = {}) => makeLeases(dir, { driver: () => drv, web: drv, defaultMode: "allow", ...o });
const W1 = { pid: 10, windowId: 1, app: "Notes", title: "" }, W2 = { pid: 10, windowId: 2, app: "Notes", title: "" };
const T = { tabId: 5, docId: "d1", app: "web", title: "表" }, W3 = { pid: 11, windowId: 3, app: "Pad", title: "" };

test("--on に Object の既定の名前（constructor / __proto__）を渡しても面として通らない", () => {
  const env = { KANGAE_LEASES: JSON.stringify({ tab: "t|1|s:1", window: "w|1|s:1" }) };
  for (const n of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(pickLease(env, n)).toMatchObject({ ok: false });
});

test("stopAll で 2 枚とも外れても agent を止める呼びは 1 回", () => {
  const revoked: string[] = [];
  const L = mk({ onRevoke: (o) => { revoked.push(o); } });
  L.give(T, "s:1"); L.give(W3, "s:1");
  expect(L.stopAll()).toBe(2);
  expect(revoked).toEqual(["s:1"]);
});

test("touch(pid): 絵を押した窓だけ見逃し、同じ app の別の窓は取り戻す", () => {
  const L = mk();
  L.give(W1, "s:1"); L.give(W2, "s:1");
  expect(L.touch(10, (k) => k === "10:1")).toBe(1);
  expect(L.facesOf("s:1").map((l) => l.surface)).toEqual([W1]);
});

test("undo は最後に操作した面から・その面が空なら前の面へ", async () => {
  const L = mk();
  const t = L.give(T, "s:1"), w = L.give(W3, "s:1");
  if (!t.ok || !w.ok) throw new Error();
  await L.act(tokenOf(t.lease), "type_text", { text: "ab" });
  await L.act(tokenOf(w.lease), "type_text", { text: "c" });
  ran.length = 0;
  expect(await L.undo("s:1")).toMatchObject({ ok: true });
  const acts = () => ran.filter((c) => !["list_windows", "tab_state"].includes(c.tool));
  expect(acts().length > 0 && acts().every((c) => c.args.pid === 11)).toBe(true); // 窓（Pad）の 1 文字
  ran.length = 0;
  expect(await L.undo("s:1")).toMatchObject({ ok: true });
  expect(acts().some((c) => c.args.tabId === 5)).toBe(true);
});

test("履歴: 偽装 host・userinfo・port・query を通さない", () => {
  const v = shapeHistory([
    { url: "https://evilexample.com/a", title: "x" },
    { url: "https://example.com.evil.com/a", title: "x" },
    { url: "https://u:p@example.com/a", title: "x" },
    { url: "javascript://example.com/%0aalert(1)", title: "x" },
    { url: "https://a.example.com:8443/p?token=S#f", title: "ok" },
  ], "example.com");
  expect(v).toEqual([{ url: "https://a.example.com:8443/p", title: "ok" }]);
});

// 常駐の口: 絵を押した直後でも、頁の中の人の入力（input）は取り戻す
function handler() {
  const web: Driver = { call: async (tool) => ({ text: "ok", isError: false, data: tool === "tab_info" ? { docId: "d1", title: "t" } : null }), close() {} };
  const s = openStore(":memory:");
  const h = makeHandler(s, async () => [], undefined, { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [], spawn: (() => { throw new Error("no"); }) as any, browserUrl: async () => null }, { uiHome: mktmp("kangae-ui"), webDriver: web, leaseDriver: () => null });
  return { H: (m: any) => h(m) as Promise<any>, root: s.add(null, "user", "会話", true) };
}
test("絵を押した直後の『前面にした』は見逃し、頁の中の人の入力は取り戻す", async () => {
  const { H, root } = handler();
  await H({ op: "leaseGive", rootId: root.id, tabId: 5, title: "t" });
  await H({ op: "peekFront", key: "tab:5" });
  expect(await H({ op: "webEvent", tabId: 5 })).toMatchObject({ taken: 0 });
  expect(await H({ op: "webEvent", tabId: 5, input: true })).toMatchObject({ taken: 1 });
});

test("undo の面の順は時刻でなく連番: 時計が止まっていても最後に操作した面から（holes-22）", async () => {
  const L = makeLeases(dir, { driver: () => drv, web: drv, defaultMode: "allow", now: () => 1000 });
  const t = L.give(T, "s:1"), w = L.give(W3, "s:1");
  if (!t.ok || !w.ok) throw new Error();
  await L.act(tokenOf(t.lease), "type_text", { text: "ab" });
  await L.act(tokenOf(w.lease), "type_text", { text: "c" });
  ran.length = 0;
  await L.undo("s:1");
  expect(ran.some((c) => c.args.pid === 11)).toBe(true);
});
