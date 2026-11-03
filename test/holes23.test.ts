// holes-23: 1 本あたりの締切は suite.ts / affected.ts が `bun test --timeout 30000` で渡す（bunfig の [test] timeout は読まれず、preload の setDefaultTimeout は最初の 1 file にしか効かない）
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reads } from "../tools/affected.ts";

const root = join(import.meta.dir, "..");
const slow = (d: string, n: string) => writeFileSync(join(d, `${n}.test.ts`), `import {test} from "bun:test"; test("${n}",async()=>{await Bun.sleep(5500)});`);

test("suite.ts: 何も指定しない 5.5 秒の test が 2 file とも通る（--timeout を外すと 5 秒で赤）", async () => {
  const d = mktmp("h23s");
  slow(d, "a"); slow(d, "b");
  const p = Bun.spawn(["bun", join(root, "tools/suite.ts"), join(d, "a.test.ts"), join(d, "b.test.ts")], { cwd: d, stdout: "pipe", stderr: "pipe" });
  await new Response(p.stdout).text(); await new Response(p.stderr).text();
  expect(await p.exited).toBe(0);
}, 60_000);

test("affected.ts: まとめて回す unit も同じ締切（--timeout を外すと 5 秒で FAIL）", async () => {
  const d = mktmp("h23a");
  mkdirSync(join(d, "tools")); mkdirSync(join(d, "test")); mkdirSync(join(d, "docs/verify"), { recursive: true });
  copyFileSync(join(root, "tools/affected.ts"), join(d, "tools/affected.ts"));
  copyFileSync(join(root, "tools/test-timeout.ts"), join(d, "tools/test-timeout.ts")); // affected.ts が import する
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")) as [string, string][]);
  const g = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: d, env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  mkdirSync(join(d, "test"), { recursive: true });
  slow(join(d, "test"), "a"); slow(join(d, "test"), "b");
  g("init", "-q", "-b", "impl/w1a"); g("add", "-A"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
  const p = Bun.spawn(["bun", "tools/affected.ts", "--files", "test/a.test.ts,test/b.test.ts"], { cwd: d, stdout: "pipe", stderr: "pipe", env });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  expect(out).toMatch(/PASS\s+test\/a\.test\.ts/);
  expect(await p.exited).toBe(0);
}, 90_000);

test("reads は同じ file の閉包を使い回す（同じ Set を返す）", () => {
  expect(reads("src/main.ts")).toBe(reads("src/main.ts"));
  expect(reads("src/main.ts").has("src/lease.ts")).toBe(true);
});
