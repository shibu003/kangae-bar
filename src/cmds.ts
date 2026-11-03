// W17a: 人が一度登録した command だけを agent が走らせる口（正本 docs/BRIEF-w17.md）。
// agent が決められるのは名前だけ。argv・cwd・env は人の登録（印つき）。shell を通さない。承認の card は lease.ts の asked 1 か所。
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir as readdirP } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

export type Cmd = { name: string; cwd: string; argv: string[]; timeoutSec: number; at: number; seal: string; network?: boolean; reads?: string[]; app?: boolean }; // app = 待たずに起こす GUI の型（kangae launch・W31a）。network = 通信を許す（人が --network で登録）・reads = 読みを戻す folder（人が --read で登録・書きは広げない）
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
export const TIMEOUT_DEFAULT = 600, TIMEOUT_MAX = 1800, OUT_MAX = 2 * 1024 * 1024;

const file = (home: string) => join(home, "commands.json");
// 印 = 動かす物の全部（mods.ts の宣言の印と同じ型）。書き換えると動かさない
// W17c-b: network / reads は付けた時だけ印に入る（付けない登録の印は今までと同じ＝前の登録が書き換えと見なされない）
export const sealOf = (c: Pick<Cmd, "name" | "cwd" | "argv" | "timeoutSec" | "network" | "reads" | "app">) => createHash("sha256").update(JSON.stringify([c.name, c.cwd, c.argv, c.timeoutSec, ...(c.network || c.reads?.length || c.app ? [!!c.network, c.reads ?? [], ...(c.app ? ["app"] : [])] : [])])).digest("hex");
// 人がターミナルで打つ時の kangae は、PATH に入っていない（installer は他人の shell の設定を書き換えない）ので、置き場のフルパスで案内する。bar 版 / 専用ブラウザ版のどちらの installer も、ここに symlink を置く
export const CLI = "~/.kangae/bin/kangae";
// W12-9: bar を入れた人にも ~/.kangae/bin/kangae を置く（installer を打ち直さなくても）。bar が起こす常駐（同梱の .app/Contents/Resources/bin/kangae）が起動時に呼ぶ。
// 置くのは「無い時」だけ。他人の file・向き先の生きている symlink は触らない。壊れた symlink は、向き先が同梱の kangae（app を移した跡）の時だけ直す。PATH・shell の設定は触らない
const BUNDLED = /\.app\/Contents\/Resources\/bin\/kangae$/;
export function ensureCliLink(home: string, exe: string): "linked" | "repaired" | "exists" | "skipped" {
  if (!BUNDLED.test(exe)) return "skipped"; // 開発の bun・dist/kangae からは置かない
  try {
    const dir = join(home, ".kangae", "bin"), link = join(dir, "kangae");
    let st: ReturnType<typeof lstatSync> | null = null;
    try { st = lstatSync(link); } catch {}
    if (st) {
      if (!st.isSymbolicLink() || existsSync(link)) return "exists"; // 他人の file・生きている symlink
      if (!BUNDLED.test(readlinkSync(link))) return "exists"; // 壊れているが、うちの物ではない
      unlinkSync(link);
      symlinkSync(exe, link);
      return "repaired";
    }
    mkdirSync(dir, { recursive: true });
    symlinkSync(exe, link);
    return "linked";
  } catch { return "skipped"; }
}
// agent に渡す kangae の path（claude の許す行・案内・AGENTS.md・system prompt が全部これ）。W24 の実測（docs/verify/w24/probe.md）: claude -p の許可は空白入りの path に当たらない
// （引用しても「requires approval」・\ で逃がすと「Contains backslash-escaped whitespace」）。bar 同梱の kangae（…/Kangae Bar.app/…）は空白入りなので、同じ実体を指す空白なしの ~/.kangae/bin/kangae（展開した絶対 path）を使う。無い・向き先が違う時は従来の path
export function agentBin(execPath: string, isCompiled: boolean, main: string, home = homedir()): string {
  const plain = isCompiled ? execPath : `${execPath} ${main}`;
  const spaced = /\s/.test(execPath) || (!isCompiled && /\s/.test(main));
  if (!spaced || !isCompiled) return plain; // 空白が無ければそのまま。開発の `bun main.ts` は空白入りでも symlink で包む手が無い
  try {
    ensureCliLink(home, execPath); // 無い時だけ・同梱の kangae の時だけ置く
    const link = join(home, ".kangae", "bin", "kangae");
    if (!/\s/.test(link) && existsSync(link) && realpathSync(link) === realpathSync(execPath)) return link;
  } catch {}
  return plain;
}
export const registerLine = (name = "build") => `${CLI} cmd-add ${name} --cwd <フォルダ> -- <実行する command>`;

export function loadCmds(home: string): Cmd[] {
  try {
    const j = JSON.parse(readFileSync(file(home), "utf8"));
    return Array.isArray(j?.items) ? j.items.filter((c: any) => c && typeof c.name === "string" && typeof c.cwd === "string" && Array.isArray(c.argv) && c.argv.every((a: unknown) => typeof a === "string")) : [];
  } catch { return []; }
}
const save = (home: string, items: Cmd[]) => {
  mkdirSync(home, { recursive: true });
  const tmp = `${file(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ items }, null, 2), { mode: 0o600 });
  renameSync(tmp, file(home));
};

// 登録した場所（cwd・読みを許す所）を 1 回開く。~/Downloads などの保護 folder は、常駐（Bar の下の責任 process）が最初に読む時に macOS が確認を出す。
// 人が居る「登録の瞬間と常駐の起動」に出し切り、agent の途中（open_app の stat）で出さない（W34）。確認の答えを待つ間も常駐は止まらない（非同期・読めなくても続ける）
export async function touchCmdDirs(home: string, readDir: (d: string) => Promise<unknown> = (d) => readdirP(d)): Promise<string[]> {
  const dirs = [...new Set(loadCmds(home).flatMap((c) => [c.cwd, ...(c.reads ?? [])]))];
  await Promise.all(dirs.map((d) => readDir(d).catch(() => {})));
  return dirs;
}

// W37: 編集器は agent が裏で開かない・app として登録もできない（上流 Zed は path を開くと自分の窓を前に出し、止める設定がない＝W34）。名前の表に加え、VS Code 系の fork は構造（.app の中の product.json）でも見る
const EDITOR_NAME = /^(zed( preview)?|visual studio code.*|vscodium|code|cursor|windsurf|antigravity.*|sublime( text| merge)?|textmate|bbedit|nova|atom|xcode|textedit|emacs|macvim|neovide|kate|fleet|intellij.*|pycharm.*|webstorm.*|clion.*|rider.*|goland.*|rubymine.*|phpstorm.*|datagrip.*|android studio.*)$/i;
const EDITOR_BUNDLE = /^(dev\.zed\.|com\.microsoft\.vscode|com\.todesktop\.230313mzl4w4u92|com\.sublimetext\.|com\.apple\.dt\.xcode|com\.apple\.textedit|com\.jetbrains\.|com\.panic\.nova|com\.barebones\.bbedit|com\.github\.atom|com\.exafunction\.windsurf|org\.vim\.macvim|org\.gnu\.emacs|com\.macromates\.textmate|com\.vscodium|com\.google\.antigravity)/i;
const vscodeLike = (appDir: string) => existsSync(join(appDir, "Contents/Resources/app/product.json")); // VS Code・Cursor・Antigravity など fork は同じ構造
export const isEditor = (name: string, bundle: string, home = homedir()) => {
  const n = name.trim();
  return EDITOR_NAME.test(n) || EDITOR_BUNDLE.test(bundle.trim()) || (n !== "" && !/[/\\:\x00-\x1f]/.test(n) && [`/Applications/${n}.app`, join(home, "Applications", `${n}.app`)].some(vscodeLike));
};
// 実行 file が編集器か（cmd-add --app / launch）: 実行 file の名前の表と、入っている .app の構造
export const editorExe = (exe: string) => isEditor(basename(exe), "") || (() => { const m = exe.match(/^(.*?\.app)\//); return !!m && vscodeLike(m[1]!); })();
// 登録する場所（agent が直接編集できる場所になる）は、肯定形で絞る: home の下で、home 直下の名前が「.」で始まらず Library / Applications でもない folder／/Volumes/<disk>/ の下の folder／この Mac の tmp の下だけ。
// それ以外（/ /Users /Applications /opt/homebrew /usr/local ~/.claude ~/.config ~/Library/LaunchAgents ~/Applications 鍵の場所 など）は、設定・LaunchAgent・brew・app の bundle を書き換えられるので断る
export const cwdTooWide = (d: string, home = homedir()) => {
  const h = real(home), under = (r: string, base: string) => r.startsWith(base.endsWith(sep) ? base : base + sep);
  if (under(d, h)) { const first = d.slice(h.length + 1).split(sep)[0] ?? ""; return first === "" || first.startsWith(".") || ["Library", "Applications"].includes(first) || SENSITIVE_HOME.some((x) => overlaps(d, join(h, x))); }
  if (under(d, "/Volumes")) return d.split(sep).filter(Boolean).length < 3; // /Volumes/<disk> そのものは広すぎる
  return !(under(d, real(tmpdir())) || under(d, "/private/tmp"));
};
// 人の登録。argv[0] は登録時に絶対 path へ解く（走る時に PATH で別の物に替わらない）。cwd は実在する folder の realpath
export function addCmd(home: string, name: string, cwdIn: string, argv: string[], timeoutSec = TIMEOUT_DEFAULT, at = Date.now(), opts: { network?: boolean; reads?: string[]; app?: boolean } = {}): { ok: true; cmd: Cmd } | { ok: false; hint: string } {
  if (!NAME_RE.test(name)) return { ok: false, hint: "名前は、英小文字・数字・「-」だけで 32 字までです。例: build" };
  if (!argv.length || argv.length > 64 || argv.some((a) => typeof a !== "string" || a.length > 500 || a.includes("\0"))) return { ok: false, hint: "実行する command が空か長すぎます（-- の後ろに、ターミナルで打つ形で書いてください。例: -- cmake --build build）" };
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > TIMEOUT_MAX) return { ok: false, hint: `--timeout は 1〜${TIMEOUT_MAX} 秒で指定してください（既定 ${TIMEOUT_DEFAULT} 秒）` };
  let cwd: string;
  try { cwd = realpathSync(cwdIn); if (!statSync(cwd).isDirectory()) throw 0; } catch { return { ok: false, hint: `--cwd の場所が見つかりません（${cwdIn}）。command を走らせるフォルダを指してください。例: --cwd ~/my-project` }; }
  if (cwdTooWide(cwd)) return { ok: false, hint: `--cwd ${cwdIn} は広すぎるか、秘密が入る場所（~/.ssh など）と重なります（agent がこの場所の file を直接編集できるようになるため）。project の folder だけを指してください。例: --cwd ~/my-project` };
  const exe = argv[0]!.includes("/") ? argv[0]! : Bun.which(argv[0]!, { PATH: MINIMAL_PATH }) ?? "";
  if (!exe.startsWith("/") || !existsSync(exe)) return { ok: false, hint: `「${argv[0]}」という command が見つかりません。フルパス（/ から始まる場所）で書くか、${MINIMAL_PATH} のどれかに入れてください` };
  const rd = checkReads(opts.reads ?? []);
  if (!rd.ok) return rd;
  const network = opts.network === true;
  const app = opts.app === true;
  if (app && editorExe(exe)) return { ok: false, hint: "編集器は app として登録できません（起こすと前に出て人の画面を奪います）。file の編集は run の場所（--cwd）の中で agent が直接行います。人が自分で開く分には構いません" };
  if (app) { // 待たずに起こす GUI（W31a）: 実行 file は在る・実行権のある 1 つの file。build の道具の「未対応」の表は当てない
    let ok = false; try { const st = statSync(exe); ok = st.isFile() && (st.mode & 0o111) !== 0; } catch {}
    if (!ok) return { ok: false, hint: `「${argv[0]}」は実行できる file ではありません。起こす GUI の実行 file（例: ~/proj/build/my_gui）を絶対 path で書いてください` };
  }
  const no = app ? null : unsupported([exe, ...argv.slice(1)], { network, reads: rd.reads });
  if (no) return { ok: false, hint: no };
  const body = { name, cwd, argv: [exe, ...argv.slice(1)], timeoutSec, ...(network ? { network } : {}), ...(rd.reads.length ? { reads: rd.reads } : {}), ...(app ? { app } : {}) };
  const cmd: Cmd = { ...body, at, seal: sealOf(body) };
  save(home, [...loadCmds(home).filter((c) => c.name !== name), cmd]);
  return { ok: true, cmd };
}
// --read <dir>: 読みを戻す folder（書きは広げない）。実在する folder の realpath だけ。home 全体・/Users・/Volumes・/ は広すぎて断る
export const READ_MAX = 8;
export const SENSITIVE_HOME = [".ssh", ".aws", ".gnupg", ".kangae", ".docker", ".kube", ".azure", ".config/gcloud", ".config/gh", "Library/Keychains", "Library/Cookies", "Library/Mail", "Library/Messages", "Library/Safari", "Library/Application Support", "Library/Containers", "Library/Group Containers"];
export function checkReads(dirs: string[], home = homedir()): { ok: true; reads: string[] } | { ok: false; hint: string } {
  if (dirs.length > 64) return { ok: false, hint: `--read は ${READ_MAX} 個までです` };
  const out: string[] = [];
  for (const d of dirs) {
    let r: string;
    try { r = realpathSync(d); if (!statSync(r).isDirectory()) throw 0; } catch { return { ok: false, hint: `--read の場所が見つかりません（${d}）。読みを許すフォルダを指してください。例: --read ~/.rustup` }; }
    // firmlink（/System/Volumes/Data/…）は sandbox が /Users 側の綴りに直して比べるので許可に効かない＝card だけ「読める」と嘘を言う。入れない
    if (["/", "/Users", "/Volumes", real(home)].includes(r) || r.startsWith("/System/Volumes")) return { ok: false, hint: `--read ${d} は広すぎます（ホーム全体は渡せません）。必要なフォルダだけ指してください。例: --read ~/.rustup` };
    const secret = SENSITIVE_HOME.find((x) => overlaps(r, join(real(home), x))); // 鍵・token・cookie・keychain が入る場所（その親も）
    if (secret) return { ok: false, hint: `--read ${d} は、秘密が入る場所（~/${secret}）と重なるので渡せません。必要なフォルダだけを指してください` };
    const hit = DENY_READ.find((d) => overlaps(r, d));
    if (hit) return { ok: false, hint: `--read ${d} は、守っている場所（${hit}）と重なるので渡せません。必要なフォルダだけを指してください` };
    if (!out.includes(r)) out.push(r);
  }
  if (out.length > READ_MAX) return { ok: false, hint: `--read は ${READ_MAX} 個までです` };
  return { ok: true, reads: out.sort() };
}
// 測って通らなかった道具は、登録の時に「未対応」と次の一手を言う（走らせて初めて失敗、にしない）。測った結果は docs/verify/w17cb/probe.md
export function unsupported(argv: string[], o: { network: boolean; reads: string[] }, home = homedir()): string | null {
  const exe = basename(argv[0] ?? ""), sub = argv.slice(1).find((a) => !a.startsWith("-")) ?? "";
  const reads = (d: string) => o.reads.some((r) => r === join(real(home), d));
  if (exe === "swift" && ["build", "test", "run", "package"].includes(sub)) return "「swift build」（SwiftPM）は、この安全装置の中では動きません（ユーザーの cache フォルダへ書く必要があり、書ける場所を登録したフォルダの中に絞っているため）。1 ファイルなら「swiftc」、プロジェクトなら cmake か make で登録してください";
  if (exe === "xcodebuild" || exe === "xcrun") return `「${exe}」は未対応です（この Mac に Xcode が無く測れていません。DerivedData などユーザーのフォルダへの書き込みが要る見込みです）。cmake か make で登録してください`;
  if (exe === "cargo") {
    if (!argv.includes("--offline")) return "cargo は「--offline」を付けて登録してください（依存を取りに行くにはユーザーのフォルダ（~/.cargo）への書き込みが要り、未対応です。依存の無い project か、取得済みの project だけ動きます）";
    if (!reads(".rustup") || !reads(".cargo")) return "cargo は、読みだけ許す「--read ~/.rustup --read ~/.cargo」を付けて登録してください（道具の置き場を読むために要ります）";
  }
  if (["npm", "pnpm"].includes(exe) && ["install", "i", "ci", "add", "update", "up"].includes(sub) && !o.network) return `「${exe} ${sub}」は通信が要ります。「--network」を付けて登録してください（通信を許した command は、承認の card に「ネットワーク: あり」と出ます）`;
  if (["yarn", "npx"].includes(exe)) return `「${exe}」は未測のため未対応です。npm か pnpm で登録してください`;
  return null;
}
export function rmCmd(home: string, name: string): boolean {
  const all = loadCmds(home);
  if (!all.some((c) => c.name === name)) return false;
  save(home, all.filter((c) => c.name !== name));
  return true;
}

// macOS は大文字小文字を区別しない file system なので、比べる時は畳む。realpath は native（実在する綴りに直る）
const real = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };
const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p);
export const inside = (child: string, parent: string) => { const c = fold(real(child)), p = fold(real(parent)); return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep); };
// cwd が作業場所・uiHome の中、または作業場所・uiHome を中に含む（親 folder で再帰して探す test / build が agent の書いた file を拾う）
export const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
// argv の絶対 path（--opt=/path の形も）が作業場所・uiHome の中の file を指していないか（登録は絶対 path の script を許すので、agent が書ける file を走らせる道になる）
export const argvInside = (argv: string[], ...roots: string[]) => argv.flatMap((a) => [a, a.slice(a.indexOf("=") + 1)]).filter((a) => a.startsWith("/")).some((a) => roots.some((r) => inside(a, r)));

// 渡す env は固定の最小だけ（KANGAE_*・token・API key は渡さない）
export const minimalEnv = (): Record<string, string> => ({ PATH: MINIMAL_PATH, HOME: process.env.HOME ?? "/", LANG: "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp" });

export type Ran = { code: number | null; ms: number; why: "exit" | "timeout" | "big" | "killed" };
// W17c-a: OS の sandbox（seatbelt）の中で走らせる。書けるのは cwd と走りごとの tmp だけ・通信（常駐の unix socket も）できない・人の home と外付けは読めない（cwd と tmp だけ戻す）。
// path は固定の文字列に埋め込まず -D の parameter で渡す（cwd に引用符や括弧が入っても profile を壊せない）。docs/BRIEF-w17c.md §3・probe は docs/verify/w17c/probe.md
export const SANDBOX = { bin: "/usr/bin/sandbox-exec" }; // 試験が「無い時は走らせない」を確かめるために差し替える
// reads は -D R0.. の parameter（個数ぶんだけ規則を足す）。network を許す時は review21: 「閉じて、要る所だけ開ける」＝ 外へは 443 / 80 / 53（https・http・DNS）と DNS の unix socket だけ。他の unix socket（ssh-agent・docker・gpg-agent）・localhost の TCP・任意の port には出ない。「localhost だけ塞ぐ」規則は新しい listener への最初の接続が通る事があった（実測 1/10 前後）ので採らない。SOCK = 常駐の socket の綴り 2 通り（上の全部閉じるに含まれるが、意図を残す）
// review20: 他の process へ signal を送れない・/private/tmp と /private/var/folders と keychain と log は読めない（/Users /Volumes の外でも他の道具の scratch・system keychain が読めた）。cwd と tmp と --read は後ろの allow で戻す（--read は DENY_READ と重ならない folder だけ＝checkReads）
export const DENY_READ = ["/private/tmp", "/private/var/folders", "/private/var/log", "/Library/Keychains"];
export const profileOf = (network: boolean, nReads: number) => `(version 1)(allow default)${network ? '(deny network-outbound (remote unix-socket (path-literal (param "SOCK"))))(deny network-outbound (remote unix-socket (path-literal (param "SOCK2"))))(deny network-outbound)(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))(allow network-outbound (remote ip "*:443")(remote ip "*:80")(remote ip "*:53"))(deny network-outbound (remote ip "localhost:80")(remote ip "localhost:443"))(deny network-bind)(deny network-inbound)' : "(deny network*)"}(deny signal (target others))(deny file-write*)(allow file-write* (subpath (param "CWD"))(subpath (param "TMP"))(literal "/dev/null")(literal "/dev/tty")(regex #"^/dev/fd/"))(deny file-read-data (subpath "/Users")(subpath "/Volumes")${DENY_READ.map((d) => `(subpath "${d}")`).join("")})(allow file-read-data (subpath (param "CWD"))(subpath (param "TMP"))${Array.from({ length: nReads }, (_, i) => `(subpath (param "R${i}"))`).join("")})`;
export const PROFILE = profileOf(false, 0);
const sbArgs = (c: Pick<Cmd, "cwd" | "network" | "reads">, tmp: string, sock = ""): string[] => {
  const reads = c.reads ?? [], extra = c.network ? ["-D", `SOCK=${sock}`, "-D", `SOCK2=${real(sock)}`] : [];
  return [SANDBOX.bin, "-p", profileOf(!!c.network, reads.length), "-D", `CWD=${c.cwd}`, "-D", `TMP=${tmp}`, ...extra, ...reads.flatMap((r, i) => ["-D", `R${i}=${r}`])];
};
const okBins = new Set<string>(); // 起動の自己検査を通った（sandbox-exec × profile の形）。失敗は覚えない＝次にまた確かめる
function sandboxReady(c: Pick<Cmd, "network" | "reads">, sock: string): boolean {
  const key = `${SANDBOX.bin}|${!!c.network}|${c.reads?.length ?? 0}`;
  if (okBins.has(key)) return true;
  try {
    const t = mkdtempSync(join(real(process.env.TMPDIR ?? "/tmp"), "w17c-self-")), canary = `${t}.canary`;
    try {
      // 1) 同じ profile で起こせる 2) 守りが実際に効いている（cwd の外へ書けない）。exit 0 だけでは「何もしない sandbox-exec」「効かない profile」を通してしまう
      const args = sbArgs({ cwd: t, network: c.network, reads: (c.reads ?? []).map(() => t) }, t, sock);
      const ok = Bun.spawnSync([...args, "/usr/bin/true"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).exitCode === 0;
      const blocked = Bun.spawnSync([...args, "/usr/bin/touch", canary], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).exitCode !== 0 && !existsSync(canary);
      if (ok && blocked) okBins.add(key);
    } finally { rmSync(t, { recursive: true, force: true }); rmSync(canary, { force: true }); }
  } catch {}
  return okBins.has(key);
}

// HOME は走りごとの tmp（道具の cache・設定が人の home でなくここに出来る＝npm install が通る・人の設定を読まない）。道具の置き場を --read で戻した時だけ、その場所を指す
const toolEnv = (reads: string[], home = real(homedir())): Record<string, string> => ({ ...(reads.includes(join(home, ".rustup")) ? { RUSTUP_HOME: join(home, ".rustup") } : {}), ...(reads.includes(join(home, ".cargo")) ? { CARGO_HOME: join(home, ".cargo") } : {}) });
// review20: 走りの印を env に持たせ、終わりに（時間切れ・取り戻しの kill の後も）同じ印を持つ process を全部止める。setsid で process group を抜けた子孫・親が先に死んで launchd に引き取られた子孫が、後から cwd に書き続けない
const RUN_ENV = "W17C_RUN";
const psEnv = () => Bun.spawnSync(["/bin/ps", "-axww", "-E", "-o", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore", stdin: "ignore" }).stdout.toString(); // 走りの印（env）つきの process 一覧。sweep / sweepOrphans の 1 か所
function sweep(id: string) {
  try {
    for (const l of psEnv().split("\n")) { const m = /^\s*(\d+)\s/.exec(l); if (m && l.includes(`${RUN_ENV}=${id}`) && Number(m[1]) !== process.pid) try { process.kill(Number(m[1]), "SIGKILL"); } catch {} }
  } catch {}
}

// review23: 常駐が SIGKILL・クラッシュで死ぬと、detached で起こした command / GUI（自分の session・process group）は孤児として残り、寿命の timer も無いので永久に居る。
// 常駐の起動時に、走りの印（W17C_RUN）を持ち、親が launchd（pid 1）に替わった process を止める。生きている別の常駐の子（親は常駐の pid）は止めない
export function sweepOrphans(): number {
  let n = 0;
  try {
    for (const l of psEnv().split("\n")) { const m = /^\s*(\d+)\s+(\d+)\s/.exec(l); if (m && m[2] === "1" && l.includes(`${RUN_ENV}=`) && Number(m[1]) !== process.pid) try { process.kill(Number(m[1]), "SIGKILL"); n++; } catch {} }
  } catch {}
  return n;
}

// shell なし・窓なし・stdin なし。出力は out の file へ（0600）。process group ごと止められる。sandbox が使えない時は走らせずに投げる（黙って緩くならない）
export function startCmd(c: Cmd, out: string, lim: { timeoutMs?: number; maxBytes?: number; sock?: string } = {}): { pid: number; done: Promise<Ran>; kill: () => void } {
  if (c.network && !lim.sock) throw new Error("通信を許す command は、常駐の socket の場所が分からないと安全に走らせられません");
  if (!sandboxReady(c, lim.sock ?? "")) throw new Error("この Mac では OS の安全装置（sandbox）が使えないので、安全に走らせられません");
  const fd = openSync(out, "a", 0o600); // stdout と stderr は同じ 1 本の fd（別々に開くと書き位置が別で、片方がもう片方を上書きする）
  chmodSync(out, 0o600);
  const tmp = real(mkdtempSync(join(dirname(out), "tmp-"))); // 走りごとの一時 folder（/private/tmp は許さない）。終わりに消す
  const t0 = Date.now();
  const runId = randomBytes(8).toString("hex");
  const p = Bun.spawn([...sbArgs(c, tmp, lim.sock ?? ""), ...c.argv], { cwd: c.cwd, env: { [RUN_ENV]: runId, ...minimalEnv(), HOME: tmp, TMPDIR: tmp, ...toolEnv(c.reads ?? []) }, // 印は先頭（title を書き換える process は ps の env 表示が先頭の 1 つに縮む）
    stdin: "ignore", stdout: fd, stderr: fd, detached: true });
  let why: Ran["why"] = "exit";
  const kill = () => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill(9); } catch {} } };
  const stop = (w: Ran["why"]) => { if (why === "exit") why = w; kill(); sweep(runId); };
  const timer = setTimeout(() => stop("timeout"), lim.timeoutMs ?? c.timeoutSec * 1000);
  const watch = setInterval(() => { try { if (statSync(out).size > (lim.maxBytes ?? OUT_MAX)) stop("big"); } catch {} }, 100);
  const done = p.exited.then((code) => { clearTimeout(timer); clearInterval(watch); sweep(runId); closeSync(fd); rmSync(tmp, { recursive: true, force: true }); return { code: why === "exit" ? code : null, ms: Date.now() - t0, why }; });
  return { pid: p.pid, done, kill: () => stop("killed") };
}

// 出力の末尾（行数と byte の両方で切る）
export function tailOf(out: string, lines = 20, bytes = 2048): string {
  try {
    const size = statSync(out).size, n = Math.min(size, bytes * 4), buf = Buffer.alloc(n), fd = openSync(out, "r");
    try { readSync(fd, buf, 0, n, size - n); } finally { closeSync(fd); }
    const s = buf.toString("utf8").split("\n").filter((l, i, a) => l || i < a.length - 1).slice(-lines).join("\n");
    return s.length > bytes ? s.slice(-bytes) : s;
  } catch { return ""; }
}
export const outName = () => `run-${Date.now()}-${randomBytes(4).toString("hex")}.txt`;
