// W75b: chat の添付の表示（chip・吹き出しの縮小画像 / file / link）・送る前の ×・消した会話の添付の片付け
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { attDir, gcAtt, makeAttach } from "../src/attach.ts";
import { defaultWorkspace, makeHandler, splitAtts } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let top: string, ui: string, nodes: string;
beforeEach(() => { top = realpathSync(mktmp("w75b")); ui = join(top, "ui"); nodes = join(top, "nodes"); mkdirSync(ui); mkdirSync(nodes); });
afterEach(() => rmSync(top, { recursive: true, force: true }));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const put = (A: ReturnType<typeof makeAttach>, owner: string, buf: Buffer, name: string, id = "up-12345678") => (A.chunk(owner, { upId: id, seq: 0, last: true, name, b64: buf.toString("base64") }) as any).att;
const mkH = () => { const store = openStore(":memory:"); const H: any = makeHandler(store, async () => [], undefined, { ...defaultWorkspace(), dir: nodes }, { uiHome: ui, leaseDriver: () => null }); return { store, H }; };

test("W75b 縮小絵: 画像は JPEG の縮小（1MB の壁の下）・別の会話からは引けない・file は絵にしない・id は形が正しい物だけ", () => {
  const A = makeAttach(ui);
  const a = put(A, "s:1", PNG, "点.png");
  const t = A.thumb("s:1", a.id, 240);
  expect(t).not.toBeNull();
  expect(Buffer.from(t!, "base64").subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
  expect(t!.length).toBeLessThan(900_000);
  expect(A.thumb("s:2", a.id, 240)).toBeNull(); // 持ち主の会話だけ
  const f = put(A, "s:1", Buffer.from("hello"), "m.md", "up-87654321");
  expect(A.thumb("s:1", f.id, 240)).toBeNull();
  for (const bad of ["../x.png", "a/b.png", "x.png", "", 5, null, `${a.id}/../${a.id}`]) { expect(A.meta("s:1", bad), String(bad)).toBeNull(); expect(A.thumb("s:1", bad, 240), String(bad)).toBeNull(); }
  expect(A.meta("s:1", a.id)).toMatchObject({ kind: "image", name: "点", size: PNG.length });
});

test("W75b 載せる→chip→送る: attachList に出て、× で消え（file も無くなる）、送ると吹き出しの行に添付が付き、送った後は × で消せず chip も空", async () => {
  const { store, H } = mkH();
  const root = store.add(null, "user", "会話", true);
  const up = async (id: string, buf: Buffer, name: string) => (await H({ op: "attachChunk", rootId: root.id, upId: id, seq: 0, last: true, name, b64: buf.toString("base64") })).att;
  const a = await up("up-chip0001", PNG, "写真.png"), b = await up("up-chip0002", Buffer.from("メモ"), "メモ.md");
  expect((await H({ op: "attachList", rootId: root.id })).items.map((x: any) => x.name)).toEqual(["写真", "メモ"]);
  expect((await H({ op: "attachRemove", rootId: root.id, attId: b.id })).ok).toBe(true);
  expect(readdirSync(attDir(ui, `s:${root.id}`)).some((f) => f.includes(b.id))).toBe(false); // file も meta も消える
  expect((await H({ op: "attachRemove", rootId: root.id, attId: b.id })).ok).toBe(false);
  expect((await H({ op: "attachThumb", rootId: root.id, attId: a.id, w: 240 })).jpeg).toBeTruthy();
  const s = await H({ op: "send", rootId: root.id, text: "" }); // 欄が空でも添付があれば送れる
  expect(s.ok === true || s.row != null).toBe(true);
  const chat = await H({ op: "chat", rootId: root.id });
  const row = chat.rows.find((r: any) => r.atts);
  expect(row.atts).toEqual([{ kind: "image", id: a.id, name: "写真", size: PNG.length, view: "image" }]); // W91: 押した時の見方 view が載る
  expect(row.text).not.toContain("[[att:"); // 印は外れる
  expect((await H({ op: "attachList", rootId: root.id })).items).toEqual([]);
  expect((await H({ op: "attachRemove", rootId: root.id, attId: a.id })).ok).toBe(false); // 送った物は会話の記録
  expect(existsSync(join(attDir(ui, `s:${root.id}`), a.id))).toBe(true);
  expect((await H({ op: "send", rootId: root.id, text: "" })).ok).toBe(false); // 添付も無い空は送れない
});

test("W75b 他人が書ける印: 別の会話の file を指す [[att:]] は出ない・人の行の [[link:]] は文字のまま・🤖 の link は http(s) だけで origin を先に出す・javascript: / file: / 認証情報つきは文字のまま", () => {
  const A = makeAttach(ui);
  const mine = put(A, "s:1", PNG, "a.png");
  const look = (owner: string) => (id: string) => A.meta(owner, id);
  expect(splitAtts(`見て [[att:${mine.id}]]`, look("s:1")).atts.length).toBe(1);
  expect(splitAtts(`見て [[att:${mine.id}]]`, look("s:2")).atts).toEqual([]); // 別の会話
  expect(splitAtts("[[att:../../etc/passwd]]", look("s:1")).atts).toEqual([]);
  expect(splitAtts("人が打った [[link: https://a.example/ | x]]", look("s:1")).atts).toEqual([]);
  const ok = splitAtts("🤖 sns: 出来ました [[link: https://docs.example.com/a?b=1#c | 週報]]", look("s:1"));
  expect(ok.atts).toEqual([{ kind: "link", url: "https://docs.example.com/a?b=1#c", origin: "https://docs.example.com", title: "週報" }]);
  expect(ok.body).not.toContain("[[link");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "https://user:pw@evil.example/", "notaurl", `https://a.example/${"x".repeat(2100)}`]) {
    const r = splitAtts(`🤖 x: [[link: ${bad} | t]]`, look("s:1"));
    expect(r.atts, bad.slice(0, 30)).toEqual([]);
  }
  const evil = splitAtts("🤖 x: [[link: https://evil.example/ | https://bank.example の確認]]", look("s:1")).atts[0] as any;
  expect(evil.origin).toBe("https://evil.example"); // 題で origin を偽れない（origin は URL から）
});

test("W75b 片付け: 消して 30 日を過ぎた会話・根の無い dir の添付は消え、30 日以内（restore できる）と生きている会話は残る", () => {
  const A = makeAttach(ui);
  for (const n of [1, 2, 3, 4]) put(A, `s:${n}`, PNG, "a.png", `up-gc00000${n}`);
  const DAY = 86_400_000, now = 100 * DAY;
  const roots: Record<number, { deletedAt: number | null }> = { 1: { deletedAt: null }, 2: { deletedAt: now - 10 * DAY }, 3: { deletedAt: now - 31 * DAY } }; // 4 は根が無い
  expect(gcAtt(ui, (id) => roots[id], now)).toBe(2);
  expect(existsSync(attDir(ui, "s:1"))).toBe(true);
  expect(existsSync(attDir(ui, "s:2"))).toBe(true);
  expect(existsSync(attDir(ui, "s:3"))).toBe(false);
  expect(existsSync(attDir(ui, "s:4"))).toBe(false);
});

test("W75b panel: chip（×つき）・吹き出しの添付・link は新しい tab で noopener・欄に [file:] を足す古い形は無い・文字は textContent だけ", () => {
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(js).toContain("function attEl(");
  expect(js).toContain('box.target = "_blank"; box.rel = "noopener noreferrer"');
  expect(js).toContain('call("attachRemove"');
  expect(js).toContain('call("attachThumb"');
  expect(js).toContain("row.atts?.length");
  expect(js).not.toContain("[file:");
  const a = js.slice(js.indexOf("function attEl("), js.indexOf("function paintChips"));
  expect(a).not.toMatch(/innerHTML|insertAdjacentHTML/);
  expect(readFileSync(join(import.meta.dir, "../extension/panel.html"), "utf8")).toContain('id="att-chips"');
});
