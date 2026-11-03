// W28（CEO「bar の UI がものすごく見づらい・小さくしても見れるように」）: 小さい窓（<720px）の字は 14px 以上・押せる物は 36px 以上・灰色の字は薄い地でも 4.5:1 以上（明・暗）
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../extension/panel.css"), "utf8");
const tok = (block: string, name: string) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? "";
const lum = (hex: string) => { const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!; };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const light = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf("* { box-sizing"));
const small = css.match(/@media \(max-width: calc\(var\(--w-read\) - var\(--line-w\)\)\) \{[\s\S]*?\n\}/)?.[0] ?? "";

test("W28 灰色の字（--muted-fg）は、地（bg / muted / card）の上で 4.5:1 以上（明・暗）", () => {
  for (const [name, b, mode] of [["light", light, light], ["dark", dark, dark]] as const) {
    const fg = tok(b, "muted-fg");
    expect(fg, name).not.toBe("");
    for (const bgName of ["bg", "muted", "card"]) {
      const bg = tok(b, bgName) || tok(light, bgName);
      expect(ratio(fg, bg), `${name} ${bgName}`).toBeGreaterThanOrEqual(4.5);
    }
    void mode;
  }
});

test("W28 小さい窓（<720px）: 字の token を上書きしない・押せる物は --hit-sm（36px）", () => {
  expect(small).not.toMatch(/--fs-/); // W110: 狭い幅の後勝ちで --fs-* を戻さない
  expect(small).not.toMatch(/font-size:\s*\d+px/);
  expect(small).toMatch(/min-height:\s*var\(--hit-sm\)/);
  expect(light).toMatch(/--hit-sm:\s*36px/);
  expect(small).not.toMatch(/(^|\n)\s*\.btn[ ,{][^\n]*min-height/); // 素の .btn（既に 44px）の高さは下げない
});
