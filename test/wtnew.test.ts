// wtnew: tools/wt-new.sh が作った worktree は、そのまま startup1 などが通る（node_modules が入っている）。手で worktree を作って bun install を忘れる偽の赤を無くす
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(240_000);

const root = join(import.meta.dir, "..");
let wt: string, name: string;
const git = (...a: string[]) => Bun.spawnSync(["git", "-C", root, ...a], { stdout: "pipe", stderr: "pipe" });
const make = (extra: Record<string, string> = {}, n = name) => Bun.spawnSync(["sh", join(root, "tools/wt-new.sh"), n], { env: { ...Bun.env, KANGAE_WT_DIR: wt, KANGAE_WT_BASE: "HEAD", ...extra } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
const startup1 = (cwd: string) => Bun.spawnSync(["bun", "test", "test/startup1.test.ts"], { cwd, stdout: "pipe", stderr: "pipe" });
beforeEach(() => { wt = realpathSync(mktmp("wtnew")); name = `wtnewtest-${Math.random().toString(36).slice(2, 8)}`; });
afterEach(() => { git("worktree", "remove", "--force", join(wt, name)); git("branch", "-D", `impl/${name}`); rmSync(wt, { recursive: true, force: true }); });

test("wtnew: 作った worktree で startup1 が通る（node_modules が入っている）・branch は impl/<名前>", () => {
  const r = make();
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const path = r.stdout.toString().trim();
  expect(path).toBe(join(wt, name));
  expect(existsSync(join(path, "node_modules/@ai-sdk"))).toBe(true);
  expect(Bun.spawnSync(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim()).toBe(`impl/${name}`);
  const t = startup1(path);
  expect(t.exitCode, t.stdout.toString().slice(-600) + t.stderr.toString().slice(-600)).toBe(0);
});

test("wtnew 負の対照: node_modules を入れないと startup1 は赤（＝この script が潰している物）", () => {
  const r = make({ KANGAE_WT_NO_INSTALL: "1" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect(existsSync(join(wt, name, "node_modules"))).toBe(false);
  expect(startup1(join(wt, name)).exitCode).not.toBe(0);
});

test("wtnew: 既にある名前・branch には触らない（何もせず止まる）・不正な名前は断る", () => {
  expect(make().exitCode).toBe(0);
  const again = make();
  expect(again.exitCode).toBe(1);
  expect(again.stderr.toString()).toContain("既にあります");
  git("worktree", "remove", "--force", join(wt, name)); // branch だけ残す
  const b = make();
  expect(b.exitCode).toBe(1);
  expect(b.stderr.toString()).toContain(`branch impl/${name} は既にあります`);
  for (const bad of ["", "Foo", "a b", "-x", "a/b", "x".repeat(33)]) expect(make({}, bad).exitCode, bad).toBe(2);
});
