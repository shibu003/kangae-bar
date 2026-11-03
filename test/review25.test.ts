// review25: orphan-lock（f0501a2）の攻撃。e2e-lock.sh の番犬を group ごと止める直しが、(1) 非対話 sh で効くか (2) 他人の lock / 子を巻き込まないか (3) 3 つの終わり方の後で孤児が 0 か
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTimeoutMs } from "../tools/test-timeout.ts";
import { alive, dogOf, until, waitNap } from "./e2e-lock-util.ts";

const M = testTimeoutMs() / 30_000; // 混雑の倍率（load 770 で 10・番犬の sleep が生まれるまで・刈られるまでの待ちと、時間切れの秒を同じ倍率で伸ばす）
const lock = join(import.meta.dir, "../tools/e2e-lock.sh");
const mkL = () => join(mktmp("r25"), "lock");
const env = (L: string, x: Record<string, string> = {}) => ({ ...process.env, E2E_LOCK: L, E2E_LOCK_GRACE: "2", ...x });

test("review25-1 非対話の sh で set -m が効く: 子は自分の group の頭（pgid == pid）・script とは別 group", async () => {
  const L = mkL();
  const p = Bun.spawn(["sh", lock, "sh", "-c", 'echo "$$ $(ps -o pgid= -p $$ | tr -d " ")"; ps -o pgid= -p $PPID | tr -d " "'], { env: env(L), stdout: "pipe", stderr: "ignore" });
  const [self, parentPg] = (await new Response(p.stdout).text()).trim().split("\n");
  const [pid, pgid] = self!.split(" ");
  expect(pgid).toBe(pid); // 子は group の頭
  expect(parentPg).not.toBe(pgid);
}, 60_000);

test("review25-2 他人の lock を待っている間に止められても、持ち主の子・番犬・lock には触らない", async () => {
  const L = mkL();
  const a = Bun.spawn(["sh", lock, "sleep", "40"], { env: env(L, { E2E_TIMEOUT_SEC: "7401" }), stdout: "ignore", stderr: "ignore" });
  const napA = await waitNap(a.pid); // 数えるのは A の番犬の sleep の pid だけ（機械全体の 7401 秒の sleep は数えない）
  expect(await until(() => Number(readFileSync(join(L, "pgid"), "utf8") || 0) > 1, 10_000)).toBe(true);
  const pgidA = Number(readFileSync(join(L, "pgid"), "utf8"));
  expect(alive(pgidA) && napA > 0 && alive(napA)).toBe(true); // 対照: A の子と番犬は居る
  const b = Bun.spawn(["sh", lock, "sleep", "1"], { env: env(L, { E2E_TIMEOUT_SEC: "7402" }), stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(1500);
  b.kill("SIGTERM"); await b.exited;
  await Bun.sleep(500);
  expect(alive(pgidA)).toBe(true);
  expect(alive(napA)).toBe(true);
  expect(existsSync(join(L, "pid"))).toBe(true);
  expect(Number(await Bun.file(join(L, "pid")).text())).toBe(a.pid);
  a.kill("SIGTERM"); await a.exited; // 後始末: 孤児 0
  expect(await until(() => !alive(napA) && !alive(pgidA), 5000)).toBe(true);
  expect(existsSync(L)).toBe(false);
}, 60_000);

test("review25-3 終わり方 3 つ（正常・時間切れ・TERM を無視する子の時間切れ）の後で、孤児の sleep が 0・lock が外れる", async () => {
  const L = mkL();
  const gate = join(mktmp("r25"), "go");
  const go = async (sec: string, cmd: string[], want: number) => {
    const p = Bun.spawn(["sh", lock, ...cmd], { env: env(L, { E2E_TIMEOUT_SEC: sec }), stdout: "ignore", stderr: "ignore" });
    const napPid = await waitNap(p.pid); // 走っている間に、自分の番犬の sleep の pid を控える
    expect(napPid).toBeGreaterThan(0);
    writeFileSync(gate, ""); // 正常終了の子はここで終わる（混んだ機械では番犬が生まれるまで数秒かかる＝固定の長さの子では先に終わってしまう）
    expect(await p.exited).toBe(want);
    expect(await until(() => !alive(napPid) && !existsSync(L), 5000 * M)).toBe(true); // 孤児 0・lock が外れる
  };
  const f = join(mktmp("r25"), "child");
  await go("7411", ["sh", "-c", `while [ ! -e ${gate} ]; do sleep 0.2; done`], 0); // 正常（番犬が居る間に終わる）
  await go(String(12 * M), ["sleep", String(40 * M)], 124); // 時間切れ
  await go(String(12 * M), ["sh", "-c", `trap '' TERM; sleep ${40 * M} & echo $! > ${f}; wait`], 124); // TERM を無視 → 番犬の KILL か release の KILL で刈る
  expect(await until(() => existsSync(f) && !alive(Number(readFileSync(f, "utf8"))), 5000 * M)).toBe(true);
}, 120_000 * M);

test("review25-4 script が KILL で死んで番犬が残っても、次の持ち主の lock に timedout を書いて偽の 124 にしない", async () => {
  const L = mkL();
  const a = Bun.spawn(["sh", lock, "sleep", "40"], { env: env(L, { E2E_TIMEOUT_SEC: "4" }), stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(1200);
  const g = Number(await Bun.file(join(L, "pgid")).text());
  process.kill(a.pid, "SIGKILL"); await a.exited; // trap の効かない死に方（番犬は残る）
  process.kill(-g, "SIGKILL"); // 子の group も居なくする＝lock は stale になる
  await Bun.sleep(300);
  const t0 = Date.now();
  const b = Bun.spawn(["sh", lock, "sleep", "8"], { env: env(L), stdout: "ignore", stderr: "ignore" }); // 番犬の時間切れ（4 秒）をまたいで正常に終わる B
  const code = await b.exited;
  expect(Date.now() - t0).toBeGreaterThan(5000); // 対照: 番犬が鳴る時刻をまたいだ
  expect(code).toBe(0); // 偽の 124 になっていない
}, 60_000);
