// W94（docs/BRIEF-w94.md）: 一覧の状態色は「あなたの番です」と失敗 2 つだけ。Esc / 外側 click で popover を 1 つ閉じる。
// 本物のブラウザ・ポインタに触れない。実機の見た目は未測（要 operator）。
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount, El } from "./domshim.ts";
beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const cssRules = (css: string) => {
  const out: { sel: string; body: string }[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) for (const sel of m[1]!.split(",")) out.push({ sel: sel.trim(), body: m[2]! });
  return out;
};
const find = (n: El, cls: string): El | undefined => (n.className.split(" ").includes(cls) ? n : n.children.map((c) => find(c, cls)).find(Boolean));

test("W94 css: .mark は灰、.mark.turn は --turn、.mark.fail は --fail、.mark.work は --work。他の .mark に色は無い。spin に色は無い", () => {
  const rules = cssRules(read("extension/panel.css"));
  const body = (sel: string) => rules.filter((r) => r.sel === sel).map((r) => r.body).join(";");
  expect(body(".mark")).toContain("color:var(--muted-fg)");
  expect(body(".mark.turn")).toContain("color:var(--turn)"); // W110: 状態色は primary ではなく --turn
  expect(body(".mark.turn")).toMatch(/font-weight:\s*var\(--fw-medium\)/); // DESIGN §3 状態は 500
  expect(body(".mark.fail")).toContain("color:var(--fail)");
  expect(body(".mark.work")).toContain("color:var(--work)");
  const colored = rules.filter((r) => r.sel.split(/\s+/).some((p) => p.includes(".mark")) && /color\s*:/.test(r.body));
  expect(colored.map((r) => r.sel).sort()).toEqual([".mark", ".mark.fail", ".mark.turn", ".mark.work"]);
  expect(colored.every((r) => !/--ag\d*|spin/.test(r.body))).toBe(true);
  expect(body(".spin")).not.toMatch(/color\s*:/);
});

test("W94 panel: 「あなたの番です」だけ tone turn、失敗 2 つだけ tone fail。kind は変えない。他に色 class は付けない", () => {
  const fill = code(read("extension/panel.js")).slice(code(read("extension/panel.js")).indexOf("function fillRootButton"), code(read("extension/panel.js")).indexOf("function markSeen"));
  const tone = /const tone = [^;]+;/.exec(fill)![0];
  expect(tone).toContain('=== "あなたの番です" ? "turn"');
  expect(tone).toContain('=== "失敗"');
  expect(tone).toContain('=== "うまく終われませんでした"');
  expect(tone).toContain('? "fail"');
  expect(tone).toMatch(/: ""\s*;$/);
  expect(tone).not.toMatch(/work|done|ag|spin|primary|destructive|承認待ち|止まりました|替えられません|動いています|終わりました/);
  expect(fill).toContain('["turn", "承認待ち"]');
  expect(fill).toContain('["turn", "止まりました"]');
  expect(fill).toContain('["turn", "替えられません"]');
  expect(fill).toContain('["work", "動いています"]');
  expect(fill).toContain('["turn", "失敗"]');
  expect(fill).toContain('["turn", "うまく終われませんでした"]');
  expect(fill).toContain('["turn", "あなたの番です"]');
  expect(fill).toContain('["done", "終わりました"]');
  expect(fill).toContain("state, tone, fail:");
});

test("W94 kg-row: tone が mark の class。空文字は fail フラグより優先して色 class なし。未指定は従来の fail", () => {
  const base = { name: "経理", glyph: "経", prov: "", state: ["work", "動いています"] as [string, string], fail: false, last: "x", lastHidden: true, time: "10:02", dot: false, surfaces: [] };
  const k = mount("kg-row") as any;
  k.data = { ...base, state: ["turn", "あなたの番です"], tone: "turn" };
  expect(find(k, "mark")!.className).toBe("mark turn");
  k.data = { ...base, state: ["turn", "失敗"], tone: "fail", fail: true };
  expect(find(k, "mark")!.className).toBe("mark fail");
  k.data = { ...base, state: ["turn", "うまく終われませんでした"], tone: "fail", fail: true };
  expect(find(k, "mark")!.className).toBe("mark fail");
  k.data = { ...base, state: ["work", "動いています"], tone: "", fail: true };
  expect(find(k, "mark")!.className).toBe("mark");
  k.data = { ...base, state: ["turn", "失敗"], fail: true };
  expect(find(k, "mark")!.className).toBe("mark fail");
});

test("W94 popover: Esc は開いている「…」だけ閉じ、無ければ何もしない、IME は無視。外側 click は閉じ、中と button は閉じない。nav は触らない（W113: 歯車は画面になり、ここには無い）", () => {
  const js = code(read("extension/panel.js"));
  const i = js.indexOf('document.addEventListener("keydown", (e) => {\n  if (e.key !== "Escape"');
  const j = js.indexOf('$("add-line")', i);
  expect(i).toBeGreaterThan(0);
  const block = js.slice(i, j);
  expect(block).toContain('document.addEventListener("keydown"');
  expect(block).toContain('document.addEventListener("click"');
  expect(block).toContain("e.isComposing");
  expect(block).toContain("closeMore()");
  expect(block).not.toContain("user-pop"); // W113: 歯車の popover の枝は無い
  expect(block).toContain("hidePanes()"); // 設定の画面は Esc で 1 つ閉じる（nav は触らず hidePanes に任せる）
  expect(block).not.toContain("plus-menu"); // W103: ＋ は popover ではない
  expect(block).not.toMatch(/nav\.(back|push|root|settle|stack)/);
  const els: Record<string, { id: string; hidden: boolean; parent: unknown; contains: (t: unknown) => boolean }> = {};
  const make = (id: string) => {
    const n = { id, hidden: true, parent: null as unknown, contains: (_t: unknown) => false };
    n.contains = (t) => { for (let p = t as { parent?: unknown } | null; p; p = p.parent as { parent?: unknown } | null) if (p === n) return true; return false; };
    els[id] = n;
    return n;
  };
  for (const id of ["more", "hd-more", "settings"]) make(id);
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const document = { addEventListener(type: string, fn: (e: any) => void) { (listeners[type] ??= []).push(fn); } };
  const calls: string[] = [];
  const $ = (id: string) => els[id];
  const closeMore = () => { calls.push("closeMore"); els.more!.hidden = true; };
  const hidePanes = () => { calls.push("hidePanes"); els.settings!.hidden = true; };
  const api = new Function("$", "closeMore", "hidePanes", "document", `let composing = false;\n${block}\nreturn { setComposing(v) { composing = v; } };`)($, closeMore, hidePanes, document);
  const key = (o: Record<string, unknown>) => listeners.keydown!.forEach((fn) => fn({ key: "Escape", isComposing: false, keyCode: 0, ...o }));
  const click = (t: unknown) => listeners.click!.forEach((fn) => fn({ target: t }));
  expect(listeners.keydown!.length).toBe(1);
  expect(listeners.click!.length).toBe(1);
  key({});
  expect(calls).toEqual([]);
  els.more!.hidden = false;
  key({ isComposing: true });
  expect(els.more!.hidden).toBe(false);
  key({ keyCode: 229 });
  expect(els.more!.hidden).toBe(false);
  api.setComposing(true);
  key({});
  expect(els.more!.hidden).toBe(false);
  api.setComposing(false);
  key({});
  expect(els.more!.hidden).toBe(true);
  expect(calls).toEqual(["closeMore"]);
  calls.length = 0;
  key({}); // 何も開いていない
  expect(calls).toEqual([]);
  els.settings!.hidden = false; // 設定の画面: Esc で 1 つ閉じる。IME 中は閉じない。「…」が開いていればそちらが先
  key({ isComposing: true });
  expect(els.settings!.hidden).toBe(false);
  els.more!.hidden = false;
  key({});
  expect(calls).toEqual(["closeMore"]);
  expect(els.settings!.hidden).toBe(false);
  key({});
  expect(calls).toEqual(["closeMore", "hidePanes"]);
  expect(els.settings!.hidden).toBe(true);
  calls.length = 0;
  els.settings!.hidden = false;
  click({ parent: null }); // 外側 click は設定の画面を閉じない（全面の画面は popover ではない）
  expect(calls).toEqual([]);
  els.settings!.hidden = true;
  els.more!.hidden = false;
  click(els["hd-more"]);
  click({ parent: els.more });
  expect(els.more!.hidden).toBe(false);
  expect(calls).toEqual([]);
  click({ parent: null });
  expect(calls).toEqual(["closeMore"]);
  const n = calls.length;
  click({ parent: null });
  key({ key: "Enter" });
  expect(calls.length).toBe(n);
});
