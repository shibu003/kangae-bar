// W90（docs/BRIEF-w90.md・design-ui-inventory.md §6-15 / §10.1 / §10.6 / §10.7）: ○＜ で戻る（kg-back）・選択で copy!・always allow の toast・#cmds / #mods の CSS の漏れ。
// 本物のブラウザ・ポインタに触れない（最小の DOM の代役）。実機の見た目・clipboard は未測（要 operator）。読む file を literal で名指す: "extension/kg.js" "extension/panel.js" "extension/panel.html" "extension/panel.css"
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount } from "./domshim.ts";
beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const fire = (el: any, type: string) => el.dispatchEvent({ type, bubbles: true, target: el, stopPropagation() { (this as any).stopped = true; } });

test("W90 kg-back: 1 押しで kg-back {to:prev}・2 度押しで {to:root}・Enter でも prev・depth=0（一覧＝根）では何も投げない", () => {
  const b = mount("kg-back", { depth: "2" }) as any; const got: string[] = [];
  b.addEventListener("kg-back", (e: any) => got.push(e.detail.to));
  b.click();
  fire(b, "dblclick");
  let prevented = false;
  (b.listeners.get("keydown") ?? []).forEach((l: any) => l.f({ key: "Enter", preventDefault: () => (prevented = true) }));
  expect(got).toEqual(["prev", "root", "prev"]);
  expect(prevented).toBe(true);
  expect(b.getAttribute("role")).toBe("button");
  expect(b.getAttribute("aria-disabled")).toBe("false");
  b.setAttribute("depth", "0");
  expect(b.getAttribute("aria-disabled")).toBe("true");
  b.click(); fire(b, "dblclick");
  expect(got).toEqual(["prev", "root", "prev"]); // 根では投げない
  expect(b.querySelectorAll("span").length).toBe(1); // 連結し直しても ring は 1 つ
  b.connectedCallback();
  expect(b.querySelectorAll("span").length).toBe(1);
});

test("W90 kg-back: 中の ○＜ は固定の SVG（文字も css の線も持たない・W119）・port / storage を持たない", () => {
  const kg = code(read("extension/kg.js")), src = kg.slice(kg.indexOf("class KgBack"), kg.indexOf("customElements.define")), css = read("extension/panel.css");
  expect(src).not.toMatch(/textContent|\bcall\(|chrome\.|localStorage/);
  expect(src).toContain("this._ring.innerHTML = BACK_SVG"); // 固定の定数だけ（利用者の文字は入らない）
  expect(css).not.toContain(".ring::before");
  expect(kg).toContain('customElements.define("kg-back", KgBack)');
});

test("W90 panel: ○＜ は会話の header（#hd-list）と一覧の header（#list-back）の両方に・☰ は無い・stack は 1 本（根 = 一覧）で dblclick = root", () => {
  const html = read("extension/panel.html"), js = code(read("extension/panel.js")), css = read("extension/panel.css");
  expect(html).toContain('<kg-back id="hd-list" depth="1"');
  expect(html).toContain('<kg-back id="list-back" depth="0"');
  expect(html).not.toContain("M2.5 4.5h11M2.5 8h11M2.5 11.5h11"); // ☰ の線
  expect(html.indexOf('id="list-back"')).toBeLessThan(html.indexOf('id="user-btn"')); // 一覧でも左上
  expect(js).toContain('stack: ["list"]');
  expect(js).toContain('root() { this.stack = ["list"]; this.show("list"); }');
  expect(js).toContain('$(id).addEventListener("kg-back", (e) => (e.detail.to === "root" ? nav.root() : nav.back()))');
  expect(js).toContain('if (nav.top() !== "chat") nav.stack.push("chat");'); // 会話を開いたら 1 段
  expect(js).toContain("nav.push(name);"); // 一覧の中の頁も 1 段
  expect(js).toContain('$("user-btn").onclick = () => nav.show("settings");'); // 歯車も 1 段（W113: openPane が push する）
  expect(js).not.toContain('$("hd-list").onclick'); // 旧 ☰ の handler は無い
  expect(css).toContain('kg-back[depth="0"] { opacity:.35; cursor:default; }');
  expect(css).toContain("kg-back .ring { width:var(--back-size); height:var(--back-size); border-radius:50%;"); // W119: 円は kg.js の固定 SVG（.back-ring）・.ring は hover の背景だけ
  expect(css).toContain("#list-hd, #hd, #press-hd, #thread header, #settings > header {"); // W123: 一覧も会話も 1 つの rule（左端は --header-start = Bar の信号機の右から）
  expect(css).toContain("var(--sp-2) var(--gutter) var(--sp-2) var(--header-start)");
});

test("W90 panel: 文を選ぶと copy して toast「copy!」・入力欄の中は触らない・同じ文は 2 度入れない・Shift の keyup でも", () => {
  const js = code(read("extension/panel.js"));
  const fn = js.slice(js.indexOf("function copySel()"), js.indexOf('document.addEventListener("mouseup"'));
  expect(fn).toContain('if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return;');
  expect(fn).toContain("if (!text || text === copied) return;");
  expect(fn).toContain('ok = !!document.execCommand("copy")');
  expect(fn).toContain('toast("copy!", { ms: 1100 })');
  expect(fn).toContain("navigator.clipboard?.writeText(text)"); // execCommand が駄目な環境の予備
  expect(js).toContain('document.addEventListener("mouseup", () => setTimeout(copySel, 0));');
  expect(js).toContain('if (e.key === "Shift" || e.shiftKey) setTimeout(copySel, 0);');
  expect(js).toContain('if (!String(window.getSelection() || "").trim()) copied = "";'); // 選択を解いたら次は入る
});

test("W90 panel: always allow を押すと「全部の agent に効く」toast（承認の leaseMode と金庫の両方）", () => {
  const js = code(read("extension/panel.js"));
  expect(js).toContain('await call("leaseMode", { app: a.app, mode: "allow" }); toast(`always allow: これからは全部の agent に効きます（${a.app}）`); }');
  expect(js).toContain('toast(`always allow: これからは全部の agent に効きます（${a.host}）`)');
  expect(js.match(/これからは全部の agent に効きます/g)!.length).toBe(2);
});

test("W90→W97 css: #cmds / #mods は kg-settings の中に在り、節の中では display:flex（出さない rule は #screen-engine だけ）", () => {
  const css = read("extension/panel.css"), html = read("extension/panel.html");
  expect(css).toContain("#screen-engine { display:none; }");
  expect(css).not.toContain("#screen-engine, #cmds, #mods { display:none; }");
  const cmds = /^#cmds \{[^}]*\}/m.exec(css)![0], mods = /^#mods \{[^}]*\}/m.exec(css)![0];
  expect(cmds).toContain("display:flex");
  expect(mods).toContain("display:flex");
  expect(css.match(/^#cmds \{/gm)!.length).toBe(1);
  expect(css.match(/^#mods \{/gm)!.length).toBe(1);
  const pop = html.slice(html.indexOf('<kg-settings id="user-pop"'), html.indexOf("</kg-settings>"));
  expect(pop.indexOf("<summary>覚えた物</summary>")).toBeGreaterThan(-1);
  expect(pop.indexOf("<summary>覚えた物</summary>")).toBeLessThan(pop.indexOf('id="cmds"'));
  expect(pop.indexOf('id="cmds"')).toBeLessThan(pop.indexOf('id="mods"'));
});
