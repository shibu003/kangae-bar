// W75d: 受け取った file / 画像の保存（512KB ずつ読む）・link を人が押して開く（人の画面からだけ・http(s) だけ）
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeAttach } from "../src/attach.ts";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(120_000);

let top: string, ui: string;
beforeEach(() => { top = realpathSync(mktmp("w75d")); ui = join(top, "ui"); mkdirSync(ui); });
afterEach(() => rmSync(top, { recursive: true, force: true }));
const rnd = (n: number) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 255; b[0] = 0x25; b[1] = 0x50; b[2] = 0x44; b[3] = 0x46; return b; }; // %PDF で始まる
const cli = { write() {} };

test("W75d 保存の読み出し: 512KB ずつ・つなぐと元と同じ・最後に last・範囲外 / 別の会話 / 形の悪い id は読めない", () => {
  const A = makeAttach(ui);
  const data = rnd(1_300_000);
  let r: any; for (let i = 0; i * 262144 < data.length; i++) r = A.chunk("s:1", { upId: "up-save0001", seq: i, last: (i + 1) * 262144 >= data.length, name: "資料.pdf", b64: data.subarray(i * 262144, (i + 1) * 262144).toString("base64") });
  const id = r.att.id;
  const parts: Buffer[] = []; let last = false;
  for (let seq = 0; !last; seq++) { const c = A.readChunk("s:1", id, seq)!; expect(c.b64.length).toBeLessThan(800_000); expect(c.ext).toBe("pdf"); parts.push(Buffer.from(c.b64, "base64")); last = c.last; expect(seq).toBeLessThan(10); }
  expect(parts.length).toBe(3);
  expect(Buffer.concat(parts).equals(data)).toBe(true);
  expect(A.readChunk("s:1", id, 3)).toBeNull();
  expect(A.readChunk("s:1", id, -1)).toBeNull();
  expect(A.readChunk("s:1", id, 1.5)).toBeNull();
  expect(A.readChunk("s:2", id, 0)).toBeNull();
  for (const bad of ["../x.pdf", "a/b.pdf", "", 3, null]) expect(A.readChunk("s:1", bad, 0), String(bad)).toBeNull();
});

test("W75d 常駐の op: 保存は人の画面（panel）からだけ・agent の口（CLI）からは読めない・link を開くのも人の画面だけで http(s) だけ", async () => {
  const opened: string[] = [];
  const store = openStore(":memory:");
  const H: any = makeHandler(store, async () => [], undefined, { ...defaultWorkspace(), dir: join(top, "ws") }, { uiHome: ui, leaseDriver: () => null, openLink: async (u: string) => { opened.push(u); return true; } });
  const root = store.add(null, "user", "会話", true);
  const up: any = await H({ op: "attachChunk", rootId: root.id, upId: "up-op000001", seq: 0, last: true, name: "メモ.md", b64: Buffer.from("本文").toString("base64") });
  const ok = await H({ op: "attachRead", rootId: root.id, attId: up.att.id, seq: 0 }, {});
  expect(ok).toMatchObject({ ok: true, last: true, ext: "txt" });
  expect(Buffer.from(ok.b64, "base64").toString()).toBe("本文");
  expect((await H({ op: "attachRead", rootId: root.id, attId: up.att.id, seq: 0 }, cli)).ok).toBe(false); // agent は読み出せない
  expect((await H({ op: "attachRead", rootId: 9999, attId: up.att.id, seq: 0 }, {})).ok).toBe(false);
  expect(await H({ op: "openLink", url: "https://docs.example.com/a?b=1" }, {})).toMatchObject({ ok: true });
  expect(opened).toEqual(["https://docs.example.com/a?b=1"]);
  expect((await H({ op: "openLink", url: "https://docs.example.com/" }, cli)).ok).toBe(false); // agent が自分で人の browser を開けない
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "https://u:p@evil.example/", "", "x", `https://a.example/${"x".repeat(2100)}`]) expect((await H({ op: "openLink", url: bad }, {})).ok, bad.slice(0, 20)).toBe(false);
  expect(opened.length).toBe(1);
});

test("W75d panel: 吹き出しの file / 画像に「保存」・link は人が押した時だけ chrome.tabs.create か openLink・保存名は種類から付けた拡張子・文字は textContent だけ", () => {
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(js).toContain('call("attachRead"');
  expect(js).toMatch(/x\.download = `\$\{a\.name \|\| "file"\}\.\$\{ext\}`/);
  expect(js).toContain("chrome.tabs.create({ url: a.url, active: true })");
  expect(js).toContain('call("openLink", { url: a.url })');
  expect(js).toContain("if (!/^https?:\\/\\//.test(a.url)) { e.preventDefault(); return; }");
  const att = js.slice(js.indexOf("function attEl("), js.indexOf("// W75d: 受け取った"));
  expect(att).not.toMatch(/innerHTML|insertAdjacentHTML/);
  expect(att).toContain('addEventListener("kg-save", () => saveAtt(a, chip))'); // W91: 保存は kg-chip の「保存」（saveable）から
  expect(existsSync(join(import.meta.dir, "../docs/verify/w75/README.md"))).toBe(true);
});
