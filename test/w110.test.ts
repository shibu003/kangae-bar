// W110: DESIGN.md §2 の token を panel.css の :root に置く。glass・色付き左線・:root 外の #hex を置かない。
// 実機の見た目は未測。読む file: "extension/panel.css" "docs/design/DESIGN.md"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function rootBlocks(css: string): string[] {
  const out: string[] = [];
  const re = /:root\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < css.length && depth) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push(css.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

function decls(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const hit of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    map.set(hit[1]!, hit[2]!.replace(/\s+/g, " ").trim());
  }
  return map;
}

const LEGACY = [
  "bg", "fg", "card", "muted", "muted-fg", "border", "primary", "primary-fg", "destructive", "shadow",
  "dim", "line", "soft", "accent", "warn",
  "fs-body", "lh-body", "fs-name", "lh-name", "fs-status", "lh-status",
  "fs-card", "lh-card", "fs-card-title", "lh-card-title", "fs-meta", "lh-meta", "fs-time",
  "fs-list-title", "lh-list-title", "fs-list-last", "lh-list-last", "lh-time",
  "sp-1", "sp-2", "sp-3", "sp-4", "sp-5", "gutter",
  "r-sm", "r-md", "r-lg", "r-bubble", "r-tail", "r-xl", "r-pill",
  "ag0", "ag1", "ag2", "ag3", "ag4", "ag5", "ag-fg",
  "av-header", "av-msg", "av-list", "h-row", "badge-dot", "h-header", "hit", "hit-sm", "hit-xs",
  "sb-w", "sb-thumb", "sb-thumb-hover", "send", "ic-1", "ic-2", "ic-3", "dot", "w-read", "w-bubble", "pad-x",
];

function designFence(md: string): string {
  const h = md.indexOf("### 差し替える token 全文");
  const start = md.indexOf("```css", h);
  const end = md.indexOf("```", start + 6);
  return md.slice(start + 6, end);
}

test("W110 AC1: DESIGN.md §2 の token が panel.css の :root に全部在り、旧名も残る", () => {
  const design = stripComments(designFence(read("docs/design/DESIGN.md")));
  const css = stripComments(read("extension/panel.css"));
  const dRoots = rootBlocks(design);
  const cRoots = rootBlocks(css);
  expect(dRoots.length).toBeGreaterThanOrEqual(2);
  expect(cRoots.length).toBeGreaterThanOrEqual(2);
  for (const [label, want, got] of [
    ["light", decls(dRoots[0]!), decls(cRoots[0]!)],
    ["dark", decls(dRoots[1]!), decls(cRoots[1]!)],
  ] as const) {
    const missing = [...want.entries()].filter(([k, v]) => got.get(k) !== v).map(([k, v]) => `${label} --${k}: want ${v} got ${got.get(k) ?? "（無い）"}`);
    expect(missing).toEqual([]);
  }
  const lightNames = decls(cRoots[0]!);
  expect(LEGACY.filter((n) => !lightNames.has(n))).toEqual([]);
  expect(cRoots[0]).toMatch(/color-scheme:\s*light dark/);
});

test("W110 AC2: backdrop-filter / url(#liquid) / border-left の --ag が panel.css に無い", () => {
  const css = stripComments(read("extension/panel.css"));
  expect(css).not.toMatch(/backdrop-filter/);
  expect(css).not.toMatch(/url\(#liquid\)/);
  expect(css).not.toMatch(/border-left\s*:[^;{}]*var\(\s*--ag/);
});

test("W110 AC3: scrollbar は --sb-w 4px と scrollbar-width:thin と WebKit", () => {
  const css = stripComments(read("extension/panel.css"));
  expect(decls(rootBlocks(css)[0]!).get("sb-w")).toBe("4px");
  expect(css).toMatch(/scrollbar-width:\s*thin/);
  expect(css).toMatch(/scrollbar-color:\s*var\(--sb-thumb\)\s+transparent/);
  expect(css).toMatch(/::-webkit-scrollbar\s*\{\s*width:\s*var\(--sb-w\)/);
});

test("W110 AC4: .mark.turn / .mark.fail / .mark.work は token。:root の外に色の #hex が無い", () => {
  const css = stripComments(read("extension/panel.css"));
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
  const body = (sel: string) => rules.filter((r) => r.sel.split(",").some((s) => s.trim() === sel)).map((r) => r.body).join(";");
  expect(body(".mark.turn")).toMatch(/color:\s*var\(--turn\)/);
  expect(body(".mark.fail")).toMatch(/color:\s*var\(--fail\)/);
  expect(body(".mark.work")).toMatch(/color:\s*var\(--work\)/);
  let rest = css.replace(/:root\s*\{[^{}]*\}/g, "");
  rest = rest.replace(/#add-[\w-]*/g, ""); // id セレクタ #add-line / #add-tab。色ではない
  const hexes = [...rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]!.toLowerCase());
  expect(hexes).toEqual([]);
});

// 色・字・間隔・形の px は :root の token だけ。残る直書きは glyph と縮小絵（DESIGN に token が無い）。
const RAW_PX_OK = ["0px", "1.8px", "2px", "7px", "72px", "96px"];

test("W110 AC5: :root の外の px は glyph と縮小絵だけ", () => {
  let rest = stripComments(read("extension/panel.css")).replace(/:root\s*\{[^{}]*\}/g, "");
  const px = [...rest.matchAll(/\d+(?:\.\d+)?px\b/g)].map((m) => m[0]!);
  const bad = [...new Set(px.filter((n) => !RAW_PX_OK.includes(n)))].sort();
  expect(bad).toEqual([]);
});
