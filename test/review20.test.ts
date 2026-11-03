// review20: W17c-a（登録 command を sandbox-exec で包む）を攻める。実際に sandbox-exec を回す（画面は出ない）
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX, startCmd, type Cmd } from "../src/cmds.ts";
import { armExe } from "./exe";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000); // holes-30: sandbox / process を起こす test は混んだ機械（load 600）で 30 秒を超える＝既定を混み倍率×実測の余裕に

let top: string, proj: string, outDir: string, n = 0;
const cmd = (argv: string[], cwd = proj): Cmd => ({ name: "t", cwd, argv, timeoutSec: 600, at: 0, seal: "" });
const run = async (argv: string[], cwd = proj, lim: Parameters<typeof startCmd>[2] = {}) => {
  const out = join(outDir, `o${n++}.txt`);
  const r = startCmd(cmd(argv, cwd), out, lim);
  const ran = await r.done;
  return { ran, text: existsSync(out) ? readFileSync(out, "utf8") : "", out };
};
const sh = (script: string, cwd = proj, lim = {}) => run(["/bin/sh", "-c", script], cwd, lim);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid: number, ms = 3000) => { for (const end = Date.now() + ms; alive(pid) && Date.now() < end;) await Bun.sleep(20); return !alive(pid); };

beforeEach(() => {
  top = realpathSync(mktmp("r20"));
  proj = join(top, "proj"); outDir = join(top, "out");
  mkdirSync(proj); mkdirSync(outDir);
});
afterEach(() => { rmSync(top, { recursive: true, force: true }); SANDBOX.bin = "/usr/bin/sandbox-exec"; });

test("① -D の値に 引用符・括弧・; ・改行・= ・先頭の - を含む cwd でも、書けるのはその cwd だけ（外へ書けない）", async () => {
  const outside = join(top, "outside.txt");
  for (const name of ['a"b', "a)b(c", "a;b", "a\nb", "a=b", "-D x", "a b\\c", "x\") (allow file-write* (regex #\".*\"))"]) {
    const cwd = join(top, `dir-${name}`);
    mkdirSync(cwd);
    const r = await sh(`echo in > ./in.txt; echo out > '${outside}'; echo rc=$?`, cwd);
    expect(existsSync(join(cwd, "in.txt")), JSON.stringify(name) + " " + r.text).toBe(true);
    expect(existsSync(outside), JSON.stringify(name)).toBe(false);
    expect(r.text).not.toContain("rc=0");
  }
});

test("② 他の process へ signal を送れない（常駐 kangae や人の app を kill できない）・自分の子には送れる", async () => {
  const victim = Bun.spawn(["/bin/sleep", "300"]);
  try {
    const r = await sh(`/bin/kill -9 ${victim.pid}; echo rc=$?`);
    expect(r.text).not.toContain("rc=0");
    await Bun.sleep(200);
    expect(alive(victim.pid)).toBe(true);
    const own = await sh("/bin/sleep 50 & C=$!; /bin/kill -9 $C; echo child-rc=$?");
    expect(own.text).toContain("child-rc=0");
  } finally { victim.kill(9); }
});

test("③ fail closed: 守りが効かない sandbox-exec（何も包まず exec するだけ・exit 0）は自己検査で断る。印の file は作られない", () => {
  const fake = join(top, "fake-sandbox-exec");
  writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" = -p -o "$1" = -D ]; do shift; shift; done\nexec "$@"\n');
  armExe(fake);
  SANDBOX.bin = fake;
  const mark = join(proj, "ran");
  expect(() => startCmd(cmd(["/usr/bin/touch", mark]), join(outDir, "o.txt"))).toThrow(/安全に走らせられません/);
  expect(existsSync(mark)).toBe(false);
  SANDBOX.bin = join(top, "nonexistent");
  expect(() => startCmd(cmd(["/usr/bin/touch", mark]), join(outDir, "o2.txt"))).toThrow(/安全に走らせられません/);
  expect(existsSync(mark)).toBe(false);
});

test("④ setsid で process group を抜けた子孫・親が死んだ後に残った孫も、終わりに止まる（後から cwd に書き続けない）", async () => {
  const tag = `r20marker${process.pid}${Date.now()}`;
  // 孫は 0.2 秒ごとに alive.txt を書き続ける。止まっていれば mtime が進まない（固定の遅れ sleep と sweep の競争にしない＝load が高いと sweep の ps に数秒かかる）
  const loop = `use POSIX; $0="${tag}"; %PRE% POSIX::setsid(); $0="${tag}"; while (1) { open(F, ">", "alive.txt"); print F time; close F; select(undef, undef, undef, 0.2); }`;
  const frozen = async () => {
    const f = join(proj, "alive.txt");
    for (let i = 0; i < 100 && !existsSync(f); i++) await Bun.sleep(20); // 孫が一度も書く前に殺された時は存在しない＝止まっている
    if (!existsSync(f)) return true;
    const m1 = statSync(f).mtimeMs;
    await Bun.sleep(1200);
    return statSync(f).mtimeMs === m1;
  };
  const r = await run(["/usr/bin/perl", "-e", loop.replace("%PRE%", "if (fork()) { exit 0 }")]);
  expect(r.ran.why).toBe("exit");
  expect(await frozen()).toBe(true);
  expect(Bun.spawnSync(["/bin/ps", "-axww", "-o", "pid=,command="]).stdout.toString().includes(tag)).toBe(false);
  // timeout の kill でも同じ（親が生きている間に時間切れ）
  rmSync(join(proj, "alive.txt"), { force: true });
  const t = await run(["/usr/bin/perl", "-e", loop.replace("%PRE%", "if (fork()) { sleep 60; exit 0 }")], proj, { timeoutMs: 1500 });
  expect(t.ran.why).toBe("timeout");
  expect(await frozen()).toBe(true);
  expect(Bun.spawnSync(["/bin/ps", "-axww", "-o", "pid=,command="]).stdout.toString().includes(tag)).toBe(false);
}, 60_000);

test("⑤ symlink / hard link で cwd の外を読み書きできない", async () => {
  const outside = join(top, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
  writeFileSync(join(outside, "target.txt"), "orig");
  const r = await sh(`ln -s '${outside}/secret.txt' ./s; cat ./s; ln '${outside}/secret.txt' ./h; cat ./h; ln -s '${outside}/target.txt' ./w; echo changed >> ./w; ln -s '${outside}' ./d; echo x > ./d/new.txt`);
  expect(r.text).not.toContain("TOPSECRET");
  expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("orig");
  expect(existsSync(join(outside, "new.txt"))).toBe(false);
  symlinkSync(outside, join(proj, "pre")); // cwd の中に最初からある symlink でも同じ
  const r2 = await sh("cat ./pre/secret.txt; echo x > ./pre/new2.txt");
  expect(r2.text).not.toContain("TOPSECRET");
  expect(existsSync(join(outside, "new2.txt"))).toBe(false);
});

test("⑥ env: 常駐の env にある token / 鍵は子に渡らない・TMPDIR は走りごとの tmp", async () => {
  const seed = { KANGAE_LEASE: "lease-xyz", KANGAE_OWNER: "s:1", BW_SESSION: "bw-xyz", ANTHROPIC_API_KEY: "sk-xyz", OPENAI_API_KEY: "sk-abc", GITHUB_TOKEN: "ghp_x", SSH_AUTH_SOCK: "/tmp/agent.sock" };
  const was = Object.fromEntries(Object.keys(seed).map((k) => [k, process.env[k]]));
  Object.assign(process.env, seed);
  try {
    const r = await run(["/usr/bin/env"]);
    for (const [k, v] of Object.entries(seed)) { expect(r.text).not.toContain(`${k}=`); expect(r.text).not.toContain(v); }
    expect(r.text).toMatch(new RegExp(`^TMPDIR=${outDir}/tmp-`, "m"));
  } finally { for (const [k, v] of Object.entries(was)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
});

test("⑦ fd: 子に渡る fd は 0〜2 だけ（常駐の store・socket・他の走りの out file を /dev/fd/N で書けない）", async () => {
  const r = await sh("echo FDS:$(ls /dev/fd | tr '\\n' ' ')"); // 3 と 4 は ls 自身の dir fd
  const fds = (/FDS:([\d ]+)/.exec(r.text)?.[1] ?? "").trim().split(/\s+/).map(Number);
  expect(fds.length).toBeGreaterThan(0);
  expect(Math.max(...fds)).toBeLessThanOrEqual(4);
  // 常駐が開いている fd を意図して持たせても（試験の process が開いた file）、子には渡らない
  const secretFd = require("node:fs").openSync(join(top, "daemon-held.txt"), "w");
  try {
    const r2 = await sh(`echo FDS:$(ls /dev/fd | tr '\\n' ' '); echo stolen > /dev/fd/${secretFd} 2>/dev/null; echo rc=$?`);
    expect(Math.max(...(/FDS:([\d ]+)/.exec(r2.text)![1]!.trim().split(/\s+/).map(Number)))).toBeLessThanOrEqual(4);
    expect(readFileSync(join(top, "daemon-held.txt"), "utf8")).toBe("");
  } finally { require("node:fs").closeSync(secretFd); }
});

test("⑧ 読み: /Users /Volumes の外でも、他の道具の scratch（/private/tmp・/private/var/folders）・system keychain・log は読めない。cwd の中は読める", async () => {
  const inTmp = `/private/tmp/r20-secret-${process.pid}`;
  writeFileSync(inTmp, "TMPSECRET");
  writeFileSync(join(top, "sibling-secret.txt"), "FOLDERSSECRET"); // top は /var/folders の下＝cwd（proj）の外
  writeFileSync(join(proj, "mine.txt"), "MINE");
  try {
    const kc = existsSync("/Library/Keychains/System.keychain") ? "head -c 16 /Library/Keychains/System.keychain | od -c | head -1;" : "";
    const r = await sh(`cat '${inTmp}'; cat '${top}/sibling-secret.txt'; ${kc} cat ./mine.txt; ls /private/tmp | head -1; ls /private/var/folders | head -1`);
    expect(r.text).toContain("MINE");
    expect(r.text).not.toContain("TMPSECRET");
    expect(r.text).not.toContain("FOLDERSSECRET");
    if (kc) expect(r.text).not.toContain("0000000"); // od の出力（keychain の先頭 byte）が出ない
  } finally { rmSync(inTmp, { force: true }); }
});

test("⑨ launchd 経由（launchctl submit）で sandbox の外に process を起こせない", async () => {
  const id = `r20.${process.pid}.${Date.now()}`, mark = `/private/tmp/r20-escape-${process.pid}`;
  rmSync(mark, { force: true });
  try {
    await sh(`/bin/launchctl submit -l ${id} -- /usr/bin/touch ${mark}`);
    await Bun.sleep(1500);
    expect(existsSync(mark)).toBe(false);
  } finally { Bun.spawnSync(["/bin/launchctl", "remove", id]); rmSync(mark, { force: true }); }
}, 20_000);
