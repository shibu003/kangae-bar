// W8e-2 覗き窓: 一望が見えていない時・面が無い時は撮らない／押した時だけ前に出す／撮れない時は絵なしで理由 1 行
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHandler } from "../src/main.ts";
import type { Driver, Surface } from "../src/lease.ts";
import { makePeek, PEEK_BIG_W, PEEK_GRACE_MS, PEEK_W, peekEvery } from "../src/peek.ts";
import { openStore } from "../src/store.ts";
import { readFileSync } from "node:fs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="; // 1x1
const WIN: Surface = { pid: 10, windowId: 7, app: "ScratchPad", title: "的" };
const TAB: Surface = { tabId: 5, docId: "d", app: "web", title: "t" };
function rig(surf: Record<string, Surface>, o: { img?: boolean; cua?: boolean; tabShot?: any } = {}) {
  const log: string[] = [];
  const widths: number[] = [];
  let t = 1000;
  const win: Driver = { call: async (tool) => { log.push(`cua:${tool}`); return { text: o.img === false ? "permission denied" : "", isError: o.img === false, data: null, ...(o.img === false ? {} : { img: { data: PNG, mime: "image/png" } }) }; }, close() {} };
  const web: Driver = { call: async (tool, args) => { log.push(`web:${tool}`); if (tool === "tab_shot") widths.push((args as any).w); return tool === "tab_shot" ? (o.tabShot ?? { text: "", isError: false, data: { jpeg: "QUJD" } }) : { text: "fronted", isError: false, data: null }; }, close() {} };
  const p = makePeek({ surface: (k) => surf[k], win: () => (o.cua === false ? null : win), web: () => web, raise: async () => { log.push("raise"); return { raised: true }; }, now: () => t });
  return { p, log, widths, tick: (ms: number) => (t += ms) };
}

test("一望が見えていない時は撮らない（窓も tab も 0 回）", async () => {
  const { p, log } = rig({ w: WIN, "tab:5": TAB });
  expect(await p.shot("w", false)).toMatchObject({ ok: false });
  expect(await p.shot("tab:5", false)).toMatchObject({ ok: false });
  expect(log).toEqual([]);
});

test("面が渡されていない key は撮らない・前にも出さない", async () => {
  const { p, log } = rig({});
  expect(await p.shot("w", true)).toMatchObject({ ok: false, hint: "絵は出せません: その面はもう agent に渡されていません" });
  expect(await p.front("w")).toMatchObject({ ok: false });
  expect(log).toEqual([]);
});

test("窓: 撮ると縮めた JPEG の data URL・tab: 拡張の jpeg", async () => {
  const { p } = rig({ w: WIN, "tab:5": TAB });
  const w = await p.shot("w", true);
  expect(w.ok && w.img.startsWith("data:image/jpeg;base64,")).toBe(true);
  expect(await p.shot("tab:5", true)).toMatchObject({ ok: true, img: "data:image/jpeg;base64,QUJD" });
});

test("撮れない道は絵なしで理由 1 行（cua-driver 無し・許可なしで画像が返らない・裏の tab）", async () => {
  expect(await rig({ w: WIN }, { cua: false }).p.shot("w", true)).toEqual({ ok: false, hint: "絵は出せません: 画面を操作する部品（cua-driver）が見つかりません。入れ直してください" });
  expect(await rig({ w: WIN }, { img: false }).p.shot("w", true)).toEqual({ ok: false, hint: "絵は出せません: permission denied" });
  const silent: Driver = { call: async () => ({ text: "", isError: false, data: null }), close() {} }; // 許可が無いと cua-driver は error 無しで絵だけ欠ける
  expect(await makePeek({ surface: () => WIN, win: () => silent, web: () => silent, raise: async () => ({ raised: true }) }).shot("w", true)).toMatchObject({ ok: false, hint: expect.stringContaining("「画面収録」で許可されていない") });
  expect(await rig({ "tab:5": TAB }, { tabShot: { text: "その tab は今見えていません（裏の tab は撮れません）", isError: true, data: null } }).p.shot("tab:5", true)).toMatchObject({ ok: false, hint: expect.stringContaining("今見えていません") });
});

test("前に出すのは front() を呼んだ時だけ（撮るだけでは raise / tab_front を呼ばない）", async () => {
  const { p, log } = rig({ w: WIN, "tab:5": TAB });
  await p.shot("w", true); await p.shot("tab:5", true);
  expect(log.filter((x) => x === "raise" || x === "web:tab_front")).toEqual([]);
  expect(await p.front("w")).toEqual({ ok: true });
  expect(await p.front("tab:5")).toEqual({ ok: true });
  expect(log.filter((x) => x === "raise" || x === "web:tab_front")).toEqual(["raise", "web:tab_front"]);
});

test("押した直後だけ「人が触った」を取り戻しにしない（猶予の外は戻る）", async () => {
  const { p, tick } = rig({ w: WIN });
  expect(p.justFronted("w")).toBe(false);
  await p.front("w");
  expect(p.justFronted("w")).toBe(true);
  tick(PEEK_GRACE_MS + 1);
  expect(p.justFronted("w")).toBe(false);
});

// 常駐の口を通す: 押していない時に人が tab に触れば取り戻す（今まで通り）／絵を押した直後の触れは取り戻さない
function handler() {
  const calls: string[] = [];
  const web: Driver = { call: async (tool) => { calls.push(tool); return tool === "tab_info" ? { text: "", isError: false, data: { docId: "d1", title: "t" } } : tool === "tab_shot" ? { text: "", isError: false, data: { jpeg: "QUJD" } } : { text: "ok", isError: false, data: null }; }, close() {} };
  const s = openStore(":memory:");
  const h = makeHandler(s, async () => [], undefined, { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [], spawn: (() => { throw new Error("no"); }) as any, browserUrl: async () => null }, { uiHome: mktmp("kangae-ui"), webDriver: web, leaseDriver: () => null });
  const root = s.add(null, "user", "会話", true);
  return { H: (m: any) => h(m) as Promise<any>, root, calls };
}

test("口: peek は visible の時だけ・絵を押した直後の webEvent は取り戻さず、押さない時の webEvent は取り戻す", async () => {
  const { H, root, calls } = handler();
  await H({ op: "leaseGive", rootId: root.id, tabId: 5, title: "t" });
  calls.length = 0;
  expect(await H({ op: "peek", key: "tab:5", visible: false })).toMatchObject({ ok: false });
  expect(calls).toEqual([]);
  expect(await H({ op: "peek", key: "tab:5", visible: true })).toMatchObject({ ok: true });
  expect(calls).toEqual(["tab_sig", "tab_shot"]); // W8e-5: 先に頁の要約を読み、前回と違う時だけ撮る
  expect(await H({ op: "peekFront", key: "tab:5" })).toMatchObject({ ok: true });
  expect(await H({ op: "webEvent", tabId: 5 })).toMatchObject({ taken: 0 });
  expect((await H({ op: "leaseList" })).leases).toHaveLength(1);
  const b = handler();
  await b.H({ op: "leaseGive", rootId: b.root.id, tabId: 5, title: "t" });
  expect(await b.H({ op: "webEvent", tabId: 5 })).toMatchObject({ taken: 1 }); // 押していなければ今まで通り取り戻す
});

test("F2: fronted は猶予を過ぎると消え、面が無くなっても消える", async () => {
  const surf: Record<string, Surface> = { w: WIN };
  const { p, tick } = rig(surf);
  await p.front("w");
  expect(p.fronts()).toBe(1);
  tick(PEEK_GRACE_MS + 1);
  expect(p.justFronted("w")).toBe(false);
  expect(p.fronts()).toBe(0);
  await p.front("w");
  delete surf.w;
  await p.shot("w", true);
  expect(p.fronts()).toBe(0);
});

// W8e-4 拡げる: 拡げている間だけ短い間隔・閉じたら戻る・見えていない時は 0／大きく撮る／前面は変えない
test("撮る間隔: 拡げている間 2 秒・閉じたら 4 秒・見えていない時は 0（panel.js の timer も同じ値）", () => {
  expect([peekEvery(true, true), peekEvery(false, true), peekEvery(true, false), peekEvery(false, false)]).toEqual([2000, 4000, 0, 0]);
  expect(readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8")).toContain("big ? 2000 : 4000");
});

test("拡げた時は大きい幅で撮る・前に出す口は呼ばない・見えていなければ拡げていても撮らない", async () => {
  const { p, log, widths } = rig({ "tab:5": TAB, w: WIN });
  await p.shot("tab:5", true); await p.shot("tab:5", true, true);
  expect(widths).toEqual([PEEK_W, PEEK_BIG_W]);
  const big = await p.shot("w", true, true);
  expect(big.ok).toBe(true);
  expect(log.filter((x) => x === "raise" || x === "web:tab_front")).toEqual([]);
  log.length = 0;
  expect(await p.shot("tab:5", false, true)).toMatchObject({ ok: false });
  expect(log).toEqual([]);
});

test("口: peek の big が撮る道まで届く", async () => {
  const { H, root } = handler();
  await H({ op: "leaseGive", rootId: root.id, tabId: 5, title: "t" });
  expect(await H({ op: "peek", key: "tab:5", visible: true, big: true })).toMatchObject({ ok: true });
});

// W8e-5 変わった時だけ撮る: 変わらない間は撮らない・変わったら撮る・見えていない時は 0・長く経てば 1 回撮り直す
function rig5() {
  const calls = { cua: 0, tab: 0 };
  const st = { ax: 1, tab: "a" };
  const win: Driver = { call: async () => { calls.cua++; return { text: "", isError: false, data: null, img: { data: PNG, mime: "image/png" } }; }, close() {} };
  const web: Driver = { call: async (tool) => { if (tool === "tab_sig") return { text: "", isError: false, data: { sig: st.tab } }; calls.tab++; return { text: "", isError: false, data: { jpeg: "QUJD" } }; }, close() {} };
  let t = 1000;
  const p = makePeek({ surface: (k) => (k === "w" ? WIN : TAB), win: () => win, web: () => web, raise: async () => ({ raised: true }), read: async () => ({ elements: [{ depth: 0, role: "AXButton", label: `b${st.ax}`, value: "" }] }), now: () => t });
  return { p, calls, st, tick: (ms: number) => (t += ms) };
}

test("窓: AX が変わらない間は撮らない・変わったら撮る・見えていなければ 0", async () => {
  const { p, calls, st, tick } = rig5();
  for (let i = 0; i < 5; i++) { expect((await p.shot("w", true)).ok).toBe(true); tick(4000); }
  expect(calls.cua).toBe(1);
  st.ax = 2;
  await p.shot("w", true);
  expect(calls.cua).toBe(2);
  await p.shot("w", false);
  expect(calls.cua).toBe(2);
  expect(p.stats()).toEqual({ shots: 2, skips: 4 });
});

test("tab: 頁の要約が変わらない間は撮らない・変わったら撮る／長く経っても定期には撮り直さない（peek-lite）", async () => {
  const { p, calls, st, tick } = rig5();
  await p.shot("tab:5", true); await p.shot("tab:5", true); await p.shot("tab:5", true);
  expect(calls.tab).toBe(1);
  st.tab = "b";
  await p.shot("tab:5", true);
  expect(calls.tab).toBe(2);
  tick(10 * 60_000);
  await p.shot("tab:5", true);
  expect(calls.tab).toBe(2); // 10 分経っても、変わっていなければ撮らない
});
