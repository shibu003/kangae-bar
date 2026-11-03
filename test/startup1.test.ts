// startup-1: host / CLI の起動（引数で終わるだけでも）で AI SDK（@ai-sdk/*・ai）を読まない。読むのは鍵の口が実際に呼ばれる時だけ（190〜350ms・compiled で CPU 0.6s → 0.4s）
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const loadsSdk = (mod: string) => {
  const r = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(join(root, mod))}); console.log(Object.keys(require.cache).some((k) => /@ai-sdk|node_modules\\/ai\\//.test(k)))`], { cwd: root, env: { ...process.env, KANGAE_HOME: mktmp("su1") } }); // 試験の下では owner の home を指す既定を resolvePath が拒む
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString().trim() === "true";
};

test("main.ts と keys.ts を読んでも AI SDK は読まれない（負の対照: 静的 import に戻すと赤）", () => {
  expect(loadsSdk("src/keys.ts")).toBe(false);
  expect(loadsSdk("src/main.ts")).toBe(false);
}, 60_000);

test("鍵の口が呼ばれる時に読む SDK は、遅延 import で解決できる（パッケージ名の変更で黙って壊れない）", async () => {
  for (const m of ["@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/google", "ai"]) expect(Object.keys(await import(m)).length, m).toBeGreaterThan(0);
  const { createAnthropic } = await import("@ai-sdk/anthropic"), { generateText } = await import("ai");
  expect(typeof createAnthropic).toBe("function");
  expect(typeof generateText).toBe("function");
});
