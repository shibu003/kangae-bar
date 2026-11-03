// W52: 実験役の手順書（docs/verify/exp1/RUN.md 新版）が、今の道と食い違っていない事の検査（書いた物が実物の道具・実物の文と合う）
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const RUN = read("docs/verify/exp1/RUN.md");
const rows = RUN.split("\n").filter((l) => /^\| (起|終|[AB]\d) \|/.test(l));

test("W52 表: A0〜A9・B0〜B6・起・終 が 1 行ずつ在り、各行に「# / 誰が / 手 / card / 答え / 写真 / 止め方」の 7 欄が揃っている", () => {
  const ids = rows.map((l) => l.split("|")[1]!.trim());
  expect(ids).toEqual(["起", ...Array.from({ length: 10 }, (_, i) => `A${i}`), ...Array.from({ length: 7 }, (_, i) => `B${i}`), "終"]);
  for (const l of rows) expect(l.split("|").length - 2).toBe(7);
  for (const l of rows) for (const cell of l.split("|").slice(1, -1)) expect(cell.trim()).not.toBe("");
});

test("W52 文言: 今の道（Zed を使わない・clipboard 不使用・cmd-add 3 行・毎回 card・--human・HIDIdle・止め方）が書かれ、旧い道（Zed を裏で開く・open_app で Zed）の指示は無い", () => {
  for (const w of ["Zed は使わない", "クリップボードは使わない", "--human", "HIDIdleTime", "毎回", "web_op", "canvas-week", "er-triage-add", "--load data.csv", "window_image", "止め方", "backup", "front-read", "front-watch"]) expect(RUN).toContain(w);
  expect(RUN).not.toMatch(/act open_app|open_app.*Zed|zedで開き|Zed で build/);
});

test("W52 実物と合う: 参照している道具の file が在り、cmd-add の行は MAIN_CPP_PATCH.md と同じ形、card の文は lease.ts / 案内の実物の文を含む", () => {
  for (const f of ["tools/front-watch.swift", "tools/front-read.ts", "docs/verify/w48b/MAIN_CPP_PATCH.md", "docs/verify/w48/ER_TRIAGE.md", "docs/verify/w47b/SOURCES.md"]) expect(existsSync(join(root, f))).toBe(true);
  expect(read("tools/front-read.ts")).toContain("--human");
  const patch = read("docs/verify/w48b/MAIN_CPP_PATCH.md");
  expect(patch).toContain("cmd-add er-triage-add --cwd");
  expect(patch).toContain("--load data.csv");
  const lease = read("src/lease.ts");
  for (const w of ["を実行します", "を起動します", "Google Docs の本文に書き込みます。書く内容を上で確かめてから許してください（1 回ごとに聞きます）", "確かめること: 開く先の URL が頼んだ事に合っているか"]) expect(lease.includes(w) || read("src/lease.ts").includes(w)).toBe(true);
  expect(RUN).toContain("Google Docs の本文に書き込みます。書く内容を上で確かめてから許してください（1 回ごとに聞きます）");
  expect(RUN).toContain("確かめること: 開く先の URL が頼んだ事に合っているか");
  expect(RUN).toContain("今開いている tab をこの会話の agent に渡す");
  expect(read("extension/panel.js")).toContain("今開いている tab をこの会話の agent に渡す");
});
