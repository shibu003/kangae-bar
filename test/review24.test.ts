// review24: loginfix-2（c7cb782）の攻撃審査。load / CPU 数が取れない・壊れた値の時に待ちが NaN になり、setTimeout(NaN) が即発火（＝誤報が 1ms で出る）しないか
import { expect, test } from "bun:test";
import { NO_REPLY_MS, noReplyWait } from "../src/main.ts";

const sane = (ms: number) => Number.isFinite(ms) && ms >= NO_REPLY_MS && ms <= NO_REPLY_MS * 10;

test("review24 実測: setTimeout(NaN) はほぼ即発火する（待ちが NaN になると誤報が出る根拠）", async () => {
  const t = Date.now();
  await new Promise<void>((r) => setTimeout(r, NaN));
  expect(Date.now() - t).toBeLessThan(50);
});

test("review24 攻撃1: load が NaN でも待ちは 60 秒以上の有限値", () => expect(sane(noReplyWait(NaN, 8))).toBe(true));
test("review24 攻撃2: CPU 数が NaN でも待ちは 60 秒以上の有限値", () => expect(sane(noReplyWait(8, NaN))).toBe(true));
test("review24 攻撃3: load が undefined 相当（0）・CPU 数 0（cpus() が空の環境）は 60 秒", () => {
  expect(noReplyWait(0, 8)).toBe(NO_REPLY_MS);
  expect(noReplyWait(0, 0)).toBe(NO_REPLY_MS);
  expect(noReplyWait(5, 0)).toBe(NO_REPLY_MS * 5); // 0 CPU は 1 とみなす
});
test("review24 攻撃4: 負・Infinity・巨大でも 60 秒〜10 倍に収まる", () => {
  expect(noReplyWait(-5, 8)).toBe(NO_REPLY_MS);
  expect(noReplyWait(Infinity, 8)).toBe(NO_REPLY_MS * 10);
  expect(noReplyWait(1e9, 1)).toBe(NO_REPLY_MS * 10);
});
