import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Press } from "../src/press";
import { validateFields } from "../src/press";
import { checkCardText, cardText } from "../src/press-card";
import { resolveRequirements } from "../src/press-env";
import { env } from "./press-fixture";

const ucd = (): Press => JSON.parse(readFileSync(new URL("./fixtures/press-ucd.json", import.meta.url), "utf8"));
const reqs = (p: Press) => [...new Set(p.stages.flatMap((s) => s.requires ?? []))];
const resolve = (p: Press, e = env()) => resolveRequirements(reqs(p), e);
const given = { photos: "3 枚", pair_code: "123456 192.168.1.2:3", share_to: "a@example.com" };

describe("W69 UC-D press", () => {
  test("1 欄: 写真が空なら断る・題は固定で given を無視", () => {
    expect(validateFields(ucd(), { ...given, photos: "" }).ok).toBe(false);
    expect(validateFields(ucd(), { ...given, photos: " " }).ok).toBe(false);
    const r = validateFields(ucd(), { ...given, title: "上書き" });
    expect(r.ok && r.values.title).toBe("写真 3 枚");
  });
  test("2 環境: brew だけ在る → adb・login・cmd の人向けの行が残る", () => {
    const r = resolve(ucd(), env({ exists: (p) => p === "/opt/homebrew/bin/brew" }));
    expect(r.ok).toEqual(["brew"]);
    const lines = r.missing.map((m) => `${m.req}|${m.line}`).join("\n");
    expect(lines).toContain("adb|スマホとつなぐための道具が入っていません");
    expect(lines).toContain("login:docs.google.com|docs.google.com に login した tab");
    expect(lines).toContain("cmd:scrcpy-build|PC に道具が要ります");
  });
  test("3 card: 道具が結び付いた時、主画面に禁止語 0・あなた ≥2・agent・作り手の宣言", () => {
    const p = ucd();
    const c = cardText(p, resolve(p, env({ exists: () => true, which: () => true, cmds: ["scrcpy-build"] })));
    expect(checkCardText(c)).toEqual({ ok: true });
    expect(c.steps.filter((s) => s.who === "you").length).toBeGreaterThanOrEqual(2);
    expect(c.steps.some((s) => s.who === "agent")).toBe(true);
    const text = c.lines.join("\n");
    for (const claim of p.claims!) expect(text).toContain(claim);
    expect(text).toContain("戻せる物: 共有は外せます");
    expect(text).toContain("止まる時: 予定と違う時は、止まってあなたに聞きます");
  });
  test("3 armed: 段の goal に adb を入れると赤", () => {
    const p = ucd();
    p.stages[2]!.goal = "adb で写真を並べる";
    const c = cardText(p, resolve(p, env({ exists: () => true, which: () => true, cmds: ["scrcpy-build"] })));
    expect(checkCardText(c)).toEqual({ ok: false, words: ["adb"] });
  });
  test("3 command 名: 主画面（title / lines / steps）に出ず detail にだけ・checkCardText が ok", () => {
    const p = ucd();
    for (const e of [env(), env({ exists: () => true, which: () => true, cmds: ["scrcpy-build"] })]) {
      const c = cardText(p, resolve(p, e));
      expect([c.title, ...c.lines, ...c.steps.map((x) => x.text)].join("\n")).not.toContain("scrcpy-build");
      expect(c.lines.join("\n")).toContain("触る物: PC に道具を入れる（初回だけ）");
      expect(c.detail.join("\n")).toContain("scrcpy-build");
      expect(checkCardText(c)).toEqual({ ok: true });
    }
  });
  test("4 10-B の語: 6 桁・数字の列は主画面に・技術語は detail だけ", () => {
    const p = ucd();
    const c = cardText(p, resolve(p, env({ exists: () => true, which: () => true, cmds: ["scrcpy-build"] })));
    const main = [c.title, ...c.lines, ...c.steps.map((s) => s.text)].join("\n");
    expect(main).toContain("6 桁");
    expect(main).toContain("数字の列");
    const detail = c.detail.join("\n");
    expect(detail).toContain("adb");
    expect(detail).toContain("scrcpy-build");
    expect(/adb|IP|build/.test(main)).toBe(false);
  });
});
