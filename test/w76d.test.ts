// W76d（要件 14・29）: 認証 card の「登録する」= この host×口 を金庫（Bitwarden）の項目の id に結ぶ。値は保存しない（host・口・項目の参照だけ・0600）。
// 登録できるのは金庫が開いている時だけ・人の画面だけ・複数あれば人が名前で選ぶ・登録した項目が host に合わなくなったら入れない。登録後に allow / always が出る
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ITEM_RE, isRegistered, register, ruleOf } from "../src/authrules.ts";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(120_000);

const PASS = "hunter2-VAULT-VALUE-7731", TOTP = "483920", KEY = "fake-session-key-abc";
let top: string, ui: string;
beforeEach(() => { top = realpathSync(mktmp("w76d")); ui = join(top, "ui"); mkdirSync(ui); });
afterEach(() => { rmSync(top, { recursive: true, force: true }); delete process.env.KANGAE_BW; });
const items = (list: { id: string; name: string; host: string }[]) => writeFileSync(join(top, "items.json"), JSON.stringify(list.map((i) => ({ id: i.id, name: i.name, login: { username: "SECRET-USER", password: PASS, uris: [{ uri: `https://${i.host}/` }] } }))));
const fakeBw = () => { const f = join(top, "bw"); writeFileSync(f, `#!/bin/sh\necho "$@" >> "${top}/bw.log"\n[ "$BW_SESSION" = "${KEY}" ] || exit 1\nif [ "$1" = list ]; then cat "${top}/items.json"; elif [ "$2" = totp ]; then printf '%s\\n' '${TOTP}'; else printf '%s\\n' '${PASS}'; fi\n`); chmodSync(f, 0o755); return f; };

async function boot(o: { unlock?: boolean } = {}) {
  process.env.KANGAE_BW = fakeBw();
  const s = openStore(":memory:"), ext = {}, sent: string[] = [], bc: string[] = []; let h: any;
  const reply = (m: any) => { if (m.type !== "web") return; const data = m.tool === "tab_state" ? { exists: true, docId: "d1" } : m.tool === "tab_info" ? { docId: "d1", title: "t", url: "https://shop.example.com/login" } : m.tool === "get_window_state" ? { snapshot_id: "s", elements: [{ element_token: "p1", role: "textbox", label: "コード", value: "", gate: "otp" }] } : m.tool === "vault_fill" ? (typeof m.args.value === "string" ? { filled: m.args.value.length } : { n: 1 }) : null; queueMicrotask(() => void h({ op: "webResult", callId: m.id, text: "", data }, ext)); };
  h = makeHandler(s, async () => [], undefined, { ...defaultWorkspace(), dir: join(top, "ws") }, { uiHome: ui, awaitWebPeer: true, isExtension: () => true, broadcast: (m: any) => { bc.push(JSON.stringify(m)); reply(m); }, unicast: (_t: any, m: any) => { sent.push(JSON.stringify(m)); reply(m); }, carryMs: 3000 } as any);
  const root = s.add(null, "user", "課題", true), owner = `s:${root.id}`;
  await h({ op: "webHello" }, ext);
  await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" });
  if (o.unlock !== false) await h({ op: "vaultKey", key: KEY });
  await h({ op: "act", owner, on: "tab", tool: "get_window_state", args: {} }); // 認証コードの欄が見える＝gate が立つ
  const card = async () => ((await h({ op: "leaseList" })) as any).auth[0];
  const ids = async () => (await card()).options.map((x: any) => x.id);
  return { h, owner, sent, bc, card, ids };
}

test("W76d 登録: 金庫が開いていて未登録なら「登録する」が出る・項目が 1 つなら結ぶ・rules には host・口・項目の id だけ（値・鍵・項目名・user 名は無い・0600）・登録後に allow / always が出る", async () => {
  items([{ id: "item-1", name: "Shop 本垢", host: "shop.example.com" }]);
  const { h, card, ids } = await boot();
  expect(await ids()).toEqual(["done", "register", "deny"]); // 未登録: 自動は出ない
  const c = await card();
  expect(await h({ op: "authAnswer", authId: c.id, choice: "allow" })).toMatchObject({ ok: false }); // 未登録のまま自動は押せない
  expect(await h({ op: "authAnswer", authId: c.id, choice: "register" })).toMatchObject({ ok: true, registered: true });
  expect(ruleOf(ui, "shop.example.com", "otp")).toMatchObject({ always: false, item: "item-1" });
  expect(await ids()).toEqual(["done", "allow", "always", "deny"]);
  const file = readFileSync(join(ui, "auth-rules.json"), "utf8");
  for (const leak of [PASS, TOTP, KEY, "SECRET-USER", "Shop 本垢", "bw"]) expect(file, leak).not.toContain(leak);
  expect(statSync(join(ui, "auth-rules.json")).mode & 0o777).toBe(0o600);
});

test("W76d 複数の項目: 人が名前で選ぶ（返すのは id と名前だけ・値と user 名は出ない）・選んだ物が候補に無い id は結べない", async () => {
  items([{ id: "item-a", name: "個人", host: "shop.example.com" }, { id: "item-b", name: "会社", host: "shop.example.com" }, { id: "item-x", name: "別 site", host: "other.example.com" }]);
  const { h, card } = await boot();
  const c = await card();
  const r: any = await h({ op: "authAnswer", authId: c.id, choice: "register" });
  expect(r).toMatchObject({ ok: true }); expect(r.registered).toBeUndefined();
  expect(r.pick).toEqual([{ id: "item-a", name: "個人" }, { id: "item-b", name: "会社" }]); // 別 site の項目は出ない
  expect(JSON.stringify(r)).not.toMatch(/SECRET-USER|hunter2/);
  expect(isRegistered(ui, "shop.example.com", "otp")).toBe(false); // まだ結んでいない
  expect((await h({ op: "authAnswer", authId: c.id, choice: "register", itemId: "item-x" })).registered).toBeUndefined(); // 別 site の項目は選べない
  expect(isRegistered(ui, "shop.example.com", "otp")).toBe(false);
  expect(await h({ op: "authAnswer", authId: c.id, choice: "register", itemId: "item-b" })).toMatchObject({ ok: true, registered: true });
  expect(ruleOf(ui, "shop.example.com", "otp")?.item).toBe("item-b");
});

test("W76d 出ない・断る: 金庫が閉じている時は「登録する」を出さない・項目が 0 件なら理由つきで断る・agent の CLI からは登録できない・形の悪い id は結べない", async () => {
  items([{ id: "item-1", name: "x", host: "shop.example.com" }]);
  const closed = await boot({ unlock: false });
  expect(await closed.ids()).toEqual(["done", "deny"]);
  items([]);
  const empty = await boot();
  const r = await empty.h({ op: "authAnswer", authId: (await empty.card()).id, choice: "register" });
  expect(r).toMatchObject({ ok: false, hint: expect.stringContaining("項目がありません") });
  expect((await empty.h({ op: "authAnswer", authId: (await empty.card()).id, choice: "register" }, { write() {} })).ok).toBe(false);
  for (const bad of ["../x", "a b", "", "x".repeat(65), "-x"]) { expect(ITEM_RE.test(bad), bad).toBe(false); expect(register(ui, "a.example", "otp", bad), bad).toBe(false); }
  expect(isRegistered(ui, "a.example", "otp")).toBe(false);
});

test("W76d 登録した項目で入れる: allow は登録した項目の値を人の面へ 1 回（返事・broadcast・rules に値は無い）・項目が host に合わなくなったら入れない", async () => {
  items([{ id: "item-1", name: "Shop", host: "shop.example.com" }]);
  const { h, sent, bc, card } = await boot();
  const c = await card();
  await h({ op: "authAnswer", authId: c.id, choice: "register" });
  items([{ id: "item-1", name: "Shop", host: "moved.example.com" }]); // 項目の URL が変わった（もう host に合わない）
  const bad: any = await h({ op: "authAnswer", authId: c.id, choice: "allow" });
  expect(bad.ok).toBe(false);
  expect(sent.filter((x) => x.includes(TOTP)).length).toBe(0);
  items([{ id: "item-1", name: "Shop", host: "shop.example.com" }]);
  const ok: any = await h({ op: "authAnswer", authId: c.id, choice: "allow" });
  expect(ok).toMatchObject({ ok: true });
  expect(sent.filter((x) => x.includes(TOTP)).length).toBe(1);
  for (const x of [JSON.stringify(ok), ...bc, JSON.stringify(await h({ op: "leaseList" })), readFileSync(join(ui, "auth-rules.json"), "utf8")]) { expect(x).not.toContain(TOTP); expect(x).not.toContain(PASS); }
});

test("W76d 同じ host に項目が複数でも、登録した項目で入れる（登録が無ければ曖昧で入れない）", async () => {
  items([{ id: "item-a", name: "個人", host: "shop.example.com" }, { id: "item-b", name: "会社", host: "shop.example.com" }]);
  const { h, sent, card } = await boot();
  const c = await card();
  await h({ op: "authAnswer", authId: c.id, choice: "register", itemId: "item-b" });
  expect(await h({ op: "authAnswer", authId: c.id, choice: "allow" })).toMatchObject({ ok: true });
  expect(readFileSync(join(top, "bw.log"), "utf8")).toContain("get totp item-b");
  expect(readFileSync(join(top, "bw.log"), "utf8")).not.toContain("item-a");
  expect(sent.filter((x) => x.includes(TOTP)).length).toBe(1);
});

test("W76d panel: 複数の項目は名前の button で選ぶ（値は見せない）・登録の返事は card の選択肢を更新する", () => {
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(js).toContain("どの項目に結びますか");
  expect(js).toContain('choice: "register", itemId: it.id');
  const m = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  expect(m).toContain("authCanRegister: () => vault.unlocked()");
  expect(m).toContain("itemId: ruleOf(uiHome(), c.host, c.kind)?.item");
});
