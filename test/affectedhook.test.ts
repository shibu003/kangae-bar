// affected-hook: kangae-sora の git commit で affected の unit が回り、実物の赤なら止まる
// 使い捨ての git repo に tools/affected.ts と .githooks を写して、本物の `git commit` を打つ
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(30000);
const SRC = resolve(import.meta.dir, "..");
let dir: string;
// 親が git hook の中だと GIT_DIR 等が入っている。外さないと使い捨て repo ではなく本物の repo に commit する
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))) as Record<string, string>;
// 作者は config でなく env で渡す（repo の config に user.* を書くと affected の見張りが「共有 config の書き換え」と読む）
const who = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (args: string[], extra: Record<string, string> = {}) => {
  if (args[0] === "git" && args[1] !== "-C") args = ["git", "-C", dir, ...args.slice(1)]; // cwd に頼らず使い捨ての dir を指す
  // 重い所は tools/serial.ts の直列 lock の下（hook-serial）。試験の lock は使い捨ての dir の中（本物の ~/.kangae の lock を取り合わない）
  const p = Bun.spawnSync(args, { cwd: dir, env: { ...cleanEnv(), ...who, AFFECTED_TIMEOUT_SEC: "3", KANGAE_AFFECTED_LOCK: join(dir, ".affected.lock"), ...extra } });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};
const put = (f: string, s: string) => {
  mkdirSync(join(dir, f, ".."), { recursive: true });
  writeFileSync(join(dir, f), s);
};
const commit = (msg: string, extra: Record<string, string> = {}) => {
  sh(["git", "add", "src", "test", "docs"]);
  return sh(["git", "commit", "-m", msg], extra);
};

beforeEach(() => {
  dir = mktmp("affhook");
  mkdirSync(join(dir, "tools"));
  cpSync(join(SRC, "tools/affected.ts"), join(dir, "tools/affected.ts"));
  cpSync(join(SRC, "tools/rules-lint.ts"), join(dir, "tools/rules-lint.ts"));
  cpSync(join(SRC, "tools/test-timeout.ts"), join(dir, "tools/test-timeout.ts")); // affected.ts が import する（写し忘れると最初の commit が exit 1）
  cpSync(join(SRC, "tools/serial.ts"), join(dir, "tools/serial.ts")); // pre-commit が重い所を serial.ts の下で回す（hook-serial・a16f276）
  cpSync(join(SRC, ".githooks"), join(dir, ".githooks"), { recursive: true });
  mkdirSync(join(dir, "docs/verify"), { recursive: true });
  put("src/a.ts", "export const a = () => 1;\n");
  put("test/a.test.ts", 'import { test, expect } from "bun:test";\nimport { a } from "../src/a.ts";\ntest("a", () => expect(a()).toBe(1));\n');
  sh(["git", "init", "-q"]);
  expect(sh(["git", "rev-parse", "--show-toplevel"]).out.trim().endsWith(dir.split("/").pop()!)).toBe(true);
  sh(["git", "config", "core.hooksPath", ".githooks"]);
  expect(commit("init").code).toBe(0);
});
// 試験の前後で本物の repo の共有 config が変わらないこと（GIT_DIR を継いだまま走っても）
const realCfg = () => {
  const common = Bun.spawnSync(["git", "-C", SRC, "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.toString().trim();
  return Bun.spawnSync(["git", "config", "--file", join(common, "config"), "--list"]).stdout.toString();
};
let before: string;
beforeEach(() => { before = realCfg(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); expect(realCfg()).toBe(before); });

test("src を壊す commit は止まり、何が赤かが出る", () => {
  put("src/a.ts", "export const a = () => 2;\n");
  const r = commit("break");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("FAIL  test/a.test.ts");
  expect(sh(["git", "log", "--oneline"]).out.trim().split("\n").length).toBe(1);
});

test("効く unit が通れば commit できる", () => {
  put("src/a.ts", "export const a = () => 1; // ok\n");
  const r = commit("fine");
  expect(r.code).toBe(0);
  expect(r.out).toContain("PASS  test/a.test.ts");
});

test("docs だけの commit では unit を回さない", () => {
  put("src/a.ts", "export const a = () => 3;\n"); // 作業ツリーでは赤い。だが index に載せない
  put("docs/x.md", "memo\n");
  sh(["git", "add", "docs/x.md"]);
  const r = sh(["git", "commit", "-m", "docs"]);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("test/a.test.ts");
});

test("時間切れは単独で再走し、それでも時間切れなら止めずに但し書き", () => {
  put("test/a.test.ts", 'import { test } from "bun:test";\nimport "../src/a.ts";\ntest("slow", async () => { await Bun.sleep(20000); }, 30000);\n');
  const r = commit("slow");
  expect(r.code).toBe(0);
  expect(r.out).toContain("時間切れ（混雑・止めない）");
  expect(r.out).toContain("但し書き");
}, 60000);

const addB = (body: string) => put("test/b.test.ts", `import { test, expect } from "bun:test";\nimport { a } from "../src/a.ts";\ntest("b", () => { ${body} });\n`);

test("まとめて回しても赤は赤: 赤い file だけ FAIL・通る file は PASS・1 回にまとめた印が出る", () => {
  addB("expect(a()).toBe(1);");
  put("src/a.ts", "export const a = () => 1; // two\n");
  expect(commit("two").out).toContain("まとめて 2 本");
  addB("expect(a()).toBe(99);");
  put("src/a.ts", "export const a = () => 1; // touch\n");
  const r = commit("red b");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("FAIL  test/b.test.ts");
  expect(r.out).toContain("PASS  test/a.test.ts");
});

test("まとめて回した中の遅い file だけ単独で再走して時間切れ・他は PASS で止めない", () => {
  addB("expect(a()).toBe(1);");
  put("test/a.test.ts", 'import { test } from "bun:test";\nimport "../src/a.ts";\ntest("slow", async () => { await Bun.sleep(20000); }, 30000);\n');
  const r = commit("slow one");
  expect(r.code).toBe(0);
  expect(r.out).toContain("時間切れ（混雑・止めない）  test/a.test.ts");
  expect(r.out).toContain("PASS  test/b.test.ts");
}, 90000);

test("逃げ道は 1 つで、理由が commit message に残る", () => {
  put("src/a.ts", "export const a = () => 2;\n");
  const r = commit("skip", { KANGAE_SKIP_AFFECTED: "混雑で測れない" });
  expect(r.code).toBe(0);
  expect(sh(["git", "log", "-1", "--format=%B"]).out).toContain("Skip-affected: 混雑で測れない");
});

test("決まり: 足した行が決まりに反すると止まり、KANGAE_SKIP_RULES の理由は commit message に残る", () => {
  put("test/k.test.ts", 'Bun.spawnSync(["pkill", "-f", "kangae"]);\n'); // rules-ok: 違反の例（使い捨ての repo に書く）
  const r = commit("kill");
  expect(r.code).toBe(1);
  expect(r.out).toContain("[shared-kill]");
  expect(commit("skip", { KANGAE_SKIP_RULES: "共有名の試験", KANGAE_SKIP_AFFECTED: "unit は無い" }).code).toBe(0);
  expect(sh(["git", "log", "-1", "--format=%B"]).out).toContain("Skip-rules: 共有名の試験");
});

test("負の対照: hook を外すと赤いまま通る", () => {
  sh(["git", "config", "--unset", "core.hooksPath"]);
  put("src/a.ts", "export const a = () => 2;\n");
  expect(commit("no hook").code).toBe(0);
});

test("GIT_DIR を継いだ親から走っても本物の config は変わらない", () => {
  const r = Bun.spawnSync(["git", "-C", dir, "commit", "--allow-empty", "-m", "x"], { env: { ...cleanEnv(), ...who, GIT_DIR: join(dir, ".git") } });
  expect(r.exitCode).toBe(0); // afterEach が本物の config の不変を見る
});

test("hook の中で回す試験に GIT_DIR / GIT_INDEX_FILE が漏れない（漏れると試験の子の git が本物の branch に commit する）", () => {
  put("test/a.test.ts", 'import { test, expect } from "bun:test";\nimport "../src/a.ts";\ntest("env", () => expect(Object.keys(process.env).filter((k) => k.startsWith("GIT_DIR") || k === "GIT_INDEX_FILE")).toEqual([]));\n');
  const r = commit("env");
  expect(r.out).toContain("PASS  test/a.test.ts");
  expect(r.code).toBe(0);
}, 90000);

test("見張り: 共有 config に core.bare=true か user.email が在ると affected が止まる", () => {
  const run = () => sh(["bun", "tools/affected.ts", "--list"]);
  expect(run().code).toBe(0);
  sh(["git", "config", "core.bare", "true"]);
  const r = run();
  expect(r.code).toBe(2);
  expect(r.out).toContain("共有の .git/config が書き換えられています: core.bare");
  sh(["git", "config", "core.bare", "false"]);
  sh(["git", "config", "user.email", "t@t"]);
  expect(run().out).toContain("user.email");
});
