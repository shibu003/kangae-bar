import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

// owner の本物の置き場（常駐の保存場所・bar・mods・nodes・Chrome の profile）。試験の下でここに解決されたら throw する（2026-10-08 leases.json が試験に書き換えられた → holes-9 は KANGAE_HOME だけ → holes-12 で全部）
export const ownerDirs = (home = homedir()): string[] => [
  join(home, "Library/Application Support/Kangae"),
  join(home, ".kangae"),
  join(home, "Documents/考えの空"),
  join(home, "Library/Application Support/Kangae/nodes"),
  join(home, "Library/Application Support/Google/Chrome"),
];

// agent の作業場所（nodes）の既定。~/Documents は macOS の TCC 保護の folder で、署名の無い kangae の CLI が bar を responsible とする連鎖の中でそこを cwd に動くと、起動直後の openat が TCC の照会で止まる（EXP-1 再走 run2・W25b の実測）。TCC の対象外の場所に置く
export const nodesDefault = (home = homedir()): string => join(home, "Library/Application Support/Kangae/nodes");
export const OLD_NODES = (home = homedir()): string => join(home, "Documents/考えの空");

// 旧い既定（~/Documents/考えの空）から新しい既定へ、常駐の起動時に 1 回・冪等で移す。KANGAE_NODES_DIR が指定されていれば触らない・新が在れば何もしない・旧が無ければ新を作るだけ。
// 移すのは rename だけ（同一 volume・コピーも削除もしない）で、旧の場所には新を指す symlink を残す（旧 path を読む物が壊れない）。symlink が置けなければ rename を戻す。試験（NODE_ENV=test）は home を渡さない限り何もしない
export function migrateNodesDir(home?: string, env: Record<string, string | undefined> = process.env, link: (target: string, path: string) => void = symlinkSync): "moved" | "created" | "exists" | "skipped" {
  if (env.KANGAE_NODES_DIR) return "skipped";
  if (home === undefined && env.NODE_ENV === "test") return "skipped";
  const h = home ?? homedir(), neu = nodesDefault(h), old = OLD_NODES(h);
  const st = (p: string) => { try { return lstatSync(p); } catch { return null; } };
  if (st(neu)) return "exists";
  try {
    mkdirSync(dirname(neu), { recursive: true });
    const o = st(old);
    if (o?.isDirectory() && !o.isSymbolicLink()) {
      renameSync(old, neu);
      try { link(neu, old); } catch { try { renameSync(neu, old); } catch {} return "skipped"; }
      return "moved";
    }
    mkdirSync(neu, { recursive: true });
    return "created";
  } catch { return "skipped"; }
}

// 書き込み先になる既定の path を持つ環境変数と、その既定。試験では preload が temp に置く（BAR は KANGAE_SOCK の有無で意味が変わるので置かない）
export const PATH_KEYS = ["KANGAE_HOME", "KANGAE_NODES_DIR", "KANGAE_MODS", "KANGAE_CHROME_DIR", "KANGAE_PROFILE", "CHROMIUM_APP", "KANGAE_BAR"] as const;

// 在る path は実の綴り（symlink・大文字小文字・正規化）に直してから比べる。無ければ resolve のまま（metadata だけ見る・中身は読まない）
const real = (p: string): string => {
  const r = resolve(p);
  try { return realpathSync.native(r); } catch { const up = dirname(r); return up === r ? r : join(real(up), basename(r)); } // 無い末尾は、在る所までの実の綴りに足す
};
export const pointsAtOwner = (p: string, home = homedir()): boolean => {
  const rs = [resolve(p), real(p)];
  return ownerDirs(home).some((d) => [d, real(d)].some((o) => rs.some((r) => r === o || r.startsWith(o + sep))));
};

// 既定の path の解決は全部ここ。試験（NODE_ENV=test）の下で owner の場所に解決されたら throw。製品の起動では env があればそれ・無ければ既定
export function resolvePath(key: string, fallback: () => string, env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const v = env[key] || fallback();
  if (env.NODE_ENV === "test" && pointsAtOwner(v, home)) throw new Error(`試験の下で ${key} が owner の場所を指す: ${key} を temp に（bunfig.toml の preload を確認）`);
  return v;
}

// preload 用: 無い・owner を指す PATH_KEYS を temp に置き換える（BAR は置き換えのみ・無ければ触らない）
export function scrubOwnerEnv(env: Record<string, string | undefined> = process.env, home = homedir(), tmp = () => mkdtempSync(join(tmpdir(), "kangae-test-"))): void {
  const base = tmp();
  for (const k of PATH_KEYS) {
    const v = env[k];
    if (!(v ? pointsAtOwner(v, home) : k !== "KANGAE_BAR")) continue;
    env[k] = join(base, k.toLowerCase());
    if (k !== "CHROMIUM_APP" && k !== "KANGAE_BAR") mkdirSync(env[k]!, { recursive: true }); // 置き場は在る前提（旧 preload は mkdtemp で作っていた）
  }
}
