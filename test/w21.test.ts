// W21（EXP-1 再走の所見）: ①「＋」の新規画面は空 ②信号機に重ならない ③丸の字が agent A / B で同じにならない
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
const css = readFileSync(join(import.meta.dir, "../extension/panel.css"), "utf8");
const glyphOf = (roots: { id: number; text: string; agent?: { name: string } }[]) => {
  const src = js.slice(js.indexOf("const nameOf = "), js.indexOf("// 一覧の行（LINE のトーク一覧の形）"));
  const f = new Function("roots", `${src}; return avatarGlyph;`)(roots) as (r: unknown) => string;
  return roots.map(f);
};

test("W21③ agent A / agent B は丸の字が別（先頭が同じなら最後の語の頭）・それでも同じなら番号・RTL 上書きは字にしない", () => {
  expect(glyphOf([{ id: 1, text: "x", agent: { name: "agent A" } }, { id: 2, text: "y", agent: { name: "agent B" } }])).toEqual(["A", "B"]);
  expect(glyphOf([{ id: 1, text: "調べ物" }, { id: 2, text: "資料作り" }])).toEqual(["調", "資"]); // 別なら先頭のまま
  expect(glyphOf([{ id: 1, text: "請求 係" }, { id: 2, text: "請求 係" }, { id: 3, text: "請求 係" }])).toEqual(["1", "2", "3"]);
  expect(glyphOf([{ id: 1, text: "‮evil" }])).toEqual(["E"]); // review19: 書式の文字は字に使わない
  expect(js).not.toContain('Array.from(r.text.replace(/[\\p{Cc}\\p{Cf}\\s]/gu, ""))[0]'); // 一覧は avatarGlyph 1 本
});

test("W21① 「＋」の新規画面は空: new-session で吹き出し・承認・次の一手を消し、見出しは「新しい会話」", () => {
  expect(js).toContain('$("app").classList.toggle("new-session", naming === "new")');
  expect(js).toContain('if (naming === "new") { set($("hd-name"), "textContent", "新しい会話")');
  expect(css).toMatch(/#app\.new-session #rows, #app\.new-session #approve[^{]*\{ display:none; \}/);
});

test("W21② 一番上に出る行（画面の操作・渡している物・command・mod）は信号機の右から", () => {
  expect(css).toContain("html[data-bar] #screen-engine, html[data-bar] #leases, html[data-bar] #cmds, html[data-bar] #mods { margin-left:var(--bar-inset-left, 0px); }");
});
