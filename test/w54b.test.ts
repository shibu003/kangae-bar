// W54b-prep: 裏の窓への drag を、自前の小さな注入器（tools/drag-post.swift）で pid 宛てに送る道を、Kangae の門の内側に置く。ここは**偽の注入器**の上の門の test（実 binary の実行・実機は owner の許可が出てから）。
// 門 = 呼べるのは lease の配信だけ・送り先はその会話に貸した窓だけ（pid・窓番号は貸した面から・agent の引数は見ない）・自己確認が通らなければ配らない（cua の拒否のまま止まる）・本物のポインタが動いたら以後止める
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FIELDS, makeDragPost, type DragPost, type DragReq } from "../src/dragpost.ts";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let dir: string, calls: { tool: string; args: Record<string, unknown> }[];
beforeEach(() => { dir = mktmp("w54b"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const src = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");

// 偽の cua: list_windows は貸した窓（pid 10・window 7・画面の (100,200) に 300x200）と、貸していない窓（pid 20・window 9）を返す。drag は上流どおり background_unavailable
const cua = (): Driver => ({
  call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 7, is_on_screen: true, bounds: { x: 100, y: 200, width: 300, height: 200 } }, { pid: 20, window_id: 9, is_on_screen: true, bounds: { x: 0, y: 0, width: 500, height: 500 } }] } };
    if (tool === "drag") return { text: '{"code":"background_unavailable"}', isError: true, data: { code: "background_unavailable" } };
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
const fakePost = (o: { ready?: boolean; moved?: boolean } = {}) => {
  const sent: DragReq[] = []; let ready = o.ready ?? true;
  const dp: DragPost = { ready: () => ready, init: async () => ready, send: async (r) => { sent.push(r); if (o.moved) { ready = false; return { ok: false, pointerMoved: true, text: "本物のポインタが動きました" }; } return { ok: true, text: "dragged" }; } };
  return { dp, sent };
};
const mk = (dp?: DragPost) => { const L: ReturnType<typeof makeLeases> = makeLeases(dir, { driver: cua, defaultMode: "allow", approvalMs: 2000, dragPost: dp, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) }); return L; };
const give = (L: ReturnType<typeof mk>, o = "s:1", pid = 10, win = 7) => { const g = L.give({ pid, windowId: win, app: "Target", title: "" }, o); if (!g.ok) throw new Error(JSON.stringify(g)); return tokenOf(g.lease); };
const args = { from_x: 10, from_y: 20, to_x: 110, to_y: 120 };

test("W54b 門: 自己確認が通っている時、貸した窓へだけ pid 宛てに送る（pid・窓番号は貸した面から・窓内の点は list_windows の窓の位置で画面座標に）・cua の drag は呼ばない", async () => {
  const { dp, sent } = fakePost(); const L = mk(dp);
  const t = give(L);
  const r = await L.act(t, "drag", { ...args, pid: 20, window_id: 9, delivery_mode: "foreground" }); // agent が別の窓・foreground を指しても無視される
  expect(r.ok).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ pid: 10, windowNumber: 7, from: [110, 220], to: [210, 320] });
  expect(calls.filter((c) => c.tool === "drag")).toEqual([]); // cua の drag（拒否される道）は呼ばない
  expect(calls.filter((c) => /front|raise|activate|move_cursor/.test(c.tool))).toEqual([]);
});

test("W54b 貸していない窓へは 0 件: 別の会話の窓・別の pid への drag は、どの経路でも注入器に届かない", async () => {
  const { dp, sent } = fakePost(); const L = mk(dp);
  const a = give(L, "s:1", 10, 7);
  give(L, "s:2", 20, 9);
  await L.act(a, "drag", args);
  expect(sent.map((s) => [s.pid, s.windowNumber])).toEqual([[10, 7]]); // s:1 の drag は s:1 の窓だけ
  const forged = `${a.split("|")[0]}|${a.split("|")[1]}|s:2`; // 相手の持ち主の名前で叩いても
  expect((await L.act(forged, "drag", args)).ok).toBe(false);
  expect(sent).toHaveLength(1);
});

test("W54b 自己確認が通っていない（ready=false）: 注入器は呼ばず、cua の拒否のまま DRAG_HINT（drag 以外の道・draft）で止まる。本物のポインタの道（foreground）には落ちない", async () => {
  const { dp, sent } = fakePost({ ready: false }); const L = mk(dp);
  const r = await L.act(give(L), "drag", args);
  expect(r).toMatchObject({ ok: false, why: "tool" });
  expect((r as any).hint).toContain("kangae draft");
  expect(sent).toEqual([]);
  expect(calls.filter((c) => c.tool === "drag")).toHaveLength(1);
  expect(Object.keys(calls.find((c) => c.tool === "drag")!.args)).not.toContain("delivery_mode");
  // 注入器そのものが無い（opts に無い）時も同じ
  const L2 = makeLeases(mktmp("w54b2"), { driver: cua, defaultMode: "allow" });
  const g = L2.give({ pid: 10, windowId: 7, app: "T", title: "" }, "s:1"); if (!g.ok) throw new Error();
  expect(await L2.act(tokenOf(g.lease), "drag", args)).toMatchObject({ ok: false, why: "tool" });
});

test("W54b 窓の外の点・画面上に無い窓・不正な座標は送らない（注入器 0 件）・送った drag が本物のポインタを動かしたら以後は配らない", async () => {
  const { dp, sent } = fakePost(); const L = mk(dp); const t = give(L);
  for (const bad of [{ from_x: -1, from_y: 5, to_x: 5, to_y: 5 }, { from_x: 5, from_y: 5, to_x: 301, to_y: 5 }, { from_x: 5, from_y: 5, to_x: 5, to_y: 201 }, { from_x: "a", from_y: 5, to_x: 5, to_y: 5 }, {}] as any[])
    expect((await L.act(t, "drag", bad)).ok, JSON.stringify(bad)).toBe(false);
  expect(sent).toEqual([]);
  const m = fakePost({ moved: true }); const L2 = makeLeases(mktmp("w54b3"), { driver: cua, defaultMode: "allow", dragPost: m.dp, onChange: () => queueMicrotask(() => L2.approvals().forEach((a) => L2.answer(a.id, true))) });
  const g = L2.give({ pid: 10, windowId: 7, app: "T", title: "" }, "s:1"); if (!g.ok) throw new Error();
  expect((await L2.act(tokenOf(g.lease), "drag", args)).ok).toBe(false); // ポインタが動いた → 失敗
  expect((await L2.act(tokenOf(g.lease), "drag", args)).ok).toBe(false);
  expect(m.sent).toHaveLength(1); // 2 回目は ready=false で注入器まで行かない
});

test("W54b makeDragPost: 自己確認が ok:true の時だけ ready・落ちる / 答えない / JSON でないなら ready にならず send も断る・本物のポインタが動いた報告で止まる・不正な引数は helper を呼ばない", async () => {
  const ran: string[][] = [];
  const mkRun = (out: string, code = 0) => async (a: string[]) => { ran.push(a); return { code, out }; };
  for (const [out, code] of [['{"ok":false,"why":"x"}', 0], ["not json", 0], ['{"ok":true}', 1], ["", 0]] as const) { const d = makeDragPost({ run: mkRun(out, code) }); expect(await d.init()).toBe(false); expect(d.ready()).toBe(false); expect((await d.send({ pid: 1, windowNumber: 2, from: [0, 0], to: [1, 1] })).ok).toBe(false); }
  ran.length = 0;
  const d = makeDragPost({ run: mkRun('{"ok":true,"pointer":{"before":[1,2],"after":[1,2]}}') });
  expect(await d.init()).toBe(true);
  expect(ran[0]).toEqual(["--selfcheck"]);
  for (const bad of [{ pid: 0, windowNumber: 2 }, { pid: 1.5, windowNumber: 2 }, { pid: 1, windowNumber: -1 }, { pid: 1, windowNumber: 2, from: [NaN, 0] }] as any[]) expect((await d.send({ from: [0, 0], to: [1, 1], ...bad })).ok).toBe(false);
  expect(ran).toHaveLength(1); // 不正な引数では helper を呼んでいない
  expect(await d.send({ pid: 5, windowNumber: 6, from: [1.234, 2], to: [3, 4], steps: 999, durationMs: 99999 })).toMatchObject({ ok: true });
  expect(ran[1]).toEqual(["drag", "5", "6", "1.23", "2", "3", "4", "60", "3000"]); // steps / 時間は上限で切る
  const mv = makeDragPost({ run: async (a) => ({ code: 0, out: a[0] === "--selfcheck" ? '{"ok":true}' : '{"ok":true,"pointer":{"before":[1,2],"after":[9,9]}}' }) });
  await mv.init();
  expect(await mv.send({ pid: 1, windowNumber: 2, from: [0, 0], to: [1, 1] })).toMatchObject({ ok: false, pointerMoved: true });
  expect(mv.ready()).toBe(false);
});

test("W54b 欄の番号は上流 cua と同じ（SOURCES.md §2）で、TS の定数と tools/drag-post.swift の定数が一致する・helper は窓の持ち主と点の範囲を確かめ、前面にする API を呼ばない", () => {
  expect(FIELDS).toEqual({ clickState: 1, buttonNumber: 3, subtype: 7, windowNumber: 51, clickGroup: 58, windowUnderPointer: 91, windowUnderPointerCanHandle: 92, targetPid: 40 });
  const sw = src("tools/drag-post.swift");
  for (const [n, v] of [["F_CLICK_STATE", 1], ["F_BUTTON_NUMBER", 3], ["F_SUBTYPE", 7], ["F_WINDOW_NUMBER", 51], ["F_CLICK_GROUP", 58], ["F_WINDOW_UNDER", 91], ["F_WINDOW_UNDER_CAN_HANDLE", 92], ["F_TARGET_PID", 40]] as const) expect(sw, n).toMatch(new RegExp(`${n}: UInt32 = ${v}\\b`));
  expect(sw).toContain("kCGWindowOwnerPID"); // 窓の持ち主が pid と合うか
  expect(sw).toContain("b.contains(from), b.contains(to)"); // 点が窓の中か
  expect(sw).toContain("SLEventPostToPid");
  expect(sw).not.toMatch(/CGEventPost\(|\.post\(tap|activate\(|NSRunningApplication|SLPSSetFrontProcess|AXRaise/); // 本物の HID への post・前面化の道は持たない
});

test("W54b 配線: lease は cua の drag の前に ready を見て、貸した面（cur）の pid・窓番号だけを渡す。agent の引数（pid / window_id / delivery_mode）は注入器へ渡らない", () => {
  const l = src("src/lease.ts");
  expect(l).toContain('const viaPost = tool === "drag" && !("tabId" in cur) && opts.dragPost?.ready() === true;');
  expect(l).toContain("opts.dragPost!.send({ pid: cur.pid, windowNumber: cur.windowId,");
  const at = l.indexOf("const dragViaPost"), body = l.slice(at, at + 1800);
  expect(body).not.toMatch(/a\.(pid|window_id|delivery_mode)/);
});
