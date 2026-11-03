// W55: 版。配る物は bun build の --define で process.env.KANGAE_BUILD に commit を焼く（scripts/dist-bar.sh）。焼いた後は実行時の環境変数では替わらない。source のまま動かす時は "dev"
export const VERSION: string = process.env.KANGAE_BUILD || "dev";

// `kangae version` の本文。bar = 常駐が書いた bar.json（port / token / pid / version）。alive = その pid が生きているか
export function versionReport(self: string, bar: { pid?: unknown; version?: unknown } | null, alive: boolean): string[] {
  const out = [`kangae ${self}`];
  if (!bar || typeof bar.pid !== "number") return [...out, "常駐: 起きていません（bar.json がありません）"];
  if (!alive) return [...out, `常駐: 起きていません（bar.json の pid ${bar.pid} は居ません）`];
  const d = typeof bar.version === "string" && bar.version ? bar.version : "不明（古い版で、版を返しません）";
  out.push(`常駐: ${d}（pid ${bar.pid}）`);
  if (d !== self) out.push(`版が違います（この kangae: ${self}・動いている常駐: ${d}）。Kangae Bar の「考」→「全部終わる」の後に開き直すと、新しい常駐に替わります`);
  return out;
}

// bar.json の pid が、まだ常駐か（review29）。pid が生きているだけでは、落ちた常駐の bar.json の pid を別の process が使い回した時に「起きています」と嘘を言う（再起動後が一番多い）。実行 file の名前（kangae・dev の bun）まで見る
export function isDaemonPid(pid: number, comm: (pid: number) => string = (p) => { const r = Bun.spawnSync(["ps", "-p", String(p), "-o", "comm="], { stdout: "pipe", stderr: "ignore" }); return r.exitCode === 0 ? r.stdout.toString().trim() : ""; }): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); } catch (e: any) { if (e?.code !== "EPERM") return false; }
  const n = comm(pid).split("/").pop() ?? "";
  return n === "kangae" || n === "bun" || n.startsWith("kangae-");
}
