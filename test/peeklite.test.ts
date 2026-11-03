// peek-lite: 覗き窓の定期の撮影をやめる。撮るのは (1) 初めて・人が拡げた・押した後 (2) 文字（AX / DOM）の要約が変わった時だけ。変化の判定は文字だけ（撮って比べない）。
import { expect, test } from "bun:test";
import { PEEK_BIG_W, PEEK_W, makePeek } from "../src/peek.ts";
import type { Driver, Surface } from "../src/lease.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const WIN: Surface = { pid: 10, windowId: 7, app: "A", title: "t" };
function rig() {
  const c = { cua: 0, sips: 0 }, st = { ax: 1 };
  let t = 1000;
  const win: Driver = { call: async () => { c.cua++; return { text: "", isError: false, data: null, img: { data: PNG, mime: "image/png" } }; }, close() {} };
  const p = makePeek({ surface: () => WIN, win: () => win, web: () => win, raise: async () => ({ raised: true }), read: async () => ({ found: true, elements: [{ depth: 0, role: "AXButton", label: `b${st.ax}`, value: "" }] }), now: () => t });
  return { p, c, st, tick: (ms: number) => (t += ms) };
}

test("peek-lite 変化なしの 60 秒（4 秒ごとの見に 15 回）で、初回の 1 回のほか撮影は 0 回", async () => {
  const { p, c, tick } = rig();
  for (let i = 0; i < 16; i++) { expect((await p.shot("w", true)).ok).toBe(true); tick(4000); }
  expect(c.cua).toBe(1); // 初回だけ
  tick(10 * 60_000); await p.shot("w", true);
  expect(c.cua).toBe(1); // 10 分後も変わらない限り撮らない
});

test("peek-lite 文字が 1 回変われば撮影も 1 回（変わった後はまた撮らない）", async () => {
  const { p, c, st, tick } = rig();
  await p.shot("w", true);
  st.ax = 2;
  for (let i = 0; i < 6; i++) { await p.shot("w", true); tick(4000); }
  expect(c.cua).toBe(2);
});

test("peek-lite 人が拡げた（幅が別）と押した後は撮る・見えていない間は撮らない", async () => {
  const { p, c } = rig();
  await p.shot("w", true);
  await p.shot("w", true, true); // 拡げた＝別の幅は初めて
  expect(c.cua).toBe(2);
  await p.shot("w", true, true);
  expect(c.cua).toBe(2);
  await p.front("w"); // 押した
  await p.shot("w", true); await p.shot("w", true, true);
  expect(c.cua).toBe(4); // 押した後は両方の幅を 1 回ずつ撮り直す
  await p.shot("w", false);
  expect(c.cua).toBe(4);
  expect([PEEK_W, PEEK_BIG_W]).toEqual([240, 720]);
});

test("peek-lite 撮れなかった行だけは 30 秒後に 1 回撮り直す（許可を入れた後に絵が出る）・撮れた絵は定期に撮り直さない", async () => {
  let ok = false, n = 0;
  let t = 1000;
  const win: Driver = { call: async () => { n++; return ok ? { text: "", isError: false, data: null, img: { data: PNG, mime: "image/png" } } : { text: "permission denied", isError: true, data: null }; }, close() {} };
  const p = makePeek({ surface: () => WIN, win: () => win, web: () => win, raise: async () => ({ raised: true }), read: async () => ({ found: true, elements: [{ depth: 0, role: "b", label: "x", value: "" }] }), now: () => t });
  expect((await p.shot("w", true)).ok).toBe(false); t += 4000;
  await p.shot("w", true); expect(n).toBe(1); // 30 秒までは撮り直さない
  ok = true; t += 30_000;
  expect((await p.shot("w", true)).ok).toBe(true); expect(n).toBe(2);
  t += 10 * 60_000; await p.shot("w", true); expect(n).toBe(2);
});
