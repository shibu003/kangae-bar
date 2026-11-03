// W57: 新しい版の初回の LaunchServices 起動は macOS の初回の検査（小さい窓）を伴う。install-bar.sh は人が居る今ここでその 1 回を済ませ、前に案内する。
// 実測と出典は docs/verify/w57/GATEKEEPER.md。人の ~/Applications・本物の home には触らない（temp の KANGAE_APPS・偽の open を PATH の先頭に）
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mktmp } from "./tmp.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000); // install-bar.sh を実際に通す（ditto・shasum・混んだ機械）

const root = join(import.meta.dir, "..");
const tmp = (p: string) => mktmp(`w57-${p}`);
const sh = (c: string, env: Record<string, string> = {}, input?: string) => {
  const r = Bun.spawnSync(["sh", "-c", c], { env: { ...process.env, ...env }, stdin: input === undefined ? "ignore" : Buffer.from(input) });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};
function dist() { // 配る形（review16 と同じ作り）: install-bar.sh の本文と、file:// の置き場の偽の zip
  const d = tmp("dist"), app = join(d, "s", "Kangae Bar.app", "Contents");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "Info.plist"), "<plist/>");
  for (const a of ["x64", "arm64"]) expect(sh(`ditto -c -k '${d}/s' '${d}/KangaeBar-${a}.zip'`).code).toBe(0);
  const sha = sh(`shasum -a 256 '${d}/KangaeBar-x64.zip' | cut -d' ' -f1`).out.trim();
  const body = readFileSync(join(root, "scripts/install-bar.sh"), "utf8").replaceAll("@SHA_x64@", sha).replaceAll("@SHA_arm64@", sha);
  return { base: `file://${d}`, body };
}
// 偽の open: 呼ばれたら「OPEN-CALLED <引数>」を標準出力に出す（script の出力と同じ順に並ぶ）
function fakeOpen() {
  const bin = tmp("bin");
  writeFileSync(join(bin, "open"), '#!/bin/sh\necho "OPEN-CALLED $*"\n');
  chmodSync(join(bin, "open"), 0o755);
  writeFileSync(join(bin, "pgrep"), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, "pgrep"), 0o755); // 前の Bar が動いていない形（本物の機械の KangaeBar に左右されない・review29）
  return bin;
}

test("W57 install-bar.sh: 最初の起動の前に「初回だけ macOS が調べる・窓が出ても待つ・2 回目からは出ない」を出し、その後で open を 1 回（前面に出さない旗なしで）打つ", () => {
  const { base, body } = dist();
  const apps = tmp("apps"), bin = fakeOpen();
  const r = sh("sh", { KANGAE_BASE: base, KANGAE_APPS: apps, PATH: `${bin}:${process.env.PATH}` }, body);
  expect(r.code, r.out).toBe(0);
  const notice = r.out.indexOf("初回の起動だけ、macOS が Kangae Bar を調べます");
  const open = r.out.indexOf("OPEN-CALLED");
  expect(notice).toBeGreaterThan(-1);
  expect(open).toBeGreaterThan(notice); // 案内が先・起動が後
  expect(r.out).toContain("2 回目からは出ません");
  expect(r.out.match(/OPEN-CALLED/g)!.length).toBe(1);
  expect(r.out).toContain(`OPEN-CALLED ${apps}/Kangae Bar.app`); // 旗なし（-g / -j を付けない＝人が居る今に済ませる・panel も出る）
  expect(r.out).not.toMatch(/OPEN-CALLED -/);
});

test("W57 install-bar.sh の silent（KANGAE_NO_OPEN）: 起こさず、「最初の起動は人が画面の前に居る時に 1 度だけ」を出す", () => {
  const { base, body } = dist();
  const apps = tmp("apps"), bin = fakeOpen();
  const r = sh("sh", { KANGAE_BASE: base, KANGAE_APPS: apps, KANGAE_NO_OPEN: "1", PATH: `${bin}:${process.env.PATH}` }, body);
  expect(r.code, r.out).toBe(0);
  expect(r.out).not.toContain("OPEN-CALLED");
  expect(r.out).toContain("人が画面の前に居る時に Kangae Bar を 1 度だけ開いてください");
  expect(r.out).not.toContain("初回の起動だけ、macOS が Kangae Bar を調べます");
});

test("W57 手順書と実測の文書: RUN.md は『新版の最初の起動は人が居る時に 1 度・GK evaluateScanResult を見てから』を言い、GATEKEEPER.md は出典と実測の表を持つ", () => {
  const run = readFileSync(join(root, "docs/verify/exp1/RUN.md"), "utf8");
  for (const w of ["初回の検査", "人が画面の前に居る時に 1 度だけ", "evaluateScanResult", "front-read が赤になる"]) expect(run).toContain(w);
  const g = readFileSync(join(root, "docs/verify/w57/GATEKEEPER.md"), "utf8");
  for (const w of ["support.apple.com/guide/security/gatekeeper-and-runtime-protection", "eclecticlight.co/2026/08/11", "eclecticlight.co/2023/07/05", "GK performScan", "spctl --assess", "直 exec"]) expect(g).toContain(w);
  for (const f of ["run1.txt", "run2.txt", "exp.sh", "tiny.swift"]) expect(readFileSync(join(root, "docs/verify/w57", f), "utf8").length).toBeGreaterThan(20);
  // 実測の生の記録に、この文書の主張（初見は検査が走る・2 回目は走らない）の根拠がある
  const raw = readFileSync(join(root, "docs/verify/w57/run1.txt"), "utf8");
  expect(raw).toMatch(/=== A-fresh-open[\s\S]*GK performScan/);
  expect(raw.split("=== A-second-open")[1]!.split("=== B-after-spctl")[0]).not.toContain("GK performScan");
});
