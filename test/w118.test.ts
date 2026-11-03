// W118: DESIGN.md §7 状態と動き。source の検査（見た目の実機は未測）
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const css = read("extension/panel.css").replace(/\/\*[\s\S]*?\*\//g, "");
const tok = (n: string) => new RegExp(`--${n}:\\s*([^;]+);`).exec(css)?.[1]?.trim();

test("W118 AC1: 操作できる物の色の移りは --duration(150ms) と --ease の 3 つだけ", () => {
  expect(tok("duration")).toBe("150ms");
  const rule = /([^{}]+)\{\s*transition:\s*([^;}]+)/.exec(css.slice(css.indexOf("button, .btn")))!;
  for (const s of ["button", ".btn", "kg-row", "summary", "a"]) expect(rule[1]!.split(",").map((x) => x.trim())).toContain(s);
  expect(rule[2]!.split(",").map((x) => x.trim().split(" ")[0])).toEqual(["background-color", "color", "border-color"]);
  expect(rule[2]).not.toMatch(/\b(all|height|width)\b/);
});

test("W118 AC2: 無限の animation と .spin が無い・動いています の SVG は回らない", () => {
  expect(css).not.toMatch(/\binfinite\b/);
  expect(css).not.toMatch(/\.spin\b/);
  expect(read("extension/panel.js")).not.toMatch(/class="ic spin"/);
});

test("W118 AC3: reduced-motion の最後の block は transition / animation を 0ms にする", () => {
  expect(tok("reduced-duration")).toBe("0ms");
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{(.*)\}\s*$/gm)];
  const last = blocks.at(-1)![1]!;
  expect(last).toContain("transition-duration:var(--reduced-duration) !important");
  expect(last).toContain("animation-duration:var(--reduced-duration) !important");
  expect(css.lastIndexOf("prefers-reduced-motion")).toBeGreaterThan(css.indexOf("details[open] > summary .chev"));
});

test("W118 節: chevron は open で 90°・中身は opacity だけ・height は動かさない／押した直後は disabled + aria-busy", () => {
  expect(css).toMatch(/details\[open\] > summary \.chev[^{]*\{\s*transform:rotate\(90deg\)/);
  expect(css).toMatch(/@keyframes details-in \{\s*from \{\s*opacity:0;/);
  expect(css).not.toMatch(/@keyframes details-in[^}]*height/);
  // W114 以後: 押した瞬間に card の全 button / input を disabled にして aria-busy="true"（busy(true)）。戻すのは自分が止めた物だけ
  const kg = read("extension/kg.js");
  const busy = /\n  busy\(on\) \{([\s\S]*?)\n  \}\n/.exec(kg)?.[1] ?? "";
  expect(busy).toContain('this.setAttribute("aria-busy", "true")');
  expect(busy).toMatch(/querySelectorAll\("button"\)[\s\S]*querySelectorAll\("input"\)/);
  expect(busy).toMatch(/for \(const n of this\._held\) n\.disabled = true/);
  expect(busy).toContain('this.toggleAttribute("aria-busy", false)');
  expect(kg).toMatch(/this\.busy\(true\);[^\n]*\n\s*this\.dispatchEvent\(new CustomEvent\("kg-answer"/); // 押下 → busy → kg-answer の順（answer を投げる前に止める）
});
