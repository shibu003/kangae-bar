// W78p（inventory §10.0 #6 後半）: 歯車の「覚えた許し」。認証の always（host×口）・聞かずに開く・書き込みの always allow を 1 画面に並べ、［戻す］でその 1 件だけ聞くに戻す。
// 値も item の参照も出さない（host / app の名前と口の種類だけ）。戻すは人だけ。実機の見た目は未測（要 operator）
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAlways, register, setAlways } from "../src/authrules.ts";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let top: string, ui: string, H: any;
beforeEach(() => {
  top = realpathSync(mktmp("w78p")); ui = join(top, "ui"); mkdirSync(ui); mkdirSync(join(top, "nodes")); mkdirSync(join(top, "lease"));
  H = makeHandler(openStore(":memory:"), async () => [], undefined, { ...defaultWorkspace(), dir: join(top, "nodes") }, { uiHome: ui, leaseDriver: () => null });
});
afterEach(() => rmSync(top, { recursive: true, force: true }));
const src = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const ids = async () => ((await H({ op: "remembered" }, {})).items as { id: string; label: string }[]).map((x) => x.id).sort();
const seed = async () => { register(ui, "school.example", "password"); setAlways(ui, "school.example", "password", true); register(ui, "mail.example", "otp"); setAlways(ui, "mail.example", "otp", true); register(ui, "bank.example", "password"); /* always 無し＝一覧に出ない */ writeFileSync(join(ui, "open-allow"), ""); await H({ op: "leaseMode", app: "Zed", mode: "allow" }, {}); await H({ op: "leaseMode", app: "Preview", mode: "ask" }, {}); };

test("W78p 空: まだ何も覚えていません（items 0）", async () => {
  expect((await H({ op: "remembered" }, {})).items).toEqual([]);
  expect(src("extension/panel.html")).toContain('<p id="remembered-empty">まだ何も覚えていません</p>');
});

test("W78p 3 種が出る: 認証の always（host×口）・聞かずに開く・書き込みの always allow。always の無い登録・ask の app は出ない・値も鍵も出ない", async () => {
  await seed();
  const r = await H({ op: "remembered" }, {});
  expect(r.items.map((x: any) => x.label).sort()).toEqual(["Zed の操作", "mail.example の認証コードの入力", "school.example のパスワードの入力", "必要な tab や app を、聞かずに裏で開く"].sort());
  expect(await ids()).toEqual(["auth|mail.example|otp", "auth|school.example|password", "open", "write|Zed"].sort());
  const all = JSON.stringify(r);
  expect(all).not.toMatch(/bank\.example|Preview|"at"|token|secret/); // 登録だけの host・ask の app・時刻・鍵は出ない
  expect(Object.keys(r.items[0]).sort()).toEqual(["id", "label"]); // id と label だけ
});

test("W78p 戻すはその 1 件だけ: 該当 file / 表から 1 行だけ消え、他の 2 種・同じ host の別の口は残る", async () => {
  await seed();
  register(ui, "school.example", "otp"); setAlways(ui, "school.example", "otp", true);
  expect((await H({ op: "forget", id: "auth|school.example|password" }, {})).ok).toBe(true);
  expect(isAlways(ui, "school.example", "password")).toBe(false);
  expect(isAlways(ui, "school.example", "otp")).toBe(true); // 同じ host の別の口は残る
  expect(isAlways(ui, "mail.example", "otp")).toBe(true);
  expect(existsSync(join(ui, "open-allow"))).toBe(true);
  expect(await ids()).toEqual(["auth|mail.example|otp", "auth|school.example|otp", "open", "write|Zed"].sort());
  expect((await H({ op: "forget", id: "open" }, {})).ok).toBe(true);
  expect(existsSync(join(ui, "open-allow"))).toBe(false);
  expect((await H({ op: "forget", id: "write|Zed" }, {})).items.map((x: any) => x.id).sort()).toEqual(["auth|mail.example|otp", "auth|school.example|otp"]);
  expect((await H({ op: "leaseMode", app: "Zed", mode: "ask" }, {})).modes.Zed).toBe("ask");
});

test("W78p 戻せるのは人だけ・一覧に無い id は何もしない（agent の CLI・owner つき・作り物の id・登録だけの host を always にしない）", async () => {
  await seed();
  expect(await H({ op: "forget", id: "open" }, { write() {} })).toMatchObject({ ok: false });
  expect(await H({ op: "forget", id: "open", owner: "s:1" }, {})).toMatchObject({ ok: false });
  expect(existsSync(join(ui, "open-allow"))).toBe(true);
  for (const id of ["", "auth|bank.example|password", "auth|nowhere.example|otp", "write|Preview", "write|Nothing", "open|x", "../x", "auth|school.example|passkey"]) expect(await H({ op: "forget", id }, {}), id).toMatchObject({ ok: false });
  expect(await ids()).toHaveLength(4); // 何も消えていない
  expect(isAlways(ui, "bank.example", "password")).toBe(false); // 戻す口が always を付けることもない
});

test("W78p panel: 歯車の節「覚えた許し」・［戻す］は forget の口・内部語なし", () => {
  const html = src("extension/panel.html"), js = src("extension/panel.js");
  const sec = html.match(/<details id="remembered-sec">[\s\S]*?<\/details>/)![0];
  expect(sec).toContain("<summary>覚えた許し</summary>");
  expect(sec).not.toMatch(/lease|token|origin|\bop\b|always|vault|auth-rules/);
  expect(js).toContain('call("forget", { id: it.id })');
  expect(js).toContain("void loadRemembered();");
  expect(js).toContain('b.textContent = "戻す"');
});
