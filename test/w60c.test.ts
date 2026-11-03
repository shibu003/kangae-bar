// W60c: ops.jsonl の回転と追記を別 process と直列にする（review28 で「別 process が同時に回すと 1 世代早く落ちる」を未対処にした物）
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { appendOps, recentFor } from "../src/opsview.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(120_000);
let dir: string;
beforeEach(() => { dir = mktmp("w60c"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const all = (f: string) => [f, `${f}.1`, `${f}.2`].filter(existsSync).flatMap((x) => readFileSync(x, "utf8").trim().split("\n").map((l) => JSON.parse(l)));

test("W60c 別 process 6 本が同じ file へ回転しながら足す: 上限に収まる量なら 1 行も落ちない（回転が 2 度送りにならない）・lock は残らない", async () => {
  const f = join(dir, "ops.jsonl"), script = join(dir, "w.ts");
  writeFileSync(script, `import { appendOps } from ${JSON.stringify(join(import.meta.dir, "../src/opsview.ts"))};
const w = Number(process.argv[2]);
for (let i = 0; i < 100; i++) appendOps(${JSON.stringify(f)}, JSON.stringify({ at: i, w, v: "v".repeat(60), owner: "s:1" }), 30000);
process.exit(0);`);
  const ps = Array.from({ length: 6 }, (_, w) => Bun.spawn(["bun", script, String(w)], { stdout: "pipe", stderr: "pipe" }));
  await Promise.all(ps.map((p) => p.exited));
  const rows = all(f);
  expect(rows.length).toBe(600); // 600 行 × 約 90 byte = 54KB・上限 30KB × 3 世代に収まる
  expect(new Set(rows.map((r) => `${r.w}:${r.at}`)).size).toBe(600);
  expect(readdirSync(dir).filter((x) => x.includes("lock"))).toEqual([]);
  expect(existsSync(`${f}.1`)).toBe(true); // 回転は実際に起きた
});

test("W60c 回転の lock: 別の process が回している間は回さず足すだけ（記録は失わない）・死んだ持ち主の lock は奪って回す・pid を書く前の作りたての lock は奪わない", () => {
  const f = join(dir, "ops.jsonl");
  writeFileSync(f, "X".repeat(500) + "\n");
  writeFileSync(`${f}.lock`, `${process.pid} ${Date.now()}`); // 生きている持ち主（自分）が回している最中
  const t0 = Date.now();
  appendOps(f, JSON.stringify({ at: 1 }), 100);
  expect(existsSync(`${f}.1`)).toBe(false); // 回していない（lock を待ちきれず足しただけ）
  expect(readFileSync(f, "utf8")).toContain('{"at":1}');
  expect(Date.now() - t0).toBeLessThan(5000);
  rmSync(`${f}.lock`);
  writeFileSync(`${f}.lock`, `99999999 ${Date.now()}`); // 居ない pid の lock
  appendOps(f, JSON.stringify({ at: 2 }), 100);
  expect(existsSync(`${f}.1`)).toBe(true);
  expect(existsSync(`${f}.lock`)).toBe(false);
  rmSync(`${f}.1`);
  writeFileSync(f, "X".repeat(500) + "\n"); writeFileSync(`${f}.lock`, ""); // 作りたて（pid 未記入）
  appendOps(f, JSON.stringify({ at: 3 }), 100);
  expect(existsSync(`${f}.1`)).toBe(false);
  rmSync(`${f}.lock`);
  writeFileSync(`${f}.lock`, `${process.pid} ${Date.now() - 60_000}`); // 生きた pid でも 5 秒を過ぎた lock
  appendOps(f, JSON.stringify({ at: 4 }), 100);
  expect(existsSync(`${f}.1`)).toBe(true);
});

test("W60c lock の中で大きさを見直す: 先に回した人が居れば 2 度目は回さない（回したばかりの .1 を .2 へ送らない）", () => {
  const f = join(dir, "ops.jsonl");
  writeFileSync(f, "X".repeat(500) + "\n"); writeFileSync(`${f}.1`, "OLD1\n");
  appendOps(f, JSON.stringify({ at: 1 }), 100); // 1 度目: file → .1・古い .1 → .2
  expect(readFileSync(`${f}.2`, "utf8")).toBe("OLD1\n");
  const first = readFileSync(`${f}.1`, "utf8");
  appendOps(f, JSON.stringify({ at: 2 }), 100); // 新しい file はまだ小さい: 回らない
  expect(readFileSync(`${f}.1`, "utf8")).toBe(first);
  expect(readFileSync(`${f}.2`, "utf8")).toBe("OLD1\n");
  expect(recentFor(f, "s:1").length).toBe(0);
});
