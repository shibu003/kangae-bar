// W76b（CEO 10-14「小さい絵を押すと、実際の画面が前に出て、途中から人の操作に変わる」）: 認証 card の絵を人が押す → 面が前に出る（peekFront）→ card は「人が操作中」（旗は残る＝agent は書けないまま）→
// 人が「戻す」か、読み直した画面から入力欄が消えていたら旗を落として agent が続く。値は agent に見せない（card・案内に文字は載らない）
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeAuthCards } from "../src/authcard.ts";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let dir: string, els: any[], clock: number, gateCalls: string[];
const web: Driver = {
  call: async (tool) => {
    if (tool === "gate_off" || tool === "gate_on") gateCalls.push(tool);
    if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: "d1" } };
    if (tool === "tab_info") return { text: "", isError: false, data: { docId: "d1", url: "https://shop.example.com/login" } };
    if (tool === "get_window_state") return { text: "", isError: false, data: { snapshot_id: "s", elements: els } };
    return { text: "ok", isError: false, data: null };
  },
  close() {},
};
const mk = () => makeLeases(dir, { web, defaultMode: "allow", now: () => clock });
const otp = () => [{ element_token: "d1", role: "textbox", label: "コード", value: "", gate: "otp" }];
const plain = () => [{ element_token: "d1", role: "button", label: "マイページ", value: "" }];
beforeEach(() => { dir = mktmp("w76b"); clock = 1_000_000; els = otp(); gateCalls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const give = (L: ReturnType<typeof mk>) => { const g = L.give({ tabId: 7, docId: "d1", app: "Chrome", title: "ログイン", url: "https://shop.example.com/login" }, "s:1"); if (!g.ok) throw new Error(); g.lease.hold = false; return tokenOf(g.lease); };
const write = (L: ReturnType<typeof mk>, t: string) => L.act(t, "type_text", { element_token: "d1", text: "1" });

test("W76b 人が絵を押して面を前に出すと card が「人が操作中」になる（fronted）・同じ面に card が無ければ何も起きない・2 度押しても時刻は変わらない", async () => {
  const L = mk(); const t = give(L);
  await L.act(t, "get_window_state", {});
  expect(L.authCards()[0]!.fronted).toBeNull();
  expect(L.authFronted("tab:99")).toBe(false);
  expect(L.authFronted("tab:7")).toBe(true);
  const at = L.authCards()[0]!.fronted;
  expect(at).toBe(clock);
  clock += 5000;
  L.authFronted("tab:7");
  expect(L.authCards()[0]!.fronted).toBe(at);
  expect(await write(L, t)).toMatchObject({ ok: false, why: "human" }); // 前に出しても旗は残る＝agent は書けないまま
});

test("W76b 人が認証して入力欄が消えた画面を agent が読み直したら、旗が落ちて card が畳まれ、続けて書ける（「戻す」の押し忘れで待たせない）", async () => {
  const L = mk(); const t = give(L);
  await L.act(t, "get_window_state", {});
  L.authFronted("tab:7");
  els = plain(); gateCalls.length = 0; // 渡した時の gate_on は除く
  expect(await L.act(t, "get_window_state", {})).toMatchObject({ ok: true });
  expect(L.authCards()).toEqual([]);
  expect(await write(L, t)).not.toMatchObject({ why: "human" });
  expect(gateCalls).toEqual(["gate_off", "gate_on"]); // WebAuthn の見張りを張り直す（humanDone と同じ）
});

test("W76b 前に出していない card は、読み直して欄が消えても自分では畳まれない（agent が読むだけで旗を外せない）・欄がまだ在る間も外れない", async () => {
  const L = mk(); const t = give(L);
  await L.act(t, "get_window_state", {});
  els = plain();
  await L.act(t, "get_window_state", {});
  expect(L.authCards().length).toBe(1);
  expect(await write(L, t)).toMatchObject({ ok: false, why: "human" });
  els = otp(); L.authFronted("tab:7");
  await L.act(t, "get_window_state", {});
  expect(L.authCards().length).toBe(1); // 欄が在る
  expect(await write(L, t)).toMatchObject({ ok: false, why: "human" });
});

test("W76b passkey・CAPTCHA は欄が消えても自動では畳まない（人の「戻す」だけ）", async () => {
  for (const gate of ["webauthn", "captcha"]) {
    const L = mk(); const t = give(L);
    els = [{ element_token: "d1", role: "button", label: "確認", value: "", gate }];
    await L.act(t, "get_window_state", {});
    L.authFronted("tab:7");
    els = plain();
    await L.act(t, "get_window_state", {});
    expect(L.authCards().length, gate).toBe(1);
    expect(await write(L, t), gate).toMatchObject({ ok: false, why: "human" });
    L.humanDone("s:1");
    expect(L.authCards(), gate).toEqual([]);
  }
});

test("W76b card は種類・host・時刻・fronted だけ（面の題・URL の path・画面の文字・値は載らない）", async () => {
  els = [{ element_token: "d1", role: "textbox", label: "秘密ZZ9", value: "123456", gate: "otp" }];
  const L = mk(); const t = give(L);
  await L.act(t, "get_window_state", {});
  L.authFronted("tab:7");
  const dump = JSON.stringify(L.authCards());
  for (const leak of ["ログイン", "/login", "ZZ9", "123456"]) expect(dump, leak).not.toContain(leak);
  expect(makeAuthCards({ now: () => clock }).markFronted("none")).toBe(false);
});

test("W76b 口と panel: peekFront は人の画面からだけ・成功した時だけ card を fronted にする／card は前に出した後「戻す」と案内する", () => {
  const m = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  expect(m).toContain('if (m.input && leases.authOpen(`tab:${Number(m.tabId)}`)) return { ok: true, taken: 0 }'); // 人が認証している面の入力は取り戻しにしない
  expect(m).toContain("(k) => peek.justFronted(k) || leases.authOpen(k)"); // 窓も同じ
  expect(m).toMatch(/case "peekFront": \{[\s\S]{0,200}?peek\.front\([\s\S]{0,200}?if \(r\.ok\) leases\.authFronted\(/);
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  const card = js.slice(js.indexOf("function authCardEl"), js.indexOf("function renderApprove"));
  expect(card).toContain("c.fronted");
  expect(card).toContain("済んだ（agent に続きを頼む）");
  expect(card).not.toMatch(/innerHTML|surface|title/);
  expect(js).toContain("else loadLeases(); }; // W76b");
});

test("W76b 人が前に出して認証している面の移動（login 後の遷移）は面を保つ・前に出していない面の人の移動は今まで通り取り戻す", async () => {
  const nav = { startedAt: clock + 10, type: "typed", quals: [] as string[] };
  const A = mk(); const ta = give(A);
  await A.act(ta, "get_window_state", {});
  expect(await A.navigated(7, nav)).toBe(1); // 前に出していない＝人が起こした移動は取り戻す（今まで通り）
  expect(A.list().length).toBe(0);
  const B = mk(); const tb = give(B);
  await B.act(tb, "get_window_state", {});
  B.authFronted("tab:7");
  expect(await B.navigated(7, nav)).toBe(0);
  expect(B.list().length).toBe(1); // 面は保たれる
  expect(B.authOpen("tab:7")).toBe(true);
  expect(B.authOpen("tab:8")).toBe(false);
  expect(await write(B, tb)).toMatchObject({ ok: false, why: "human" }); // 旗は残る＝書けないまま（読み直して欄が消えてから続く）
});
