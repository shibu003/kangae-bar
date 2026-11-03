// W123: 窓の枠とヘッダを DESIGN.md §4 に合わせる。実機の見た目は未測。読む file: "extension/panel.css" "extension/newtab.html"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const css = read("extension/panel.css").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
const HEADERS = ["#list-hd", "#hd", "#press-hd", "#thread header"];

test("W123 AC1: calc(var(--bar-inset-left は :root の --header-start だけ・各 header の左端は --header-start", () => {
  const hits = css.split("\n").filter((l) => l.includes("calc(var(--bar-inset-left"));
  expect(hits.length).toBe(1);
  expect(hits[0]).toContain("--header-start:");
  const hd = rules.find((r) => r.sel.includes("#list-hd, #hd, #press-hd, #thread header"))!;
  expect(hd.body).toContain("var(--header-start)");
  expect(css).toMatch(/#stop-all \{[^}]*var\(--header-start\)/);
});

test("W123 AC2: header の寸法は 1 つの rule（min-height は --h-header・padding 8/16・下線 1px）で他の rule は持たない", () => {
  const hd = rules.find((r) => r.sel.includes("#list-hd, #hd, #press-hd, #thread header"))!;
  expect(hd.body).toContain("min-height:var(--h-header)");
  expect(hd.body).toContain("padding:var(--sp-2) var(--gutter) var(--sp-2) var(--header-start)");
  expect(hd.body).toContain("border-bottom:var(--line-w) solid var(--border)");
  for (const r of rules) {
    if (r === hd || !HEADERS.some((h) => r.sel.split(",").some((s) => s.trim() === h))) continue;
    expect(r.body).not.toMatch(/min-height|padding|border-bottom/); // 寸法は 1 か所
  }
});

test("W123 AC3: 100vh の後に 100dvh・最下部に safe-area-inset-bottom・Bar の上 16px は #app の padding・中央だけ scroll", () => {
  expect(css).toMatch(/height:100vh;\s*height:100dvh;/);
  expect(css).toContain("env(safe-area-inset-bottom");
  expect(css).toContain("html[data-bar] #app { padding-top:var(--drag-h); }");
  expect(css).toMatch(/#rows \{[^}]*min-height:0; overflow-y:auto;/);
  expect(css).toMatch(/#chat > #approve \{[^}]*min-height:0;[^}]*overflow-y:auto;/); // 入力欄を押し出さない
  expect(css).toMatch(/#press-hd \{[^}]*position:sticky;/);
});

test("W123 AC4: 新しいタブは中央 720px が上限（token）", () => {
  const html = read("extension/newtab.html");
  expect(html).toContain("--w-read:720px;");
  expect(html).toMatch(/max-width:var\(--w-read\)/);
});
