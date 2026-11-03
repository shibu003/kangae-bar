// W106: desk の見える文字・受け取るの label・Bar の持ち手の hover。描画は source の見える文字（w77e と同じ抜き出し）。
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { htmlTexts, jsTexts } from "./w77e.test.ts";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const press = () => {
  const html = read("extension/panel.html");
  const a = html.indexOf('<section id="press"');
  const b = html.indexOf('<section id="chat"');
  return html.slice(a, b);
};

test("W106 AC1: newtab の見える文字に session と side panel が 0。空の文と button は desk の言葉", () => {
  const seen = [...jsTexts("newtab.js"), ...htmlTexts("newtab.html")];
  expect(seen.length).toBeGreaterThan(0);
  const bad = seen.filter((s) => /session|side panel/i.test(s.text)).map((s) => `${s.at} ${s.text}`);
  expect(bad).toEqual([]);
  const texts = seen.map((s) => s.text);
  expect(texts).toContain("会話を開く");
  expect(texts).toContain("Bar の会話の『…』→『デスクトップ』で、会話や tab をここに置けます");
});

test("W106 AC2: #press の受け取るは短い label（常駐は path だけなので type=file にはしない）", () => {
  const sec = press();
  expect(sec).toContain('id="take-path"');
  expect(sec).toContain("file の場所（Finder で選んで option+右 click →パス名をコピー）");
  expect(sec).not.toContain("人から受け取った押す操作の file の場所");
  expect(sec).not.toContain('type="file"');
});

test("W106 AC3: Bar の持ち手は hover で線 1 本。drag の帯の高さは変えない", () => {
  const css = read("extension/panel.css");
  expect(css).toMatch(/html\[data-bar\] #drag:hover::before \{ opacity:1; \}/);
  expect(css).toMatch(/html\[data-bar\] #drag::before \{ content:""; width:calc\(var\(--sp-4\) \* 2\); height:var\(--focus-w\); background:var\(--line\); border-radius:var\(--r-pill\); opacity:0; \}/);
  expect(css).toMatch(/html\[data-bar\] #hd \{ padding-top:var\(--drag-h\); \}/);
  expect(read("bar/main.swift")).toMatch(/bounds\.height - dragBand \{ window\?\.performDrag\(with: e\) \}/);
  expect(read("extension/panel.html")).toContain('<div id="drag" aria-hidden="true"></div>');
});
