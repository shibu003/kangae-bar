// W91（design-ui-inventory §10.2・CEO 10-14「見なくていい物は見せない・modal は作らない」）: kg-chip = 添付 1 つ・押すと見る。kg-view = 吹き出しの中の viewer（image / text）。pdf・video は人の既定の app（attachOpen）。
// 本物のブラウザ・ポインタに触れない（最小の DOM の代役）。実機の見た目は未測（要 operator）
import { beforeAll, expect, setDefaultTimeout, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount, El } from "./domshim.ts";
import { makeAttach, sniff, viewOf } from "../src/attach.ts";
import { defaultWorkspace, makeHandler, splitAtts } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(120_000);
beforeAll(installDom);
const g = globalThis as any;
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const textOf = (e: El): string => e.textContent;
const all = (e: El, tag: string): El[] => e.querySelectorAll(tag);

test("W91 kg-chip: 名前と大きさだけ描く・保存 / × は付けた時だけ・押すと kg-open {view}・名前の HTML は文字のまま", () => {
  const c = mount("kg-chip", { view: "pdf", name: "<b>資料</b>", meta: "2 KB" }) as any;
  expect(textOf(c)).toContain("<b>資料</b>");
  expect(all(c, "button").length).toBe(1); // 見なくていい物（保存・×）は出さない
  const got: string[] = []; c.addEventListener("kg-open", (e: any) => got.push(e.detail.view));
  all(c, "button")[0]!.click();
  expect(got).toEqual(["pdf"]);
  const d = mount("kg-chip", { view: "image", name: "a", saveable: "", removable: "" }) as any;
  expect(all(d, "button").map((b) => b.className)).toEqual(["att-file att-open", "att-save", "att-x"]);
  const ev: string[] = []; d.addEventListener("kg-save", () => ev.push("save")); d.addEventListener("kg-remove", () => ev.push("rm"));
  all(d, "button")[1]!.click(); all(d, "button")[2]!.click();
  expect(ev).toEqual(["save", "rm"]);
});

test("W91 kg-chip: image は縮小絵が来たら絵になる・来なければ名前のまま", () => {
  const c = mount("kg-chip", { view: "image", name: "写真", meta: "1 KB" }) as any;
  expect(all(c, "img").length).toBe(0);
  c.setThumb("data:image/jpeg;base64,AA==");
  expect(all(c, "img").length).toBe(1);
});

test("W91 kg-view: image は 1 枚・text は整形（見出し・箇条書き・code・表・段落）・link / 画像の参照 / HTML は辿らず文字のまま・制御文字と向きを変える文字は落ちる・1MB で切ると続きの案内", () => {
  const v = mount("kg-view") as any;
  v.show({ kind: "text", name: "メモ.md", cut: true, text: "# 題\n- 一つ\n- 二つ\n\n```\ncode <x>\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n\n本文 [link](https://evil.example) ![i](https://evil.example/x.png) <img src=x onerror=1>‮abc\u0007" });
  const body = textOf(v);
  expect(all(v, "h3").length).toBe(1);
  expect(all(v, "li").length).toBe(2);
  expect(all(v, "pre").length).toBe(1);
  expect(all(v, "th").length).toBe(2);
  expect(body).toContain("[link](https://evil.example)"); // 文字のまま
  expect(body).toContain("<img src=x onerror=1>");
  expect(all(v, "a").length + all(v, "img").length).toBe(0);
  expect(body).not.toMatch(/[‮\u0007]/);
  expect(body).toContain("続きは「保存」で");
  const i = mount("kg-view") as any;
  i.show({ kind: "image", name: "p", src: "data:image/jpeg;base64,AA==" });
  expect(all(i, "img").length).toBe(1);
  const x = all(i, "button")[0]!; const closed: string[] = []; i.parent.addEventListener("kg-close", () => closed.push("c")); x.click();
  expect(closed).toEqual(["c"]);
});

test("W91 種類: 先頭バイトで mp4（ftyp）・pdf・text・image を見分け、押した時の見方（view）を決める", () => {
  const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  expect(sniff(mp4).ext).toBe("mp4");
  expect(viewOf("mp4")).toBe("video"); expect(viewOf("pdf")).toBe("pdf"); expect(viewOf("txt")).toBe("text"); expect(viewOf("png")).toBe("image"); expect(viewOf("bin")).toBe("file");
  const a = splitAtts("[[att:x-1.pdf]]", () => ({ kind: "file", id: "x-1.pdf", name: "n", size: 3, view: "pdf" }));
  expect(a.atts[0]).toMatchObject({ view: "pdf" });
});

let top: string, ui: string;
beforeEach(() => { top = realpathSync(mktmp("w91")); ui = join(top, "ui"); mkdirSync(ui); });
afterEach(() => rmSync(top, { recursive: true, force: true }));
test("W91 attachOpen: pdf / video だけ・人の画面だけ（CLI は断る）・text や image や他の会話の物は開かない", async () => {
  const opened: string[] = [];
  const store = openStore(":memory:");
  const H: any = makeHandler(store, async () => [], undefined, { ...defaultWorkspace(), dir: join(top, "ws") }, { uiHome: ui, leaseDriver: () => null, openFile: async (p: string) => { opened.push(p); return true; } });
  const root = store.add(null, "user", "会話", true);
  const up = async (n: string, body: Buffer, id: string) => (await H({ op: "attachChunk", rootId: root.id, upId: id, seq: 0, last: true, name: n, b64: body.toString("base64") })).att;
  const pdf = await up("資料", Buffer.from("%PDF-1.4 x"), "up-open0001");
  const txt = await up("メモ", Buffer.from("本文"), "up-open0002");
  const mp4 = await up("動画", Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]), "up-open0003");
  expect(pdf.view).toBe("pdf"); expect(txt.view).toBe("text"); expect(mp4.view).toBe("video");
  expect(await H({ op: "attachOpen", rootId: root.id, attId: pdf.id }, {})).toMatchObject({ ok: true });
  expect(await H({ op: "attachOpen", rootId: root.id, attId: mp4.id }, {})).toMatchObject({ ok: true });
  expect(opened.length).toBe(2);
  expect(await H({ op: "attachOpen", rootId: root.id, attId: txt.id }, {})).toMatchObject({ ok: false });
  expect(await H({ op: "attachOpen", rootId: root.id, attId: "../x.pdf" }, {})).toMatchObject({ ok: false });
  expect(await H({ op: "attachOpen", rootId: root.id, attId: pdf.id }, { write() {} })).toMatchObject({ ok: false }); // agent の口（CLI）
  expect(opened.length).toBe(2);
});

test("W91 panel は kg-chip を使い、既存の img / file の自前 chip を持たない・pdf / video は attachOpen・modal は作らない", () => {
  const p = read("extension/panel.js");
  expect(p).toContain('createElement("kg-chip")');
  expect(p).toContain('call("attachOpen"');
  expect(p).not.toMatch(/className = "att-img"/);
  expect(p).not.toMatch(/showModal|role="dialog"/);
});
