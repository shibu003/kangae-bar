import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";

// W11f: 結果不明（送った後の時間切れ）は「やり直して」と言わない。読み直すまでその面の書き換えを門が止める
let dir: string;
let sent: string[];
let hang: string | null; // この tool は送った後に時間切れ（結果不明）
let reject: string | null; // この tool は driver が理由つきで断る（実行されていない）
const EL = [{ element_token: "s1:1", role: "AXButton", label: "OK" }];
const fake = (): Driver => ({
  call: async (tool) => {
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } };
    if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: "d" } };
    sent.push(tool);
    if (tool === hang) return { text: "画面の応答が遅い", isError: true, data: null, unknown: true };
    if (tool === reject) return { text: "bad args", isError: true, data: null };
    return { text: "ok", isError: false, data: tool === "get_window_state" ? { snapshot_id: "x", elements: EL } : null };
  },
  close() {},
});
const A = { pid: 10, windowId: 1, app: "Calc", title: "" };
const W = { tabId: 5, docId: "d", app: "Chrome", title: "t" };
const mk = () => makeLeases(dir, { driver: fake, web: fake(), defaultMode: "allow" });
beforeEach(() => { dir = mktmp("w11f"); sent = []; hang = null; reject = null; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

for (const [name, surface] of [["窓", A], ["web", W]] as const) {
  test(`${name}: 送った後の時間切れは結果不明・書き換えは読むまで止まり、読むと解ける・読む act は止めない`, async () => {
    const L = mk();
    const g = L.give(surface as any, "s:1");
    if (!g.ok) throw new Error();
    const tk = tokenOf(g.lease);
    await L.act(tk, "get_window_state", {});
    hang = "type_text";
    const r = await L.act(tk, "type_text", { text: "a" });
    expect(r).toMatchObject({ ok: false, why: "result" });
    expect((r as any).hint).toContain("結果不明");
    expect((r as any).hint).not.toContain("もう一度");
    hang = null;
    sent.length = 0;
    expect(await L.act(tk, "type_text", { text: "a" })).toMatchObject({ ok: false, why: "result" }); // 読む前の書き換え
    expect(await L.act(tk, "click", { element_token: "s1:1" })).toMatchObject({ ok: false, why: "result" });
    expect(sent).toEqual([]); // 1 件も driver に届かない
    expect(await L.act(tk, "scroll", {})).toMatchObject({ ok: true }); // 読む act は止めない
    expect(await L.act(tk, "type_text", { text: "a" })).toMatchObject({ ok: false, why: "result" }); // scroll は読み直しではない
    expect(await L.act(tk, "get_window_state", {})).toMatchObject({ ok: true });
    expect(await L.act(tk, "type_text", { text: "b" })).toMatchObject({ ok: true }); // 解けた
    expect(sent.filter((t) => t === "type_text")).toEqual(["type_text"]);
  });
}

test("読む act の時間切れは結果不明にしない（書き換えを止めない）・理由つきで断られた error も止めない", async () => {
  const L = mk();
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const tk = tokenOf(g.lease);
  hang = "get_window_state";
  await L.act(tk, "get_window_state", {});
  hang = null; reject = "type_text";
  expect(await L.act(tk, "type_text", { text: "a" })).toMatchObject({ ok: true, isError: true });
  reject = null;
  expect(await L.act(tk, "type_text", { text: "a" })).toMatchObject({ ok: true, isError: false });
});

test("結果不明の手は戻す記録に『戻せません: 結果不明』で入る", async () => {
  const L = mk();
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const tk = tokenOf(g.lease);
  await L.act(tk, "type_text", { text: "x" });
  hang = "type_text";
  await L.act(tk, "type_text", { text: "y" });
  expect(await L.undo("s:1")).toEqual({ ok: false, hint: "戻せません: 結果不明" });
});
