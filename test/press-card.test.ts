import { describe, expect, test } from "bun:test";
import { PRESS_BANNED, cardText, checkCardText } from "../src/press-card";
import { resolveRequirements } from "../src/press-env";
import { env, mkPress } from "./press-fixture";

const card = (p = mkPress(), e = env()) => cardText(p, resolveRequirements([...new Set(p.stages.flatMap((s) => s.requires ?? []))], e));

describe("W63 press-card", () => {
  test("AC5: 主画面に禁止語が 0・detail には在ってよい・あなたと agent の段が分かれる", () => {
    const c = card();
    expect(checkCardText(c)).toEqual({ ok: true });
    expect(c.detail.join("\n")).toContain("adb"); // 技術名は「詳しく」にだけ
    const you = c.steps.filter((s) => s.who === "you").map((s) => s.text), agent = c.steps.filter((s) => s.who === "agent").map((s) => s.text);
    expect(you.some((t) => t.includes("予定の名前"))).toBe(true); // ask の欄
    expect(you.some((t) => t.includes("calendar.google.com に login"))).toBe(true); // login
    expect(you.some((t) => t.includes("スマホとつなぐ"))).toBe(true); // 結び付かない requires
    expect(agent).toEqual(["カレンダーを開く（新しい tab を開く）", "予定を入れる（欄に入れる）"]);
    expect(c.steps.every((s) => s.state === "wait")).toBe(true);
    expect(c.lines.join("\n")).toContain("戻せる物: 予定は消せば元に戻ります");
  });
  test("AC5 armed: goal に adb を入れると checkCardText が赤・全語・全角・制御文字で隠しても赤", () => {
    const bad = (goal: string) => checkCardText(card(mkPress({ stages: [{ ...mkPress().stages[1]!, goal }] })));
    expect(bad("adb で繋ぐ")).toEqual({ ok: false, words: ["adb"] });
    for (const w of PRESS_BANNED) expect(bad(`先に ${w} を使う`).ok).toBe(false);
    expect(bad("ａｄｂ で繋ぐ").ok).toBe(false);
    expect(bad("a​db で繋ぐ").ok).toBe(false);
    expect(bad("support と release と general").ok).toBe(true); // 語の途中は当てない
    // title・steps だけに在っても赤
    expect(checkCardText({ title: "cookie", lines: [], steps: [] }).ok).toBe(false);
    expect(checkCardText({ title: "", lines: [], steps: [{ who: "you", text: "token を入れる", state: "wait" }] }).ok).toBe(false);
  });
  test("AC6: 制御文字・RTL の文字は goal・name・label から card の文に落ちる", () => {
    const p = mkPress({ name: "名前‮逆", fields: { t: { ask: true, label: "ラ\u0007ベル‮" } }, stages: [{ ...mkPress().stages[1]!, goal: "入れる‮\u0000\n続き" }] });
    const c = card(p);
    const all = [c.title, ...c.lines, ...c.steps.map((s) => s.text), ...c.detail].join("\n");
    expect(/[‮\u0000\u0007]/.test(all)).toBe(false);
    expect(all).toContain("入れる 続き");
  });
  test("作り手の自由文（name 以外の知らない key）は入らず、DO に無い手は goal を使う（「<op> をした」と書かない）", () => {
    const p = mkPress({ stages: [{ ...mkPress().stages[1]!, goal: "予定を入れる", way: { kind: "op", app: "web", name: "weird_op", slots: {} } }] });
    const c = card(p);
    expect(c.steps.find((s) => s.who === "agent")!.text).toBe("予定を入れる");
    expect(c.lines.join("\n")).not.toContain("をした");
  });
});
