// W8a: 取り返しのつかない操作（送信・削除・購入…）は、「この頼みの間」の許しがあっても 1 件ずつ人に聞く。分からない物は聞く側・読むだけは聞かない（図 §35）
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, makeLeases, tokenOf, type Driver } from "../src/lease.ts";

let dir: string;
let ran: { tool: string; args: Record<string, unknown> }[];
const ELS = [
  { element_token: "t1", role: "AXTextField", label: "宛先", value: "" },
  { element_token: "t2", role: "AXTextArea", label: "本文", value: "" },
  { element_token: "b1", role: "AXButton", label: "送信", value: "" },
  { element_token: "b2", role: "AXButton", label: "Delete account", value: "" },
  { element_token: "b3", role: "AXButton", label: "閉じる", value: "" },
  { element_token: "b4", role: "AXButton", label: "", value: "" },
  { element_token: "b5", role: "AXButton", label: "ログアウト", value: "" },
  { element_token: "b6", role: "AXLink", label: "Account settings", value: "" },
];
const fake = (): Driver => ({
  call: async (tool, args) => {
    ran.push({ tool, args });
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } };
    if (tool === "get_window_state") return { text: "", isError: false, data: { snapshot_id: "s1", elements: ELS } };
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
const acted = () => ran.filter((c) => !["list_windows", "get_window_state"].includes(c.tool));
const tick = () => new Promise((r) => setTimeout(r, 5));
const A = { pid: 10, windowId: 1, app: "Mail", title: "" };
async function setup(mode: "ask" | "allow" = "ask") {
  const L = makeLeases(dir, { driver: fake, defaultMode: mode });
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const tk = tokenOf(g.lease);
  await L.act(tk, "get_window_state", {}); // 要素の名前を門が覚える
  return { L, tk };
}
// 1 件を待たせて答える
async function ans(L: Awaited<ReturnType<typeof setup>>["L"], p: Promise<unknown>, yes: boolean, turn = false) {
  await tick();
  const a = L.approvals();
  expect(a.length).toBe(1);
  L.answer(a[0]!.id, yes, turn);
  return { card: a[0]!, r: await p };
}

beforeEach(() => { dir = mktmp("w8a"); ran = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("W8a UC-x1: 「この頼みの間」を許した後も、文字を入れるのは聞かず、「送信」を押すのは聞く（押せば実行）", async () => {
  const { L, tk } = await setup();
  const p0 = L.act(tk, "type_text", { element_token: "t2", text: "こんにちは" });
  await ans(L, p0, true, true); // この頼みの間、許す
  expect(L.list()[0]!.turnAllow).toBe(true);
  expect((await L.act(tk, "type_text", { element_token: "t2", text: "続き" })).ok).toBe(true); // 書くのは聞かない
  const p = L.act(tk, "click", { element_token: "b1" });
  const { card, r } = await ans(L, p, true);
  expect(card).toMatchObject({ danger: true, what: "「送信」を押す" });
  expect(r).toMatchObject({ ok: true });
  expect(acted().at(-1)).toMatchObject({ tool: "click", args: { element_token: "b1" } });
});

test("W8a UC-x2: 断ると実行しない・理由つき・次に同じ物を押そうとしたらまた聞く（「この頼みの間」を返されても付かない）", async () => {
  const { L, tk } = await setup();
  await ans(L, L.act(tk, "type_text", { text: "a" }), true, true);
  const n = acted().length;
  const { r } = await ans(L, L.act(tk, "click", { element_token: "b2" }), false);
  expect(r).toMatchObject({ ok: false, why: "denied" });
  expect(acted().length).toBe(n);
  const p = L.act(tk, "click", { element_token: "b2" }); // もう一度
  const { r: r2 } = await ans(L, p, true, true); // 「この頼みの間」を押されても destructive は 1 件だけ
  expect(r2).toMatchObject({ ok: true });
  const p3 = L.act(tk, "click", { element_token: "b2" });
  await tick();
  expect(L.approvals().length).toBe(1); // 3 回目もまた聞く
  L.answer(L.approvals()[0]!.id, false);
  await p3;
});

test("W8a UC-x3: 読むだけは聞かない・名前のある安全な button と 3 行の本文は聞かない", async () => {
  const { L, tk } = await setup();
  expect((await L.act(tk, "scroll", { direction: "down" })).ok).toBe(true);
  expect((await L.act(tk, "get_window_state", {})).ok).toBe(true);
  expect(L.approvals()).toEqual([]);
  await ans(L, L.act(tk, "type_text", { element_token: "t2", text: "x" }), true, true);
  for (const a of [["click", { element_token: "b3" }], ["type_text", { element_token: "t2", text: "1行目\n2行目\n3行目" }], ["press_key", { key: "return" }]] as const) {
    expect((await L.act(tk, a[0], { ...a[1] })).ok).toBe(true); // 直前に狙ったのが本文（複数行の欄）なので return も改行
    expect(L.approvals()).toEqual([]);
  }
});

test("W8a: 1 行の欄の改行・return は聞く / 狙った先が分からない物は聞く側（先に聞く）・「許す」の app でも分からない物・destructive は聞く", async () => {
  const { L, tk } = await setup();
  await ans(L, L.act(tk, "type_text", { text: "a" }), true, true);
  for (const a of [["type_text", { element_token: "t1", text: "a\n" }], ["click", { element_token: "zz" }], ["click", { x: 5, y: 5 }], ["click", { element_token: "b4" }]] as const) {
    const p = L.act(tk, a[0], { ...a[1] });
    const { card } = await ans(L, p, false);
    expect(card.danger).toBe(true);
  }
  const { L: W, tk: wt } = await setup("allow");
  const pu = W.act(wt, "click", { element_token: "zz" }); // 分からない物は、人が「許す」にした app でも聞く
  const { card: cu } = await ans(W, pu, false);
  expect(cu).toMatchObject({ danger: true, unsure: true, what: "押す", note: "この app は「許す」ですが、押す先が分からないので聞きます" });
  const p = W.act(wt, "click", { element_token: "b1" });
  const { card } = await ans(W, p, false);
  expect(card).toMatchObject({ danger: true, note: "この app は「許す」ですが、取り返しがつかない操作なので聞きます" });
  const { L: O, tk: ot } = await setup("ask");
  O.setMode("Mail", "off");
  expect(await O.act(ot, "click", { element_token: "b1" })).toMatchObject({ ok: false, why: "off" });
});

test("W8a: destructive の「この頼みの間」は同じ窓で待つ他の destructive を巻き込まない", async () => {
  const { L, tk } = await setup();
  const p1 = L.act(tk, "click", { element_token: "b1" });
  const p2 = L.act(tk, "click", { element_token: "b2" });
  await tick();
  expect(L.approvals().length).toBe(2);
  L.answer(L.approvals()[0]!.id, true, true);
  await p1;
  await tick();
  expect(L.approvals().length).toBe(1); // 2 件目は残って、また聞く
  L.answer(L.approvals()[0]!.id, false);
  expect(await p2).toMatchObject({ ok: false, why: "denied" });
});

test("W8a: 普通の card への「この頼みの間」は待っている destructive を許さない・destructive への「この頼みの間」は普通の card を許さない", async () => {
  const { L, tk } = await setup();
  const w = L.act(tk, "type_text", { element_token: "t2", text: "x" });
  const d = L.act(tk, "click", { element_token: "b1" });
  await tick();
  const [cw, cd] = [L.approvals().find((a) => !a.danger)!, L.approvals().find((a) => a.danger)!];
  L.answer(cd.id, true, true); // destructive に「この頼みの間」→ 1 件だけ・普通の card は待ったまま
  await d;
  expect(L.approvals().map((a) => a.id)).toEqual([cw.id]);
  expect(L.list()[0]!.turnAllow).toBeUndefined();
  const d2 = L.act(tk, "click", { element_token: "b2" });
  await tick();
  L.answer(cw.id, true, true); // 普通の card に「この頼みの間」→ 待っている destructive は許されない
  await w;
  await tick();
  expect(L.approvals().length).toBe(1);
  expect(L.approvals()[0]!.danger).toBe(true);
  L.answer(L.approvals()[0]!.id, false);
  await d2;
});

test("W8a: 分類の表（道具 × 要素 × 種類）", () => {
  const btn = (label: string, value = "") => ({ role: "AXButton", label, value });
  const row: [string, Record<string, unknown>, { role: string; label: string; value?: string } | undefined, string][] = [
    ["get_window_state", {}, undefined, "read"], ["scroll", {}, undefined, "read"], ["fetch_url", {}, undefined, "read"],
    ["click", {}, btn("送信"), "destructive"], ["click", {}, btn("Buy now"), "destructive"], ["click", {}, btn("購入する"), "destructive"], ["right_click", {}, btn("Delete"), "destructive"],
    ["click", {}, btn("OK", "Post"), "destructive"], ["click", {}, btn("閉じる"), "write"], ["click", {}, btn(""), "unsure"], ["click", {}, { role: "AXTextArea", label: "" }, "write"], ["click", {}, { role: "textbox", label: "" }, "write"], ["click", {}, undefined, "unsure"],
    ["type_text", { text: "hi" }, undefined, "write"], ["type_text", { text: "a\nb" }, { role: "AXTextArea", label: "本文" }, "write"], ["type_text", { text: "a\n" }, { role: "AXTextField", label: "検索" }, "destructive"], ["type_text", { text: "a\n" }, undefined, "unsure"],
    ["press_key", { key: "return" }, { role: "AXTextField", label: "検索" }, "destructive"], ["press_key", { key: "return" }, { role: "AXTextArea", label: "" }, "write"], ["press_key", { key: "tab" }, undefined, "write"],
    ["hotkey", { keys: ["cmd", "return"] }, undefined, "destructive"], ["hotkey", { keys: ["cmd", "backspace"] }, undefined, "destructive"], ["hotkey", { keys: ["cmd", "c"] }, undefined, "write"],
    ["click", {}, btn("ログアウト"), "crossing"], ["click", {}, btn("Log out"), "crossing"], ["click", {}, btn("Sign out of all devices"), "crossing"], ["click", {}, btn("アカウント設定"), "crossing"], ["click", {}, btn("パスワードを変更"), "crossing"], ["click", {}, btn("Change password"), "crossing"], ["click", {}, btn("連携を解除"), "crossing"], ["click", {}, btn("OK", "Logout"), "crossing"],
    ["click", {}, { role: "AXTextField", label: "Change password" }, "crossing"], ["click", {}, btn("Delete account"), "destructive"], ["click", {}, btn("Dialog"), "write"], ["click", {}, btn("Dialog outline"), "write"], ["click", {}, btn("Design outline"), "write"], ["click", {}, btn("Catalog outlet"), "write"], ["click", {}, btn("Log off"), "crossing"], ["click", {}, btn("Sign-out"), "crossing"], ["click", {}, btn("Deactivate account"), "crossing"], ["click", {}, btn("メニュー", "https://x.test/settings/account"), "crossing"], ["click", {}, { role: "AXLink", label: "menu", value: "https://x.test/logout" }, "crossing"], ["click", {}, { role: "AXLink", label: "menu", value: "https://x.test/settings/account" }, "crossing"], ["click", {}, btn("Settings"), "write"],
    ["set_value", { value: "x" }, btn("送信"), "write"], ["drag", {}, undefined, "write"],
  ];
  for (const [t, a, e, want] of row) expect(`${t} ${JSON.stringify(a)} ${e?.label} → ${classify(t, a, e)}`).toBe(`${t} ${JSON.stringify(a)} ${e?.label} → ${want}`);
});

test("W8a-2: ログアウト・アカウント設定は「この頼みの間」でも「許す」の app でも毎回 1 回聞く・文言は「他の tab や他の端末にも効きます」・普通の書き換えは今まで通り", async () => {
  const { L, tk } = await setup();
  await ans(L, L.act(tk, "click", { element_token: "b3" }), true, true); // 普通の click に「この頼みの間」
  const n0 = acted().length;
  const { card, r } = await ans(L, L.act(tk, "click", { element_token: "b5" }), true, true);
  expect(card).toMatchObject({ danger: true, note: "この操作は、今の tab だけでなく同じ site の他の tab や他の端末にも効きます。許してよいか確かめてから押してください" });
  expect(r).toMatchObject({ ok: true });
  const p = L.act(tk, "click", { element_token: "b6" }); // 「この頼みの間」を押されても次の crossing は聞く
  const { card: c2 } = await ans(L, p, false);
  expect(c2.danger).toBe(true);
  expect(acted().length).toBe(n0 + 1);
  expect(await L.act(tk, "click", { element_token: "b3" })).toMatchObject({ ok: true }); // 普通の書き換えは聞かずに通る
  const { L: W, tk: wt } = await setup("allow");
  const { card: c3 } = await ans(W, W.act(wt, "click", { element_token: "b5" }), false);
  expect(c3).toMatchObject({ danger: true, note: "この操作は、今の tab だけでなく同じ site の他の tab や他の端末にも効きます。許してよいか確かめてから押してください" });
});
