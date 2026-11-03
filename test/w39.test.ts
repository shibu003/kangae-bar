// W39（改訂）: 製品は人の本物のカーソルを動かす道を持たない事の検査。(1) 門の一本道（lease.ts の act → driver.call）に、ポインタを動かす旗・道具が届かない (2) 製品の source に、本物のポインタを動かす語が無い
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED, makeLeases, tokenOf, type Driver } from "../src/lease.ts";

let dir: string, calls: { tool: string; args: Record<string, unknown> }[];
const fake = (): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }; }, close() {} });
beforeEach(() => { dir = mktmp("w39"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const HOSTILE = { scope: "desktop", delivery_mode: "foreground", cursor_id: "real", target: { kind: "desktop", display_id: "primary" }, session: "x", pointer: "os", warp: true, move_real_cursor: true };
const POINTER_TOOLS = /^(move_cursor|set_agent_cursor_\w+|get_cursor_position|set_pointer\w*)$/;

test("W39 門の一本道: 許す道具のどれに敵対的な引数を付けても、driver に届くのは許した欄だけ（scope=desktop・foreground・cursor_id・target は届かない）", async () => {
  const L = makeLeases(dir, { driver: fake, defaultMode: "allow", onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) });
  const g = L.give({ pid: 10, windowId: 1, app: "Calc", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  for (const tool of ALLOWED.filter((t) => !["fetch_url", "render_url", "open_app", "open_tab"].includes(t))) {
    calls = [];
    await L.act(tokenOf(g.lease), tool, { element_token: "s1:2", x: 5, y: 5, text: "a", key: "a", ...HOSTILE });
    for (const c of calls.filter((c) => c.tool !== "list_windows")) {
      for (const bad of Object.keys(HOSTILE)) expect(Object.keys(c.args)).not.toContain(bad);
      expect(c.tool).not.toMatch(POINTER_TOOLS);
    }
  }
});

test("W39 門に無い道具: ポインタを動かす driver の道具を act に名指しても、driver を呼ばずに断る", async () => {
  const L = makeLeases(dir, { driver: fake, defaultMode: "allow" });
  const g = L.give({ pid: 10, windowId: 1, app: "Calc", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  for (const tool of ["move_cursor", "set_agent_cursor_enabled", "set_agent_cursor_theme", "get_cursor_position"]) {
    calls = [];
    const r = await L.act(tokenOf(g.lease), tool, { x: 1, y: 1, scope: "desktop" });
    expect(r.ok).toBe(false);
    expect(calls.filter((c) => c.tool !== "list_windows")).toEqual([]);
  }
});

// 本物のポインタを動かす語（source に在ってはいけない）。コメントの説明は「語を分けて」書く（この検査自身にも当たらない）
export const POINTER_WORDS = /CGWarpMouseCursorPosition|CGEventPost\s*\(|kCGHIDEventTap|CGDisplayMoveCursorToPoint|CGAssociateMouseAndMouseCursorPosition|delivery_mode["'\s:]*["']foreground|scope["'\s:]*["']desktop/;
export const scan = (text: string) => POINTER_WORDS.test(text);

test("W39 製品の source（src・bar・extension・tools の本体）に、本物のポインタを動かす語が無い", () => {
  const roots: [string, RegExp][] = [["src", /\.ts$/], ["bar", /\.swift$/], ["extension", /\.js$/], ["tools", /\.(ts|swift|sh)$/]];
  const hit: string[] = [];
  for (const [r, ext] of roots) for (const f of readdirSync(join(import.meta.dir, "..", r)).filter((f) => ext.test(f))) {
    if (scan(readFileSync(join(import.meta.dir, "..", r, f), "utf8"))) hit.push(`${r}/${f}`);
  }
  expect(hit).toEqual([]);
});

test("W39 負の対照: 検査の語は、本物のポインタを動かす書き方を実際に拾う", () => {
  expect(scan("CGWarpMouseCursorPosition(p)")).toBe(true);
  expect(scan("e.post(tap: .cghidEventTap) // kCGHIDEventTap")).toBe(true);
  expect(scan('{ delivery_mode: "foreground" }')).toBe(true);
  expect(scan('{ scope: "desktop" }')).toBe(true);
  expect(scan('const STRIP = ["scope", "delivery_mode"]')).toBe(false); // 捨てる側の名前だけ
});

// ---- 2 段目: 面ごとの仮想カーソル ----
const win = { pid: 10, windowId: 1, app: "Calc", title: "" };
const mk = (showCursor?: () => boolean): ReturnType<typeof makeLeases> => { const L: ReturnType<typeof makeLeases> = makeLeases(dir, { driver: fake, defaultMode: "allow", showCursor, front: () => null, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) }); return L; };
const give = (L: ReturnType<typeof mk>) => { const g = L.give(win, "s:1"); if (!g.ok) throw new Error(); return tokenOf(g.lease); };

test("W39 仮想カーソル: click / drag の座標・押下・scroll が面の cursor に載り、操作が終われば押下は戻る", async () => {
  const L = mk(); const t = give(L);
  await L.act(t, "click", { x: 30, y: 40 });
  expect(L.cursor(t)).toMatchObject({ x: 30, y: 40 });
  expect(L.cursor(t)!.down).toBeUndefined();
  await L.act(t, "drag", { from_x: 1, from_y: 2, to_x: 50, to_y: 60 });
  expect(L.cursor(t)).toMatchObject({ x: 50, y: 60 });
  expect(L.cursor(t)!.down).toBeUndefined();
});

test("W39 既定 off: overlay の道具を driver に 1 度も呼ばない", async () => {
  const L = mk(); const t = give(L);
  L.seeFront(10); // 窓は見えている＝on なら出る条件。それでも off なら出ない
  await L.act(t, "click", { x: 1, y: 1 });
  await Bun.sleep(20);
  expect(calls.filter((c) => POINTER_TOOLS.test(c.tool) || c.tool === "move_cursor")).toEqual([]);
});

test("W39 on: 窓が見えていれば overlay を動かす・scope は window だけ（desktop は 1 度も無い）・turn が終われば消す", async () => {
  const L = mk(() => true); const t = give(L);
  L.seeFront(10);
  await L.act(t, "click", { x: 7, y: 8 });
  await Bun.sleep(20);
  expect(calls.filter((c) => c.tool === "move_cursor")[0]!.args).toMatchObject({ x: 7, y: 8, scope: "window" });
  expect(calls.every((c) => c.args.scope !== "desktop")).toBe(true);
  L.endTurn("s:1");
  expect(L.cursor(t)).toBeUndefined();
});

test("W39 on でも窓が人に見えていない（裏）なら overlay を出さない（嘘の位置を前の物の上に描かない）", async () => {
  const L = mk(() => true); const t = give(L);
  L.seeFront(99);
  await L.act(t, "click", { x: 7, y: 8 });
  await Bun.sleep(20);
  expect(calls.filter((c) => c.tool === "move_cursor" || c.tool.startsWith("set_agent_cursor"))).toEqual([]);
  expect(L.cursor(t)).toMatchObject({ x: 7, y: 8 }); // 仮想カーソルは動く（見せないだけ）
});
