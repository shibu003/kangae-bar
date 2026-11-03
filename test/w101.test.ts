// W101: kg-approve の choice / multi と役割 class。描画と event は domshim（本物のブラウザには触れない）。実機は未測
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount } from "./domshim.ts";

let answerLine: (d: any) => string;
beforeAll(async () => {
  await installDom();
  ({ answerLine } = await import("../extension/kg.js"));
});
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const radios = (k: any) => k.querySelectorAll("input").filter((n: any) => n.type === "radio");
const freeOf = (k: any) => k.querySelectorAll("input").find((n: any) => n.type === "text");
const goOf = (k: any) => k.querySelectorAll("button").find((n: any) => "go" in n.dataset);
const chips = (k: any) => k.querySelectorAll("button").filter((n: any) => "opt" in n.dataset);
const typeIn = (inp: any, v: string) => { inp.value = v; inp.dispatchEvent({ type: "input", bubbles: true, target: inp, stopPropagation() { (this as any).stopped = true; } }); };
const choice = (opts = "投稿する\n下書きにする\nやめる", extra: Record<string, string> = { free: "" }) => mount("kg-approve", { kind: "choice", "data-options": opts, ...extra });
const multi = (opts = "social media marketer\nshort video creator\neditor", extra: Record<string, string> = { free: "" }) => mount("kg-approve", { kind: "multi", "data-options": opts, ...extra });

test("W101 choice: radio は options の数・未選択ではこれでが disabled・選ぶか書くと有効・kg-answer は 1 度", () => {
  const k = choice();
  const rs = radios(k);
  expect(rs.map((r: any) => r.parent.querySelectorAll("span")[0].textContent)).toEqual(["投稿する", "下書きにする", "やめる"]);
  expect(new Set(rs.map((r: any) => r.getAttribute("name"))).size).toBe(1);
  const free = freeOf(k);
  expect(free.getAttribute("placeholder")).toBe("ほかに");
  const go = goOf(k);
  expect(go.textContent).toBe("これで");
  expect(go.disabled).toBe(true);
  rs[1].click();
  expect(rs[1].checked).toBe(true);
  expect(rs[0].checked).toBe(false);
  expect(go.disabled).toBe(false);
  const got: any[] = [];
  k.addEventListener("kg-answer", (e: any) => got.push(e.detail));
  typeIn(free, "朝に");
  go.click();
  go.disabled = false;
  go.click();
  expect(got).toEqual([{ kind: "choice", choice: "下書きにする", free: "朝に" }]);
  const bare = choice("a\nb\nc", {});
  expect(freeOf(bare)).toBeUndefined();
  expect(goOf(bare).disabled).toBe(true);
  radios(bare)[0].click();
  expect(goOf(bare).disabled).toBe(false);
  const only = choice("a\nb", { free: "" });
  const g2 = goOf(only);
  expect(g2.disabled).toBe(true);
  typeIn(freeOf(only), "   ");
  expect(g2.disabled).toBe(true);
  typeIn(freeOf(only), "別案");
  expect(g2.disabled).toBe(false);
  const got2: any[] = [];
  only.addEventListener("kg-answer", (e: any) => got2.push(e.detail));
  g2.click();
  expect(got2).toEqual([{ kind: "choice", choice: "", free: "別案" }]);
  expect(radios(choice())[0].getAttribute("name")).not.toBe(radios(choice())[0].getAttribute("name"));
});

test("W101 multi: チップは options の数・aria-pressed が反転・1 つ以上で有効・choices は押した物だけ", () => {
  const k = multi();
  const cs = chips(k);
  expect(cs.map((b: any) => b.textContent)).toEqual(["social media marketer", "short video creator", "editor"]);
  expect(cs.every((b: any) => b.type === "button" && b.getAttribute("aria-pressed") === "false")).toBe(true);
  const go = goOf(k);
  expect(go.disabled).toBe(true);
  cs[2].click();
  expect(cs[2].getAttribute("aria-pressed")).toBe("true");
  expect(go.disabled).toBe(false);
  cs[0].click();
  cs[2].click();
  expect(cs[2].getAttribute("aria-pressed")).toBe("false");
  const got: any[] = [];
  k.addEventListener("kg-answer", (e: any) => got.push(e.detail));
  typeIn(freeOf(k), "翻訳");
  go.click();
  expect(got).toEqual([{ kind: "multi", choices: ["social media marketer"], free: "翻訳" }]);
});

test("W101 文字は textContent（options の <b> は字のまま）", () => {
  const k = choice("<b>x</b>\ny", { free: "" });
  const span = radios(k)[0].parent.querySelectorAll("span")[0];
  expect(span.textContent).toBe("<b>x</b>");
  expect(span.innerHTML).toBe("");
  const m = multi("<b>z</b>", {});
  expect(chips(m)[0].textContent).toBe("<b>z</b>");
  expect(chips(m)[0].innerHTML).toBe("");
  const src = code(read("extension/kg.js"));
  const body = src.slice(src.indexOf("const LABEL"), src.indexOf("class KgToggle"));
  expect(body).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
});

test("W101 役割 class: 既定は allow=primary・danger で deny=danger / allow=quiet", () => {
  const k = mount("kg-approve");
  expect(k.children.map((b: any) => [b.dataset.choice, b.className])).toEqual([["always", "btn quiet"], ["allow", "btn primary"], ["deny", "btn quiet"]]);
  const d = mount("kg-approve", { danger: "" });
  expect(d.children.map((b: any) => [b.dataset.choice, b.className])).toEqual([["always", "btn quiet"], ["allow", "btn quiet"], ["deny", "btn danger"]]);
  const two = mount("kg-approve", { choices: "allow,deny", danger: "" });
  expect(two.children.map((b: any) => [b.dataset.choice, b.className])).toEqual([["allow", "btn quiet"], ["deny", "btn danger"]]);
});

test("W101 人の言葉と panel の受け手（ask の 3 ボタンは増やさない）", () => {
  expect(answerLine({ kind: "choice", choice: "投稿する", free: "" })).toBe("投稿する");
  expect(answerLine({ kind: "choice", choice: "投稿する", free: "朝に" })).toBe("投稿する（ほかに: 朝に）");
  expect(answerLine({ kind: "choice", choice: "", free: "別案" })).toBe("別案");
  expect(answerLine({ kind: "multi", choices: ["a", "b", "c"], free: "" })).toBe("選んだ: a, b, c");
  expect(answerLine({ kind: "multi", choices: ["a", "b"], free: "x" })).toBe("選んだ: a, b（ほかに: x）");
  expect(answerLine({ kind: "multi", choices: [], free: "x" })).toBe("ほかに: x");
  const js = code(read("extension/panel.js"));
  const card = js.slice(js.indexOf("function cardEl"), js.indexOf("function renderChat"));
  expect(card).toContain('k.setAttribute("kind", c.kind)');
  expect(card).toContain('k.setAttribute("data-options"');
  expect(card.indexOf('c.kind === "choice"')).toBeLessThan(card.indexOf("c.options.forEach"));
  const fn = js.slice(js.indexOf("const onAnswer"), js.indexOf("function cardEl"));
  expect(fn).toContain('d.kind === "choice" || d.kind === "multi"');
  expect(fn).toContain("answerLine(d)");
  expect(fn).toContain("sendChat(id, text)");
  expect(js.match(/approveEl\(/g)!.length).toBe(4);
});

test("W101 css: DESIGN.md §6 の token（直書きの色と px は無い・:root は触らない）", () => {
  const css = read("extension/panel.css");
  const i = css.indexOf("/* W101:");
  const block = css.slice(i, css.indexOf(".receipt", i));
  for (const s of ["background:var(--primary)", "color:var(--primary-fg)", "background:var(--primary-hover)", "background:var(--primary-active)", "background:transparent", "color:var(--fg)", "background:var(--hover)", "background:var(--active)", "background:var(--destructive)", "color:var(--destructive-fg)", "background:var(--destructive-hover)", "background:var(--destructive-active)", "outline:var(--focus-w) solid var(--focus)", "background:var(--disabled-bg)", "color:var(--disabled-fg)", "font-size:var(--fs-meta)", "line-height:var(--lh-meta)", "padding:var(--sp-2) var(--button-pad-x)", "border-radius:var(--r-md)", "gap:var(--button-gap)", "flex:1.4", "gap:var(--card-gap)"]) expect(block, s).toContain(s);
  expect(block.replace(/#add-[\w-]*/g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(|\d+px/); // W115: id セレクタ #add-tab は色ではない（w110 AC4 と同じ除外）
  expect(css.slice(0, css.indexOf("/* W101:")).replace(/:root\s*\{[^{}]*\}/g, "")).not.toContain("--destructive-fg"); // W115: :root は W110 が token を持つので外して数える
});
