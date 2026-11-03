// W76c（要件 29・38・30）: 認証 card の自動認証。登録済みの local agent（金庫）が居る時だけ allow / always allow が出て、password か認証コード（TOTP）を人の Chrome の面の欄へ直接入れる。
// 値は金庫 → 拡張の 1 回 → 捨てる（agent・card・log・返事に出ない）。passkey・CAPTCHA は人のまま。always allow は登録済みの host×口にだけ・人の画面からだけ保存
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authOptions, makeAuthCards } from "../src/authcard.ts";
import { hostKey, isAlways, isRegistered, register, ruleOf, setAlways } from "../src/authrules.ts";
import type { Driver } from "../src/lease.ts";
import { makeLeases, tokenOf } from "../src/lease.ts";
import { HUMAN_OPS, defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { makeVault } from "../src/vault.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(120_000);

const PASS = "hunter2-VAULT-VALUE-7731", TOTP = "483920", KEY = "fake-session-key-abc";
let top: string, ui: string;
beforeEach(() => { top = realpathSync(mktmp("w76c")); ui = join(top, "ui"); mkdirSync(ui); });
afterEach(() => { rmSync(top, { recursive: true, force: true }); delete process.env.KANGAE_BW; });
const fakeBw = (totp = TOTP) => {
  const f = join(top, "bw"); writeFileSync(join(top, "items.json"), JSON.stringify([{ id: "i1", login: { uris: [{ uri: "https://shop.example.com/" }] } }]));
  writeFileSync(f, `#!/bin/sh\n[ "$BW_SESSION" = "${KEY}" ] || exit 1\nif [ "$1" = list ]; then cat "${top}/items.json"; elif [ "$2" = totp ]; then printf '%s\\n' '${totp}'; else printf '%s\\n' '${PASS}'; fi\n`); chmodSync(f, 0o755);
  return f;
};

test("W76c 登録: host×口ごとに 0600・always は登録済みにだけ付く・host は大小・origin でも同じ・値は持たない", () => {
  expect(setAlways(ui, "https://shop.example.com", "password", true)).toBe(false); // 未登録に always は付けない
  register(ui, "https://Shop.Example.com", "password");
  expect(isRegistered(ui, "shop.example.com", "password")).toBe(true);
  expect(isRegistered(ui, "shop.example.com", "otp")).toBe(false);
  expect(isAlways(ui, "https://shop.example.com", "password")).toBe(false);
  expect(setAlways(ui, "https://shop.example.com/login", "password", true)).toBe(true);
  expect(isAlways(ui, "shop.example.com", "password")).toBe(true);
  expect(statSync(join(ui, "auth-rules.json")).mode & 0o777).toBe(0o600);
  expect(hostKey("https://Shop.Example.com/x")).toBe("shop.example.com");
  expect(readFileSync(join(ui, "auth-rules.json"), "utf8")).not.toMatch(/hunter|bw|session/);
  expect(ruleOf(ui, "other.example.com", "password")).toBeNull();
});

test("W76c 選択肢は今の状態で決まる: 金庫を後で開く・登録した後に card の選択肢が増える・window の面は自動にしない・passkey / CAPTCHA は出さない", () => {
  let ready = false, reg = false;
  const A = makeAuthCards({ autoReady: () => ready, registered: () => reg });
  const c = A.add({ owner: "s:1", key: "tab:7", reason: "パスワードの欄", host: "https://shop.example.com" });
  const ids = () => A.list()[0]!.options.map((o) => o.id);
  expect(ids()).toEqual(["done", "deny"]);
  reg = true; expect(ids()).toEqual(["done", "deny"]); // 登録済みでも金庫が閉じていれば出ない
  ready = true; expect(ids()).toEqual(["done", "allow", "always", "deny"]);
  expect(A.take(c.id, "always")).toMatchObject({ ok: true, choice: "always" });
  ready = false; expect(A.take(c.id, "allow").ok).toBe(false); // 閉じたら押せない
  ready = true;
  const w = makeAuthCards({ autoReady: () => true, registered: () => true });
  w.add({ owner: "s:1", key: "10:2", reason: "パスワードの欄", host: "Safari" });
  expect(w.list()[0]!.options.map((o) => o.id)).toEqual(["done", "deny"]); // window の面（vault は web だけ）
  for (const reason of ["指紋・顔・passkey の確認", "CAPTCHA（人かどうかの確認）"]) {
    const x = makeAuthCards({ autoReady: () => true, registered: () => true });
    x.add({ owner: "s:1", key: "tab:9", reason, host: "https://a.example" });
    expect(x.list()[0]!.options.map((o) => o.id), reason).toEqual(["done", "deny"]);
  }
  expect(authOptions({ kind: "otp", registered: true, autoReady: true, canRegister: false }).map((o) => o.id)).toEqual(["done", "allow", "always", "deny"]);
});

test("W76c 金庫: 承諾済み（allow）は card を出さずに入れる・password も認証コードも値は拡張へ 1 回だけ・返事 / card / 他の呼びに値は 0 件・認証コードは 6〜8 桁だけ・人の Chrome の面が無ければ入れない", async () => {
  process.env.KANGAE_BW = fakeBw();
  const calls: { tool: string; args: Record<string, any> }[] = [];
  const web: Driver = { call: async (tool, args) => { calls.push({ tool, args }); if (tool === "tab_info") return { text: "", isError: false, data: { url: "https://shop.example.com/login" } }; return typeof args.value === "string" ? { text: "filled", isError: false, data: { filled: args.value.length } } : { text: "probe", isError: false, data: { n: 1 } }; }, close() {} };
  const mk = (faces = [{ tabId: 1, gen: 3 }]) => makeVault({ web: () => web, faces: () => faces, browserUrl: async () => null, bin: () => process.env.KANGAE_BW!, session: () => KEY, approvalMs: 500 });
  const v = mk();
  const p = await v.fill("s:1", "https://shop.example.com/login", { approved: true, kind: "password" });
  const o = await v.fill("s:1", "https://shop.example.com/login", { approved: true, kind: "otp" });
  expect(p.ok && o.ok).toBe(true);
  expect(v.cards()).toEqual([]); // 承諾は済んでいる＝card を出さない
  const puts = calls.filter((c) => typeof c.args.value === "string");
  expect(puts.map((c) => [c.args.kind, c.args.value])).toEqual([["password", PASS], ["otp", TOTP]]);
  expect(calls.filter((c) => c.tool === "vault_fill" && typeof c.args.value !== "string").every((c) => ["password", "otp"].includes(c.args.kind))).toBe(true); // 下見も種類つき
  const rest = JSON.stringify([p, o, v.cards(), calls.filter((c) => !puts.includes(c))]);
  expect(rest).not.toContain(PASS); expect(rest).not.toContain(TOTP);
  // 値の形が悪い（認証コードでない文字）は入れない
  process.env.KANGAE_BW = fakeBw("not-a-code");
  expect((await mk().fill("s:1", "https://shop.example.com/login", { approved: true, kind: "otp" })).ok).toBe(false);
  // 人の Chrome の面が無い（agent 用ブラウザの password 欄へは入れても、認証コードは入れない）
  process.env.KANGAE_BW = fakeBw();
  const n = calls.length;
  expect((await mk([]).fill("s:1", "https://shop.example.com/login", { approved: true, kind: "otp" })).ok).toBe(false);
  expect(calls.slice(n).filter((c) => typeof c.args.value === "string")).toEqual([]);
  // 承諾が無い通常の fill は今までどおり card を待つ（時間切れで入れない）
  const q = await mk().fill("s:1", "https://shop.example.com/login");
  expect(q.ok).toBe(false);
});

test("W76c 面の gate → card → 自動: 新しく立った時だけ onAuthCard が呼ばれる（再検出で呼ばない）・登録済みの欄が入力欄として選択肢に出る", async () => {
  const seen: string[] = [];
  const web: Driver = { call: async (tool) => tool === "tab_state" ? { text: "", isError: false, data: { exists: true, docId: "d1" } } : tool === "tab_info" ? { text: "", isError: false, data: { docId: "d1", url: "https://shop.example.com/login" } } : tool === "get_window_state" ? { text: "", isError: false, data: { snapshot_id: "s", elements: [{ element_token: "p1", role: "textbox", label: "pw", value: "", gate: "otp" }] } } : { text: "ok", isError: false, data: null }, close() {} };
  register(ui, "https://shop.example.com", "otp");
  const L = makeLeases(ui, { web, defaultMode: "allow", authAuto: () => true, authRegistered: (h, k) => isRegistered(ui, h, k as any), onAuthCard: (c) => void seen.push(`${c.kind}:${c.host}`) });
  const g = L.give({ tabId: 7, docId: "d1", app: "Chrome", title: "t", url: "https://shop.example.com/login" }, "s:1"); if (!g.ok) throw new Error();
  g.lease.hold = false;
  const t = tokenOf(g.lease);
  await L.act(t, "get_window_state", {}); await L.act(t, "get_window_state", {});
  expect(seen).toEqual(["otp:https://shop.example.com"]);
  expect(L.authCards()[0]!.options.map((o) => o.id)).toEqual(["done", "allow", "always", "deny"]);
});

test("W76c 口: allow / always は人の画面からだけ・出していない選択肢は押せない・always は成功した後にだけ保存・agent の op に保存の口は無い・panel の選択肢は card の物だけ", async () => {
  const m = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  expect(Object.keys(HUMAN_OPS)).toContain("authAnswer"); // 人が押す op の入口（sec1）で agent の口は断られる。下の H(…, { write() {} }) が実際に断られる事を測る
  expect(m).toContain('if (t.choice === "allow" || t.choice === "always")');
  expect(m.indexOf("const r = await runAuto(t.card);")).toBeLessThan(m.indexOf('setAlways(uiHome(), t.card.host, t.card.kind, true)'));
  expect(m).toContain("vault.fill(c.owner, url, { approved: true, kind: c.kind, itemId: ruleOf(uiHome(), c.host, c.kind)?.item })"); // W76d: 登録した項目だけで入れる
  expect(m).toContain("isAlways(uiHome(), c.host, c.kind)");
  expect(m.match(/setAlways\(uiHome\(\), [^)]*, true\)/g)!.length).toBe(1); // always を付ける口は authAnswer の 1 か所だけ（W78p の「戻す」は false にするだけ・付ける口ではない）
  expect(m.match(/setAlways\(uiHome\(\), [^)]*, false\)/g)!.length).toBe(1);
  const store = openStore(":memory:");
  const H: any = makeHandler(store, async () => [], undefined, { ...defaultWorkspace(), dir: join(top, "ws") }, { uiHome: ui, leaseDriver: () => null });
  expect((await H({ op: "authAnswer", authId: "x", choice: "always" }, { write() {} })).ok).toBe(false); // agent の CLI
  expect((await H({ op: "authAnswer", authId: "nope", choice: "allow" }, {})).ok).toBe(false);
  expect(readFileSync(join(import.meta.dir, "../extension/web.js"), "utf8")).toContain('a.kind === "otp" ? fillOtp : fillPassword');
});
