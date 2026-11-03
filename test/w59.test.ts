// W59: docs/GAPS-NOW.md（製品の穴の今の一覧）が、「直した」と書く行に実在する commit か test を持ち、CEO の判断待ちを先頭に置き、出た所の path が実在する
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // 実在の commit を git cat-file で 1 つずつ確かめる（混んだ機械で 5 秒を超えた）

const root = join(import.meta.dir, "..");
const text = readFileSync(join(root, "docs/GAPS-NOW.md"), "utf8");
type Row = { n: string; gap: string; where: string; state: string; basis: string };
export const rowsOf = (t: string): Row[] => t.split("\n").filter((l) => /^\| \d+ \|/.test(l)).map((l) => { const c = l.split("|").slice(1, -1).map((x) => x.trim()); return { n: c[0]!, gap: c[1]!, where: c[2]!, state: c[3]!, basis: c[4]! }; });
const rows = rowsOf(text);
const kindOf = (s: string) => (["CEO の判断待ち", "許可済み", "実機待ち", "直した", "未着手", "受け入れた"] as const).find((k) => s.startsWith(`**${k}**`));
export const commitsOf = (s: string) => [...s.matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1]!);
export const testsOf = (s: string) => [...s.matchAll(/`(test\/[A-Za-z0-9_.-]+\.test\.ts)`/g)].map((m) => m[1]!);
export const isCommit = (h: string) => Bun.spawnSync(["git", "-C", root, "cat-file", "-e", `${h}^{commit}`]).exitCode === 0;

test("W59 表: 通し番号が続き、各行が 5 欄を持ち、今の状態は 6 つのどれか", () => {
  expect(rows.length).toBeGreaterThanOrEqual(30);
  expect(rows.map((r) => r.n)).toEqual(rows.map((_, i) => String(i + 1)));
  for (const r of rows) { for (const v of Object.values(r)) expect(v, `#${r.n}`).not.toBe(""); expect(kindOf(r.state), `#${r.n}: ${r.state}`).toBeDefined(); }
});

test("W59 「直した」と書く行は、実在する commit か test 名を持つ（推測で直ったと書かない）・書いた commit / test は全部実在する", () => {
  const fixed = rows.filter((r) => kindOf(r.state) === "直した");
  expect(fixed.length).toBeGreaterThanOrEqual(8);
  for (const r of fixed) {
    const cs = commitsOf(r.basis), ts = testsOf(r.basis);
    expect(cs.length + ts.length, `#${r.n} に commit か test`).toBeGreaterThan(0);
  }
  for (const r of rows) {
    for (const h of commitsOf(r.basis)) expect(isCommit(h), `#${r.n}: commit ${h} が実在しない`).toBe(true);
    for (const t of testsOf(r.basis)) expect(existsSync(join(root, t)), `#${r.n}: ${t} が実在しない`).toBe(true);
  }
  // 直した行の commit / test のうち、少なくとも 1 つが実在する（実在する物だけが根拠）
  for (const r of fixed) expect([...commitsOf(r.basis).filter(isCommit), ...testsOf(r.basis).filter((t) => existsSync(join(root, t)))].length, `#${r.n}`).toBeGreaterThan(0);
});

test("W59 CEO の判断待ちは先頭に置く（それ以外の状態の行より前）・実機待ちは「直した」に混ぜない", () => {
  const kinds = rows.map((r) => kindOf(r.state)!);
  const lastCeo = kinds.lastIndexOf("CEO の判断待ち");
  expect(lastCeo).toBeGreaterThanOrEqual(1); // 2 行以上
  expect(kinds.slice(0, lastCeo + 1).every((k) => k === "CEO の判断待ち")).toBe(true);
  expect(kinds.slice(lastCeo + 1)).not.toContain("CEO の判断待ち");
  // 「直した」の行に「実機待ち」と書いた状態は無い（実機の確認が済んでいない物は、状態を実機待ちにする）
  for (const r of rows.filter((r) => kindOf(r.state) === "直した")) expect(r.state, `#${r.n}`).not.toMatch(/\*\*実機待ち\*\*/);
});

test("W59 出た所の path は全部実在する（docs/・src/・test/・tools/ の file）", () => {
  for (const r of rows) {
    const ps = [...r.where.matchAll(/`((?:docs|src|test|tools)\/[^`]+)`/g)].map((m) => m[1]!);
    expect(ps.length, `#${r.n} に path`).toBeGreaterThan(0);
    for (const p of ps) expect(existsSync(join(root, p)), `#${r.n}: ${p}`).toBe(true);
  }
});

test("W59 検査の物差し自身: commit の形と実在を見分ける", () => {
  expect(commitsOf("`60db2ba`（W55）と `deadbee` と `abc`")).toEqual(["60db2ba", "deadbee"]);
  expect(isCommit("60db2ba")).toBe(true);
  expect(isCommit("deadbeefdeadbeef")).toBe(false);
  expect(testsOf("`test/w55.test.ts` と `src/main.ts`")).toEqual(["test/w55.test.ts"]);
});
