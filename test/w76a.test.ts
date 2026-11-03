// W76a（CEO 10-14「agent が人の手が必要な時、触っている画面の小さい版を chat に出し…allow / always allow / deny・未登録なら登録も」）: gate が立つと常駐が認証 card を面ごとに 1 枚作る。
// card は種類と host だけ（面の題・画面の文字・値は持たない）・選択肢は押せる物だけ・絵は peek（新しくは撮らない）
import { HUMAN_OPS } from "../src/main.ts";
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AUTH_TTL_MS, authOptions, kindOfReason, makeAuthCards } from "../src/authcard.ts";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let dir: string, els: any[], url: string, clock: number;
const web: Driver = {
  call: async (tool) => {
    if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: "d1" } };
    if (tool === "tab_info") return { text: "", isError: false, data: { docId: "d1", url } };
    if (tool === "get_window_state") return { text: "", isError: false, data: { snapshot_id: "s", elements: els } };
    return { text: "ok", isError: false, data: null };
  },
  close() {},
};
const mk = (o: Record<string, unknown> = {}) => makeLeases(dir, { web, defaultMode: "allow", now: () => clock, ...o });
const S = (tabId = 7, title = "ログイン") => ({ tabId, docId: "d1", app: "Chrome", title, url });
beforeEach(() => { dir = mktmp("w76a"); clock = 1_000_000; url = "https://shop.example.com/login?next=/a#x"; els = [{ element_token: "d1", role: "textbox", label: "コード", value: "", gate: "otp" }]; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const give = (L: ReturnType<typeof mk>, tabId = 7, owner = "s:1", title?: string) => { const g = L.give(S(tabId, title), owner); if (!g.ok) throw new Error(); g.lease.hold = false; return tokenOf(g.lease); };

test("W76a gate が立つと card が 1 枚: 種類・host（origin だけ）・選択肢・面の key。面の題・URL の path / query・画面の文字は載らない", async () => {
  els = [{ element_token: "d1", role: "textbox", label: "秘密の画面文字ZZ9", value: "", gate: "otp" }];
  const L = mk(); const t = give(L, 7, "s:1", "銀行 — 残高 123,456 円");
  await L.act(t, "get_window_state", {});
  const [c] = L.authCards();
  expect(L.authCards().length).toBe(1);
  expect(c).toMatchObject({ owner: "s:1", kind: "otp", host: "https://shop.example.com", key: "tab:7" });
  expect(c!.options.map((o) => o.id)).toEqual(["done", "deny"]); // 自動・登録は c / d まで出ない
  const dump = JSON.stringify(c);
  for (const leak of ["銀行", "残高", "123,456", "next=", "/login", "ZZ9"]) expect(dump, leak).not.toContain(leak);
  await L.act(t, "get_window_state", {}); await L.act(t, "get_window_state", {});
  expect(L.authCards().length).toBe(1); // 再検出で増えない
  expect(L.authCards()[0]!.id).toBe(c!.id); // card の id が変わらない（押している最中に差し替わらない）
});

test("W76a 面ごとに 1 枚・別の会話の面は別の card・「やりました」(humanDone)で消える・面を取り戻すと消える・押し忘れは時間で消える", async () => {
  const L = mk(); const a = give(L, 7, "s:1"), b = give(L, 8, "s:2");
  await L.act(a, "get_window_state", {}); await L.act(b, "get_window_state", {});
  expect(L.authCards().map((c) => c.owner).sort()).toEqual(["s:1", "s:2"]);
  L.humanDone("s:1");
  expect(L.authCards().map((c) => c.owner)).toEqual(["s:2"]);
  L.takeback("tab:8");
  expect(L.authCards()).toEqual([]);
  const A = makeAuthCards({ now: () => clock });
  A.add({ owner: "s:1", key: "tab:1", reason: "認証コード（SMS や認証アプリの数字）の欄", host: "https://a.example" });
  clock += AUTH_TTL_MS + 1;
  expect(A.list()).toEqual([]);
});

test("W76a 選択肢: 自分でやる・deny は必ず／自動（allow・always allow）は password・認証コードで登録済みかつ local agent が使える時だけ／登録するは未登録で登録できる時だけ／passkey・CAPTCHA は自動にしない", () => {
  const ids = (o: Parameters<typeof authOptions>[0]) => authOptions(o).map((x) => x.id);
  const base = { registered: false, autoReady: false, canRegister: false };
  expect(ids({ kind: "otp", ...base })).toEqual(["done", "deny"]);
  expect(ids({ kind: "otp", ...base, canRegister: true })).toEqual(["done", "register", "deny"]);
  expect(ids({ kind: "password", registered: true, autoReady: true, canRegister: true })).toEqual(["done", "allow", "always", "deny"]);
  expect(ids({ kind: "password", registered: true, autoReady: false, canRegister: true })).toEqual(["done", "deny"]); // 登録済みでも local agent が使えない時は出さない
  for (const kind of ["webauthn", "captcha", "other"] as const) expect(ids({ kind, registered: true, autoReady: true, canRegister: true }), kind).toEqual(["done", "deny"]);
  expect(kindOfReason("認証コード（SMS や認証アプリの数字）の欄")).toBe("otp");
  expect(kindOfReason("CAPTCHA（人かどうかの確認）")).toBe("captcha");
  expect(kindOfReason("指紋・顔・passkey の確認")).toBe("webauthn");
  expect(kindOfReason("パスワードの欄")).toBe("password");
});

test("W76a 返事: 出していない選択肢は押せない・もう終わった card は押せない・done は旗を落とす（読み直すまで書けない）・deny は旗を残す", async () => {
  const L = mk(); const t = give(L);
  await L.act(t, "get_window_state", {});
  const c = L.authCards()[0]!;
  for (const bad of ["allow", "always", "register", "x", null, 3]) expect(L.authTake(c.id, bad).ok, String(bad)).toBe(false);
  expect(L.authTake("nope", "done").ok).toBe(false);
  expect(await L.act(t, "type_text", { element_token: "d1", text: "1" })).toMatchObject({ ok: false, why: "human" });
  // deny: card は閉じるが、人にしかできない確認の旗は残る（agent は書けないまま）
  expect(L.authTake(c.id, "deny")).toMatchObject({ ok: true, choice: "deny" });
  L.authDismiss("s:1");
  expect(L.authCards()).toEqual([]);
  expect(await L.act(t, "type_text", { element_token: "d1", text: "1" })).toMatchObject({ ok: false, why: "human" });
  // done: 旗が落ち、読み直すまでは書けない
  expect(L.humanDone("s:1")).toBe(1);
  expect(await L.act(t, "type_text", { element_token: "d1", text: "1" })).not.toMatchObject({ why: "human" });
});

test("W76a 口と panel: 認証 card の返事は人の画面からだけ・deny は gate を残す・一覧に auth が載る・panel は種類と host と絵（peek）と選択肢だけ", () => {
  const m = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  expect(m).toContain('case "authAnswer"');
  expect(Object.keys(HUMAN_OPS)).toContain("authAnswer"); // 人の画面だけ＝入口の判定（sec1・HUMAN_OPS）が断る
  expect(m).toContain("keepGate: true");
  expect(m).toContain("auth: leases.authCards()");
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  const card = js.slice(js.indexOf("function authCardEl"), js.indexOf("function renderApprove"));
  expect(card).toContain("peekEl(c.key)");
  expect(card).toContain('call("authAnswer"');
  expect(card).not.toMatch(/innerHTML|title|surface/); // 面の題を出さない
});
