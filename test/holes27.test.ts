import { expect, test } from "bun:test";
import { frontOk, judgeFront, judgeWins } from "./front-judge.ts";

const dialog = "  1.25s  +win owner=CoreServicesUIAgent pid=123 layer=0 size=420x200";
const allowed = "  2.00s  +win(許可) owner=KangaeBar pid=9 layer=25 size=48x48";

test("前面が替わらずに出た OS の dialog を、窓として数える（旧い judgeFront は 0 件で緑のまま）", () => {
  const out = `start front=Orca  pid=1 path=/Applications/Orca.app\n${dialog}\nend front=Orca  前面が変わった回数=0  新しい窓=1`;
  expect(judgeFront(out).ok).toBe(false); // 27b: judgeFront も窓を見る（前面だけの旧い判定は緑だった）
  const w = judgeWins(out);
  expect(w.ok).toBe(false);
  expect(w.detail).toContain("CoreServicesUIAgent");
});

test("許可した窓と前面だけの行は数えない", () => {
  expect(judgeWins(`${allowed}\n  3.00s  Orca -> Safari  pid=2 path=/x`).ok).toBe(true);
});

test("27b: 我々の pid の窓と表の owner の窓は許し、それ以外の owner は赤", () => {
  const mine = "  1.00s  +win owner=Chromium pid=4242 layer=0 size=800x600";
  const bar = "  1.10s  +win owner=Kangae Bar pid=77 layer=25 size=48x48";
  expect(judgeWins([mine, bar].join("\n"), { pids: [4242] }).ok).toBe(true);
  expect(judgeWins([mine, bar].join("\n")).ok).toBe(false); // pid を知らなければ Chromium は我々と言えない
  expect(judgeWins([mine, dialog].join("\n"), { pids: [4242] }).count).toBe(1);
});

test("27b: UC の frontOk は回数=0 でも許可外の窓があれば赤（regex だけの旧い判定は緑）", () => {
  const out = `${dialog}\nend front=Orca  前面が変わった回数=0  新しい窓=1`;
  expect(/前面が変わった回数=0/.test(out)).toBe(true);
  expect(frontOk(out)).toBe(false);
  expect(frontOk("end front=Orca  前面が変わった回数=0  新しい窓=0")).toBe(true);
});
