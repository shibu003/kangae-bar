import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// holes-25: e2e-lock は子の group が居なくなってから・自分の lock の時だけ外す。待つ側は group の生死も見る
const LOCK = join(import.meta.dir, "../tools/e2e-lock.sh");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const until = async (f: () => boolean, ms: number) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await Bun.sleep(50); return f(); };
const mk = () => { const d = mktmp("e2elock"); return { d, L: join(d, "lock") }; };
// TERM を無視して KILL まで居座る偽の子
// orphan-lock: 試験が起こした子の group を必ず刈る（TERM を無視する子が suite の後も残り、pipe を握って runner の出力が止まった）
const reap = (d: string) => { try { process.kill(-Number(readFileSync(join(d, "child"), "utf8")), "SIGKILL"); } catch {} };
const stubborn = (d: string) => ["sh", "-c", `trap '' TERM; echo $$ > ${d}/child; while :; do sleep 0.2; done`];

test("holes25: TERM を無視する子が居る間は lock を外さない・KILL で居なくなってから外す", async () => {
  const { d, L } = mk();
  const p = Bun.spawn(["sh", LOCK, ...stubborn(d)], { env: { ...process.env, E2E_LOCK: L, E2E_LOCK_GRACE: "3" }, stdout: "ignore", stderr: "ignore" });
  try {
    expect(await until(() => existsSync(join(d, "child")), 5000)).toBe(true);
    const child = Number(readFileSync(join(d, "child"), "utf8"));
    p.kill("SIGTERM"); // 外の手で止める（w14-1 の chain を止めた時）
    await Bun.sleep(1500);
    expect(existsSync(L)).toBe(true); // 子がまだ居る＝lock は残る
    expect(groupAlive(child)).toBe(true);
    expect(await until(() => !existsSync(L), 8000)).toBe(true); // 3 秒の猶予の後 KILL → 居なくなってから外す
    expect(groupAlive(child)).toBe(false);
  } finally { try { p.kill("SIGKILL"); } catch {} reap(d); rmSync(d, { recursive: true, force: true }); }
});

test("holes25: lock が他人の物に付け替わっていたら、終わる時に消さない", async () => {
  const { d, L } = mk();
  const p = Bun.spawn(["sh", LOCK, "sleep", "30"], { env: { ...process.env, E2E_LOCK: L, E2E_LOCK_GRACE: "2" }, stdout: "ignore", stderr: "ignore" });
  try {
    expect(await until(() => existsSync(join(L, "pgid")), 5000)).toBe(true);
    writeFileSync(join(L, "pid"), String(process.pid)); // 他人（この test）の lock に付け替わった
    p.kill("SIGTERM");
    await p.exited;
    expect(existsSync(L)).toBe(true);
  } finally { try { p.kill("SIGKILL"); } catch {} try { process.kill(-Number(readFileSync(join(L, "pgid"), "utf8")), "SIGKILL"); } catch {} rmSync(d, { recursive: true, force: true }); }
});

test("holes25: 待つ側は、持ち主の pid が死んでいても子の group が生きている間は lock を外さない", async () => {
  const { d, L } = mk();
  const orphan = Bun.spawn(["sleep", "4"], { detached: true, stdout: "ignore", stderr: "ignore" }); // 自分の group の残り物
  const dead = Bun.spawnSync(["true"]); void dead;
  mkdirSync(L); writeFileSync(join(L, "pid"), "99999999"); writeFileSync(join(L, "pgid"), String(orphan.pid));
  const t0 = Date.now();
  try {
    const p = Bun.spawn(["sh", LOCK, "true"], { env: { ...process.env, E2E_LOCK: L }, stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(2500);
    expect(p.exitCode).toBeNull(); // まだ待っている
    expect(await p.exited).toBe(0);
    expect(Date.now() - t0).toBeGreaterThan(3500); // orphan が居なくなってから取れた
    expect(alive(orphan.pid)).toBe(false);
  } finally { try { orphan.kill(); } catch {} rmSync(d, { recursive: true, force: true }); }
}, 20000);
