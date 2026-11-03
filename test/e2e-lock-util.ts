// e2e-lock の試験が共有する道具。**数えるのは自分が起こした script の子孫の pid だけ**（機械全体で「その秒数の sleep」を pgrep すると、同じ run の他 file・別 worktree の sleep を拾い、7 file 同時の run でだけ赤くなった＝review25 / tsc-58df960）。
import { testTimeoutMs } from "../tools/test-timeout.ts";
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const until = async (f: () => boolean, ms: number) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await Bun.sleep(50); return f(); };
type Row = { pid: number; ppid: number; cmd: string };
const rows = (): Row[] => Bun.spawnSync(["ps", "-axo", "pid,ppid,command"]).stdout.toString().split("\n").flatMap((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! }] : []; });
// script（pid）の番犬 subshell の pid と、その sleep の pid（まだ生まれていなければ 0）
export const dogOf = (scriptPid: number) => { const r = rows(); const dog = r.find((x) => x.ppid === scriptPid && /^sh .*e2e-lock/.test(x.cmd)); const nap = dog && r.find((x) => x.ppid === dog.pid && /^sleep /.test(x.cmd)); return { dog: dog?.pid ?? 0, nap: nap?.pid ?? 0 }; };
// 番犬の sleep が生まれるまで待って pid を返す（取った印の後の uptime が混むと数秒かかる）。生まれなければ 0
export const waitNap = async (scriptPid: number, ms = testTimeoutMs()) => { let nap = 0; await until(() => (nap = dogOf(scriptPid).nap) > 0, ms); return nap; };
