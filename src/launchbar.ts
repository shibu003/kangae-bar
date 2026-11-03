// スマホの「Kangae を開く」: 常駐は生きているのに Bar（画面）が閉じている時、Bar を裏で起こす。
// `open -g`（前面を取らない）+ `--relaunch`（窓を出さない・bar/main.swift が panel を出さずに常駐だけ確かめる起動）。
// Mac の設定は変えない（LoginItem / LaunchAgent は作らない）。shell を渡さない・引数は固定（スマホから来た文字は 1 字も入らない）。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BarProbe = { app: string | null; running(): boolean; open(app: string): boolean };
export type BarResult = "running" | "starting" | "helperUnavailable";

export function barApp(env: Record<string, string | undefined> = process.env, home = homedir()): string | null {
  return [env.KANGAE_BAR_APP, join(home, "Applications/Kangae Bar.app"), "/Applications/Kangae Bar.app"].find((p): p is string => !!p && existsSync(p)) ?? null;
}

export function realProbe(env: Record<string, string | undefined> = process.env, home = homedir()): BarProbe {
  const app = barApp(env, home);
  return {
    app,
    running: () => !!app && Bun.spawnSync(["pgrep", "-f", `${app}/Contents/MacOS/`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0, // 常駐は Contents/Resources/bin なので当たらない
    open: (a) => Bun.spawnSync(["open", "-g", "-a", a, "--args", "--relaunch"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0,
  };
}

// 開いている = running（何もしない）・起こした = running か starting（3 秒見て、まだなら starting）・入っていない / 起こせない = helperUnavailable
export async function launchBar(p: BarProbe = realProbe(), waitMs = 3000): Promise<BarResult> {
  if (!p.app) return "helperUnavailable";
  if (p.running()) return "running";
  if (!p.open(p.app)) return "helperUnavailable";
  for (let t = 0; t < waitMs; t += 100) {
    await Bun.sleep(100);
    if (p.running()) return "running";
  }
  return "starting";
}
