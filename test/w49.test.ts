// W49: 定時で起きた会話の印が routine の fire から lease の門まで繋がっている（振る舞いは test/w11d.test.ts の「W49 定時の会話」）
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("W49 配線（review27 で turn の印に直した）: fire は scheduled:true を渡し、makeLeases の scheduled は sched.is（印があり run が走っている間だけ）", () => {
  const m = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  const fire = m.slice(m.indexOf("fire: (r, text) =>"), m.indexOf("fire: (r, text) =>") + 900);
  expect(fire).toContain("scheduled: true");
  expect(m).toContain("scheduled: sched.is");
  expect(readFileSync(join(import.meta.dir, "../src/sched.ts"), "utf8")).toContain("marks.has(owner) && running(owner)");
});
