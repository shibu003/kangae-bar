// W60e: 登録 GUI を前に出さずに起こせるかの実測の道具（docs/verify/w60e/measure.sh）の、人が居る間は測らない門と、測りの組み立て。
// 実機の測り自体は HIDIdle 120 秒以上の時に実験役が走らせる（docs/verify/w60e/RESULT.md）。ここでは偽の open / front-watch / gui を使い、本物の app は 1 つも起こさない
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(120_000);

const root = join(import.meta.dir, "..");
const script = join(root, "docs/verify/w60e/measure.sh");
let D: string;
beforeEach(() => { D = realpathSync(mktmp("w60e")); });
afterEach(() => rmSync(D, { recursive: true, force: true }));
const stub = (name: string, body: string) => { const f = join(D, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
function run(env: Record<string, string>) {
  const bin = join(D, "bin"); mkdirSync(bin, { recursive: true });
  const log = join(D, "open.log");
  writeFileSync(join(bin, "open"), `#!/bin/sh\necho "OPEN $*" >> '${log}'\n`); chmodSync(join(bin, "open"), 0o755);
  const fw = stub("front-watch", `echo "start front=Orca"`), gui = stub("gui", "exit 0");
  const out = join(D, "out");
  const r = Bun.spawnSync(["bash", script, fw, gui, out], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, W60E_RUN_S: "1", W60E_PREP_S: "0", ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out, opens: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [], result: existsSync(join(out, "RESULT.txt")) ? readFileSync(join(out, "RESULT.txt"), "utf8") : "" };
}

test("W60e 門: 人が居る（HIDIdle 120 秒未満）なら、何も起こさず・wrapper も作らず「未測」で終わる（exit 3）", () => {
  const r = run({ W60E_IDLE: "5" });
  expect(r.code).toBe(3);
  expect(r.result).toContain("未測: 人が居る");
  expect(r.opens).toEqual([]);
  expect(existsSync(join(r.out, "Wrap.app"))).toBe(false);
});

test("W60e 測りの組み立て: 人が居ない（500 秒）なら 4 case（direct / wrapper × activate / polite）を順に走らせ、wrapper は open -g -j -n で起こす・各 case の前面の結果が RESULT に並ぶ", () => {
  const r = run({ W60E_IDLE: "500" });
  expect(r.code).toBe(0);
  for (const c of ["direct-activate", "wrapper-activate", "direct-polite", "wrapper-polite"]) expect(r.result).toContain(`== ${c}（`);
  expect(r.result.match(/前面は変わらなかった/g)!.length).toBe(4); // 偽の front-watch は変化を出さない
  expect(r.result).toContain("DONE");
  expect(r.opens.length).toBe(3); // 準備の 1 回 + wrapper の 2 case
  for (const o of r.opens) expect(o).toMatch(/^OPEN -g -j -n .*Wrap\.app --args /);
  expect(r.opens[1]).toContain("--activate");
  expect(r.opens[2]).not.toContain("--activate");
});

test("W60e 人が居るかの読みは、既定で待たない（MAXWAIT 0）・待つのは実験役が秒数を付けた時だけ", () => {
  const s = readFileSync(script, "utf8");
  expect(s).toContain('MAXWAIT="${MAXWAIT:-0}"');
  expect(s).toContain("120");
  expect(readFileSync(join(root, "docs/verify/w60e/RESULT.md"), "utf8")).toContain("未測");
});
