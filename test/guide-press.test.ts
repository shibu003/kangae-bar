import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkCardText } from "../src/press-card";

const guide = readFileSync(new URL("../docs/GUIDE-press.md", import.meta.url), "utf8");
const scan = (t: string) => checkCardText({ title: "", lines: t.split("\n"), steps: [] });

describe("W71 GUIDE-press", () => {
  test("禁止語が 0（armed: 「adb」を足すと赤）", () => {
    expect(scan(guide)).toEqual({ ok: true });
    expect(scan(guide + "\nadb で繋ぐ")).toEqual({ ok: false, words: ["adb"] });
  });
  test("見出し 4 つと 2 つの command・120 行以内", () => {
    for (const h of ["覚える", "押す", "渡す", "受け取る"]) expect(guide).toContain(`\n## ${h}\n`);
    expect(guide.startsWith("# 押す操作\n")).toBe(true);
    expect(guide).toContain("kangae press share");
    expect(guide).toContain("kangae press import");
    expect(guide.split("\n").length).toBeLessThanOrEqual(120);
  });
});
