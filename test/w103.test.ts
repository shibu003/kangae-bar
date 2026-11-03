// W103: 一覧の頭は担当の行と［＋］。＋ は 1 押しで新しい会話。探す欄は担当 7 件から。料金で止まった行の button は人の言葉。
// 本物のブラウザには触れない。実機は未測（要 operator）。
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const rule = (css: string, sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
};

test("W103 html: plus-menu / project / todo / tasks / Jira / Linear が 0。探す icon は無く、欄だけ残る", () => {
  const html = read("extension/panel.html");
  for (const s of ["plus-menu", "plus-project", "project-form", "todo", "tasks", "task-", "Jira", "Linear"]) {
    expect(html.includes(s), s).toBe(false);
  }
  expect(html).toContain('id="plus"');
  expect(html).toMatch(/id="find-text"[^>]*hidden/);
  expect(html).not.toMatch(/id="find"/);
});

test("W103 plus: click は startNew。menu の分岐・paintTasks・\"tasks\" が 0", () => {
  const js = code(read("extension/panel.js"));
  expect(js).toContain("function startNew()");
  expect(js).toContain('$("plus").onclick = () => startNew();');
  expect(js).not.toContain("plus-menu");
  expect(js).not.toContain("paintTasks");
  expect(js).not.toContain('"tasks"');
  expect(js).not.toContain("isTrusted");
});

test("W103 find: 6 件は出さない。7 件は出す。paintList が件数で hidden を決める", () => {
  const js = code(read("extension/panel.js"));
  const i = js.indexOf("function findShown");
  const body = js.slice(i, js.indexOf("}", i) + 1);
  const findShown = new Function(`${body}\nreturn findShown;`)() as (n: number) => boolean;
  expect(findShown(0)).toBe(false);
  expect(findShown(6)).toBe(false);
  expect(findShown(7)).toBe(true);
  expect(findShown(8)).toBe(true);
  const paint = js.slice(js.indexOf("function paintList"), js.indexOf("async function renderRoots"));
  expect(paint).toContain("findShown(roots.length)");
  expect(paint).toContain("find.hidden = !show");
  expect(paint).toContain('$("find-text")');
});

test("W103 料金で止まった行: 古い文言は extension に 0。新しい文言と allowMetered が在る", () => {
  const all = ["panel.js", "panel.html", "panel.css"].map((f) => read(`extension/${f}`)).join("\n");
  expect(all).not.toContain("従量でもよい");
  expect(read("extension/panel.js")).toContain('set(btn, "textContent", "このまま続ける（料金がかかります）")');
  expect(read("extension/panel.js")).toContain('call("allowMetered"');
});

test("W103 見た目: ＋ は primary の token、探す欄と歯車は寸法の token。色の直書きはしない", () => {
  const css = read("extension/panel.css");
  const plus = rule(css, "#session-tools #plus");
  expect(plus).toContain("var(--primary)");
  expect(plus).toContain("var(--primary-fg)");
  expect(plus).toContain("var(--hit)");
  expect(plus).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  const find = rule(css, "#find-text");
  expect(find).toContain("var(--hit)");
  expect(find).toContain("var(--fs-body)");
  expect(find).toContain("var(--gutter)");
  expect(find).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  const gear = rule(css, "#user-btn");
  expect(gear).toContain("var(--hit)");
  expect(gear).toContain("var(--muted-fg)");
  expect(gear).not.toMatch(/#[0-9a-fA-F]{3,8}/);
});
