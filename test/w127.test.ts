// W127: choice / multi の card を常駐の印の書式に揃える（multi は「選んだ: A, B」・choice は常に自由記述・候補数の守り）。
// 描画は test/domshim.ts（本物のブラウザには触れない）。実機（見た目）は未測。読む file を literal で名指す: "extension/panel.js"
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom } from "./domshim.ts";

let answerLine: (d: any) => string;
beforeAll(async () => {
  await installDom();
  ({ answerLine } = await import("../extension/kg.js"));
});
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

test("W127 AC1: multi の答えは「選んだ: A, B」（区切りは「, 」）", () => {
  expect(answerLine({ kind: "multi", choices: ["A", "B"] })).toBe("選んだ: A, B");
  expect(answerLine({ kind: "multi", choices: ["A"], free: "x" })).toBe("選んだ: A（ほかに: x）");
  expect(answerLine({ kind: "choice", choice: "A" })).toBe("A");
});

test("W127 AC2: choice は常に free（常駐の card に free が無くても）・multi は c.free がある時だけ", () => {
  const js = code(read("extension/panel.js"));
  const card = js.slice(js.indexOf("function cardEl"), js.indexOf("function renderChat"));
  expect(card).toContain('if (c.kind === "choice" || c.free) k.setAttribute("free", "")');
});

test("W127 AC3: 候補が choice 2〜5 / multi 2〜8 の外なら card にしない（描く前の filter が card の元になる）", () => {
  const js = code(read("extension/panel.js"));
  const m = js.match(/const cards = \(row\.cards \?\? \[\]\)\.filter\((.*)\);\n/)!;
  expect(m).not.toBeNull();
  const ok = new Function("c", `return (${m[1]})(c)`) as (c: any) => boolean;
  const mk = (kind: string, n: number) => ({ kind, options: Array.from({ length: n }, (_, i) => `o${i}`) });
  expect([1, 2, 5, 6].map((n) => ok(mk("choice", n)))).toEqual([false, true, true, false]);
  expect([1, 2, 8, 9].map((n) => ok(mk("multi", n)))).toEqual([false, true, true, false]);
  expect(ok({ kind: "ask", options: ["進める"] })).toBe(true); // ask / handoff / done は数えない
  expect(ok({ kind: "done", options: [] })).toBe(true);
  expect(js).toContain("cards.findIndex((c) => c.kind !== \"done\")");
});
