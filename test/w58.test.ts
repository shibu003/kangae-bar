// W58: docs/PRODUCT-NOW.md（CEO 向けの 1 枚）が、試験だけの物を実機と言っていない・実機の行は実験役の記録の file を持つ・参照する test が実在する・数が合う
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const text = readFileSync(join(root, "docs/PRODUCT-NOW.md"), "utf8");
type Row = { n: string; what: string; how: string; piece: string; rec: string; caveat: string };
export const rowsOf = (t: string): Row[] => t.split("\n").filter((l) => /^\| \d+ \|/.test(l)).map((l) => { const c = l.split("|").slice(1, -1).map((x) => x.trim()); return { n: c[0]!, what: c[1]!, how: c[2]!, piece: c[3]!, rec: c[4]!, caveat: c[5]! }; });
// 文を「。、；」で区切った断片のうち、「実機」を含み、かつ否定（未測・未実施・未導入・なし・無い・ない・言わない・証拠ではない・通していない）を同じ断片に持たない物があれば、実機で確かめたと読める
export const claimsReal = (s: string) => s.split(/[。、；;]/).some((f) => /実機/.test(f) && !/未測|未実施|未導入|なし|無い|ない|言わない|証拠ではない|通していない/.test(f));
const rows = rowsOf(text);

test("W58 表: 各行が 6 欄を持ち、通し番号が 1 から続き、確かめ方は「試験」「実機」「試験+実機」のどれか", () => {
  expect(rows.length).toBeGreaterThanOrEqual(20);
  expect(rows.map((r) => r.n)).toEqual(rows.map((_, i) => String(i + 1)));
  for (const r of rows) { for (const v of Object.values(r)) expect(v, `#${r.n}`).not.toBe(""); expect(["試験", "実機", "試験+実機"], `#${r.n}`).toContain(r.how); }
});

test("W58 試験だけの行は実機で確かめたと言わない: 「実機の記録」は「なし」で、他の欄にも実機の肯定が無い（未測・なしの言い方だけ）", () => {
  const testOnly = rows.filter((r) => r.how === "試験");
  expect(testOnly.length).toBeGreaterThan(10);
  for (const r of testOnly) {
    expect(r.rec, `#${r.n} 実機の記録`).toBe("なし");
    for (const [k, v] of Object.entries({ what: r.what, piece: r.piece, caveat: r.caveat })) expect(claimsReal(v), `#${r.n} ${k}: ${v}`).toBe(false);
  }
});

test("W58 実機の行は、実験役の記録の file が実在する（docs/verify/ の path を 1 つ以上）・数が冒頭の「実機の行の数」と合う", () => {
  const real = rows.filter((r) => r.how !== "試験");
  const m = /実機の行の数: \*\*(\d+) 行\*\*/.exec(text);
  expect(m, "冒頭に「実機の行の数: **N 行**」").not.toBeNull();
  expect(real.length).toBe(Number(m![1]));
  for (const r of real) {
    const paths = [...r.rec.matchAll(/`(docs\/verify\/[^`]+)`/g)].map((x) => x[1]!);
    expect(paths.length, `#${r.n} の実機の記録に docs/verify/ の path`).toBeGreaterThan(0);
    for (const p of paths) expect(existsSync(join(root, p)), `#${r.n}: ${p}`).toBe(true);
  }
});

test("W58 参照する test が実在し、行は W 番号か review を持つ", () => {
  for (const r of rows) {
    expect(r.piece, `#${r.n}`).toMatch(/\bW\d+|review\d+/);
    const tests = [...r.piece.matchAll(/`(test\/[^`]+)`/g)].map((x) => x[1]!.replace(/（.*$/, "").trim());
    expect(tests.length, `#${r.n} に test`).toBeGreaterThan(0);
    for (const t of tests) expect(existsSync(join(root, t)), `#${r.n}: ${t}`).toBe(true);
  }
});

test("W58 検査の物差し自身: 否定の言い方は通り、肯定は拾う（claimsReal）", () => {
  for (const ok of ["実機は未測", "実機では未測", "実機の記録はなし", "実機の panel の表示は未測", "実機で 2 つ同時は未測（メモリが足りるかも）", "実機で通した記録はまだ無い"]) expect(claimsReal(ok), ok).toBe(false);
  for (const bad of ["実機で確かめた", "実機で動いた", "実機の記録あり", "実機 OK", "実機で確かめた。ただし別の所は未測"]) expect(claimsReal(bad), bad).toBe(true);
});
