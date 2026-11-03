// W55: bar を open -g … --relaunch で起こしても（panel を出さない起動でも）常駐は起きている・前面は取らない・panel は人が開いた時だけ。常駐は自分の版を返す（bar.json の version と `kangae version`）
// bar は実物の swift を本当に build して（約 1.5 分）、temp の KANGAE_* だけで起こす（人の ~/.kangae・~/Applications には触らない）。常駐の代わりは印を書くだけの shell
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frontApp } from "../src/lease.ts";
import { VERSION, versionReport } from "../src/version.ts";
import { spawnDaemon, waitDaemon } from "./spawn-daemon.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(1_200_000); // 実物の swift の build は混んだ機械で 7 分かかった（キャッシュが無い最初の 1 回だけ）

const root = join(import.meta.dir, "..");
const SWIFT = ["main.swift", "Glass.swift", "Region.swift", "Point.swift", "Lease.swift", "Front.swift", "Badge.swift"];
let D: string, BIN: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms: number) => { for (const end = Date.now() + ms; Date.now() < end;) { if (f()) return true; await sleep(100); } return f(); };
const kids: { kill: () => void }[] = [];

beforeAll(() => {
  D = realpathSync(mktmp("w55"));
  // build した bar は swift の中身の hash で使い回す（同じ中身なら再 build しない）。中身が替われば別の file になる＝古い bar で緑にならない
  const h = createHash("sha1"); for (const f of SWIFT) h.update(readFileSync(join(root, "bar", f)));
  const dir = process.env.KANGAE_W55_BAR_CACHE ?? "/tmp/kangae-w55-bar"; // 試験の TMPDIR は走りごとの temp なので、使い回す置き場は固定（中身は hash つきの file 名）
  mkdirSync(dir, { recursive: true });
  BIN = join(dir, `KangaeBar-${h.digest("hex").slice(0, 16)}`);
  if (existsSync(BIN)) return;
  const tmp = `${BIN}.${process.pid}.tmp`;
  const r = Bun.spawnSync(["swiftc", "-Onone", ...SWIFT.map((f) => join(root, "bar", f)), "-o", tmp], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`swiftc: ${r.stderr.toString().slice(-600)}`);
  renameSync(tmp, BIN);
});
afterAll(() => { for (const k of kids) { try { k.kill(); } catch {} } rmSync(D, { recursive: true, force: true }); });

// 偽の常駐: 起こされたら印を 1 行書く（引数つき）。bar が探す KANGAE_DAEMON
const fakeDaemon = (name: string) => {
  const dir = join(D, name); mkdirSync(dir, { recursive: true });
  const script = join(dir, "daemon.sh"), mark = join(dir, "started");
  writeFileSync(script, `#!/bin/sh\necho "$@" >> '${mark}'\nexit 0\n`); chmodSync(script, 0o755);
  return { dir, script, mark, bar: join(dir, "bar.json"), lock: join(dir, "bar.lock"), conf: join(dir, "bar.conf"), started: () => (existsSync(mark) ? readFileSync(mark, "utf8").trim().split("\n") : []) };
};
const runBar = (d: ReturnType<typeof fakeDaemon>, args: string[]) => {
  const p = Bun.spawn([BIN, ...args], { env: { ...process.env, KANGAE_DAEMON: d.script, KANGAE_BAR: d.bar, KANGAE_BAR_LOCK: d.lock, KANGAE_BAR_CONF: d.conf, KANGAE_BAR_OFFSCREEN: "1" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  kids.push(p);
  return p;
};

test("W55-1 --relaunch（panel を出さない起動）でも、常駐が居なければ起こす（--daemon で 1 回）・前面は変わらない・bar は生きている", async () => {
  const d = fakeDaemon("a");
  const front = frontApp();
  const p = runBar(d, ["--relaunch"]);
  expect(await until(() => d.started().length >= 1, 20_000)).toBe(true);
  expect(d.started()).toEqual(["--daemon"]);
  await sleep(1500);
  expect(d.started()).toEqual(["--daemon"]); // 1 回だけ（--relaunch は panel を出さないので connect の再試行の起こしは無い）
  expect(p.exitCode).toBeNull();            // bar は生きている（待機）
  expect(frontApp()).toBe(front);           // 前面を取っていない
  p.kill();
});

test("W55-2 試験の直 exec（引数なし・親が launchd でない）も同じ: panel を出さず、常駐だけ起こす", async () => {
  const d = fakeDaemon("b");
  const front = frontApp();
  const p = runBar(d, []);
  expect(await until(() => d.started().length >= 1, 20_000)).toBe(true);
  expect(d.started()).toEqual(["--daemon"]);
  expect(frontApp()).toBe(front);
  p.kill();
});

test("W55-3 常駐が既に居る（bar.json の pid が生きている）時は、起こさない（二重に起こさない・HTTP には頼らない）", async () => {
  const d = fakeDaemon("c");
  // review29 の isDaemonPid は実行 file の名前（kangae・bun）まで見る。生きているだけの sleep では「常駐」と読まないので、名前が bun の生きた process を使う
  const alive = Bun.spawn([process.execPath, "-e", "setTimeout(()=>{},30000)"], { stdout: "ignore", stderr: "ignore" }); kids.push(alive);
  writeFileSync(d.bar, JSON.stringify({ port: 1, token: "t", pid: alive.pid }));
  const front = frontApp();
  const p = runBar(d, ["--relaunch"]);
  await sleep(6000); // bar が立ち上がって ensureDaemon を通る間
  expect(p.exitCode).toBeNull();
  expect(d.started()).toEqual([]);
  expect(frontApp()).toBe(front);
  p.kill();
});

test("W55-3b pid が生きていても常駐でない（名前が kangae・bun でない・pid の使い回し）なら、起こす（review29）", async () => {
  const d = fakeDaemon("c2");
  const other = Bun.spawn(["sleep", "30"]); kids.push(other);
  writeFileSync(d.bar, JSON.stringify({ port: 1, token: "t", pid: other.pid }));
  const p = runBar(d, ["--relaunch"]);
  expect(await until(() => d.started().length >= 1, 30_000)).toBe(true);
  expect(d.started()).toEqual(["--daemon"]);
  p.kill();
});

test("W55-4 bar.json が古い（pid が居ない）時は起こす", async () => {
  const d = fakeDaemon("d");
  const dead = Bun.spawn(["true"]); await dead.exited;
  writeFileSync(d.bar, JSON.stringify({ port: 1, token: "t", pid: dead.pid }));
  const p = runBar(d, ["--relaunch"]);
  expect(await until(() => d.started().length >= 1, 30_000)).toBe(true);
  expect(d.started()).toEqual(["--daemon"]);
  p.kill();
});

test("W55-5 配線: 窓を出す道（--show・人が開いた時）は toggle・出さない道は ensureDaemon（どちらも 1 つの分岐）・dist-bar は版を焼く", () => {
  const s = readFileSync(join(root, "bar/main.swift"), "utf8");
  expect(s).toMatch(/\{ toggle\(\) \} else \{ ensureDaemon\(\) \}/);
  expect(s).toContain("func ensureDaemon()");
  expect(readFileSync(join(root, "scripts/dist-bar.sh"), "utf8")).toContain('--define "process.env.KANGAE_BUILD=');
});

// ---- 版 ----
test("W55-6 versionReport: 起きていない・古い版（版を返さない）・版が違う・同じ を人の言葉で出し、違う時は開き直しを案内する", () => {
  expect(versionReport("abc", null, false)).toEqual(["kangae abc", "常駐: 起きていません（bar.json がありません）"]);
  expect(versionReport("abc", { pid: 123, version: "abc" }, false)[1]).toContain("pid 123 は居ません");
  expect(versionReport("abc", { pid: 123 }, true)).toEqual(["kangae abc", "常駐: 不明（古い版で、版を返しません）（pid 123）", expect.stringContaining("版が違います")]);
  const diff = versionReport("abc", { pid: 123, version: "old1" }, true);
  expect(diff[1]).toBe("常駐: old1（pid 123）");
  expect(diff[2]).toContain("開き直す");
  expect(versionReport("abc", { pid: 123, version: "abc" }, true)).toEqual(["kangae abc", "常駐: abc（pid 123）"]);
});

test("W55-7 実物: 常駐は bar.json に version を書き、`kangae version` は動いている常駐の版を出す（居なければ「起きていません」）", async () => {
  const home = join(D, "home7"); mkdirSync(home, { recursive: true });
  const bar = join(home, "bar.json"), sock = join(home, "k.sock");
  const env = { ...process.env, KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_BAR: bar, KANGAE_NODES_DIR: join(home, "nodes") } as Record<string, string>;
  const out = () => Bun.spawnSync(["bun", join(root, "src/main.ts"), "version"], { env, stdout: "pipe", stderr: "pipe" }).stdout.toString();
  expect(out()).toContain("常駐: 起きていません");
  const proc = spawnDaemon(["bun", join(root, "src/main.ts"), "--daemon"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  kids.push(proc);
  await waitDaemon(proc, { bar, sock });
  const j = JSON.parse(readFileSync(bar, "utf8")) as { version?: string; pid: number };
  expect(j.version).toBe(VERSION);
  const o = out();
  expect(o).toContain(`kangae ${VERSION}`);
  expect(o).toContain(`常駐: ${VERSION}（pid ${j.pid}）`);
  expect(o).not.toContain("版が違います");
  proc.kill();
});

test("W55-8 配る物の版は焼かれて実行時の環境変数では替わらない（bun build --define）", () => {
  const f = join(D, "ver-entry.ts");
  writeFileSync(f, `import { VERSION } from ${JSON.stringify(join(root, "src/version.ts"))}; console.log(VERSION);`);
  const bin = join(D, "ver-bin");
  expect(Bun.spawnSync(["bun", "build", "--compile", "--define", 'process.env.KANGAE_BUILD="abc1234"', f, "--outfile", bin], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  expect(Bun.spawnSync([bin], { env: { PATH: process.env.PATH ?? "", KANGAE_BUILD: "spoof" }, stdout: "pipe" }).stdout.toString().trim()).toBe("abc1234");
});
