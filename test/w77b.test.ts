// W77b（CEO 10-14「UI せっていからボタンの配列を module で」「見なくていい物は見せない」）: kg-approve（always allow / allow / deny）と kg-toggle を light DOM の部品にし、
// panel.js の承認ボタンの 4 重複を置き換えた。見た目と文言は 1 対 1。ここは本物のブラウザ・ポインタに触れない（最小の DOM の代役で属性→描画・イベントを測る）。実機の見た目は未測（要 operator）
import { beforeAll, expect, test } from "bun:test";
import { Plain, installDom, mount } from "./domshim.ts";
const g = globalThis as any;
beforeAll(installDom);
import { readFileSync } from "node:fs";
import { join } from "node:path";


test("W77b kg-approve: 既定は always allow / allow / deny の 3 語がこの順（CEO 指定の英語）・.btns の見た目のまま", () => {
  const k = mount("kg-approve");
  expect(k.children.map((b) => b.textContent)).toEqual(["always allow", "allow", "deny"]);
  expect(k.children.every((b: any) => b.tagName === "BUTTON" && b.type === "button" && b.className.startsWith("btn "))).toBe(true);
  expect(k.children.map((b: any) => b.className)).toEqual(["btn quiet", "btn primary", "btn quiet"]); // W101: allow だけ primary
  expect(k.className).toContain("btns");
});

test("W77b kg-approve: 押すと kg-answer（選んだ id）が 1 度だけ上がり、押した button は押せなくなる（二重押し不可）・choices に無い物は描かない", () => {
  const k = mount("kg-approve"); const got: string[] = [];
  k.addEventListener("kg-answer", (e) => got.push(e.detail.choice));
  k.children[1]!.click(); k.children[1]!.click();
  expect(got).toEqual(["allow"]);
  // W114 以後: 押した瞬間に card の全 button が止まり aria-busy。受け手が busy(false) で戻すと自分が止めた物だけ戻る
  expect(k.children.every((b) => b.disabled)).toBe(true);
  expect(k.getAttribute("aria-busy")).toBe("true");
  (k as any).busy(false);
  expect(k.children.every((b) => !b.disabled)).toBe(true);
  expect(k.hasAttribute("aria-busy")).toBe(false);
  const two = mount("kg-approve", { choices: "allow,deny,evil" });
  expect(two.children.map((b) => b.textContent)).toEqual(["allow", "deny"]); // 知らない id は描かない
});

test("W77b kg-approve: 受け手が足した button（次から覚えない）は残り、押しても kg-answer にならない", () => {
  const k = mount("kg-approve"); const got: string[] = [];
  k.addEventListener("kg-answer", (e) => got.push(e.detail.choice));
  const extra = g.document.createElement("button"); extra.textContent = "次から覚えない"; k.append(extra);
  extra.click();
  expect(got).toEqual([]);
  k.setAttribute("choices", "deny");
  expect(k.children.map((b) => b.textContent)).toContain("次から覚えない");
  expect(k.children.filter((b) => "choice" in b.dataset).map((b) => b.textContent)).toEqual(["deny"]);
});

test("W77b kg-approve: 文字は textContent だけ（agent の名前が入っても HTML にならない）", () => {
  const src = readFileSync(join(import.meta.dir, "../extension/kg.js"), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  expect(src).not.toMatch(/outerHTML|insertAdjacentHTML/);
  expect(src.split("\n").filter((l) => /innerHTML/.test(l)).every((l) => /\.innerHTML = (KgRow\.icons\[|KIND_ICON\[|SURF\[|BACK_SVG;)|^function iconSpan\(html\) \{/.test(l))).toBe(true); // 例外は固定の絵だけ: 状態の絵（W77c kg-row）・種類の印（KIND_ICON）・面の印（SURF）・戻る（BACK_SVG）・kg-progress の固定の SVG（W109 iconSpan）。文字は入らない
  expect([...src.matchAll(/iconSpan\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => a !== "html")).toEqual(["KgProgress.icon", "KgProgress.tick"]); // iconSpan に渡すのは固定の SVG 文字列だけ
  expect(src).not.toMatch(/\bcall\(|chrome\.|localStorage|sessionStorage/); // 部品は port・storage を持たない
});

test("W77b kg-toggle: label・hint・on・disabled を描き、押すと kg-toggle {on} が上がる・受け手の失敗で .on を戻すと表示も戻る", () => {
  const t = mount("kg-toggle", { label: "agent のカーソルを見せる", hint: "見せます" }) as any; const got: boolean[] = [];
  t.addEventListener("kg-toggle", (e: any) => got.push(e.detail.on));
  const lab = t.children[0]! as Plain, [text, box] = lab.children as [Plain, Plain];
  expect(text.textContent).toBe("agent のカーソルを見せる");
  expect(box.getAttribute("aria-label")).toBe("agent のカーソルを見せる");
  expect(lab.title).toBe("見せます");
  expect(box.checked).toBe(false);
  box.checked = true; box.dispatchEvent({ type: "change", bubbles: true });
  expect(got).toEqual([true]);
  expect(t.on).toBe(true);
  t.on = false; // 受け手の失敗 → 戻す
  expect(box.checked).toBe(false);
  t.disabled = true; expect(box.disabled).toBe(true);
  t.disabled = false; expect(box.disabled).toBe(false);
  t.on = true; expect(box.checked).toBe(true);
});

test("W77b panel: 承認の 3 ボタンの for は panel.js から無くなり、4 箇所すべて kg-approve を通る・設定の 2 つは kg-toggle・文言は CEO 指定のまま", () => {
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const html = readFileSync(join(import.meta.dir, "../extension/panel.html"), "utf8");
  expect(js).not.toMatch(/\["always allow",/); // 重複していた 3 択の配列は部品の 1 か所だけ
  expect(js).toContain('document.createElement("kg-approve")');
  expect(js.match(/approveEl\(/g)!.length).toBe(4); // approval・vault・carry・routine
  expect(readFileSync(join(import.meta.dir, "../extension/kg.js"), "utf8")).toContain('always: "always allow", allow: "allow", deny: "deny"');
  expect(html).toContain('<kg-toggle id="cursor-overlay" label="agent のカーソルを見せる"');
  expect(html).toContain('<kg-toggle id="named-only" label="tab では名前で指す操作だけ使わせる"');
  expect(html.indexOf('src="kg.js"')).toBeGreaterThan(0);
  expect(html.indexOf('src="kg.js"')).toBeLessThan(html.indexOf('src="panel.js"')); // 部品を先に定義（panel.js が .on を触る前）
  expect(js).toContain('call("leaseMode", { app: a.app, mode: "allow" })'); // always の副作用は受け手に残っている
});

test("W77b css: scrollbar は細く薄く（token）・hover で濃く・直書きの高さは token へ", () => {
  const css = readFileSync(join(import.meta.dir, "../extension/panel.css"), "utf8");
  expect(css).toMatch(/::-webkit-scrollbar \{ width:var\(--sb-w\)/);
  expect(css).toMatch(/::-webkit-scrollbar-thumb:hover \{ background:var\(--sb-thumb-hover\)/);
  expect(css).toMatch(/--sb-w:\s*4px/); // W110: DESIGN §5 の scrollbar は 4px（token --sb-w）
  expect(css).not.toMatch(/min-height:(32|36)px/);
});
