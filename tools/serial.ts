// pre-commit の重い所（affected の unit + tsc）を、同時に 1 commit だけ回す直列 lock（hook-serial）。runner の e2e-lock とは別の軽い lock（runner の 12 分の JOB に commit を待たせない）。
// 使い方: bun tools/serial.ts -- <command…>   command の exit code をそのまま返す。lock が取れなければ（待つ上限 KANGAE_AFFECTED_WAIT_MS・既定 5 分）command を回さず「混んでいる」と言って 0 で通す＝commit は止めない（但し書き）。
// lock = mkdir（原子的）の folder + pid。hook が落ちて残った lock は、pid が死んでいれば次の人が掃除する。置き場は KANGAE_AFFECTED_LOCK（既定 ~/.kangae/affected.lock・試験は temp）。
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOCK = process.env.KANGAE_AFFECTED_LOCK ?? join(homedir(), ".kangae/affected.lock");
const WAIT_MS = Number(process.env.KANGAE_AFFECTED_WAIT_MS ?? 300_000);
const STALE_MS = 30 * 60_000; // hook が 30 分生きていたら（pid が生きていても）見捨てる

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
const holder = () => { try { return Number(readFileSync(join(LOCK, "pid"), "utf8").trim()) || 0; } catch { return 0; } };
const ageMs = () => { try { return Date.now() - statSync(LOCK).mtimeMs; } catch { return 0; } };

// 取れたら true。持ち主が死んでいる（pid が無い・死んでいる）lock は掃除して取り直す。pid を書く前の一瞬（pid 無し）は、5 秒までは「取ったばかり」と見る
function tryTake(): boolean {
  try { mkdirSync(dirname(LOCK), { recursive: true }); mkdirSync(LOCK); writeFileSync(join(LOCK, "pid"), String(process.pid)); return true; }
  catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    const pid = holder();
    const dead = pid ? !alive(pid) || ageMs() > STALE_MS : ageMs() > 5000;
    if (dead) rmSync(LOCK, { recursive: true, force: true });
    return false;
  }
}
const release = () => { if (holder() === process.pid) rmSync(LOCK, { recursive: true, force: true }); };

const a = process.argv.slice(2), cmd = a[0] === "--" ? a.slice(1) : a; // bun は `--` を落とす事がある＝あっても無くても読める
if (!cmd.length) { console.error("使い方: bun tools/serial.ts -- <command…>"); process.exit(2); }

const t0 = Date.now();
let got = tryTake(), told = false;
while (!got && Date.now() - t0 < WAIT_MS) {
  if (!told) { console.error(`affected: 他の commit の確認が回っているので順番を待っています（最大 ${Math.round(WAIT_MS / 1000)} 秒・pid ${holder() || "?"}）`); told = true; }
  await Bun.sleep(1000);
  got = tryTake();
}
if (!got) { console.error(`affected: 混んでいる（${Math.round(WAIT_MS / 1000)} 秒待っても順番が来なかった）＝この commit は unit と tsc を回さずに通す（但し書き: 型と unit は未確認 → 後で runner に頼む）`); process.exit(0); }

for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => { release(); process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[s]); });
process.on("exit", release);
const p = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const code = await p.exited;
release();
process.exit(code);
