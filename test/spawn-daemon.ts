import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATH_KEYS } from "../src/paths.ts";
import { pollUntil } from "../src/wait.ts";

// 試験が常駐（--daemon）を起こす口はここ 1 つ。親（この process）の pid を渡し、親が居なくなったら常駐が自分で止まる（src/main.ts watchParent）
// stderr が "ignore" / 未指定なら temp file に落とし、waitDaemon が起きなかった時の 1 行に入れる
// 子の env の土台: preload が temp にした PATH_KEYS（7 つ）を、呼ぶ側が env を自前で組んでも必ず渡す（足りないと子の既定が owner の場所に解決され、試験の守りが throw する・review5-2）
const pathKeysOf = () => Object.fromEntries(PATH_KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
export const childEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ...process.env,
  ...pathKeysOf(),
  ...extra,
});

export function spawnDaemon(cmd: string[], opts: { env?: Record<string, string | undefined> } & Record<string, any> = {}) {
  let errLog: string | undefined;
  if (opts.stderr === undefined || opts.stderr === "ignore") {
    errLog = join(tmpdir(), `kangae-daemon-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.err`);
    const fd = openSync(errLog, "a");
    opts = { ...opts, stderr: fd };
    setTimeout(() => closeSync(fd), 0); // 子が継いだ後は親の fd は要らない
  }
  const p = Bun.spawn(cmd, { ...opts, env: { ...(opts.env ? pathKeysOf() : {}), ...(opts.env ?? process.env), KANGAE_PARENT_PID: String(process.pid) } } as any);
  (p as any).errLog = errLog;
  return p;
}

// 実の締切（Date.now 基準）で待つ。固定回数の sleep は load が高いと 10 秒では足りず、後ろの readFileSync が ENOENT になる（holes-13）
export async function waitFor(what: string, ok: () => unknown | Promise<unknown>, ms = 60_000, detail: () => string = () => ""): Promise<void> {
  if (!(await pollUntil(async () => !!(await ok()), ms, 100))) throw new Error(`${what} が ${ms / 1000} 秒で揃わなかった${detail()}`);
}

// 起こした常駐の bar.json と socket を（指定した分だけ）両方待つ。越えたら常駐の生死と最後の stderr を 1 行に入れて throw
export async function waitDaemon(proc: { exitCode: number | null; errLog?: string }, o: { bar?: string; sock?: string; log?: string; ms?: number }): Promise<void> {
  const files = [o.bar, o.sock].filter(Boolean) as string[];
  const detail = () => {
    let err = "";
    try { err = readFileSync(o.log ?? proc.errLog ?? "", "utf8").trim().split("\n").slice(-3).join(" / ").slice(-300); } catch {}
    return `（${files.map((f) => `${f.split("/").pop()} ${existsSync(f) ? "有" : "無"}`).join("・")}・常駐 ${proc.exitCode === null ? "生きている" : `終わった exit ${proc.exitCode}`}・stderr「${err || "空"}」）`;
  };
  await waitFor("常駐", () => files.every(existsSync), o.ms ?? 60_000, detail);
}
