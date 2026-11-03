// red-triage: 締切は load の倍率に伸びる（偽の赤を作らない）。読む file: "tools/test-timeout.ts" "test/preload-home.ts" "tools/suite.ts" "tools/affected.ts"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { testTimeoutMs } from "../tools/test-timeout.ts";

test("redfix-1 締切 = 30 秒 × ceil(load / (CPU×8))・下限 1・上限 10", () => {
  expect(testTimeoutMs(30_000, 0.5, 8)).toBe(30_000);
  expect(testTimeoutMs(30_000, 64, 8)).toBe(30_000);
  expect(testTimeoutMs(30_000, 65, 8)).toBe(60_000);
  expect(testTimeoutMs(30_000, 300, 8)).toBe(150_000);
  expect(testTimeoutMs(30_000, 770, 8)).toBe(300_000);
  expect(testTimeoutMs(30_000, 99999, 8)).toBe(300_000);
});

test("redfix-2 preload・suite・affected は固定の 30000 を渡さず、この関数を通る", () => {
  for (const f of ["test/preload-home.ts", "tools/suite.ts", "tools/affected.ts"]) {
    const s = readFileSync(f, "utf8");
    expect(s.includes("testTimeoutMs()"), f).toBe(true);
    expect(/"--timeout", "30000"|setDefaultTimeout\(30_000\)/.test(s), f).toBe(false);
  }
});
