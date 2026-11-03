// W96: 初回の「置きました」のあとは <ol> の 3 行。見える文字に password / side panel / 許可は off が 0。
// 描画は test/domshim.ts の要素（本物のブラウザには触れない）。読む file を literal で名指す: "extension/panel.js" "extension/newtab.html" "extension/panel.html" "extension/kg.js" "test/internal-words.ts"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstCards } from "../extension/groups.js";
import { RULES } from "../extension/rules.js";
import { El, Plain } from "./domshim.ts";
import { INTERNAL } from "./internal-words.ts";
import { htmlTexts, jsTexts } from "./w77e.test.ts";

const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const panel = () => read("extension/panel.js");
const renderSrc = () => {
  const js = panel();
  return js.slice(js.indexOf("function renderFirst"), js.indexOf("const sleepMs"));
};
const STEPS = [
  "chrome://extensions を開き、右上の「デベロッパー モード」をオンにする",
  "「パッケージ化されていない拡張機能を読み込む」を押す",
  "Finder で開いた「extension」フォルダを選ぶ",
];
const WORDS = ["password", "side panel", "許可は off"];

class Box extends Plain {
  override append(...n: any[]) {
    const els: El[] = n.map((x): El => {
      if (x instanceof El) return x;
      const t = new Box("span");
      t.textContent = String(x ?? "");
      return t;
    });
    return super.append(...els);
  }
}
const g = globalThis as any;
g.document = { createElement: (t: string) => new Box(t) };
const mk = (tag: string, cls: string) => Object.assign(g.document.createElement(tag), { className: cls });
const el = (tag: string, cls: string, html?: string) => { const x = mk(tag, cls); if (html != null) x.innerHTML = html; return x; };
const txt = (tag: string, cls: string, text: string) => { const x = mk(tag, cls); x.textContent = text; return x; };
const walk = (n: El): El[] => [n, ...n.children.flatMap(walk)];

function renderFirstOf(place: { ok: boolean; hint?: string }) {
  const js = panel();
  const src = js.slice(js.indexOf("function rulesCard"), js.indexOf("const sleepMs"));
  const box = new Box("div");
  const $ = (id: string) => (id === "first" ? box : null);
  const call = async (op: string) => { expect(op).toBe("extPlace"); return place; };
  const renderFirst = new Function("$", "mk", "txt", "el", "ICON", "RULES", "firstCards", "call", `${src}; return renderFirst;`)($, mk, txt, el, { turn: "" }, RULES, firstCards, call) as (needs: unknown[]) => void;
  return { box, renderFirst };
}

test("W96 renderFirst: 置けたら <ol> の li が 3（textContent・innerHTML 無し）。拡張の項目が無い描き直しで ol は消える", async () => {
  const src = renderSrc();
  expect(src).toContain('document.createElement("ol")');
  expect(src).toContain('document.createElement("li")');
  expect(src).toContain("li.textContent = step");
  expect(src).not.toMatch(/innerHTML/);
  expect(src).not.toContain("①");
  const js = panel();
  expect(js).toContain("if (sig(now) !== sig(shown)) return (renderFirst(now), watchFirst(token, now));");
  const { box, renderFirst } = renderFirstOf({ ok: true });
  const ext = [{ kind: "extension", what: "拡張を置く", how: "Chrome に読み込みます" }];
  renderFirst(ext);
  const btn = walk(box).find((n) => n.tagName === "BUTTON") as Plain & { onclick?: () => Promise<void> };
  expect(btn.textContent).toContain("拡張の置き場を Finder で開く");
  await btn.onclick!();
  const ols = walk(box).filter((n) => n.tagName === "OL");
  expect(ols.length).toBe(1);
  const lis = ols[0]!.children.filter((n) => n.tagName === "LI");
  expect(lis.map((n) => n.textContent)).toEqual(STEPS);
  expect(box.textContent).toContain("置きました。次の 3 つを Chrome でしてください");
  renderFirst([{ kind: "claude", what: "準備できました", how: "使えます", notice: true }]);
  expect(walk(box).filter((n) => n.tagName === "OL")).toEqual([]);
  const fail = renderFirstOf({ ok: false, hint: "disk" });
  fail.renderFirst(ext);
  const no = walk(fail.box).find((n) => n.tagName === "BUTTON") as Plain & { onclick?: () => Promise<void> };
  await no.onclick!();
  expect(walk(fail.box).filter((n) => n.tagName === "OL")).toEqual([]);
  expect(fail.box.textContent).toContain("置けませんでした（disk）");
});

test("W96 見える文字に password / side panel / 許可は off が 0（表に 3 語・長さ 36）", () => {
  const all = [...["panel.js", "kg.js", "newtab.js"].flatMap((f) => jsTexts(f)), ...["panel.html", "newtab.html"].flatMap((f) => htmlTexts(f))];
  expect(all.length).toBeGreaterThan(250);
  const bad = all.filter((s) => new RegExp(WORDS.join("|"), "i").test(s.text)).map((s) => `${s.at} ${s.text.slice(0, 80)}`);
  expect(bad).toEqual([]);
  const parts = INTERNAL.source.split("|");
  expect(parts.length).toBe(36);
  for (const w of WORDS) expect(parts, w).toContain(w);
  expect(read("extension/newtab.html")).toContain("Bar の会話の『…』→『デスクトップ』で、会話や tab をここに置けます");
});
