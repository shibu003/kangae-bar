// hook-serial: pre-commit の重い所（affected の unit + tsc）を同時に 1 commit だけ回す直列 lock（tools/serial.ts）。temp の lock・実際に bun を 2 本同時に起こす
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
let top: string, lock: string, log: string;
beforeEach(() => { top = realpathSync(mktmp("hs")); lock = join(top, "affected.lock"); log = join(top, "log.txt"); });
afterEach(() => rmSync(top, { recursive: true, force: true }));

const serial = (cmd: string[], env: Record<string, string> = {}) =>
  Bun.spawn(["bun", join(root, "tools/serial.ts"), "--", ...cmd], { env: { ...process.env, KANGAE_AFFECTED_LOCK: lock, ...env }, stdout: "pipe", stderr: "pipe" });
const text = async (p: ReturnType<typeof serial>) => (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
const job = (tag: string, ms = 1200) => ["sh", "-c", `echo ${tag}-start >> '${log}'; sleep ${ms / 1000}; echo ${tag}-end >> '${log}'`];

test("2 本同時に走らせても直列になる（start・end・start・end）・終わると lock は残らない", async () => {
  const a = serial(job("a")), b = serial(job("b"));
  await Promise.all([a.exited, b.exited]);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  expect(lines).toHaveLength(4);
  expect(lines[0]!.replace("start", "")).toBe(lines[1]!.replace("end", "")); // 同じ tag の start の次に end（交互にならない）
  expect(lines[2]!.replace("start", "")).toBe(lines[3]!.replace("end", ""));
  expect(lines[0]!.slice(0, 1)).not.toBe(lines[2]!.slice(0, 1));
  expect(existsSync(lock)).toBe(false);
}, 30_000);

test("command の exit code をそのまま返す（失敗した commit は止まる）・失敗しても lock は残らない", async () => {
  const p = serial(["sh", "-c", "exit 3"]);
  expect(await p.exited).toBe(3);
  expect(existsSync(lock)).toBe(false);
});

test("hook が SIGKILL で落ちて lock が残っても、次の人が pid の死を見て掃除して回せる", async () => {
  const a = serial(job("a", 30_000));
  for (let i = 0; i < 100 && !existsSync(join(lock, "pid")); i++) await Bun.sleep(50);
  expect(existsSync(lock)).toBe(true);
  process.kill(a.pid, "SIGKILL"); // exit handler も走らない落ち方
  await a.exited;
  expect(existsSync(lock)).toBe(true); // 残った
  const pidA = Number(readFileSync(join(lock, "pid"), "utf8"));
  Bun.spawnSync(["pkill", "-P", String(pidA)]); // a の子の sleep を片付ける（名前では殺さない・親 pid だけ）
  const b = serial(job("b", 300));
  expect(await b.exited).toBe(0);
  expect(readFileSync(log, "utf8")).toContain("b-end");
  expect(existsSync(lock)).toBe(false);
}, 30_000);

test("待つ上限を過ぎても順番が来なければ『混んでいる』と言って command を回さずに 0 で通す（commit を止めない）", async () => {
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid)); // 生きている持ち主（この試験の process）
  const p = serial(job("c"), { KANGAE_AFFECTED_WAIT_MS: "1500" });
  const out = await text(p);
  expect(await p.exited).toBe(0);
  expect(out).toContain("混んでいる");
  expect(existsSync(log)).toBe(false); // command は回していない
  expect(readdirSync(lock)).toEqual(["pid"]); // 他人の lock は触らない
});

test("pre-commit は重い所を serial.ts の下で回す（逃げ道 KANGAE_NO_SERIAL で直接）・軽い検査は lock の外", () => {
  const pre = readFileSync(join(root, ".githooks/pre-commit"), "utf8"), heavy = readFileSync(join(root, ".githooks/pre-commit-heavy"), "utf8");
  expect(pre).toContain('exec bun "$root/tools/serial.ts" -- sh "$root/.githooks/pre-commit-heavy"');
  expect(pre).toContain("KANGAE_NO_SERIAL");
  expect(pre.indexOf("rules-lint.ts")).toBeLessThan(pre.indexOf("serial.ts")); // rules-lint と --guard は軽いので lock の前
  expect(pre).not.toContain("affected.ts\" --staged");
  expect(heavy).toContain('tools/affected.ts" --staged');
  expect(heavy).toContain("node_modules/.bin/tsc --noEmit");
});
