// W113（docs/BRIEF-w113.md・DESIGN.md §6 設定 / kg-settings・kg-toggle・select、§4 設定 summary / 設定行 / 設定の節）: 設定は popover でなく独立した全面の画面。
// 本物のブラウザには触れない（domshim と source の読み）。実機の見た目は未測（要 operator）。読む file: "extension/panel.html" "extension/panel.js" "extension/kg.js" "extension/panel.css"
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount, Plain } from "./domshim.ts";

beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const html = read("extension/panel.html");
const js = code(read("extension/panel.js"));
const css = read("extension/panel.css");

test("W113 AC1 歯車は nav に settings を積んで画面を開く・popover の開閉 code（user-pop / aria-expanded / 外側 click の枝）が無い", () => {
  expect(js).toContain('$("user-btn").onclick = () => nav.show("settings");');
  expect(js).not.toContain("user-pop\").hidden"); // popover の開け閉めは無い
  expect(js).not.toMatch(/\$\("user-btn"\)\.setAttribute/); // 歯車は menu button ではない
  expect(js).not.toMatch(/openPop|closePop|popHolds/);
  expect(html).not.toMatch(/id="user-btn"[^>]*aria-expanded/);
  // 画面は一覧の頭（#list-hd）の中でなく自分の section に在り、ヘッダに ○＜ と題「設定」
  const hd = html.slice(html.indexOf('<header id="list-hd">'), html.indexOf("</header>", html.indexOf('<header id="list-hd">')));
  expect(hd).not.toContain("user-pop");
  const sec = html.slice(html.indexOf('<section id="settings"'), html.indexOf("</kg-settings>") + "</kg-settings>".length);
  expect(sec).toMatch(/<section id="settings" hidden aria-label="設定">\s*<header id="settings-hd">\s*<kg-back id="settings-back" depth="1"/);
  expect(sec).toContain("<h1>設定</h1>");
  expect(sec).toContain('<kg-settings id="user-pop">');
  expect(sec).not.toContain('<kg-settings id="user-pop" hidden');
  expect(js).toContain('for (const id of ["hd-list", "list-back", "press-back", "settings-back", "thread-back"])');
  // nav の本物を取り出して回す: show("settings") は hidePanes ではなく openPane を呼び、stack に積み、○＜ の 1 押しで一覧へ
  const src = js.slice(js.indexOf("const nav = {"), js.indexOf("function closeList()"));
  const calls: string[] = [], depths: Record<string, string> = {};
  const node = (id: string) => ({ hidden: false, classList: { add() {}, remove() {}, contains: () => false }, setAttribute(k: string, v: string) { if (k === "depth") depths[id] = v; } });
  const cache: Record<string, ReturnType<typeof node>> = {};
  const $ = (id: string) => (cache[id] ??= node(id));
  let nav: any;
  const openPane = (n: string) => { calls.push(`openPane:${n}`); nav.push(n); };
  const hidePanes = () => calls.push("hidePanes");
  nav = new Function("$", "hidePanes", "openPane", "closeList", `${src}\nreturn nav;`)($, hidePanes, openPane, () => {});
  nav.show("settings");
  expect(nav.stack).toEqual(["list", "settings"]);
  expect(calls).toEqual(["openPane:settings"]);
  expect(depths["settings-back"]).toBe("1");
  nav.back();
  expect(nav.stack).toEqual(["list"]);
  expect(calls).toEqual(["openPane:settings", "hidePanes"]);
  expect(depths["settings-back"]).toBe("0");
  // openPane / hidePanes は #settings を出し入れする
  expect(js).toContain('$("settings").hidden = name !== "settings";');
  expect(js).toContain('listChrome(name !== "press" && name !== "settings");');
  expect(js).toContain('$("settings").hidden = true;');
});

test("W113 AC2 節は 会話 → 画面の操作 → 覚えた許し → 覚えた物 の順・全部閉じで始まり、1 つ開くと他が閉じ、画面を開くたびに全部閉じる", () => {
  const pop = html.slice(html.indexOf('<kg-settings id="user-pop"'), html.indexOf("</kg-settings>"));
  const at = ["<summary>会話</summary>", "<summary>画面の操作</summary>", "<summary>覚えた許し</summary>", "<summary>覚えた物</summary>"].map((s) => pop.indexOf(s));
  expect(at.every((i) => i > -1)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(pop.match(/<details[ >]/g)!.length).toBe(4);
  expect(pop).not.toMatch(/<details[^>]*\sopen/); // 閉じで始まる
  const s = mount("kg-settings") as any;
  const [a, b, c] = [new Plain("details"), new Plain("details"), new Plain("details")];
  s.append(a, b, c);
  a.open = true; a.dispatchEvent({ type: "toggle", target: a });
  b.open = true; b.dispatchEvent({ type: "toggle", target: b });
  expect([a.open, b.open, c.open]).toEqual([false, true, false]);
  s.closeAll();
  expect([a.open, b.open, c.open]).toEqual([false, false, false]);
  expect(js).toContain('if (name === "settings") { $("user-pop").closeAll();');
});

test("W113 AC3 toggle: DOM は label > [名前, input(role=switch), track, 説明]・説明は常時（hint なしなら出さない）・css は §6 の寸法を token で（hit 44・track 36×22・thumb 16・inset 3・移動 14）", () => {
  const t = mount("kg-toggle", { label: "agent のカーソルを見せる", hint: "見せます" }) as any;
  const lab = t.children[0] as Plain;
  const [text, box, track, hint] = lab.children as any[];
  expect(lab.tagName).toBe("LABEL");
  expect(text.className).toBe("setting-label");
  expect(box.getAttribute("role")).toBe("switch");
  expect(box.type).toBe("checkbox");
  expect(track.className).toBe("switch-track");
  expect(track.getAttribute("aria-hidden")).toBe("true");
  expect(hint.textContent).toBe("見せます");
  expect(hint.hidden).toBe(false);
  expect(box.getAttribute("aria-describedby")).toBe(hint.id);
  const bare = mount("kg-toggle", { label: "on" }) as any;
  const [, bbox, , bhint] = bare.children[0].children as any[];
  expect(bhint.hidden).toBe(true);
  expect(bbox.getAttribute("aria-describedby")).toBeNull();
  const root = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));
  for (const [k, v] of [["toggle-w", "36px"], ["toggle-h", "22px"], ["toggle-thumb", "16px"], ["toggle-inset", "3px"], ["toggle-shift", "14px"], ["hit", "44px"], ["hit-sm", "36px"]]) expect(root).toMatch(new RegExp(`--${k}:\\s*${v};`));
  const rule = (sel: string) => { const m = new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[^}]*\\}`, "m").exec(css); expect(m, sel).not.toBeNull(); return m![0]; };
  const input = rule("kg-toggle input");
  expect(input).toContain("width:var(--hit)");
  expect(input).toContain("height:var(--hit)");
  const trackCss = rule("kg-toggle .switch-track");
  expect(trackCss).toContain("width:var(--toggle-w)");
  expect(trackCss).toContain("height:var(--toggle-h)");
  expect(trackCss).toContain("border:var(--line-w) solid var(--control-border)"); // off は control-border の輪郭
  const thumb = rule("kg-toggle .switch-track::after");
  expect(thumb).toContain("width:var(--toggle-thumb)");
  expect(thumb).toContain("height:var(--toggle-thumb)");
  expect(thumb).toContain("var(--toggle-inset)");
  const on = rule("kg-toggle input:checked + .switch-track");
  expect(on).toContain("background:var(--primary)");
  expect(rule("kg-toggle input:checked + .switch-track::after")).toMatch(/translateX\(var\(--toggle-shift\)\).*var\(--primary-fg\)/);
  expect(rule("kg-toggle .setting-label")).toMatch(/var\(--fs-body\).*var\(--lh-body\)/); // 14/24
  expect(rule("kg-toggle .setting-hint")).toMatch(/var\(--fs-meta\).*var\(--lh-meta\)/); // 12/20
  expect(rule("#user-pop kg-toggle > label")).toContain("min-height:var(--hit)");
  // 節: card 背景・border 1px・r-lg・節間 8px・summary は 14/600・min 52px・chevron 16px
  expect(rule("#user-pop > details")).toMatch(/background:var\(--card\).*var\(--line-w\) solid var\(--border\).*var\(--r-lg\)/);
  expect(rule("#user-pop")).toContain("gap:var(--section-gap)");
  expect(root).toMatch(/--section-gap:\s*var\(--sp-2\);/);
  const sum = rule("#user-pop > details > summary");
  expect(sum).toContain("min-height:calc(var(--hit) + var(--sp-2))");
  expect(sum).toContain("font-size:var(--fs-body)");
  expect(sum).toContain("font-weight:var(--fw-strong)");
  expect(rule("#user-pop > details > summary::before")).toMatch(/width:var\(--ic-2\); height:var\(--ic-2\)/);
  expect(rule("#user-pop > details[open] > summary::before")).toContain("rotate(90deg)");
  // select は label と右端を揃え min 36px
  const row = rule("#viewer-row");
  expect(row).toContain("justify-content:space-between");
  expect(row).toContain("min-height:var(--hit-sm)");
  // 直書きの px・色を足していない（この片の rule 群）
  const mine = css.slice(css.indexOf("/* W113:"), css.indexOf("@media (prefers-reduced-motion: reduce) { #user-pop")).replace(/\/\*[\s\S]*?\*\//g, "");
  expect(mine.length).toBeGreaterThan(1000);
  expect(mine).not.toMatch(/\b\d+px\b/);
  expect(mine).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(css).not.toMatch(/^#user-pop \{ position:absolute/m); // popover の絶対配置は無い
  expect(css).toContain("#sessions:has(> #settings:not([hidden])) :is(#turn-line, #find-text, #roots-empty) { display:none; }"); // 全面の時は一覧の上に載る物も隠す
});

test("W113 AC4 kangaeOpenSettings は nav.root のあと歯車（= nav の画面）を開く・popover の hidden は見ない", () => {
  const start = js.indexOf("window.kangaeOpenSettings =");
  const block = js.slice(start, js.indexOf("};", start));
  expect(block).toContain("nav.root();");
  expect(block).toContain('$("user-btn").onclick();');
  expect(block).not.toContain("user-pop");
});
