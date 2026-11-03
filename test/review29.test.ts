// review29: W55（常駐を起こす・kangae version）・W57（Gatekeeper の案内）・W42c（名前で指す操作だけの切り替え）の module review。作者でない目で、自分の実装が通らない入力を撃つ
// 破れ: R29-1 bar.json の pid を別の process が使い回していると「常駐が居る」と読む（再起動後に起こさない・version が「起きています」・「終わる」が無関係な process へ SIGTERM）
//       R29-2 名前つき操作だけの tab で、断った先の道が無い: range / color（slider の set_value）・password 欄
//       R29-3 install-bar.sh: 前の Bar が動いたままだと「初回の起動だけ…今調べます」が嘘（open は動いている物を前に出すだけ）・窓は 2/4 回なのに silent の文は「前に出ます」と断言
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { namedHint } from "../src/lease.ts";
import { isDaemonPid, versionReport } from "../src/version.ts";
import { installChrome, load } from "./fake-chrome";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(1_200_000);

const root = join(import.meta.dir, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms: number) => { for (const end = Date.now() + ms; Date.now() < end;) { if (f()) return true; await sleep(100); } return f(); };

// ---- R29-1 swift の bar（W55 と同じ build・同じ cache）----
const SWIFT = ["main.swift", "Glass.swift", "Region.swift", "Point.swift", "Lease.swift", "Front.swift", "Badge.swift"];
let D: string, BIN: string;
const kids: { kill: () => void }[] = [];
beforeAll(() => {
  D = realpathSync(mktmp("r29"));
  if (process.env.R29_BAR) { BIN = process.env.R29_BAR; return; } // 負の対照: 直す前の bar を指す
  const h = createHash("sha1"); for (const f of SWIFT) h.update(readFileSync(join(root, "bar", f)));
  const dir = process.env.KANGAE_W55_BAR_CACHE ?? "/tmp/kangae-w55-bar";
  mkdirSync(dir, { recursive: true });
  BIN = join(dir, `KangaeBar-${h.digest("hex").slice(0, 16)}`);
  if (existsSync(BIN)) return;
  const tmp = `${BIN}.${process.pid}.tmp`;
  const r = Bun.spawnSync(["swiftc", "-Onone", ...SWIFT.map((f) => join(root, "bar", f)), "-o", tmp], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`swiftc: ${r.stderr.toString().slice(-600)}`);
  renameSync(tmp, BIN);
});
afterAll(() => { for (const k of kids) { try { k.kill(); } catch {} } rmSync(D, { recursive: true, force: true }); });

test("R29-1 bar: bar.json の pid が生きていても、それが常駐でなければ（pid の使い回し）常駐を起こす", async () => {
  const dir = join(D, "a"); mkdirSync(dir, { recursive: true });
  const script = join(dir, "daemon.sh"), mark = join(dir, "started"), bar = join(dir, "bar.json");
  writeFileSync(script, `#!/bin/sh\necho "$@" >> '${mark}'\nexit 0\n`); chmodSync(script, 0o755);
  const other = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" }); kids.push(other); // 無関係な生きた process（常駐ではない）
  writeFileSync(bar, JSON.stringify({ port: 1, token: "t", pid: other.pid, version: "old" }));
  const p = Bun.spawn([BIN, "--relaunch"], { env: { ...process.env, KANGAE_DAEMON: script, KANGAE_BAR: bar, KANGAE_BAR_LOCK: join(dir, "bar.lock"), KANGAE_BAR_CONF: join(dir, "bar.conf"), KANGAE_BAR_OFFSCREEN: "1" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); kids.push(p);
  expect(await until(() => existsSync(mark), 20_000)).toBe(true);
  expect(readFileSync(mark, "utf8").trim()).toBe("--daemon");
  expect(other.exitCode).toBeNull(); // 無関係な process には何もしていない
  p.kill(); other.kill();
});

test("R29-1b kangae version の pid 判定: 生きている無関係な process は常駐ではない・実行 file が kangae / bun なら常駐・居ない pid・1 以下・小数は常駐でない", async () => {
  const other = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  try {
    expect(isDaemonPid(other.pid)).toBe(false);
    expect(isDaemonPid(other.pid, () => "/x/Kangae Bar.app/Contents/Resources/bin/kangae")).toBe(true);
    expect(isDaemonPid(other.pid, () => "/opt/homebrew/bin/bun")).toBe(true);
    expect(isDaemonPid(other.pid, () => "/usr/bin/sleep")).toBe(false);
    expect(isDaemonPid(other.pid, () => "")).toBe(false); // 名前を読めない時は「居る」と言わない
  } finally { other.kill(); await other.exited; }
  for (const bad of [0, 1, -5, 2 ** 31, 1.5, NaN]) expect(isDaemonPid(bad as number, () => "kangae"), String(bad)).toBe(false);
  expect(versionReport("abc", { pid: 99, version: "abc" }, false).join("\n")).toContain("居ません");
});

// ---- R29-2 W42c: 断った先に道が無い ----
installChrome();
const { namedOp } = await load("web");
type FE = Record<string, any>;
const fe = (o: FE): FE => ({ value: "", innerText: "", attrs: {}, getAttribute(n: string) { return this.attrs[n] ?? null; }, getClientRects: () => [1], click() {}, focus() {}, dispatchEvent() {}, ...o });
afterEach(() => { delete (globalThis as any).document; delete (globalThis as any).__kangae; });
const install = (els: FE[]) => { (globalThis as any).document = { querySelectorAll: () => els, execCommand: () => true }; (globalThis as any).Event = class { constructor(public type: string) {} }; (globalThis as any).__kangae = { doc: "D1" }; };

test("R29-2 slider（input[type=range]）: 名前つき操作だけの tab が set_value を断って案内する fill が、その slider を見つけて値を入れられる", () => {
  const range = fe({ tagName: "INPUT", type: "range", attrs: { "aria-label": "音量" } });
  install([range]);
  const hint = namedHint("set_value", { value: "60" }, { role: "textbox", label: "音量" }, { e1: { role: "textbox", label: "音量" } });
  expect(hint).toContain("act fill"); // 案内は出る（snapshot の role は textbox）
  const r = namedOp("fill", { docId: "D1", field: "音量", value: "60" });
  expect(r.error, r.text).toBeUndefined(); // 案内の先が行き止まりでない
  expect(range.value).toBe("60");
});

test("R29-2b password 欄: 案内しない（fill は password を入れられない＝行き止まり）。secure でない textbox は今までどおり案内する", () => {
  const els = { e1: { role: "textbox", label: "パスワード", secure: true }, e2: { role: "textbox", label: "名前" } };
  expect(namedHint("type_text", { text: "x" }, els.e1, els)).toBe("");
  expect(namedHint("type_text", { text: "x" }, els.e2, els)).toContain("act fill");
  install([fe({ tagName: "INPUT", type: "password", attrs: { "aria-label": "パスワード" } })]);
  expect(namedOp("fill", { docId: "D1", field: "パスワード", value: "x" }).error).toBeTruthy(); // fill 側は今も password を入れない（人の金庫の道）
});

// ---- R29-3 install-bar.sh ----
const sh = (c: string, env: Record<string, string>, input: string) => { const r = Bun.spawnSync(["sh", "-c", c], { env: { ...process.env, ...env }, stdin: Buffer.from(input) }); return r.stdout.toString() + r.stderr.toString(); };
function dist() {
  const d = mktmp("r29-dist"), app = join(d, "s", "Kangae Bar.app", "Contents");
  mkdirSync(app, { recursive: true }); writeFileSync(join(app, "Info.plist"), "<plist/>");
  for (const a of ["x64", "arm64"]) Bun.spawnSync(["ditto", "-c", "-k", join(d, "s"), join(d, `KangaeBar-${a}.zip`)]);
  const sha = Bun.spawnSync(["sh", "-c", `shasum -a 256 '${d}/KangaeBar-x64.zip' | cut -d' ' -f1`]).stdout.toString().trim();
  return { base: `file://${d}`, body: readFileSync(join(root, "scripts/install-bar.sh"), "utf8").replaceAll("@SHA_x64@", sha).replaceAll("@SHA_arm64@", sha) };
}
test("R29-3 install-bar.sh: 前の Bar が動いている時は「今ここで調べます」と言わず、開き直す時だと言う・silent の窓は「ことがある」", () => {
  const { base, body } = dist();
  const bin = mktmp("r29-bin");
  writeFileSync(join(bin, "open"), '#!/bin/sh\necho "OPEN-CALLED $*"\n'); chmodSync(join(bin, "open"), 0o755);
  writeFileSync(join(bin, "pgrep"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "pgrep"), 0o755); // 前の Bar が動いている
  const env = { KANGAE_BASE: base, KANGAE_APPS: mktmp("r29-apps"), PATH: `${bin}:${process.env.PATH}` };
  const out = sh("sh", env, body);
  expect(out).not.toContain("初回の起動だけ、macOS が Kangae Bar を調べます");
  expect(out).toContain("終わらせて開き直す時です");
  const silent = sh("sh", { ...env, KANGAE_NO_OPEN: "1" }, body);
  expect(silent).toContain("前に出ることがあります");
  expect(silent).not.toContain("数秒、前に出ます。");
  const bin2 = mktmp("r29-bin2"); // 前の Bar が居ない時は今までどおり（案内が先・open は 1 回）
  writeFileSync(join(bin2, "open"), '#!/bin/sh\necho "OPEN-CALLED $*"\n'); chmodSync(join(bin2, "open"), 0o755);
  writeFileSync(join(bin2, "pgrep"), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin2, "pgrep"), 0o755);
  const fresh = sh("sh", { ...env, PATH: `${bin2}:${process.env.PATH}`, KANGAE_APPS: mktmp("r29-apps2") }, body);
  expect(fresh.indexOf("初回の起動だけ、macOS が Kangae Bar を調べます")).toBeLessThan(fresh.indexOf("OPEN-CALLED"));
  expect(fresh.match(/OPEN-CALLED/g)!.length).toBe(1);
});
