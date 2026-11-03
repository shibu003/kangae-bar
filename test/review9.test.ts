// review9: gitguard の見張りが読み落としていた形（core.bare の別表記・config.worktree・include）と、spawnDaemon が minimal env に親の env 全部を足していた漏れ
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitGuard } from "../tools/affected.ts";
import { spawnDaemon } from "./spawn-daemon.ts";

const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as Record<string, string>;
const mk = () => {
  const d = mktmp("r9");
  const g = (...a: string[]) => Bun.spawnSync(["git", "-C", d, ...a], { env });
  g("init", "-q"); g("commit", "-q", "--allow-empty", "-m", "i");
  return { d, g };
};
test("gitGuard: 使い捨て repo が綺麗なら通る", () => { expect(gitGuard(mk().d)).toBeNull(); });
for (const v of ["true", "True", "yes", "on", "1"]) {
  test(`gitGuard: core.bare=${v} で止まる`, () => { const { d, g } = mk(); g("config", "core.bare", v); expect(gitGuard(d)).toContain("core.bare"); });
}
test("gitGuard: core.bare=false は止めない", () => { const { d, g } = mk(); g("config", "core.bare", "false"); expect(gitGuard(d)).toBeNull(); });
test("gitGuard: config.worktree の user.email で止まる", () => { const { d, g } = mk(); g("config", "extensions.worktreeConfig", "true"); g("config", "--worktree", "user.email", "a@b"); expect(gitGuard(d)).toContain("user.email"); });
test("gitGuard: include 経由の user.name で止まる", () => { const { d, g } = mk(); writeFileSync(join(d, "inc"), "[user]\n\tname = z\n"); g("config", "include.path", "../inc"); expect(gitGuard(d)).toContain("user.name"); });
test("spawnDaemon: env を絞って渡した子に、親の env が漏れない", async () => {
  process.env.ZZ_R9 = "leak";
  const p = spawnDaemon(["sh", "-c", "echo [$ZZ_R9]"], { env: { PATH: process.env.PATH }, stdout: "pipe" });
  const out = await new Response(p.stdout as ReadableStream).text();
  delete process.env.ZZ_R9;
  expect(out.trim()).toBe("[]");
});
