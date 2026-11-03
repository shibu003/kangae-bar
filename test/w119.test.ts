// W119: アイコンを DESIGN.md §8 に合わせる（viewBox 20・stroke 1.6・歯車は歯車・○＜ は円＋左 chevron・機能の icon に emoji を使わない）。実機の見た目は未測
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount } from "./domshim.ts";
beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

test("W119 AC1: panel.html / panel.js / kg.js の svg に viewBox 0 0 16 16 が無く、固定の線画は stroke 1.6・currentColor・round", () => {
  for (const f of ["extension/panel.html", "extension/panel.js", "extension/kg.js"]) expect(read(f)).not.toContain('viewBox="0 0 16 16"');
  const html = read("extension/panel.html");
  const svgs = [...html.matchAll(/<svg class="ic"[^>]*>/g)].map((m) => m[0]);
  expect(svgs.length).toBe(4); // 歯車・＋・添付・送る
  for (const s of svgs) for (const w of ['viewBox="0 0 20 20"', 'fill="none"', 'stroke="currentColor"', 'stroke-width="1.6"', 'stroke-linecap="round"', 'stroke-linejoin="round"', 'aria-hidden="true"']) expect(s).toContain(w);
  expect(strip(read("extension/panel.css"))).toMatch(/\.ic \*[^{]*\{\s*vector-effect:\s*non-scaling-stroke/);
});

test("W119 AC2: kg-back は SVG の円（r=13.5）と左 chevron を持ち、css に .ring::before の直書き px が無い", () => {
  const b = mount("kg-back", { depth: "2" }) as any;
  const ring = b.querySelectorAll("span")[0];
  expect(ring.innerHTML).toContain("<svg");
  expect(ring.innerHTML).toContain('<circle class="back-ring" cx="10" cy="10" r="13.5" stroke-width="1"/>');
  expect(ring.innerHTML).toMatch(/<path [^>]*d="M13\.5 3\.5L7 10l6\.5 6\.5"/); // 左を向く chevron
  const css = strip(read("extension/panel.css"));
  expect(css).not.toContain(".ring::before");
  expect(css).not.toMatch(/kg-back[^{]*\{[^}]*\d(\.\d)?px/); // kg-back の rule に px の直書きが無い（token だけ）
  expect(b.getAttribute("aria-label")).toBe("前の画面へ（2 度押しで一覧）"); // 挙動は W90 のまま
});

test("W119 AC3: 機能の icon に emoji（🌐 🖥）が無い・面の印は SVG で aria-label は W122 のまま", () => {
  for (const f of ["extension/panel.html", "extension/panel.js", "extension/kg.js"]) expect(read(f)).not.toMatch(/[🌐🖥]/u);
  const row = mount("kg-row") as any;
  row.data = { name: "経理", glyph: "経", prov: "", state: null, fail: false, last: "", lastHidden: true, time: "", dot: false, surfaces: [{ key: "a", kind: "tab", app: "" }, { key: "b", kind: "app", app: "Zed" }] };
  const surfs = row.querySelectorAll("span").find((s: any) => s.className === "surfs");
  expect(surfs.children.map((c: any) => c.getAttribute("aria-label"))).toEqual(["タブ", "Zed"]);
  expect(surfs.children.every((c: any) => c.innerHTML.startsWith('<svg class="ic" viewBox="0 0 20 20"'))).toBe(true);
});

test("W119: icon だけの button は今の aria-label と title を持つ（送る・＋・添付・設定）", () => {
  const html = read("extension/panel.html");
  for (const id of ["user-btn", "plus", "attach"]) {
    const tag = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)![0];
    expect(tag).toMatch(/aria-label="[^"]+"/);
    expect(tag).toMatch(/title="[^"]+"/);
  }
  expect(read("extension/panel.js")).toContain('btn.title = btn.getAttribute("aria-label");');
});
