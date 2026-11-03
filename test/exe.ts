// 試験が書いた実行 file（fake の claude / chrome / bw / open）を起こせる形にする 1 か所（holes-26）。chmodSync(p, 0o755) の代わりに呼ぶ。
// 1) 隔離の印（com.apple.quarantine）が付いていたら起こす前に理由つきで throw（ASP が殺す物を黙って待たない）
// 2) 新しい inode の初回 exec は syspolicyd の評価を待つ（load 280 で 2〜7.7 秒・holes-26 実測）。
//    ここで 1 回起こして評価を済ませ、その待ちを試験の締切（WAIT_MS 等）に数えさせない
import { mktmp } from "./tmp.ts";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function quarantined(path: string): boolean {
  return Bun.spawnSync(["/usr/bin/xattr", "-p", "com.apple.quarantine", path], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

export function armExe(path: string): string {
  chmodSync(path, 0o755);
  if (quarantined(path)) throw new Error(`macOS が止めます（隔離の印 com.apple.quarantine が付いた実行 file: ${path}）`);
  const body = readFileSync(path, "utf8");
  if (!body.startsWith("#!")) return path;
  const nl = body.indexOf("\n");
  const sh = /\/(ba|z)?sh\s*$/.test(body.slice(0, nl));
  writeFileSync(path, body.slice(0, nl + 1) + (sh ? '[ -n "$KANGAE_EXE_WARM" ] && exit 0' : "if (process.env.KANGAE_EXE_WARM) process.exit(0);") + "\n" + body.slice(nl + 1));
  Bun.spawnSync([path], { env: { ...process.env, KANGAE_EXE_WARM: "1" }, stdout: "ignore", stderr: "ignore" });
  return path;
}

// 1 つの試験 file で何度も作る同じ fake（bw など）は、process に 1 つだけ作って armExe する（holes-29）。
// 新しい inode ごとに xattr + 初回 exec が要り、load 280 で 1 回 3〜8 秒＝ループで 4 回作ると 30 秒の締切を割った。
// 中身の違い（作業 dir・log の置き場）は env（FAKEBW_DIR など）で渡す。script はその env を読む
const shared = new Map<string, string>();
export function sharedExe(name: string, script: string): string {
  let p = shared.get(name);
  if (!p || !existsSync(p)) { // 置いた folder が消えていたら（temp の掃除・別の run）作り直す
    p = join(mktmp("exe"), name); writeFileSync(p, script); armExe(p); shared.set(name, p); }
  return p;
}
