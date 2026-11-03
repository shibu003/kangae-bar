// W78: 画素 x,y の click は最後の手段。読んだ要素が覆う点は element_token へ回し、覆う要素が無い点（canvas）だけ画素の道に残る。本物のポインタは W39 の通り 0
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeLeases, pixelHint, tokenOf, type Driver } from "../src/lease.ts";
import { readFileSync } from "node:fs";

let dir: string, calls: { tool: string; args: Record<string, unknown> }[];
const els = [{ element_token: "s1:1", role: "AXButton", label: "保存", frame: { x: 10, y: 10, width: 80, height: 30 } }, { element_token: "s1:2", role: "AXGroup", label: "", frame: { x: 0, y: 0, width: 400, height: 300 } }];
const fake = (): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : tool === "get_window_state" ? { snapshot_id: "s1", elements: els } : null }; }, close() {} });
beforeEach(() => { dir = mktmp("w78"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const mk = () => { const L: ReturnType<typeof makeLeases> = makeLeases(dir, { driver: fake, defaultMode: "allow", front: () => null, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) }); return L; };
const give = async (L: ReturnType<typeof mk>) => { const g = L.give({ pid: 10, windowId: 1, app: "Calc", title: "" }, "s:1"); if (!g.ok) throw new Error(); const t = tokenOf(g.lease); await L.act(t, "get_window_state", {}); calls = []; return t; };
const sent = () => calls.filter((c) => c.tool !== "list_windows");

test("W78 読んだ要素が覆う点への画素 click は、driver に送らず element_token を案内する（3 つの click とも）", async () => {
  const L = mk(), t = await give(L);
  for (const tool of ["click", "double_click", "right_click"]) {
    const r = await L.act(t, tool, { x: 20, y: 20 });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain('element_token \\"s1:1\\"'); // 覆う中で一番小さい要素（ボタン）を指す
    expect(sent()).toEqual([]);
  }
});

test("W78 既定の道（element_token）は座標を持たずに driver へ届く", async () => {
  const L = mk(), t = await give(L);
  const r = await L.act(t, "click", { element_token: "s1:1" });
  expect(r.ok).toBe(true);
  expect(sent().map((c) => Object.keys(c.args).filter((k) => /^(x|y|from_x|from_y|to_x|to_y)$/.test(k)))).toEqual([[]]);
});

test("W78 覆う要素が無い点（canvas など）は最後の手段として画素のまま届き、仮想カーソルが動く", async () => {
  const L = mk(), t = await give(L);
  const r = await L.act(t, "click", { x: 500, y: 500 });
  expect(r.ok).toBe(true);
  expect(sent()[0]!.args).toMatchObject({ x: 500, y: 500 });
  expect(L.cursor(t)).toMatchObject({ x: 500, y: 500 });
});

test("W78 案内文は道の優先順を言う・負の対照: 覆いの判定を外すと上の断りは赤になる", () => {
  expect(readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")).toContain("操作の道の優先順");
  const e = { "s1:1": { role: "AXButton", label: "保存", f: [10, 10, 80, 30] as [number, number, number, number] } };
  expect(pixelHint("click", { x: 20, y: 20 }, e)).not.toBe("");
  expect(pixelHint("click", { x: 20, y: 20, element_token: "s1:1" }, e)).toBe("");
  expect(pixelHint("click", { x: 200, y: 200 }, e)).toBe("");
  expect(pixelHint("click", { x: 20, y: 20 }, undefined)).toBe("");
  expect(pixelHint("scroll", { x: 20, y: 20 }, e)).toBe("");
});

test("W78 既定の道に本物のポインタを動かす呼びが 0: delivery_mode・scope・move_cursor・warp 系は driver へ届かない（agent が渡しても）", async () => {
  const L = mk(), t = await give(L);
  await L.act(t, "click", { element_token: "s1:1", delivery_mode: "foreground", scope: "desktop", debug_image_out: "/tmp/x" });
  await L.act(t, "click", { x: 500, y: 500, delivery_mode: "foreground" });
  for (const c of sent()) { expect(c.args).not.toHaveProperty("delivery_mode"); expect(c.args).not.toHaveProperty("scope"); }
  expect(sent().some((c) => /warp|move_cursor|set_agent_cursor/.test(c.tool))).toBe(false); // overlay も既定 off（W39c）
  expect((await L.act(t, "move_cursor", { x: 1, y: 1 })).ok).toBe(false); // ALLOWED に無い
});
