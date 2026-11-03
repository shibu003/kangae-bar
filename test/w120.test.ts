// W120: 初回の 3 手順の直下に Downloads の 1 行。案内（拡張の項目）が消える描き直しで ol と同時に無い。
// 描画は test/domshim.ts の要素（本物のブラウザには触れない）。読む file を literal で名指す: "extension/panel.js" "extension/panel.css"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstCards } from "../extension/groups.js";
import { RULES } from "../extension/rules.js";
import { El, Plain } from "./domshim.ts";

const NOTE = "macOS が『Downloads フォルダへのアクセス』を聞いたら『許可』を押してください（Kangae が添付を保存するために使います）";
const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

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
const notes = (box: El) => walk(box).filter((n) => n.className.split(" ").includes("first-note"));

function renderFirstOf(place: { ok: boolean; hint?: string }) {
  const js = read("extension/panel.js");
  const src = js.slice(js.indexOf("function rulesCard"), js.indexOf("const sleepMs"));
  const box = new Box("div");
  const $ = (id: string) => (id === "first" ? box : null);
  const call = async (op: string) => { expect(op).toBe("extPlace"); return place; };
  const renderFirst = new Function("$", "mk", "txt", "el", "ICON", "RULES", "firstCards", "call", `${src}; return renderFirst;`)($, mk, txt, el, { turn: "" }, RULES, firstCards, call) as (needs: unknown[]) => void;
  return { box, renderFirst, src };
}

test("W120 初回の案内: checklist の直下に Downloads の 1 行。拡張の項目が無い描き直しで ol と同時に無い", async () => {
  const { box, renderFirst, src } = renderFirstOf({ ok: true });
  expect(src).toContain('txt("p", "first-note"');
  expect(src).not.toMatch(/innerHTML/);
  const ext = [{ kind: "extension", what: "拡張を置く", how: "Chrome に読み込みます" }];
  renderFirst(ext);
  expect(notes(box)).toEqual([]);
  const btn = walk(box).find((n) => n.tagName === "BUTTON") as Plain & { onclick?: () => Promise<void> };
  await btn.onclick!();
  const found = notes(box);
  expect(found.length).toBe(1);
  expect(found[0]!.tagName).toBe("P");
  expect(found[0]!.textContent).toBe(NOTE);
  const ol = walk(box).find((n) => n.tagName === "OL")!;
  expect(ol.parent).toBe(found[0]!.parent);
  expect(ol.parent!.children.indexOf(found[0]!) - ol.parent!.children.indexOf(ol)).toBe(1);
  renderFirst([{ kind: "claude", what: "準備できました", how: "使えます", notice: true }]);
  expect(notes(box)).toEqual([]);
  expect(walk(box).filter((n) => n.tagName === "OL")).toEqual([]);
  const fail = renderFirstOf({ ok: false, hint: "disk" });
  fail.renderFirst(ext);
  const no = walk(fail.box).find((n) => n.tagName === "BUTTON") as Plain & { onclick?: () => Promise<void> };
  await no.onclick!();
  expect(notes(fail.box)).toEqual([]);
});

test("W120 first-note は補足の token（px と色の直書きが無い）", () => {
  const css = read("extension/panel.css");
  const i = css.indexOf(".card .first-note");
  expect(i).toBeGreaterThan(-1);
  const rule = css.slice(i, css.indexOf("}", i));
  expect(rule).toContain("var(--fs-meta)");
  expect(rule).toContain("var(--lh-meta)");
  expect(rule).toContain("var(--muted-fg)");
  expect(rule).toContain("var(--sp-2)");
  expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}|[0-9]+px/);
  expect(css.slice(0, css.indexOf("}"))).not.toContain("first-note");
});
