// review3（W11 module review）: AC の外を破りに行く攻撃。W11b 資源 / W11c 取り戻し / W11d hold / W11f 結果不明 が act の 1 か所で重なる所
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";

let dir: string;
let calls: string[];
let mode: "ok" | "throw" = "ok";
const fake = (): Driver => ({
  call: async (tool) => {
    calls.push(tool);
    if (mode === "throw" && tool === "type_text") throw new Error("pipe closed");
    return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null };
  },
  close() {},
});
const mk = (leaveMs = 60_000) => makeLeases(dir, { driver: fake, web: fake(), defaultMode: "allow", leaveMs });
const A = { pid: 10, windowId: 1, app: "Calc", title: "" };
const tick = () => new Promise((r) => setTimeout(r, 20));
beforeEach(() => { dir = mktmp("review3"); calls = []; mode = "ok"; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("攻撃1 hold 中に人が操作した面: 離れた後の最初の書き換えは送らず、読み直させる（古い木の token を押さない）", async () => {
  const L = mk();
  L.seeFront(10);
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const p = L.act(tokenOf(g.lease), "type_text", { text: "a" });
  await tick();
  L.seeInput({ pid: 10 }); // 人が held の窓の中を押した（取り戻しは hold 中は起きない）
  L.seeFront(99); // 離れた
  const r = await p;
  expect(r).toMatchObject({ ok: false, why: "result" });
  expect(calls.filter((c) => c === "type_text")).toHaveLength(0);
  expect((await L.act(tokenOf(g.lease), "type_text", { text: "a" })).ok).toBe(false); // 読むまで書けない
  await L.act(tokenOf(g.lease), "get_window_state", {});
  expect(calls.includes("get_window_state")).toBe(true);
});

test("攻撃2 driver が throw しても sentOf が残らず、結果不明として止まる（次の書き換えを門が止める）", async () => {
  const L = mk();
  const g = L.give(A, "s:1", false);
  if (!g.ok) throw new Error();
  mode = "throw";
  const r = await L.act(tokenOf(g.lease), "type_text", { text: "a" });
  expect(r).toMatchObject({ ok: false, why: "result" });
  mode = "ok";
  expect((await L.act(tokenOf(g.lease), "type_text", { text: "b" })).ok).toBe(false);
});

test("攻撃3 hold の待ち中に取り戻された: 何も送っていないので 結果を確認中 に入らない", async () => {
  const L = mk();
  L.seeFront(10);
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const p = L.act(tokenOf(g.lease), "type_text", { text: "a" });
  await tick();
  L.takeback(tokenOf(g.lease).split("|")[0]!);
  const r = await p;
  expect(r.ok).toBe(false);
  expect(calls.filter((c) => c === "type_text")).toHaveLength(0);
  expect(L.recoveries().every((x) => x.phase !== "verifying" && x.sent === 0)).toBe(true);
});

// W11fix F2: webSeen / humanSeen は webHello / humanHello した口からだけ（外すと赤）
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
test("F2 webSeen / humanSeen: hello していない口は捨てる・した口は受ける", async () => {
  const h = makeHandler(openStore(":memory:"), async () => [], undefined, undefined, { isExtension: () => true });
  const ext = {}, bar = {}, fake = {};
  await h({ op: "webHello" }, ext);
  await h({ op: "humanHello" }, bar);
  expect(await h({ op: "webSeen", tab: 1 }, fake)).toMatchObject({ ok: false });
  expect(await h({ op: "humanSeen", kind: "front", pid: 1 }, fake)).toMatchObject({ ok: false });
  expect(await h({ op: "humanSeen", kind: "front", pid: 1 }, ext)).toMatchObject({ ok: false }); // 拡張は bar ではない
  expect(await h({ op: "webSeen", tab: 1 }, ext)).toMatchObject({ ok: true });
  expect(await h({ op: "humanSeen", kind: "front", pid: 1 }, bar)).toMatchObject({ ok: true });
});
