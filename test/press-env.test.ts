import { describe, expect, test } from "bun:test";
import { resolveRequirements } from "../src/press-env";
import { checkCardText } from "../src/press-card";
import { env } from "./press-fixture";

describe("W63 press-env", () => {
  test("AC4: brew だけ在る → missing に adb と login の 2 行（人向けの文・禁止語なし）", () => {
    const r = resolveRequirements(["brew", "adb", "login:calendar.google.com"], env({ exists: (p) => p === "/opt/homebrew/bin/brew" }));
    expect(r.ok).toEqual(["brew"]);
    expect(r.missing.map((m) => m.req)).toEqual(["adb", "login:calendar.google.com"]);
    expect(r.missing[1]!.line).toContain("calendar.google.com に login した tab");
    expect(checkCardText({ title: "", lines: r.missing.map((m) => m.line), steps: [] }).ok).toBe(true);
  });
  test("表のとおり: brew は 2 つの場所・adb は PATH か /opt/homebrew・bw は PATH・chromium-ext・app・cmd", () => {
    expect(resolveRequirements(["brew"], env({ exists: (p) => p === "/usr/local/bin/brew" })).ok).toEqual(["brew"]);
    expect(resolveRequirements(["adb"], env({ which: (b) => b === "adb" })).ok).toEqual(["adb"]);
    expect(resolveRequirements(["adb"], env({ exists: (p) => p === "/opt/homebrew/bin/adb" })).ok).toEqual(["adb"]);
    expect(resolveRequirements(["bw"], env({ which: (b) => b === "bw" })).ok).toEqual(["bw"]);
    expect(resolveRequirements(["chromium-ext"], env({ extensionConnected: () => false })).missing).toHaveLength(1);
    expect(resolveRequirements(["app:com.x.y"], env({ appInstalled: (b) => b === "com.x.y" })).ok).toEqual(["app:com.x.y"]);
    expect(resolveRequirements(["cmd:scrcpy-build"], env({ cmds: ["scrcpy-build"] })).ok).toEqual(["cmd:scrcpy-build"]);
    expect(resolveRequirements(["cmd:other"], env({ cmds: ["scrcpy-build"] })).missing).toHaveLength(1);
  });
  test("login は deps が何を言っても常に「押す前の card の行」・知らない種類は通さない", () => {
    const all = env({ exists: () => true, which: () => true, appInstalled: () => true, cmds: ["x"] });
    expect(resolveRequirements(["login:a.example"], all).missing).toHaveLength(1);
    expect(resolveRequirements(["weird" as any], all).missing).toHaveLength(1);
  });
});
