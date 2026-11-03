import { expect, test } from "bun:test";
import { pollUntil } from "../src/wait.ts";

test("遅い相手でも締切までは待つ（1 周 100ms でも 3 回で諦めない）", async () => {
  let calls = 0;
  const v = await pollUntil(async () => { calls++; await Bun.sleep(100); return calls >= 6 ? "ok" : null; }, 1500, 10);
  expect(v).toBe("ok");
  expect(calls).toBe(6);
});

test("締切を越えたら undefined・probe は 0ms でも 1 回は呼ぶ", async () => {
  const t0 = Date.now();
  expect(await pollUntil(() => false, 300, 20)).toBeUndefined();
  expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  let n = 0;
  await pollUntil(() => { n++; return null; }, 0, 5);
  expect(n).toBe(1);
});

test("締切を越えたら止まる（締切 200ms・上限 1 秒。締切の判定を外すと永久に回って落ちる）", async () => {
  const t0 = Date.now();
  expect(await pollUntil(() => null, 200, 20)).toBeUndefined();
  expect(Date.now() - t0).toBeLessThan(1000);
}, 3000);
