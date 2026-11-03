// W17c-a: 登録 command を OS の sandbox（sandbox-exec）の中で走らせる（docs/BRIEF-w17c.md §5 の AC 1〜8）。実際に sandbox-exec を回す。読む file を literal で名指す: "src/cmds.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE, SANDBOX, startCmd, type Cmd } from "../src/cmds.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000); // holes-30: sandbox / process を起こす test は混んだ機械（load 600）で 30 秒を超える＝既定を混み倍率×実測の余裕に

let top: string, proj: string, outDir: string, homeDir: string;
const cmd = (argv: string[], cwd = proj): Cmd => ({ name: "t", cwd, argv, timeoutSec: 600, at: 0, seal: "" });
let n = 0;
const run = async (argv: string[], cwd = proj, lim: Parameters<typeof startCmd>[2] = {}) => {
  const out = join(outDir, `o${n++}.txt`);
  const r = startCmd(cmd(argv, cwd), out, lim);
  const ran = await r.done;
  return { ran, text: existsSync(out) ? readFileSync(out, "utf8") : "", out };
};
const sh = (script: string, cwd = proj, lim = {}) => run(["/bin/sh", "-c", script], cwd, lim);

beforeEach(() => {
  top = realpathSync(mktmp("w17ca"));
  proj = join(top, "proj"); outDir = join(top, "out");
  mkdirSync(proj); mkdirSync(outDir);
  homeDir = join(homedir(), `.w17ca-${process.pid}-${Date.now()}`); // /Users の下（読みを閉じる対象）。終わりに消す
  mkdirSync(homeDir);
});
afterEach(() => { rmSync(top, { recursive: true, force: true }); rmSync(homeDir, { recursive: true, force: true }); rmSync("/private/tmp/w17ca-should-not-exist", { force: true }); SANDBOX.bin = "/usr/bin/sandbox-exec"; });

test("AC-1 書き: cwd の中は書ける・cwd の外（home の下の別 folder・/private/tmp）には書けない", async () => {
  const outside = join(homeDir, "outside"); mkdirSync(outside);
  const r = await sh(`echo ok > inside.txt; echo x > '${outside}/f' 2>&1; echo x > /private/tmp/w17ca-should-not-exist 2>&1; echo done`);
  expect(r.ran.code).toBe(0);
  expect(readFileSync(join(proj, "inside.txt"), "utf8")).toBe("ok\n");
  expect(existsSync(join(outside, "f"))).toBe(false);
  expect(existsSync("/private/tmp/w17ca-should-not-exist")).toBe(false);
  expect(r.text.includes("Operation not permitted")).toBe(true);
});

test("AC-1b TMPDIR は走りごとの tmp（書ける）で、終わりに消える", async () => {
  const r = await sh('echo $TMPDIR > "$TMPDIR/note"; cat "$TMPDIR/note"');
  const tmp = r.text.trim();
  expect(tmp.startsWith(outDir)).toBe(true);
  expect(existsSync(tmp)).toBe(false);
  expect(readdirSync(outDir).filter((f) => f.startsWith("tmp-"))).toEqual([]);
});

test("AC-2 読み: /Users の下の cwd 外は読めない（~/.ssh 相当の偽 folder）・cwd の中は読める", async () => {
  const secret = join(homeDir, "secret"); mkdirSync(secret); writeFileSync(join(secret, "key"), "TOP-SECRET");
  writeFileSync(join(proj, "mine.txt"), "mine");
  const r = await sh(`cat '${secret}/key' 2>&1; cat mine.txt`);
  expect(r.text.includes("TOP-SECRET")).toBe(false);
  expect(r.text.includes("Operation not permitted")).toBe(true);
  expect(r.text.includes("mine")).toBe(true);
});

test("AC-3 通信: 既定では TCP も 常駐の unix socket も繋がらない（対照: sandbox 無しなら繋がる）", async () => {
  const sock = join(top, "d.sock");
  const srv = Bun.listen({ unix: sock, socket: { data(s) { s.write("pong"); }, open() {} } });
  const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(s) { s.write("pong"); }, open() {} } });
  try {
    const probe = (path: string, args: string[]) => Bun.spawn([path, ...args], { stdout: "pipe", stderr: "ignore", stdin: new Blob(["hi\n"]) });
    // 対照: 外では繋がる（試験が効く事）
    expect(await new Response(probe("/usr/bin/nc", ["-U", "-w", "2", sock]).stdout).text()).toContain("pong");
    expect(await new Response(probe("/usr/bin/nc", ["-w", "2", "127.0.0.1", String(tcp.port)]).stdout).text()).toContain("pong");
    const u = await sh(`echo hi | /usr/bin/nc -U -w 2 '${sock}' 2>&1`);
    expect(u.text.includes("pong")).toBe(false);
    const t = await sh(`echo hi | /usr/bin/nc -w 2 127.0.0.1 ${tcp.port} 2>&1`);
    expect(t.text.includes("pong")).toBe(false);
  } finally { srv.stop(true); tcp.stop(true); }
});

test("AC-4 通し: 小さな C の cmake project の configure と build が sandbox の下で通る", async () => {
  mkdirSync(join(proj, "src"));
  writeFileSync(join(proj, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.10)\nproject(t C)\nadd_executable(t src/main.c)\n");
  writeFileSync(join(proj, "src/main.c"), "int main(void){return 0;}\n");
  const cmake = existsSync("/usr/local/bin/cmake") ? "/usr/local/bin/cmake" : existsSync("/opt/homebrew/bin/cmake") ? "/opt/homebrew/bin/cmake" : "";
  if (!cmake) return; // cmake が無い機械では飛ばす（この Mac には在る）
  const a = await run([cmake, "-S", ".", "-B", "build"], proj, { timeoutMs: 120_000 });
  expect(a.ran.code).toBe(0);
  const b = await run([cmake, "--build", "build"], proj, { timeoutMs: 120_000 });
  expect(b.ran.code).toBe(0);
  expect(existsSync(join(proj, "build/t"))).toBe(true);
}, 300_000);

test("AC-5 出力: stdout / stderr が fd 経由で out file に届く（out は cwd の外・書き許可の外）", async () => {
  const r = await sh("echo to-stdout; echo to-stderr 1>&2");
  expect(r.text).toBe("to-stdout\nto-stderr\n");
});

test("AC-6 kill: sandbox-exec 越しでも時間切れ / kill で process group ごと死ぬ（子の sleep まで）", async () => {
  for (const how of ["timeout", "kill"] as const) {
    const pidf = join(proj, `pid-${how}`);
    const out = join(outDir, `k-${how}.txt`);
    const r = startCmd(cmd(["/bin/sh", "-c", `sleep 60 & echo $! > ${pidf}; wait`]), out, how === "timeout" ? { timeoutMs: 800 } : {});
    for (const end = Date.now() + 4000; !existsSync(pidf) && Date.now() < end;) await Bun.sleep(20);
    await Bun.sleep(100);
    const child = Number(readFileSync(pidf, "utf8").trim());
    expect(() => process.kill(child, 0)).not.toThrow();
    if (how === "kill") r.kill();
    const ran = await r.done;
    expect(ran.why).toBe(how === "timeout" ? "timeout" : "killed");
    let dead = false;
    for (const end = Date.now() + 3000; !dead && Date.now() < end; await Bun.sleep(20)) { try { process.kill(child, 0); } catch { dead = true; } }
    expect(dead).toBe(true);
  }
});

test("AC-7 profile を壊せない: cwd に 引用符・括弧・; ・空白・改行 を含んでも、書けるのは その cwd だけのまま", async () => {
  for (const name of [`a"b`, "a)b(c", "a;b c", "a\nb", `x") (allow file-write* (subpath "/`]) {
    const weird = join(top, name);
    mkdirSync(weird);
    const sibling = join(top, "sibling-of-" + n++); mkdirSync(sibling);
    const r = await sh(`echo ok > inside.txt; echo x > '${sibling}/f' 2>&1; echo x > /private/tmp/w17ca-should-not-exist 2>&1`, weird);
    expect(existsSync(join(weird, "inside.txt"))).toBe(true);
    expect(existsSync(join(sibling, "f"))).toBe(false);
    expect(existsSync("/private/tmp/w17ca-should-not-exist")).toBe(false);
    expect(r.text.includes("Operation not permitted")).toBe(true);
  }
  expect(PROFILE.includes(proj)).toBe(false); // path は profile に埋め込まない（-D の parameter）
});

test("AC-8 fail closed: sandbox-exec が使えない（無い）時は走らせず、出力 file も作らない", () => {
  SANDBOX.bin = join(top, "no-such-sandbox-exec");
  const out = join(outDir, "never.txt");
  const marker = join(proj, "ran");
  expect(() => startCmd(cmd(["/usr/bin/touch", marker]), out)).toThrow("安全に走らせられません");
  expect(existsSync(out)).toBe(false);
  expect(existsSync(marker)).toBe(false);
  expect(readdirSync(outDir)).toEqual([]);
});
