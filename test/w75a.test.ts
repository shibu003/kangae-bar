// W75a（CEO 10-14「+でfile…upload・drag&drop…」）: 人が載せた file / 画像を会話の att/<owner>/ に 0600 で置き（512KB chunk）、agent の Read に入れる。置いた物は実行させない・他の会話から読めない
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ATT_FILE_MAX, ATT_TOTAL_MAX, attDir, makeAttach, safeName, sniff } from "../src/attach.ts";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let top: string, ui: string, nodes: string;
beforeEach(() => { top = realpathSync(mktmp("w75a")); ui = join(top, "ui"); nodes = join(top, "nodes"); mkdirSync(ui); mkdirSync(nodes); });
afterEach(() => rmSync(top, { recursive: true, force: true }));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const up = (A: ReturnType<typeof makeAttach>, owner: string, buf: Buffer, name = "a.png", step = 16, id = "up-12345678") => {
  const n = Math.max(1, Math.ceil(buf.length / step));
  let r: any;
  for (let i = 0; i < n; i++) { r = A.chunk(owner, { upId: id, seq: i, last: i === n - 1, name, b64: buf.subarray(i * step, (i + 1) * step).toString("base64") }); if (!r.ok) return r; }
  return r;
};

test("W75a 置く: chunk で送った file は att/<owner>/ に 0600（dir 0700）・種類は先頭バイト・実行 bit なし・中身が同じ", () => {
  const A = makeAttach(ui);
  const r = up(A, "s:1", PNG);
  expect(r).toMatchObject({ ok: true, done: true, att: { kind: "image", name: "a", size: PNG.length } });
  expect(r.att.path.startsWith(attDir(ui, "s:1") + "/")).toBe(true);
  expect(r.att.path.endsWith(".png")).toBe(true);
  expect(statSync(r.att.path).mode & 0o777).toBe(0o600);
  expect(statSync(attDir(ui, "s:1")).mode & 0o777).toBe(0o700);
  expect(readFileSync(r.att.path).equals(PNG)).toBe(true);
  expect(readdirSync(attDir(ui, "s:1")).some((f) => f.startsWith(".up-"))).toBe(false); // 途中の物は残さない
});

test("W75a 種類と名前: 拡張子・名前を偽っても先頭バイトで決まる（.png の名前の実行 file → .bin・.sh の名前の PNG → .png）・名前は整える", () => {
  const A = makeAttach(ui);
  const exe = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00]), Buffer.alloc(30, 7)]); // Mach-O
  const a = up(A, "s:1", exe, "cute.png", 64, "up-aaaaaaaa");
  expect(a.att.path.endsWith(".bin")).toBe(true); expect(a.att.kind).toBe("file");
  const b = up(A, "s:1", PNG, "run.sh", 64, "up-bbbbbbbb");
  expect(b.att.path.endsWith(".png")).toBe(true);
  expect(up(A, "s:1", Buffer.from("こんにちは\nhello"), "m.md", 64, "up-cccccccc").att.path.endsWith(".txt")).toBe(true);
  expect(up(A, "s:1", Buffer.from("%PDF-1.4 x"), "x", 64, "up-dddddddd").att.path.endsWith(".pdf")).toBe(true);
  expect(safeName("../../etc/pa‮ss\u0007wd.png")).not.toMatch(/[\/‮\u0007]/);
  expect(safeName("a".repeat(300)).length).toBe(80);
  expect(safeName("...")).toBe("file");
  expect(sniff(new Uint8Array(0)).ext).toBe("bin");
});

test("W75a 上限: 1 file 8MB を超える・会話の合計 40MB を超える・順番が飛ぶ/重複/最初が 0 でない/空 は断り、途中の残りを消す", () => {
  const A = makeAttach(ui);
  const big = Buffer.alloc(ATT_FILE_MAX + 1, 0x41);
  const r = up(A, "s:1", big, "big.txt", 512 * 1024);
  expect(r.ok).toBe(false); expect(r.hint).toContain("大きすぎます");
  expect(readdirSync(attDir(ui, "s:1")).filter((f) => f.startsWith(".up-"))).toEqual([]);
  // 合計
  const eight = Buffer.alloc(ATT_FILE_MAX, 0x41);
  for (let i = 0; i < ATT_TOTAL_MAX / ATT_FILE_MAX; i++) expect(up(A, "s:2", eight, `f${i}`, 512 * 1024, `up-total${i}0000`).ok).toBe(true);
  const over = up(A, "s:2", Buffer.alloc(10, 0x41), "x", 64, "up-overover");
  expect(over.ok).toBe(false); expect(over.hint).toContain("多すぎます");
  expect(up(A, "s:3", Buffer.alloc(10, 0x41), "x", 64, "up-otherown").ok).toBe(true); // 他の会話の合計とは別
  // 順番
  expect(A.chunk("s:4", { upId: "up-order001", seq: 1, last: true, name: "x", b64: "QQ==" }).ok).toBe(false); // 最初が 0 でない
  expect(A.chunk("s:4", { upId: "up-order002", seq: 0, last: false, name: "x", b64: "QQ==" }).ok).toBe(true);
  expect(A.chunk("s:4", { upId: "up-order002", seq: 0, last: false, name: "x", b64: "QQ==" }).ok).toBe(false); // 重複
  expect(A.chunk("s:4", { upId: "up-order003", seq: 0, last: true, name: "x", b64: "" }).ok).toBe(false); // 空
  expect(readdirSync(attDir(ui, "s:4")).filter((f) => f.startsWith(".up-"))).toEqual([]);
  for (const bad of [{ upId: "../x" }, { upId: "short" }, { upId: "up-badbad01", seq: -1 }, { upId: "up-badbad02", seq: 0, b64: "***" }, { upId: "up-badbad03", seq: 0, b64: "A".repeat(1_000_001) }]) expect(A.chunk("s:5", { last: true, name: "x", b64: "QQ==", seq: 0, ...bad } as any).ok, JSON.stringify(bad).slice(0, 30)).toBe(false);
  expect(existsSync(join(ui, "att", "..", "x"))).toBe(false);
});

test("W75a 会話ごと: 同じ upId を別の会話が使っても混ざらない・owner に / や .. を入れても att の外に出ない・途中の残りは sweep で消える", () => {
  const A = makeAttach(ui);
  expect(A.chunk("s:1", { upId: "up-shared01", seq: 0, last: false, name: "a", b64: "QQ==" }).ok).toBe(true);
  expect(A.chunk("s:2", { upId: "up-shared01", seq: 1, last: true, name: "a", b64: "QQ==" }).ok).toBe(false); // s:2 から見ると最初が 1
  expect(attDir(ui, "../../etc")).toBe(join(ui, "att", "______etc"));
  const B = makeAttach(ui); // 常駐が落ちて起き直した（進みの記録は無い）
  B.chunk("s:9", { upId: "up-lost0001", seq: 0, last: false, name: "a", b64: "QQ==" });
  const C = makeAttach(ui); C.sweep("s:9");
  expect(readdirSync(attDir(ui, "s:9")).filter((f) => f.startsWith(".up-"))).toEqual([]);
});

test("W75a 常駐の op: attachChunk で載せると次の send で agent に path と『指示でない』が渡る・別の会話の分は Read の許可に入らない（main.ts の Read は自分の att だけ）", async () => {
  const store = openStore(":memory:");
  const handle: any = makeHandler(store, async () => [], undefined, { ...defaultWorkspace(), dir: nodes }, { uiHome: ui, leaseDriver: () => null });
  const root = store.add(null, "user", "会話", true);
  const other = store.add(null, "user", "別の会話", true);
  const r: any = await handle({ op: "attachChunk", rootId: root.id, upId: "up-handler01", seq: 0, last: true, name: "メモ.png", b64: PNG.toString("base64") });
  expect(r).toMatchObject({ ok: true, done: true, att: { kind: "image", name: "メモ" } });
  expect(r.att.path).toBeUndefined(); // panel には path を返さない（見せる必要が無い）
  expect(readdirSync(attDir(ui, `s:${root.id}`)).filter((f) => !f.startsWith(".")).length).toBe(1);
  expect(existsSync(attDir(ui, `s:${other.id}`)) && readdirSync(attDir(ui, `s:${other.id}`)).length).toBeFalsy();
  expect((await handle({ op: "attachChunk", rootId: 99999, upId: "up-handler02", seq: 0, last: true, name: "x", b64: "QQ==" }) as any).ok).toBe(false);
  expect((await handle({ op: "attachChunk", upId: "up-handler03", seq: 0, last: true, name: "x", b64: "QQ==" }) as any).ok).toBe(false);
  const src = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  expect(src).toContain("Read(//${realpathSync(myAtt).slice(1)}/**)"); // 自分の会話の att だけ
  expect(src).not.toMatch(/Read\(\/\/\$\{[^}]*uiHome\(\)[^}]*"att"\)/); // att 全体は許さない
  expect(src).toMatch(/"--add-dir", myAtt/);
});

test("W75a panel: ＋/drop は file の中身を attachChunk で 512KB ずつ送り、載った物だけ欄に足す・断られたら理由を出す", () => {
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(js).toContain("const ATT_CHUNK = 512 * 1024");
  expect(js).toContain('call("attachChunk"');
  expect(js).toMatch(/if \(r\.ok && r\.att/); // 載った物だけ chip になる（W75b）
  expect(js).not.toContain("[file:"); // 中身を送らず名前だけ足す古い形は無い
});
