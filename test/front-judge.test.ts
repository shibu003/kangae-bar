import { expect, test } from "bun:test";
import { judgeFront } from "./front-judge.ts";

const head = "start front=Terminal  pid=100 path=/System/Applications/Utilities/Terminal.app";
const human = "  3.10s  Terminal -> Slack  pid=200 path=/Applications/Slack.app";
const dialog = "  4.00s  Slack -> UserNotificationCenter  pid=300 path=/System/CoreServices/UserNotificationCenter.app";
const oursChrome = "  5.00s  Slack -> Google Chrome  pid=4242 path=/Applications/Google Chrome.app";
const oursByPath = "  6.00s  Slack -> kangae  pid=9 path=/var/tmp/kangae-x/kangae";
const end = "end front=Slack  前面が変わった回数=3";

test("H6: 人・他の pid の前面は赤にしない（並べるだけ）", () => {
  const r = judgeFront([head, human, dialog, end].join("\n"), { pids: [4242], paths: ["/var/tmp/kangae-x"] });
  expect(r.ok).toBe(true);
  expect(r.others).toBe(2);
  expect(r.detail).toContain("人・他 2 回（Slack, UserNotificationCenter）");
});

test("H6 負の対照: 我々の pid / path が前面に来たら赤・pid の無い古い行も赤", () => {
  expect(judgeFront([human, oursChrome].join("\n"), { pids: [4242] }).ours).toBe(1);
  expect(judgeFront([human, oursByPath].join("\n"), { paths: ["/var/tmp/kangae-x"] }).ok).toBe(false);
  expect(judgeFront("  1.00s  A -> B").ok).toBe(false);
  // 同じ入力でも pid を知らなければ人として並ぶ（判定が pid で分かれている証拠）
  expect(judgeFront([human, oursChrome].join("\n")).ok).toBe(true);
});
