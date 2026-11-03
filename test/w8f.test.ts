// W8f: やり直し（門の記録から 1 手ずつ戻す）。記録は memory だけ・戻せるのは type_text と set_value だけ・戻せない物は理由 1 行で何もしない
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";

let dir: string;
let ran: { tool: string; args: Record<string, unknown> }[];
const ELS = [
  { element_token: "t2", role: "AXTextArea", label: "本文", value: "前の値ひみつ" },
  { element_token: "b1", role: "AXButton", label: "送信", value: "" },
  { element_token: "b3", role: "AXButton", label: "閉じる", value: "" },
];
const fake = (): Driver => ({
  call: async (tool, args) => {
    ran.push({ tool, args });
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } };
    if (tool === "set_value" && args.element_token === "t2") ELS[0]!.value = String(args.value); // 面は書かれた値を持つ（戻す前の読み直しが見る）
    if (tool === "get_window_state") return { text: "", isError: false, data: { snapshot_id: "s1", elements: ELS } };
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
const acted = () => ran.filter((c) => !["list_windows", "get_window_state"].includes(c.tool));
const A = { pid: 10, windowId: 1, app: "Mail", title: "" };
async function setup() {
  const L: ReturnType<typeof makeLeases> = makeLeases(dir, { driver: fake, defaultMode: "allow", onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) }); // 「送信」を押す手は W8a で聞かれる。ここは戻す側の検査なので許す
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const tk = tokenOf(g.lease);
  await L.act(tk, "get_window_state", {});
  return { L, tk };
}
beforeEach(() => { dir = mktmp("w8f"); ran = []; ELS[0]!.value = "前の値ひみつ"; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("W8f UC-u1: 3 手書く → 1 手戻す → 最後の 1 手だけ戻る（書いた文字数だけ backspace）・次の戻しは 1 つ前", async () => {
  const { L, tk } = await setup();
  for (const t of ["abc", "defg", "hi"]) await L.act(tk, "type_text", { element_token: "t2", text: t });
  expect(L.list()[0]!.undo).toBe(3);
  const n = acted().length;
  expect(await L.undo("s:1")).toMatchObject({ ok: true, text: "戻しました: 書いた 2 文字を消しました" });
  expect(acted().slice(n).map((c) => c.tool + ":" + c.args.key)).toEqual(["press_key:delete", "press_key:delete"]);
  expect(L.list()[0]!.undo).toBe(2);
  await L.undo("s:1");
  expect(acted().filter((c) => c.tool === "press_key").length).toBe(2 + 4);
});

test("W8f: set_value は前の値へ set_value で戻す", async () => {
  const { L, tk } = await setup();
  await L.act(tk, "set_value", { element_token: "t2", value: "新しい値" });
  expect(await L.undo("s:1")).toMatchObject({ ok: true });
  expect(acted().at(-1)).toMatchObject({ tool: "set_value", args: { element_token: "t2", value: "前の値ひみつ" } });
});

test("W8f UC-u2: destructive・戻し方が分からない物は「戻せません」1 行で何もしない・その先の手へ飛び越えない", async () => {
  const { L, tk } = await setup();
  await L.act(tk, "type_text", { element_token: "t2", text: "abc" });
  await L.act(tk, "click", { element_token: "b1" }); // 送信
  const n = ran.length;
  expect(await L.undo("s:1")).toEqual({ ok: false, hint: "戻せません: 「送信」（送信・削除・購入など）は取り消せません" });
  expect(ran.length).toBe(n); // 何もしていない
  expect(L.list()[0]!.undo).toBe(2); // 記録はそのまま・abc の方へは飛ばない
  await L.act(tk, "click", { element_token: "b3" }); // 閉じる（write だが戻し方が分からない）
  expect(await L.undo("s:1")).toMatchObject({ ok: false, hint: "戻せません: 何を戻せばよいか分かりません" });
});

test("W8f UC-u3: turn の終わり・取り戻し・世代が変わるのあとは「戻す物がありません」", async () => {
  for (const end of [(L: Awaited<ReturnType<typeof setup>>["L"], tk: string) => L.endTurn("s:1"), (L: any) => L.takeback(L.list()[0].key), (L: any) => L.reconfirm(L.list()[0].key)]) {
    const { L, tk } = await setup();
    await L.act(tk, "type_text", { element_token: "t2", text: "abc" });
    expect(L.list()[0]!.undo).toBe(1);
    end(L, tk);
    expect(await L.undo("s:1")).toEqual({ ok: false, hint: "戻す物がありません" });
  }
});

test("W8f: 値を file にも list にも出さない（前の値・書いた文字・最大 20 手）", async () => {
  const { L, tk } = await setup();
  await L.act(tk, "set_value", { element_token: "t2", value: "ひみつの新値" });
  await L.act(tk, "type_text", { element_token: "t2", text: "ひみつの文字" });
  const all = JSON.stringify(L.list()) + readFileSync(join(dir, "leases.json"), "utf8");
  expect(all).not.toContain("前の値ひみつ");
  expect(all).not.toContain("ひみつの");
  for (let i = 0; i < 30; i++) await L.act(tk, "type_text", { text: "x" });
  expect(L.list()[0]!.undo).toBe(20);
});
