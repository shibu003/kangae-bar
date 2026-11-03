// W33: 前面が変わった時の報告を、ASN（ASN:0x0-c00c:）でなく app の名前で（この機械で測った `lsappinfo list` の行から引く）。引けなければ ASN のまま・名前は制御文字を除いて 40 字まで
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appNameIn } from "../src/lease.ts";

// この機械（macOS 14.5）の `lsappinfo list` の実物の形（2026-10-11）
const LIST = ` 1) "loginwindow" ASN:0x0-5005: \n    bundleID="com.apple.loginwindow"\n    pid = 190 type="UIElement"\n 3) "Google Chrome" ASN:0x0-c00c: (in front)\n    bundleID="com.google.Chrome"\n 4) "Kangae Bar" ASN:0x0-d00d: \n`;

test("W33 ASN から app の名前を引く: 実物の形・見つからなければ null（呼び側が ASN のまま出す）", () => {
  expect(appNameIn(LIST, "ASN:0x0-c00c:")).toBe("Google Chrome");
  expect(appNameIn(LIST, "ASN:0x0-d00d:")).toBe("Kangae Bar");
  expect(appNameIn(LIST, "ASN:0x0-9999:")).toBeNull();
  expect(appNameIn("", "ASN:0x0-c00c:")).toBeNull();
});

test("W33 名前は他人の app が決める文字列: 制御文字・書式文字（RTL 上書き・改行）を除き 40 字まで", () => {
  const evil = ` 2) "Safari‮\u0007 ${"x".repeat(100)}" ASN:0x0-aaaa: \n`;
  const n = appNameIn(evil, "ASN:0x0-aaaa:")!;
  expect(n).not.toMatch(/[‮\u0007]/);
  expect(n.length).toBeLessThanOrEqual(40);
  expect(n.startsWith("Safari")).toBe(true);
});

test("W33 launchApp の報告は名前で出し、log は ASN のまま（名前を log・返事以外へ出さない）", () => {
  const src = readFileSync(join(import.meta.dir, "../src/lease.ts"), "utf8");
  expect(src).toContain("frontNote(before, after, opts.appName ?? appNameOf)"); // 名前は opts.appName（試験）か lsappinfo
  expect(src).toContain("を起こして前面が替わった: ${before} → ${after}`");
});
