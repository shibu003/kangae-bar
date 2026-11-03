// W64: android.ts（fake の adb だけ）と tools/scrcpy-build.sh（sh -n と dry-run だけ。brew・clone・build は走らせない）
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mktmp } from "./tmp";
import { join, resolve } from "node:path";
import { adbDevices, adbPair, findEl, tap, uiDump, type AdbDeps } from "../src/android.ts";
import { profileOf } from "../src/cmds.ts";

const FAKE = resolve(import.meta.dir, "fixtures/fake-adb");
const BUILD = resolve(import.meta.dir, "../tools/scrcpy-build.sh");
// この Mac では CEO の本物の adb server（5037）が生きている。試験の env が本物を指していたら、何も起こす前に落ちる
const guard = (env: Record<string, string>) => { const p = env.ANDROID_ADB_SERVER_PORT; if (!p || p === "5037") throw new Error(`ANDROID_ADB_SERVER_PORT=${p ?? "(無し)"}: 本物の adb server を指す`); };
const freePort = () => { const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return p; };
const mk = (extra: Record<string, string> = {}) => {
  const dir = mktmp("w64");
  const env = { PATH: "/usr/bin:/bin", ANDROID_ADB_SERVER_PORT: String(freePort()), FAKE_ADB_LOG: join(dir, "log"), FAKE_ADB_STDIN: join(dir, "stdin"), FAKE_ADB_TAPS: join(dir, "taps"), ...extra };
  guard(env);
  const d: AdbDeps = { adb: FAKE, env };
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return { dir, d, read };
};

describe("android（fake adb）", () => {
  test("AC1: pair → ok・番号は stdin に届き argv には出ない", async () => {
    const t = mk();
    expect(await adbPair("192.168.1.23:37099", "123456", t.d)).toEqual({ ok: true });
    expect(t.read("stdin")).toBe("123456");
    expect(t.read("log")).toContain("pair 192.168.1.23:37099");
    expect(t.read("log")).not.toContain("123456");
  });
  test("AC2: 番号 5 桁・host の形が違う → 起こす前に断る（fake は呼ばれない）", async () => {
    const t = mk();
    for (const [hp, c] of [["192.168.1.23:37099", "12345"], ["192.168.1.23:37099", "1234567"], ["192.168.1.23:37099", "12345a"], ["192.168.1.23", "123456"], ["abc:123", "123456"], ["192.168.1.999:37099", "123456"], ["192.168.1.23:0", "123456"], ["192.168.1.23:70000", "123456"]] as const) {
      const r = await adbPair(hp, c, t.d);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.hint).toMatch(/携帯/);
    }
    expect(existsSync(join(t.dir, "log"))).toBe(false); // 1 度も起こしていない
  });
  test("AC3: fake が Failed → ok:false・番号も host も hint に出ない", async () => {
    const t = mk({ FAKE_ADB_MODE: "fail" });
    const r = await adbPair("192.168.1.23:37099", "654321", t.d);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.hint.length).toBeGreaterThan(10); for (const s of ["654321", "192.168.1.23", "37099", "Failed", "Wrong"]) expect(r.hint).not.toContain(s); }
    const w = await adbPair("192.168.1.23:37099", "000000", mk().d); // 番号違い（fake の正解は 123456）
    expect(w.ok).toBe(false);
  });
  test("devices -l を表に・起こせない adb は hint", async () => {
    const t = mk();
    expect(await adbDevices(t.d)).toEqual({ ok: true, devices: [{ serial: "FAKE0001", state: "device", model: "Pixel_7", product: "panther", device: "panther" }] });
    const r = await adbDevices({ ...t.d, adb: "/nonexistent/adb" });
    expect(r.ok).toBe(false);
  });
  test("AC4: uiDump が 3 つ以上取り・findEl が bounds を返し・tap が中心の座標で呼ぶ", async () => {
    const t = mk();
    const u = await uiDump(t.d);
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.els.length).toBeGreaterThanOrEqual(3);
    expect(u.els.some((e) => e.text === "予定 <3枚>")).toBe(true); // entity を戻す
    expect(u.els.find((e) => e.id.endsWith(":id/more"))!.desc).toBe("その他のオプション & 設定");
    expect(u.els.some((e) => e.text === "壊れた")).toBe(false); // bounds が読めない node は捨てる
    const el = findEl(u.els, { text: "共有" });
    expect(el?.bounds).toEqual([100, 200, 300, 300]);
    expect(findEl(u.els, { text: "共有", id: "違う" })).toBeUndefined();
    expect(findEl(u.els, {})).toBeUndefined();
    expect(await tap(el!, t.d)).toEqual({ ok: true });
    expect(t.read("taps")).toBe("200 250\n");
    expect(t.read("log")).toContain("shell input tap 200 250");
  });
  test("uiDump: /dev/tty が空の機種は file に書いて読む", async () => {
    const t = mk({ FAKE_ADB_TTY_EMPTY: "1" });
    const u = await uiDump(t.d);
    expect(u.ok && u.els.length >= 3).toBe(true);
    expect(t.read("log")).toContain("shell uiautomator dump /sdcard/ui.xml");
  });
  test("AC5: 試験の env は本物の port（5037）でも無指定でもない・guard は 5037 で赤", () => {
    const t = mk();
    expect(t.d.env.ANDROID_ADB_SERVER_PORT).not.toBe("5037");
    expect(() => guard({ ANDROID_ADB_SERVER_PORT: "5037" })).toThrow();
    expect(() => guard({})).toThrow();
  });
  test("AC5b: fake 自身も 5037 では動かない（万一 本物の port を指しても何も起こさない）", async () => {
    const t = mk();
    const r = await adbDevices({ ...t.d, env: { ...t.d.env, ANDROID_ADB_SERVER_PORT: "5037" } });
    expect(r.ok).toBe(false);
  });
});

describe("tools/scrcpy-build.sh", () => {
  const sh = (args: string[], env: Record<string, string>) => Bun.spawnSync(["/bin/sh", BUILD, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const fakeBin = (names: string[], dir: string, body = "exit 0") => { const b = join(dir, "bin"); mkdirSync(b, { recursive: true }); for (const n of names) { writeFileSync(join(b, n), `#!/bin/sh\n${body}\n`); chmodSync(join(b, n), 0o755); } return b; };

  test("AC6a: sh -n が通る", () => { expect(Bun.spawnSync(["/bin/sh", "-n", BUILD]).exitCode).toBe(0); });
  test("AC6b: dry-run の command の列が SPEC §6 の順・sudo も ninja install も無い", () => {
    const dir = mktmp("w64b");
    const r = sh([dir], { PATH: fakeBin(["brew"], dir), SCRCPY_BUILD_DRY: "1" });
    const out = r.stdout.toString();
    expect(r.exitCode).toBe(0);
    const seq = out.split("\n").filter((l) => l.startsWith("+ ")).map((l) => l.slice(2).split(" ").slice(0, 2).join(" "));
    expect(seq.map((x) => x.split(" ")[0] + " " + x.split(" ")[1])).toEqual(["git clone", "brew install", "curl -fL", "shasum -a", "mv " + seq[4]!.split(" ")[1], "meson setup", "ninja -C"]);
    expect(seq[4]!.startsWith("mv ")).toBe(true);
    expect(out).not.toMatch(/sudo|ninja install|\binstall -/);
    expect(out).toContain("brew install sdl3 ffmpeg libusb pkg-config meson ninja");
    expect(out).toContain("764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536");
    expect(out).toContain("./run build-auto");
  });
  test("AC6c: script 本文に sudo の呼びが無い（コメント以外）", () => {
    const code = readFileSync(BUILD, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\bsudo\b|ninja install/);
  });
  test("AC6d: build-auto/app/scrcpy が在れば何も打たず「済」で exit 0（冪等）", () => {
    const dir = mktmp("w64c");
    mkdirSync(join(dir, "scrcpy/build-auto/app"), { recursive: true });
    writeFileSync(join(dir, "scrcpy/build-auto/app/scrcpy"), "#!/bin/sh\n"); chmodSync(join(dir, "scrcpy/build-auto/app/scrcpy"), 0o755);
    const r = sh([dir], { PATH: "/usr/bin:/bin", SCRCPY_BUILD_DRY: "1" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("済");
    expect(r.stdout.toString()).not.toContain("+ ");
  });
  test("brew が無ければ理由を言って exit 2・存在しない dir は 64", () => {
    const dir = mktmp("w64d");
    const empty = join(dir, "empty"); mkdirSync(empty);
    const r = sh([dir], { PATH: empty, SCRCPY_BUILD_DRY: "1" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("Homebrew");
    expect(sh([join(dir, "nope")], { PATH: empty }).exitCode).toBe(64);
  });
  test("AC7: sha256 が pin と違う server では build（meson・ninja）に進まず exit ≠ 0", () => {
    const dir = mktmp("w64e");
    const log = join(dir, "calls");
    // 偽物の server を返す curl。他は呼ばれた事を記録するだけ
    const b = fakeBin(["brew", "git", "meson", "ninja"], dir, `echo "$0" >> ${log}`);
    writeFileSync(join(b, "curl"), `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\necho tampered > "$out"\n`); chmodSync(join(b, "curl"), 0o755);
    const r = sh([dir], { PATH: `${b}:/usr/bin:/bin` });
    expect(r.exitCode).toBe(3);
    expect(r.stderr.toString()).toContain("sha256");
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toMatch(/meson|ninja/);
    expect(existsSync(join(dir, "scrcpy-server"))).toBe(false); // 使わない・残さない
    expect(existsSync(join(dir, ".scrcpy-server.part"))).toBe(false);
  });
  test("登録 command にできるか: sandbox の profile は書ける所が cwd と tmp だけ（brew は prefix に書けない）", () => {
    const p = profileOf(true, 0);
    expect(p).toContain("(deny file-write*)");
    expect(p).not.toMatch(/homebrew|\/usr\/local/);
    expect([...p.matchAll(/\(allow file-write\* ([^]*?)\)\(deny file-read/g)].length).toBe(1);
  });
});
