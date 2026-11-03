// review-press2: W72・W80・W81 の後の押す操作を AC の外から破りに行く。各 test の頭に「自分の実装が落ちる点」を書く
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { extractPress, readPress, savePress, type AimedRecord, type Press } from "../src/press";
import { canonical, exportPress, importPress, keepShared, readShared } from "../src/press-share";
import { handlePress, makeAims, makePressHub } from "../src/press-cli";
import { PRESS_BANNED } from "../src/press-card";
import { env, mkPress, tmp } from "./press-fixture";

const one = (o: Partial<Press> = {}): Press => mkPress({ id: "c0ffee01", fields: {}, limits: {}, runs: { total: 0, clean: 0 }, stages: [{ n: 1, kind: "op", goal: "予定を保存する", post: { kind: "none" }, way: { kind: "act", app: "web", tool: "press_button", args: { name: { const: "保存" } } } }], ...o });
const shareFile = (home: string, p: Press) => { savePress(home, p); const out = join(tmp(), "x.kangae-press.json"); expect(exportPress(home, p.id, out).ok).toBe(true); return out; };
const count = (home: string) => (existsSync(join(home, "presses")) ? readdirSync(join(home, "presses")).filter((f) => f.endsWith(".json")).length : 0);
const hubDeps = (home: string, hub = makePressHub()) => ({ home, hub, agent: false, node: 1, busy: () => false, ext: () => false, deps: () => ({}) as any, say: () => {} });

describe("① import の 2 段（W81）", () => {
  // 落ちる点: readShared が確かめるついでに保存すると、card を見てやめた人の file system に他人の押す操作が残る
  test("readShared と「path → card」は presses/ の件数を増やさない・「始める」で初めて 1 増える", async () => {
    const a = tmp(), b = tmp(), out = shareFile(a, one());
    expect(readShared(out, env()).ok).toBe(true);
    expect(count(b)).toBe(0);
    const h = hubDeps(b);
    const r = await handlePress({ action: "import", path: out }, h);
    expect(r.ok).toBe(true);
    expect(count(b)).toBe(0);
    const s = await handlePress({ action: "import", key: r.key }, h);
    expect(s.ok).toBe(true);
    expect(count(b)).toBe(1);
  });
  // 落ちる点: 「始める」の時に file を読み直すと、card を見せた後で書き換えられた file（別の goal）が保存される（TOCTOU）
  test("card を見せた後に file を書き換えても、保存されるのは card で見せた物", async () => {
    const a = tmp(), b = tmp(), out = shareFile(a, one());
    const h = hubDeps(b);
    const r = await handlePress({ action: "import", path: out }, h);
    const other = shareFile(tmp(), one({ stages: [{ ...one().stages[0]!, goal: "全部の予定を消す" }] }));
    writeFileSync(out, readFileSync(other));
    const s = await handlePress({ action: "import", key: r.key }, h);
    expect(s.ok).toBe(true);
    expect(readPress(b, "c0ffee01")!.stages[0]!.goal).toBe("予定を保存する");
  });
  // 落ちる点: key を使い回せる（2 回目の「始める」・別の key）と、保存済みの物を再保存／存在しない key で何かが保存される
  test("key は 1 回きり・知らない key は何も保存しない", async () => {
    const a = tmp(), b = tmp(), out = shareFile(a, one());
    const h = hubDeps(b);
    const r = await handlePress({ action: "import", path: out }, h);
    expect((await handlePress({ action: "import", key: "deadbeef" }, h)).ok).toBe(false);
    expect(count(b)).toBe(0);
    expect((await handlePress({ action: "import", key: r.key }, h)).ok).toBe(true);
    expect((await handlePress({ action: "import", key: r.key }, h)).ok).toBe(false);
  });
});

describe("② 署名", () => {
  // 落ちる点: 署名の対象が file の bytes だと、欄の順序を入れ替えただけの file（意味は同じ）を断る／逆に正規化が壊れていると順序の入れ替えで署名が合わなくなる
  test("press の欄（object の key）の順序だけ入れ替えた file は通る・段（配列）の順序を入れ替えた file は断る", () => {
    const a = tmp(), b = tmp();
    const p = one({ fields: { b: { ask: true }, a: { fixed: "x" } }, stages: [{ ...one().stages[0]! }, { ...one().stages[0]!, n: 2, goal: "二つ目" }] });
    const out = shareFile(a, p);
    const j = JSON.parse(readFileSync(out, "utf8"));
    const rev = (o: any): any => Array.isArray(o) ? o.map(rev) : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).reverse().map((k) => [k, rev(o[k])])) : o;
    const f1 = join(tmp(), "r.kangae-press.json"); writeFileSync(f1, JSON.stringify({ ...j, press: rev(j.press) }));
    expect(importPress(b, f1, env()).ok).toBe(true);
    j.press.stages.reverse();
    const f2 = join(tmp(), "s.kangae-press.json"); writeFileSync(f2, JSON.stringify(j));
    expect(readShared(f2, env()).ok).toBe(false);
  });
  // 落ちる点: pub を差し替えて自分で署名し直し madeBy.fp も合わせた file が、元の送り手の指紋のまま見える
  test("pub を差し替えて署名し直した file は通るが、card の「送り手」の指紋は元と違う", () => {
    const a = tmp(), out = shareFile(a, one());
    const orig = readShared(out, env()); if (!orig.ok) throw new Error("orig");
    const j = JSON.parse(readFileSync(out, "utf8"));
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    j.pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    j.press.madeBy.fp = createHash("sha256").update(Buffer.from(j.pub, "base64")).digest("hex").slice(0, 16);
    j.sig = sign(null, Buffer.from(canonical(j.press)), privateKey).toString("base64");
    const f = join(tmp(), "f.kangae-press.json"); writeFileSync(f, JSON.stringify(j));
    const r = readShared(f, env()); if (!r.ok) throw new Error("forged should verify as someone else");
    const line = (c: typeof r.card) => c.lines.find((l) => l.startsWith("送り手"))!;
    expect(line(r.card)).not.toBe(line(orig.card));
    expect(line(r.card)).toContain(r.press.madeBy!.fp.slice(0, 8));
  });
});

describe("③ 書き出しの秘匿（W81）", () => {
  // 落ちる点: 記録から作った press の way に、記録の時の要素 token（click の的）が const として残り、書き出した file に載る。受け取った人の面では別の要素を指す
  test("click の element_token・座標・入れた値・長い goal・制御文字・URL の query・〈伏せ〉は書き出しの file に 1 つも無い", () => {
    const secret = "S3CR3T-VALUE-9999", url = "https://mail.example.com/inbox?token=ABCDEF123456";
    const recs: AimedRecord[] = [
      { at: 1, face: "tab:9", app: url, gen: 3, op: "fill", value: secret, result: "ok", owner: "s:1", where: "", target: "件名‮" + "あ".repeat(200) },
      { at: 2, face: "tab:9", app: "Chrome", gen: 3, op: "fill", value: "〈伏せ〉", result: "ok", owner: "s:1", where: "", target: "pass" },
      { at: 3, face: "tab:9", app: "Chrome", gen: 3, op: "click", value: "{\"x\":412,\"y\":77}", result: "ok", owner: "s:1", where: "", el: "e7_TOKEN" },
      { at: 4, face: "tab:9", app: "Chrome", gen: 3, op: "press_button", value: "{}", result: "ok", owner: "s:1", where: "", target: "送信" },
    ];
    const home = tmp(), p = extractPress(recs, { owner: "s:1", name: "x" });
    savePress(home, p);
    const out = join(tmp(), "o.kangae-press.json"); expect(exportPress(home, p.id, out).ok).toBe(true);
    const raw = readFileSync(out, "utf8");
    const hit = [secret, "token=ABCDEF", "e7_TOKEN", "element_token", "〈伏せ〉", "\"x\":412", "‮", "あ".repeat(81)].filter((b) => raw.includes(b));
    expect(hit).toEqual([]);
    for (const g of JSON.parse(raw).press.stages.map((s: any) => s.goal)) expect(g.length).toBeLessThanOrEqual(80);
    // 残ってよい物（境界の確認）: 名前つきの button の const・欄の宣言
    expect(raw.includes("送信")).toBe(true);
  });
  // 落ちる点: 「渡す」前から保存してあった fixed の欄（人が毎回同じにした値）まで消すと const の約束と食い違う
  test("fixed の欄の値は残る（const は残ってよい）", () => {
    const home = tmp(), out = shareFile(home, one({ fields: { cal: { fixed: "仕事" } } }));
    expect(readFileSync(out, "utf8")).toContain("仕事");
  });
});

describe("④ 的の入れ替わり（W72 ⑤）", () => {
  // 落ちる点: 同じ面・世代・操作の act が並行 2 本走ると、記録（完了順）が後から来た的を先の記録に付け、press が別の欄に入れる
  test("同じ面・世代で fill が並行 2 本 → 各記録に自分の欄名が付く", async () => {
    const aims = makeAims(), tok = "tab:9|3|s:1", rec = (v: string) => ({ at: 1, face: "tab:9", app: "Chrome", gen: 3, op: "fill", value: v, result: "ok", owner: "s:1", where: "" });
    const got: any[] = [];
    // 本物の門と同じ: 記録は act の完了の時（完了順）に 1 回
    const gate = { act: async (_t: string, _tool: string, a: any) => { await Bun.sleep(a.field === "件名" ? 30 : 5); got.push(aims.tag(rec(a.value) as any)); return { ok: true, text: "ok" }; } };
    await Promise.all([aims.act(gate, tok, "fill", { field: "件名", value: "AAA" }), aims.act(gate, tok, "fill", { field: "宛先", value: "BBB" })]);
    const byValue = Object.fromEntries(got.map((r) => [r.value, r.target]));
    expect(byValue).toEqual({ AAA: "件名", BBB: "宛先" });
  });
});

describe("⑤ card の禁止語（W70・W81）", () => {
  const hostile = (s: string) => `${s}`;
  // 落ちる点: 欄の label・段の goal に禁止語（全角・RTL・制御文字で隠した物を含む）を入れた file の card が、警告を付けただけで本文にその語を出す
  test("欄の label・段の goal の禁止語は readShared の返す card の本文（title・lines・steps）に 1 つも出ない・detail は問わない・cardOk は false", () => {
    for (const w of ["adb", "ＡＤＢ", "a‮db", "po​rt", "DOM"]) {
      const a = tmp();
      const out = shareFile(a, one({ fields: { q: { ask: true, label: hostile(`${w}の値`) } }, stages: [{ ...one().stages[0]!, goal: `${w} を使う` }] }));
      const r = readShared(out, env()); if (!r.ok) throw new Error("import");
      expect(r.cardOk).toBe(false);
      const main = [r.card.title, ...r.card.lines, ...r.card.steps.map((s) => s.text)].join("\n").replace(/[\p{Cc}\p{Cf}]/gu, "").normalize("NFKC");
      for (const b of PRESS_BANNED) if (/^[A-Za-z]+$/.test(b)) expect(new RegExp(`(?<![A-Za-z0-9])${b}(?![A-Za-z0-9])`, "i").test(main)).toBe(false);
    }
  });
  // 落ちる点: 欄の名前（key）・送り手の名前（madeBy.name）が card に回り込む。名前は NAME の regex・fp だけのはず
  test("madeBy.name に禁止語を入れても card は指紋だけ・欄の key の禁止語は主画面に出ない", () => {
    const a = tmp(), out = shareFile(a, one({ fields: { adb_pair: { ask: true } } }));
    const j = JSON.parse(readFileSync(out, "utf8")); j.press.madeBy.name = "adb の人";
    const r = readShared(out, env()); if (!r.ok) throw new Error("import");
    expect([r.card.title, ...r.card.lines].join("\n")).not.toMatch(/adb/i);
    expect(JSON.stringify(r.press.madeBy)).not.toContain("adb");
  });
});

describe("⑥ 受け取るの断り方（W81 の UI の口）", () => {
  // 落ちる点: 空・存在しない path・JSON でない file の 3 つで、何が起きたかしか言わず、次の一手（何をすればよいか）を言わない
  test("空 / 存在しない / JSON でない → 各々 1 行（改行なし）で次の一手を含む・別々の文", async () => {
    const b = tmp(), junk = join(tmp(), "j.json"); writeFileSync(junk, "これは JSON ではない");
    const h = hubDeps(b);
    const hints: string[] = [];
    for (const path of ["", join(tmp(), "nothing.kangae-press.json"), junk]) {
      const r = await handlePress({ action: "import", path }, h);
      expect(r.ok).toBe(false);
      const t = String(r.hint);
      expect(t.includes("\n")).toBe(false);
      expect(t).toMatch(/してください|確かめて|選び直して|入れて/); // 次の一手の言い回し
      hints.push(t);
    }
    expect(new Set(hints).size).toBe(3);
    expect(count(b)).toBe(0);
  });
  // 落ちる点: 「渡す」の文に path の生の絶対 path（/Users/…）だけが出て、どこに在るかが人の言葉で言われない
  test("press.js の「渡す」の文は Downloads の言葉で場所を言う", () => {
    expect(readFileSync(join(import.meta.dir, "../extension/press.js"), "utf8")).toMatch(/ダウンロード/);
  });
});

describe("keepShared の同 id（W81 周辺）", () => {
  // 落ちる点: 同じ送り手の再読み込みで、別人の物ではないのに自分の押した履歴を黙って 0 に戻す
  test("同じ送り手の同じ id を受け取り直しても、既に受け取った物の再現率を 0 にしない", () => {
    const a = tmp(), b = tmp(), out = shareFile(a, one());
    const r = readShared(out, env()); if (!r.ok) throw new Error("x");
    keepShared(b, r.press);
    savePress(b, { ...readPress(b, "c0ffee01")!, runs: { total: 4, clean: 4 } });
    keepShared(b, r.press);
    expect(readPress(b, "c0ffee01")!.runs.total).toBe(4);
  });
});
