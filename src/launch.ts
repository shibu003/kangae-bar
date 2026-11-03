import { createHash } from "node:crypto";
import { resolvePath } from "./paths.ts";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EXT_ORIGIN } from "./main.ts";
import { pollUntil } from "./wait.ts";

const EXT_ID = EXT_ORIGIN.slice("chrome-extension://".length, -1);

export const HOST_NAME = "app.kangae_sora.host";
const root = join(import.meta.dir, "..");

function mergePrefs(file: string, patch: Record<string, unknown>) {
  let cur: Record<string, any> = {};
  try {
    cur = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  const set = (o: Record<string, any>, path: string[], v: unknown) => {
    const k = path.shift()!;
    if (path.length === 0) o[k] = v;
    else set((o[k] ??= {}), path, v);
  };
  for (const [k, v] of Object.entries(patch)) set(cur, k.split("."), v);
  writeFileSync(file, JSON.stringify(cur));
}

// 新しいタブの「設定が変わりました」の吹き出しで「元に戻す」が押されると、拡張が無効（disable_reasons）のまま残り、
// 次からは標準の新しいタブになる。Chromium が動いていない時だけ、その記録を消して読み込み直させる
// SingletonLock は「host-pid」を指す symlink。pid が生きていれば、その profile は使用中
function running(profile: string): boolean {
  try {
    const pid = Number(readlinkSync(join(profile, "SingletonLock")).split("-").pop());
    // 再起動の後は古い lock が残り、同じ pid を別の process が使っている事がある
    return Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="]).stdout.toString().includes("Chromium");
  } catch {
    return false;
  }
}

export function healExtension(profile: string): boolean {
  const file = join(profile, "Default/Secure Preferences");
  try {
    if (running(profile)) return false;
    const d = JSON.parse(readFileSync(file, "utf8"));
    const e = d.extensions?.settings?.[EXT_ID];
    if (!e?.disable_reasons?.length && e?.state !== 0) return false;
    delete d.extensions.settings[EXT_ID];
    delete d.protection?.macs?.extensions?.settings?.[EXT_ID];
    writeFileSync(file, JSON.stringify(d));
    return true;
  } catch {
    return false;
  }
}

// 版が同じだと Chromium は service worker を登録し直さず、古い sw.js を使い続ける。
// 中身の hash を版の 4 つ目に入れた写しを読ませ、中身が変わった時だけ写し直す
export function stageExtension(src: string, dest: string): string {
  const h = createHash("sha256");
  for (const f of (readdirSync(src, { recursive: true }) as string[]).sort()) {
    const b = (() => { try { return readFileSync(join(src, f)); } catch { return null; } })();
    if (b) h.update(f).update(b);
  }
  const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  m.version = `${m.version.split(".").slice(0, 3).join(".")}.${parseInt(h.digest("hex").slice(0, 4), 16)}`;
  try {
    if (JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8")).version === m.version) return dest;
  } catch {}
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  writeFileSync(join(dest, "manifest.json"), JSON.stringify(m, null, 2));
  return dest;
}

// Chromium は、拡張の中身（版）が変わっても、前に登録した service worker を使い続ける事がある
// （owner の profile で実測: 9/29 03:11 の sw.js が 10/1 まで動き、side panel のアイコン開き・全 port への配りが効かなかった。
// 置き場を変えても同じ。profile の「Service Worker」を消すと、新しい sw.js で登録し直された）。
// 拡張の版が前の起動と違う時だけ、Chromium が止まっている間に sw の登録を消す（web の site の sw も消えるが、次に開けば登録し直される）
export function resetWorkers(profile: string, version: string): boolean {
  const mark = join(profile, "kangae-sw-version");
  let last = "";
  try { last = readFileSync(mark, "utf8"); } catch {}
  if (last === version || running(profile)) return false;
  rmSync(join(profile, "Default", "Service Worker"), { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  writeFileSync(mark, version);
  return true;
}

export type LaunchOpts = {
  app: string; // Chromium.app
  profile: string; // --user-data-dir
  hostBinary: string; // 中継役になる binary（絶対 path）
  extensionDir: string; // 元の拡張。profile の隣に写してから読ませる
  mockKeychain?: boolean; // 試験だけ。本番では付けない（keychain の窓を先に言う）
  debugPort?: number; // --open だけ。試験は extraArgs で自分の port を渡す
  extraArgs?: string[];
  env?: Record<string, string>;
};

export function prepare(o: LaunchOpts) {
  healExtension(o.profile);
  mkdirSync(join(o.profile, "Default"), { recursive: true });
  mkdirSync(join(o.profile, "NativeMessagingHosts"), { recursive: true });
  // 「既定にする」の確認は出さず、取り込んだ bookmark が見えるよう bookmark bar を ON にする
  mergePrefs(join(o.profile, "Default/Preferences"), {
    "browser.check_default_browser": false,
    "performance_tuning.high_efficiency_mode.state": 1,
    "bookmark_bar.show_on_all_tabs": true,
    credentials_enable_service: true,
    "profile.password_manager_enabled": true,
  });
  // 起動のたびに書き直す（binary の場所が変わっても追随する）
  writeFileSync(
    join(o.profile, "NativeMessagingHosts", `${HOST_NAME}.json`),
    JSON.stringify({ name: HOST_NAME, description: "Kangae", path: o.hostBinary, type: "stdio", allowed_origins: [EXT_ORIGIN] }, null, 2),
  );
}

// debugPort がある時だけ 127.0.0.1 の remote debugging（Chromium の既定。外へは開かない）。mock keychain は試験だけ
export function chromiumArgs(o: LaunchOpts, ext: string): string[] {
  return [
    `--user-data-dir=${o.profile}`,
    `--load-extension=${ext}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(o.debugPort != null ? [`--remote-debugging-port=${o.debugPort}`] : []),
    ...(o.mockKeychain ? ["--use-mock-keychain"] : []),
    ...(o.extraArgs ?? []),
  ];
}

export function launch(o: LaunchOpts) {
  prepare(o);
  const ext = stageExtension(o.extensionDir, join(dirname(o.profile), "extension"));
  resetWorkers(o.profile, JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")).version);
  const bin = join(o.app, "Contents/MacOS/Chromium");
  if (!existsSync(bin)) throw new Error(`Chromium が見つかりません: ${o.app}`);
  const args = chromiumArgs(o, ext);
  const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true, env: { ...process.env, ...o.env } as Record<string, string> });
  proc.unref(); // 起こした側が終わっても Chromium は生き続ける
  return proc;
}

// 入口から開く。起こす時は窓を出さずに起こし、拡張が読み込まれてから新しいタブの窓を開く
// （そのまま起こすと、最初の窓が拡張より先にできて標準の新しいタブになる）。動いていれば新しい窓だけ
// url があれば（--session）、動いていればその url を新しいタブに、起こす時は窓の代わりにその url を開く
export async function openKangae(o: LaunchOpts, url?: string) {
  if (running(o.profile)) return launch(url ? { ...o, extraArgs: [...(o.extraArgs ?? []), url] } : o);
  const first = launch({ ...o, extraArgs: [...(o.extraArgs ?? []), "--no-startup-window"] });
  // 回数でなく締切（遅い機械でも 30 秒は待つ）。越えたら黙って次へ進まず理由つきで止める
  const ms = Number(process.env.KANGAE_LAUNCH_WAIT_MS) || 30_000;
  if (!(await pollUntil(() => running(o.profile), ms, 250))) throw new Error(`Chrome が起きませんでした（${Math.round(ms / 1000)} 秒待った・混んでいる時はもう一度）`);
  await Bun.sleep(1500);
  launch({ ...o, extraArgs: [url ?? "chrome://newtab/"] });
  return first;
}

export const CHROMIUM_APP = resolvePath("CHROMIUM_APP", () => join(homedir(), "Library/Application Support/Kangae/Chromium.app"));

if (import.meta.main) {
  launch({
    app: CHROMIUM_APP,
    profile: resolvePath("KANGAE_PROFILE", () => join(homedir(), "Library/Application Support/Kangae/profile")),
    hostBinary: join(root, "dist/kangae"),
    extensionDir: join(root, "extension"),
  });
}
