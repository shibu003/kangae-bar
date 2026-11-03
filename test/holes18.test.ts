// holes-18: 試験が起こす子（常駐）の env に、preload が temp にした PATH_KEYS 7 つ全部が渡る。外すと赤くなる事は env を素手で組んだ子で示す。
import { expect, test } from "bun:test";
import { PATH_KEYS } from "../src/paths.ts";
import { childEnv, spawnDaemon } from "./spawn-daemon.ts";

const dump = `node -e 'console.log(JSON.stringify(${JSON.stringify([...PATH_KEYS])}.map(k=>process.env[k])))'`;

test("env を素手で組んでも（PATH だけ）、子の PATH_KEYS は親の temp と同じ値で入る", async () => {
  const p = spawnDaemon(["sh", "-c", dump], { env: { PATH: process.env.PATH }, stdout: "pipe" });
  const got = JSON.parse(await new Response(p.stdout as ReadableStream).text()) as (string | null)[];
  const want = PATH_KEYS.map((k) => process.env[k] ?? null);
  expect(got).toEqual(want);
  expect(want.filter(Boolean).length).toBeGreaterThanOrEqual(6); // BAR は KANGAE_SOCK の都合で無い事がある・他は preload が必ず temp にしている
  for (const v of want.filter(Boolean)) expect(v).toMatch(/kangae-test-/);
});

test("childEnv は extra が勝つ・PATH_KEYS は親から落ちない", () => {
  const e = childEnv({ KANGAE_HOME: "/x" });
  expect(e.KANGAE_HOME).toBe("/x");
  expect(e.KANGAE_NODES_DIR).toBe(process.env.KANGAE_NODES_DIR);
});

test("根: env を渡さない Bun.spawn は起動時の環境を継ぐ（preload が temp にした値が届かない）→ 常駐を起こす口は env を必ず渡す", () => {
  process.env.ZZ_H18 = "set";
  const bare = Bun.spawnSync(["sh", "-c", "echo $ZZ_H18"]).stdout.toString().trim();
  const given = Bun.spawnSync(["sh", "-c", "echo $ZZ_H18"], { env: childEnv() as Record<string, string> }).stdout.toString().trim();
  delete process.env.ZZ_H18;
  expect(given).toBe("set");
  expect(bare).toBe(""); // Bun 1.3.14 の実測。変わったらこの根の説明を直す
});

test("試験の中で main.ts を --daemon で起こす Bun.spawn は env を渡している", async () => {
  const bad: string[] = [];
  for (const f of new Bun.Glob("test/*.ts").scanSync(".")) {
    if (f.endsWith("holes18.test.ts")) continue;
    for (const l of (await Bun.file(f).text()).split("\n")) if (/Bun\.spawn\(/.test(l) && /main\.ts/.test(l) && /--daemon/.test(l) && !/env:/.test(l)) bad.push(`${f}: ${l.trim().slice(0, 80)}`);
  }
  expect(bad).toEqual([]);
});
