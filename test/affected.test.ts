import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { affected, HEAVY, testFiles } from "../tools/affected.ts";

const { unit, e2e } = testFiles();

test("src/lease.ts を変えると lease.test.ts が出て、読まない test は出ない", () => {
  const hit = affected(["src/lease.ts"], unit);
  expect(hit).toContain("test/lease.test.ts");
  expect(hit).toContain("test/w8fix.test.ts"); // lease を import している別の片の test
  expect(hit).toContain("test/w8b.test.ts"); // 間接（lease を名指さず、src の別 file 経由）
  expect(hit).not.toContain("test/groups.test.ts"); // lease を（間接にも）読まない
});

test("extension/panel.js は readFileSync で読む test にも効く・test 自身の変更も拾う", () => {
  expect(affected(["extension/panel.js"], unit)).toContain("test/w8g.test.ts");
  expect(affected(["test/web.test.ts"], unit)).toEqual(["test/web.test.ts"]);
  expect(affected(["README.md"], unit)).toEqual([]);
});

test("load が高くても unit を回す（load の門を戻すと「回さない」になって赤）", () => {
  const bin = mktmp("kangae-up");
  writeFileSync(join(bin, "uptime"), "#!/bin/sh\necho ' 10:00  up 1 day, load averages: 341.00 300.00 250.00'\n", { mode: 0o755 });
  const r = Bun.spawnSync([process.execPath, "tools/affected.ts", "--files", "test/groups.test.ts"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const out = r.stdout.toString();
  expect(out).toContain("load(1m)=341.00");
  expect(out).toMatch(/PASS {2}test\/groups\.test\.ts/);
  expect(r.exitCode).toBe(0);
}, 60_000);

test("重い *.test.ts は unit に入らず、名前だけ出る側に居る（HEAVY から外すと赤）", () => {
  const dir = join(import.meta.dir);
  for (const h of Object.keys(HEAVY)) {
    expect(unit).not.toContain(h);
    expect(e2e).toContain(h);
  }
  for (const h of ["test/affectedhook.test.ts", "test/review10.test.ts"]) expect(e2e).toContain(h); // commit の hook で git / 常駐を何度も起こす物
  expect(unit).toContain("test/groups.test.ts"); // 軽い物は今まで通り unit
  // binary を compile して起こす test は、表に書き忘れると unit として回る
  const compiles = readdirSync(dir).filter((f) => f.endsWith(".test.ts") && f !== "affected.test.ts" && /--compile/.test(readFileSync(join(dir, f), "utf8")));
  for (const f of compiles) expect(Object.keys(HEAVY)).toContain(`test/${f}`);
});
