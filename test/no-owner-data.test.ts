import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// 試験と運転 script は owner の本物のデータ（会話の DB・Chrome の profile）を読まない。読むと会話の中身が log に残り commit される（2026-10-07 dm.e2e が 34 本の log に書いた）
const OWNER = new RegExp("Application Support" + "/Kangae");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });

test("test/ と docs/verify の .ts は owner の常駐の保存場所（Library の Kangae）を読まない", () => {
  const root = join(import.meta.dir, "..");
  const hits = [...walk(join(root, "test")), ...walk(join(root, "docs/verify"))].filter((f) => OWNER.test(readFileSync(f, "utf8")));
  expect(hits).toEqual([]);
});

test("試験の下では owner の home を解決しない（KANGAE_HOME 無しは throw・製品の起動では既定が出る）", async () => {
  const { resolveHome } = await import("../src/main.ts");
  expect(() => resolveHome({ NODE_ENV: "test" })).toThrow();
  expect(resolveHome({ NODE_ENV: "test", KANGAE_HOME: "/x" })).toBe("/x");
  expect(resolveHome({})).toMatch(new RegExp("Application Support" + "/Kangae$"));
  expect(process.env.KANGAE_HOME).toMatch(/kangae-test-/); // preload が効いている
});

test("既定の path は全部 1 つの関数（resolvePath）を通る: 試験の下で owner を指すと throw・製品では既定のまま・preload が owner の値を置き換える", async () => {
  const { resolvePath, scrubOwnerEnv, ownerDirs, PATH_KEYS } = await import("../src/paths.ts");
  const H = "/Users/someone"; // 解決の関数だけを test する。本物の home の中身は読まない
  const ownerFallback: Record<string, string> = {
    KANGAE_HOME: join(H, "Library/Application Support" + "/Kangae"),
    KANGAE_NODES_DIR: join(H, "Documents/考えの空"),
    KANGAE_MODS: join(H, ".kangae/mods"),
    KANGAE_CHROME_DIR: join(H, "Library/Application Support/Google/Chrome"),
    KANGAE_PROFILE: join(H, "Library/Application Support" + "/Kangae/profile"),
    CHROMIUM_APP: join(H, "Library/Application Support" + "/Kangae/Chromium.app"),
    KANGAE_BAR: join(H, ".kangae/bar.json"),
  };
  expect(Object.keys(ownerFallback).sort()).toEqual([...PATH_KEYS].sort()); // 新しい既定を足したらここに足す
  for (const [k, d] of Object.entries(ownerFallback)) {
    expect(() => resolvePath(k, () => d, { NODE_ENV: "test" }, H)).toThrow(); // 既定が owner
    expect(() => resolvePath(k, () => "/t", { NODE_ENV: "test", [k]: d }, H)).toThrow(); // 外から owner が入った
    expect(resolvePath(k, () => "/t", { NODE_ENV: "test", [k]: "/tmp/x" }, H)).toBe("/tmp/x");
    expect(resolvePath(k, () => d, {}, H)).toBe(d); // 製品の起動
    const env: Record<string, string | undefined> = { NODE_ENV: "test", [k]: d };
    scrubOwnerEnv(env, H, () => "/private/tmp/claude-501/scrub-t");
    expect(env[k]).not.toContain(H);
  }
  const env: Record<string, string | undefined> = { NODE_ENV: "test" };
  scrubOwnerEnv(env, H, () => "/private/tmp/claude-501/scrub-t");
  expect(env.KANGAE_BAR).toBeUndefined(); // BAR は KANGAE_SOCK 無しの時だけ既定が要る
  expect(ownerDirs(H).length).toBe(5); // W26: nodes の新しい既定（Library の Kangae/nodes）を足した
  // src/ に owner の既定を直書きして env と ?? で繋ぐ道を足させない
  const root = join(import.meta.dir, "..");
  const raw = walk(join(root, "src")).filter((f) => !f.endsWith("paths.ts") && /\?\? join\((homedir\(\)|homeDir), "(Library\/Application Support|\.kangae|Documents)/.test(readFileSync(f, "utf8")));
  expect(raw).toEqual([]);
});
