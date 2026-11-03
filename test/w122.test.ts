// W122: Tab の輪・ボタンの名前・動きを減らす。本物のブラウザには触れない（source と最小 DOM）。実機は未測（要 operator）
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount, El } from "./domshim.ts";
beforeAll(installDom);

const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const cssOf = () => read("extension/panel.css").replace(/\/\*[\s\S]*?\*\//g, "");
const nameOf = (attrs: string, inner: string) => {
  const aria = /aria-label="([^"]*)"/.exec(attrs)?.[1]?.trim() ?? "";
  const title = /\btitle="([^"]*)"/.exec(attrs)?.[1]?.trim() ?? "";
  const text = inner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return aria || title || text;
};
const acc = (el: any) => String(el.getAttribute?.("aria-label") || el.title || el.textContent || "").replace(/\s+/g, " ").trim();
const find = (n: El, cls: string): El | undefined => (n.className.split(" ").includes(cls) ? n : n.children.map((c) => find(c, cls)).find(Boolean));

// outline を none / 0 にしている rule で、:focus-visible の輪が勝たないもの（:focus 側に書くと輪を潰す）
export function outlineNoneWithoutRing(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
  const kills = (body: string) => /outline\s*:\s*none\b/.test(body) || /outline\s*:\s*0(?![0-9.])/.test(body);
  const ring = (body: string) => /outline\s*:/.test(body) && !kills(body);
  const restores = rules.filter((r) => /:focus-visible\b/.test(r.sel) && ring(r.body));
  const global = restores.some((r) => r.sel.split(",").some((s) => s.trim() === ":focus-visible"));
  return rules.filter((r) => kills(r.body)).filter((r) => {
    if (/:focus\b/.test(r.sel)) return !restores.some((g) => g.sel.replace(/\s/g, "") === r.sel.replace(/\s/g, ""));
    return !global;
  }).map((r) => r.sel);
}

test("W122 panel.html の button は全部、文字か aria-label か title を持つ", () => {
  const html = read("extension/panel.html");
  const tags = html.match(/<button\b/gi) ?? [];
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map((m) => ({ id: /id="([^"]*)"/.exec(m[1]!)?.[1] ?? "", name: nameOf(m[1]!, m[2]!) }));
  expect(buttons.length).toBe(tags.length);
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.filter((b) => !b.name).map((b) => b.id)).toEqual([]);
});

test("W122 kg の icon button は名前が空にならない（戻る・面・添付・閉じる・承認）", () => {
  const back = mount("kg-back", { depth: "1" }) as any;
  expect(back.getAttribute("aria-label")).toBe("前の画面へ（2 度押しで一覧）");
  const kept = mount("kg-back", { depth: "1", "aria-label": "前の画面へ（2 度押しで一覧）" }) as any;
  expect(kept.getAttribute("aria-label")).toBe("前の画面へ（2 度押しで一覧）");
  const row = mount("kg-row") as any;
  row.data = { name: "経理", glyph: "経", prov: "", state: null, fail: false, last: "", lastHidden: true, time: "", dot: false, surfaces: [{ key: "a", kind: "tab", app: "" }, { key: "b", kind: "app", app: "Zed" }] };
  const surfs = find(row, "surfs")!;
  expect(surfs.children.map((c) => acc(c))).toEqual(["タブ", "Zed"]);
  const chip = mount("kg-chip", { view: "file", name: "" }) as any;
  expect(acc(chip.querySelectorAll("button")[0])).toBe("添付");
  const named = mount("kg-chip", { view: "pdf", name: "資料" }) as any;
  expect(acc(named.querySelectorAll("button")[0])).toBe("資料");
  const view = mount("kg-view") as any;
  view.show({ kind: "image", name: "p", src: "data:image/gif;base64,AA==" });
  expect(acc(view.querySelectorAll("button")[0])).toBe("閉じる");
  const approve = mount("kg-approve") as any;
  expect(approve.querySelectorAll("button").every((b: any) => acc(b))).toBe(true);
  const toast = mount("kg-toast") as any;
  expect(toast.getAttribute("role")).toBe("status");
  toast.show("copy!", { action: { id: "undo", label: "取り消し" }, ms: 1000 });
  expect(acc(toast.querySelectorAll("button")[0])).toBe("取り消し");
});

test("W122 panel.css に :focus-visible と prefers-reduced-motion が在り、輪を潰す outline は 0", () => {
  const css = cssOf();
  // 輪は token 経由（--focus-w / --focus-offset）。global の :focus-visible が token を使い、token の値が 2px のまま
  expect(css).toMatch(/(^|\n):focus-visible \{ outline:var\(--focus-w\) solid var\(--focus\); outline-offset:var\(--focus-offset\); \}/);
  expect(css).toMatch(/--focus-w:\s*2px;/);
  expect(css).toMatch(/--focus-offset:\s*2px;/);
  expect(css).toContain("@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration:0.01ms !important; transition-duration:0.01ms !important; scroll-behavior:auto !important } }");
  expect(outlineNoneWithoutRing(css)).toEqual([]);
});

test("W122 #chat は role=log・toast は role=status", () => {
  const html = read("extension/panel.html");
  expect(html).toMatch(/<section id="chat" role="log" aria-live="polite"/);
  const toast = mount("kg-toast") as any;
  expect(toast.getAttribute("role")).toBe("status");
  expect(html).toContain('<kg-toast id="toast"></kg-toast>');
});
