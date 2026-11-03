// lockpid: e2e-lock の番犬が、script の KILL 死後に鳴っても、もう自分の物でない group へ kill を送らない（pid の再利用で他人の group を殺しうる）。
// 実在の他人は殺さない: 「再利用された group」の代わりに、自分が起こした囮の子（script の本物の子）を使う。script が死んだ後なら、番犬はこの group に触ってはいけない。
// 数えるのは自分が起こした script の子だけ（機械全体の「その秒数の sleep」は数えない＝他の file・別 worktree の process を拾って 7 file 同時の run で赤くなった・review25 の件）
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alive, dogOf, until, waitNap } from "./e2e-lock-util.ts";

const LOCK = join(import.meta.dir, "../tools/e2e-lock.sh");
const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

test("lockpid: script が KILL で死んだ後、番犬が鳴っても囮の group は殺されない（親が居ない）", async () => {
  const d = mktmp("lockpid"), L = join(d, "lock");
  const p = Bun.spawn(["sh", LOCK, "sleep", "40"], { env: { ...process.env, E2E_LOCK: L, E2E_TIMEOUT_SEC: "8" }, stdout: "ignore", stderr: "ignore" }); // 8 秒: 混んだ機械では lock を取るまでに数秒かかる＝短いと kill の前に番犬が正当に鳴って「触られた」ように見える
  let decoy = 0;
  try {
    const pg = () => Number(readFileSync(join(L, "pgid"), "utf8") || 0); // file ができてから書かれるまでの間は空（0 を group とみなすと kill(-0) は自分の group で、いつも「生きている」＝偽の緑）
    expect(await until(() => existsSync(join(L, "pgid")) && pg() > 1, 5000)).toBe(true);
    decoy = pg();
    expect(groupAlive(decoy)).toBe(true);
    expect(await until(() => dogOf(p.pid).nap > 0, 30_000)).toBe(true); // 番犬が生まれるまで待つ（取った印の後の uptime が混むと数秒かかり、先に kill すると番犬が居なくて偽の緑になる）
    p.kill("SIGKILL"); await p.exited; // trap の走らない死に方＝番犬も囮も残る
    expect(groupAlive(decoy)).toBe(true);
    await Bun.sleep(16_000); // 番犬は起動から 8 秒で鳴る（鳴れば TERM が即届く）。短いと「まだ鳴っていない」ので緑が偽になる
    expect(groupAlive(decoy)).toBe(true); // 触られていない
    expect(existsSync(join(L, `timedout.${p.pid}`))).toBe(false); // 番犬は印も書かない
  } finally { if (decoy) try { process.kill(-decoy, "SIGKILL"); } catch {} rmSync(d, { recursive: true, force: true }); }
}, 90_000);

test("lockpid: 対照 — script が生きていて時間切れなら、従来どおり子の group を止めて 124", async () => {
  const d = mktmp("lockpid"), L = join(d, "lock");
  const p = Bun.spawnSync(["sh", LOCK, "sleep", "40"], { env: { ...process.env, E2E_LOCK: L, E2E_TIMEOUT_SEC: "2" }, stdout: "ignore", stderr: "ignore" });
  expect(p.exitCode).toBe(124);
  rmSync(d, { recursive: true, force: true });
}, 60_000);

test("lockpid: 外に同じ秒数の sleep が居ても、数えるのは自分の番犬の pid だけ（囮の sleep に影響されない）", async () => {
  const d = mktmp("lockpid"), L = join(d, "lock");
  const decoy = Bun.spawn(["sleep", "7401"], { stdout: "ignore", stderr: "ignore" }); // 外の同じ秒数
  const p = Bun.spawn(["sh", LOCK, "sleep", "40"], { env: { ...process.env, E2E_LOCK: L, E2E_TIMEOUT_SEC: "7401" }, stdout: "ignore", stderr: "ignore" });
  try {
    const nap = await waitNap(p.pid);
    expect(nap).toBeGreaterThan(0);
    expect(nap).not.toBe(decoy.pid); // 囮を自分の番犬と取り違えない
    p.kill("SIGTERM"); await p.exited; // release 経由で止める
    expect(await until(() => !alive(nap), 5000)).toBe(true); // 自分の番犬は刈られた
    expect(alive(decoy.pid)).toBe(true); // 囮は触られず、判定にも入らない
  } finally { decoy.kill("SIGKILL"); rmSync(d, { recursive: true, force: true }); }
}, 60_000);
