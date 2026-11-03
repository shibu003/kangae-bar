import { apiHint, apiInstalled, apiVerb, runApi } from "./apianything.ts";
import { CLI, addCmd, agentBin, cwdTooWide, ensureCliLink, loadCmds, overlaps, rmCmd, sealOf, sweepOrphans, touchCmdDirs } from "./cmds.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { cpus, homedir, loadavg, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { PROVIDERS, loadKeyMouth, setKey, type Provider } from "./keys.ts";
import { LlmError, findClis, findProviders, pickMouths, type Found, type Mouth } from "./llm.ts";
import { type Node, type Store } from "./store.ts";
import { describe, type Component, type Roles, type Todo } from "./components.ts";
import { freeSpot, isWeb, readDesktop, unitOf, winOf, writeDesktop, type Card } from "./desktop.ts";
import { clearUi, planUi, readUi, UI_HINT, writeUi, type UiState } from "./ui.ts";
import { makeAgents, memoryFrame } from "./agents.ts";
import { makePtys, type PtyMsg } from "./pty.ts";
import { headlessAvailable, headlessHold, headlessUrl } from "./headless.ts";
import { makeCarry } from "./carry.ts";
import { makeVault } from "./vault.ts";
import { DEAD_GEMINI, GEMINI_ENDED, chooseEngine, judgeClaudeStatus, judgeGemini, judgeStop, backWords, stopWords, type Billing, type Cli } from "./engine-choice.ts";
import { axRaiseHelper, axReadHelper, cuaDriver, EXT_HANDOFF, faceNames, frontPidNow, hidIdleNow, keyOf, makeLeases, pickLease, tokenOf, winDir, type Driver, type Surface } from "./lease.ts";
import { alwaysList, isAlways, isRegistered, register as registerAuth, ruleOf, setAlways } from "./authrules.ts";
import type { AuthCard } from "./authcard.ts";
import { attDir, attNote, gcAtt, makeAttach } from "./attach.ts";
import { addDraft, dropDraft, draftLine, readDrafts } from "./drafts.ts";
import { listEditors, openArgs, readViewer, writeViewer } from "./viewer.ts";
import { makePeek } from "./peek.ts";
import { collectFirstRun, hostBinaryOf, placeExtension, type Refusal } from "./first-run.ts";
import { distill, makeMods, modFrame, modsRoot, shownText, type ModOk } from "./mods.ts";
import { openStoreKeeping } from "./aside.ts";
import { migrateNodesDir, nodesDefault, pointsAtOwner, resolvePath } from "./paths.ts";
import { browserHost } from "./peer.ts";
import { looksSecret } from "./agents.ts";
import { ENGINES, readEngine, sendsLine, step as screenStep, writeEngine, type Engine, type StepStat } from "./screen.ts";
import { MEMO_MARK, memoText } from "./memo.ts";
import { appendOps, recentFor } from "./opsview.ts";
import { handlePress, makeAims, makePressHub, pressArgv, pressOffer, recordOp, viewOf } from "./press-cli.ts";
import { makeSched } from "./sched.ts";
import { pollUntil } from "./wait.ts";
import { roleOf, rolesOf, setRole } from "./roles.ts";
import { VERSION, isDaemonPid, versionReport } from "./version.ts";
import { openDragPost, type DragPost } from "./dragpost.ts";
import { clock, makeRoutines, parseSpec, specLabel, type Deps as RoutineDeps } from "./routines.ts";
import { createRemote, keychainStore, memoryStore, type Answered, type Bridge, type Conv, type Row } from "./remote.ts";
import { launchBar, realProbe, type BarProbe } from "./launchbar.ts";

// ---------- 置き場 ----------
// 試験（bun test = NODE_ENV=test）の下で KANGAE_HOME 無しなら owner の常駐の保存場所を使わず throw（2026-10-08 leases.json が試験に書き換えられた）。bunfig の preload が temp を入れる
export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  return resolvePath("KANGAE_HOME", () => join(homedir(), "Library/Application Support/Kangae"), env);
}
const home = resolveHome();
// W54c（CEO 許可 10-14）: 裏の窓への drag の注入器。~/.kangae/bin の「Kangae Bar 注入.app」（tools/build-dragpost.sh）を LaunchServices（open -g -n -W --stdout）で起こす＝許可は .app 1 つの名前に付く。
// 常駐の中で 1 つだけ作り、起動時に自己確認（--selfcheck）を 1 回走らせる。.app が無い・試験（NODE_ENV=test）・KANGAE_NO_DRAGPOST=1 の時は undefined＝今のまま
let dragPostOnce: DragPost | undefined | null = null;
const defaultDragPost = (): DragPost | undefined => {
  if (dragPostOnce !== null) return dragPostOnce;
  return (dragPostOnce = openDragPost({ home, env: process.env, exists: existsSync, runApp: async (app, args, ms) => {
    const out = join(tmpdir(), `kangae-dragpost-${crypto.randomUUID()}.out`);
    try {
      const p = Bun.spawn(["open", "-g", "-n", "-W", "--stdout", out, "-a", app, "--args", ...args], { stdout: "ignore", stderr: "ignore" });
      const t = setTimeout(() => p.kill(), ms);
      const code = await p.exited; clearTimeout(t);
      return { code, out: existsSync(out) ? readFileSync(out, "utf8") : "" };
    } finally { try { unlinkSync(out); } catch {} }
  } }));
};
export const socketPath = () =>
  process.env.KANGAE_SOCK ?? join(tmpdir(), `kangae-${createHash("sha256").update(process.execPath).digest("hex").slice(0, 10)}.sock`);
const compiled = Bun.main.startsWith("/$bunfs/");
// extension/manifest.json の key から決まる ID。Chromium は native host の起動時、この origin を引数に渡す
export const EXT_ORIGIN = "chrome-extension://kmhgbmikobfdminananoaeheobngmaef/";

// --open が Chromium に渡す debugging port。不正な値は 9339。試験の launch はこれを渡さない
export function cdpPort(raw: string | undefined = process.env.KANGAE_CDP_PORT): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 9339;
}

export function openLaunchOpts(homeDir: string, repo: string, compiledBin: boolean, execPath: string, env: NodeJS.ProcessEnv = process.env) {
  return {
    app: resolvePath("CHROMIUM_APP", () => join(homeDir, "Chromium.app"), env),
    profile: join(homeDir, "profile"),
    hostBinary: compiledBin ? execPath : join(repo, "dist/kangae"),
    extensionDir: join(repo, "extension"),
    debugPort: cdpPort(env.KANGAE_CDP_PORT),
  };
}

// --open --session <id> が開く url。id は整数だけ（それ以外は付けず、今のまま新しいタブ）
export function sessionUrl(argv: string[]): string | undefined {
  const i = argv.indexOf("--session");
  const id = i < 0 ? "" : (argv[i + 1] ?? "");
  return /^\d+$/.test(id) ? `${EXT_ORIGIN}panel.html?session=${id}` : undefined;
}

// ---------- 裏の常駐 ----------
type Msg = {
  itemId?: string; authId?: string; keepGate?: boolean; choice?: string; seq?: number; w?: number; attId?: string; arg?: string; id?: string; engine?: string; op: string; nodeId?: number; text?: string; parentId?: number; rootId?: number; provider?: Provider; key?: string; spec?: Record<string, unknown>;
  tabs?: { title: string; url: string }[]; agent?: boolean; want?: string; title?: string; url?: string; limit?: number; data?: unknown; role?: number;
  what?: string; image?: string; by?: string; name?: string; slots?: Record<string, unknown>; verb?: string; runId?: string; nodeIds?: number[]; action?: string; index?: number; color?: string; rowId?: number;
  via?: string; pid?: number; windowId?: number; tabId?: number; tab?: number | null; callId?: string; error?: boolean; app?: string; lease?: string; tool?: string; args?: Record<string, unknown>; nav?: { startedAt: number; type: string; quals: string[] };
  yes?: boolean; vault?: boolean; scope?: string; mode?: string; dirOnly?: boolean; from?: number; kind?: string; x?: number; y?: number; icon?: string; win?: unknown; ptyId?: number; cols?: number; rows?: number; owner?: string; on?: string | boolean; host?: string; op_name?: string; fields?: Record<string, unknown>; why?: string; draftId?: string; scheduled?: boolean; token?: string; method?: string; headers?: Record<string, unknown>; body?: string; visible?: boolean; big?: boolean; input?: boolean; history?: boolean;
};
type Res = { id?: string; ok: boolean; [k: string]: unknown };

// sec1: 人が押す op（承認・許し・金庫の鍵・設定・開く）。agent の口＝unix socket の CLI（拡張の native host だけは webHello で OS に確かめた人の口）・owner つき・agent 印では呼べない。
// handle の入口で 1 回だけ断る＝op ごとに guard を書かない。足す時はここに 1 行（値＝断る文の頭）。全部の op がこの 1 枚で断られる事は test/sec1.test.ts が集合を回して測る
export const HUMAN_OPS: Readonly<Record<string, string>> = {
  approvalAnswer: "承認への答え", routineAnswer: "routine の承諾", carryAnswer: "ログインを運ぶ許し", carryForget: "「覚えない」",
  leaseMode: "承認の表（許す / 先に聞く / 切る）", vaultKey: "金庫の鍵を渡す事", vaultLock: "金庫を閉じる事", distillMake: "手順を mod にする事",
  extPlace: "拡張を置く事", allowMetered: "従量でもよいと許す事", undoLast: "「1 手戻す」", modRun: "mod の札", authAnswer: "認証 card への返事",
  attachRead: "添付の保存", attachOpen: "添付を開く事", openLink: "link を開く事", peekFront: "絵を前に出す事",
  viewer: "「見る」で開く app の選択", openFolder: "「見る」", forget: "覚えた許しを戻す事", openMode: "聞かずに開く設定", namedOnly: "名前つき操作だけの設定", cursorOverlay: "カーソルを見せる設定",
  urlTabs: "落とした URL の tab を探す事", dropApp: ".app を落として渡す事",
  remote: "スマホで操作の設定", draftDrop: "下書きを捨てる事", opsRecent: "操作の履歴", modOn: "mod の許可（on / off）", distillNo: "手順を覚えない事",
  // sec2: agent が自分に権限を足せる口。窓を渡す（leaseGive）・渡した窓の期限と世代を戻す（leaseReconfirm＝常駐が落ちた後に「分からない」を「分かった」に戻し期限も延ばす）・鍵の保存（setKey）・画面の操作を窓の文字が外へ出る相手に替える（screenEngine）
  // 入れない: leaseTakeback（人が取り返す＝agent が呼んでも権限は減るだけ）。常駐の中の呼び（modRun → handle の leaseGive）は run を通らないので断られない
  leaseGive: "窓を渡す事", leaseReconfirm: "渡した窓の再確認", setKey: "鍵の保存", screenEngine: "画面の操作を任せる先の設定",
};

// AI に見せる木の一覧（節の番号つき）
// 会話の 1 行を画面に出す形（🤖 の返事は印を本文から外して cards に分ける）
// W75b: 吹き出しの添付。[[att:<id>]]（その会話に在る file だけ・名前と大きさは常駐の控えから）・[[link: URL | 題]]（🤖 の行だけ・http(s) だけ）を外して atts にする
import type { AttView as AViewKind } from "./attach.ts";
export type AttView = { kind: "image" | "file"; id: string; name: string; size: number; view?: AViewKind } | { kind: "link"; url: string; origin: string; title: string };
export function splitAtts(text: string, lookup?: (id: string) => { kind: "image" | "file"; id: string; name: string; size: number; view?: AViewKind } | null): { body: string; atts: AttView[] } {
  const atts: AttView[] = [];
  const body = text
    .replace(/\[\[att:\s*([^\]\s]+)\s*\]\]/g, (_, id: string) => { const m = lookup?.(id); if (m) atts.push({ kind: m.kind, id: m.id, name: m.name, size: m.size, view: m.view }); return ""; })
    .replace(/\[\[link:\s*([^\]|｜\n]*?)\s*(?:[|｜]\s*([^\]\n]*))?\]\]/g, (all: string, raw: string, title = "") => {
      if (!text.startsWith("🤖")) return all; // 人が打った行の印は文字のまま
      let u: URL; try { u = new URL(raw); } catch { return all; }
      if (!/^https?:$/.test(u.protocol) || raw.length > 2000 || u.username || u.password) return all;
      atts.push({ kind: "link", url: u.href, origin: u.origin, title: shownText(title, 80) });
      return "";
    })
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { body, atts };
}
const PHONE_MARK = "📱 ";
const rowView = (text: string, lookup?: Parameters<typeof splitAtts>[1]) => { const { body, cards } = splitCards(text); const a = splitAtts(body, lookup); return { text: a.body, cards, ...(a.atts.length ? { atts: a.atts } : {}) }; };

export function outlineText(nodes: Node[], id: number, depth = 0): string {
  const n = nodes.find((x) => x.id === id);
  if (!n) return "";
  const pad = "  ".repeat(depth);
  const label = { next: "次の一手", conclusion: "結論", step: "結論の次の一手", tab: "タブ", component: "部品", visit: "履歴" }[n.kind as string] ?? "一言";
  const body = n.kind === "component" && n.data ? describe(n.text, n.data as Component).replaceAll("\n", `\n${pad}  `) : `${n.text}${n.url ? ` (${n.url})` : ""}`;
  const line = `${pad}[${n.id}] ${label}: ${body}`;
  return [line, ...nodes.filter((c) => c.parentId === id).map((c) => outlineText(nodes, c.id, depth + 1))].join("\n");
}

// ---------- 節ごとの作業場所（ターミナル・agent） ----------
type Proc = { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill: () => void };
export type Workspace = {
  dir: string; // 作業場所を並べる folder
  bin: string; // agent が書き戻す時に呼ぶ binary
  open: (args: string[]) => Promise<boolean>; // macOS の open に渡す引数
  clis: () => Promise<Found[]>;
  spawn: (cmd: string[], cwd: string, env: Record<string, string>) => Proc; // 画面なしの agent を起こす
  billing?: (f: Found) => Promise<Billing>; // 契約か従量か（替える前に聞く。無ければ defaultBilling）
  browserUrl: (launch?: boolean) => Promise<string | null>; // agent 専用の headless Chromium（src/headless.ts）。launch=false は起こさず「使えるか」だけ（文脈に書くか決める時）。試験で差し替える
};

// 入っている CLI は login shell を 2 回起こして探すので数秒かかる。見つかった結果は常駐の間だけ覚える（見つからなかった時は覚えない）
let clisMemo: Promise<Found[]> | null = null;
const memoClis = () => (clisMemo ??= findClis().then((l) => { if (!l.length) clisMemo = null; return l; }));

export const defaultWorkspace = (): Workspace => ({
  dir: resolvePath("KANGAE_NODES_DIR", () => nodesDefault()), // W26: ~/Documents は TCC の対象＝~/Library/Application Support/Kangae/nodes
  get bin() { return agentBin(process.execPath, compiled, Bun.main); }, // W24: 空白入りの bar 同梱 path は claude の許可に当たらない＝空白なしの ~/.kangae/bin/kangae
  open: async (args) => (await Bun.spawn([process.env.KANGAE_OPEN_CMD ?? "open", ...args], { stdout: "ignore", stderr: "ignore" }).exited) === 0,
  clis: memoClis,
  spawn: (cmd, cwd, env) => {
    const p = Bun.spawn(cmd, { cwd, env: { ...(process.env as Record<string, string>), ...env }, stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
    return { stdout: p.stdout, exited: p.exited, kill: () => { try { process.kill(-p.pid, "SIGTERM"); } catch { p.kill(); } } };
  },
  billing: defaultBilling,
  browserUrl: async (launch = true) => (launch ? headlessUrl(home) : headlessAvailable(home) ? "headless" : null),
});

// 契約か従量かを、その AI 自身に聞く（鍵・token の中身は読まない。在るかと種別だけ）
async function defaultBilling(f: Found): Promise<Billing> {
  const forced = process.env[`KANGAE_BILLING_${f.cli.toUpperCase()}`]; // 試験用: 見分けの結果を決める（contract / metered / login / unknown）
  if (forced) return forced === "contract" ? { kind: "contract" } : forced === "metered" ? { kind: "metered", source: "GEMINI_API_KEY" } : forced === "login" ? { kind: "not-logged-in" } : { kind: "unknown" };
  try {
    if (f.cli === "gemini") {
      const g = join(homedir(), ".gemini");
      let type: unknown;
      try { type = JSON.parse(readFileSync(join(g, "settings.json"), "utf8"))?.security?.auth?.selectedType; } catch {}
      return judgeGemini(type, process.env, existsSync(join(g, "oauth_creds.json")));
    }
    const p = Bun.spawn(f.cli === "claude" ? [f.path, "auth", "status", "--json"] : [f.path, "login", "status"], { env: { ...(process.env as Record<string, string>), ...f.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const t = setTimeout(() => p.kill(), 15_000);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(t);
    if (f.cli === "claude") return judgeClaudeStatus(code, out);
    return /api key/i.test(out) ? { kind: "metered", source: "API key" } : code === 0 && /chatgpt/i.test(out) ? { kind: "contract" } : { kind: "unknown" };
  } catch { return { kind: "unknown" }; }
}

// gemini の login が「個人向け」（oauth-personal）か。2026-06-18 に終わった提供（GEMINI_ENDED）
// 読むだけ（書かない）。settings.json が普通の file でなければ（FIFO・/dev/zero への symlink など＝readFileSync が戻らず常駐が固まる）・大きすぎれば（1MB 超）読まない（review22）
export const geminiPersonal = (dir = join(homedir(), ".gemini")) => { try { const f = join(dir, "settings.json"), st = statSync(f); if (!st.isFile() || st.size > 1_000_000) return false; return JSON.parse(readFileSync(f, "utf8"))?.security?.auth?.selectedType === "oauth-personal"; } catch { return false; } };
// 替え先の AI（gemini）は claude のように書ける場所を絞る flag が無い。OS の sandbox（seatbelt）で、書けるのを作業場所・一時 folder・その AI 自身の設定 folder だけにする
const q = (p: string) => `"${p.replace(/[\\"]/g, "\\$&")}"`;
export function writeSandbox(dir: string, tools: string[] = [], sock = socketPath()): string {
  const ok = [realpathSync(dir), realpathSync(tmpdir()), "/private/tmp", join(homedir(), ".gemini")];
  const home = new Set(["/Users", "/Volumes", homedir()]);
  const rd = [...ok, ...tools.map((t) => { try { return realpathSync(t); } catch { return t; } })]; // 読みを戻すのは作業場所・一時・gemini 自身の設定・gemini と node の実体だけ。人の home（鍵・browser の profile・他の project）は読ませない（W11e-3）
  const sub = (l: string[]) => l.map((d) => `(subpath ${q(d)})`).join("");
  // 常駐の socket には繋がせず、消させない（W8g-5: 繋げれば拡張の振りの webHello・消せば先取り）。一時 folder の書きを許した後に置く（後の規則が勝つ）
  let up = dirname(sock);
  try { up = realpathSync(up); } catch {}
  const socks = [...new Set([sock, join(up, basename(sock))])]; // tmpdir は /var → /private/var の symlink 越し。両方の綴りで塞ぐ
  const each = (f: (p: string) => string) => socks.map(f).join("");
  return `(version 1)(allow default)(deny file-write*)(allow file-write* ${sub(ok)}(literal "/dev/null")(literal "/dev/tty")(regex #"^/dev/fd/"))(deny file-read-data ${sub([...home])})(allow file-read-data ${sub(rd)})(deny network-outbound ${each((p) => `(remote unix-socket (path-literal ${q(p)}))`)})(deny file-write* ${each((p) => `(literal ${q(p)})`)})`;
}
// gemini と node の実体（realpath）の置き場。home の読みを閉じても起動できるよう戻す。node か gemini の実体が分からなければ null = 読みを閉じたまま起こせないので替え先にしない（W11e-3）
export function geminiReadDirs(gemini: string, node: string | null | undefined = Bun.which("node")): string[] | null {
  try {
    const ds = node ? [dirname(dirname(realpathSync(gemini))), dirname(dirname(realpathSync(node)))] : null;
    // ~/bin/gemini のような置き場だと dirname 2 回で home（や / ）になり、後に書く allow が home の deny を丸ごと消す（seatbelt は後勝ち・review14）= 替え先にしない
    return ds && !ds.some((d) => `${homedir()}/`.startsWith(`${d.replace(/\/$/, "")}/`)) ? ds : null;
  } catch { return null; }
}
// gemini の web を外す policy（--admin-policy・人の ~/.gemini/policies は書かない）。送り先の network は API に要るので閉じられない = 読んだ物を載せて外へ出せる道（web_fetch / google_web_search）を道具ごと外す
export const GEMINI_NO_WEB = `[[rule]]\ntoolName = ["web_fetch", "google_web_search"]\ndecision = "deny"\npriority = 900\ndenyMessage = "Web access is disabled by policy."\n`;

// 替えた先に渡す指示（上流 engineer-spec.ts switchSpec の形）: 前の頼み・変えた file・今の頼み。替え先は前の会話を何も持っていない
function changedFiles(dir: string, since: number): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "AGENTS.md", "CLAUDE.md", "browser-mcp.json"]);
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (skip.has(n) || out.length >= 40) continue;
      const f = join(d, n);
      const st = statSync(f);
      if (st.isDirectory()) walk(f);
      else if (st.mtimeMs >= since) out.push(` ${f.slice(dir.length + 1)}`);
    }
  };
  try { walk(dir); } catch {}
  return out;
}
export function switchSpec(dir: string, from: string, why: string, asks: string[], changes: string[], now: string): string {
  const hist = asks.slice(-8).map((a, i) => ` ${i + 1}. ${a.replace(/\s+/g, " ").slice(0, 300)}`);
  return [
    `TARGET: this folder (${dir}). Work already happened here — keep it.`,
    `You are taking over: ${from} stopped (${why}). You hold none of the previous conversation.`,
    "WHAT WAS ASKED BEFORE (oldest first):", ...(hist.length ? hist : [" (nothing)"]),
    "WHAT ALREADY CHANGED IN THIS FOLDER:", ...(changes.length ? changes : [" nothing yet"]),
    `NOW DO THIS: ${now}`,
    "CONSTRAINTS: build on what is here rather than starting over. Do not revert earlier work unless asked. Write only inside this folder. You cannot run shell commands or operate other windows; do what you can with files here and say plainly what you could not do.",
  ].join("\n");
}

// ---------- 画面なしの agent（指示を出し、続きを頼める） ----------
export type Run = {
  id: string; nodeId: number; role?: string; dir: string; cli: string;
  status: "running" | "idle" | "failed" | "stopped";
  log: string[]; queue: { text: string; rowId: number | null; scheduled?: boolean }[]; rowId: number | null; sched?: boolean;
  sessionId?: string; startedAt: number; updatedAt: number; need?: Need;
  screen?: StepStat; // W5c: 画面の操作を decision model（d1 / Jev）に任せた段の数と時間（一望の 1 行）
  switched?: { from: Cli; to: Cli; line: string; limits: string }; // W5: 止まったので別の AI に替わった（一望の 1 行）
  stop?: { line: string; reason: string; engine?: Cli }; // 替えられずに止めた理由と次の一手（従量なら engine = 許す先）
  home?: Cli; homeSession?: string; // 替える前の AI と、その session（戻る時に使う）
  mod?: ModOk; // W6a: 押された mod（手順の枠と MCP をこの頼みに付ける。終わるまで残り、替え先の AI での再実行にも付く）
  agent?: string; turns?: number; // 名前を持つ agent（W4b）。turns = 何回目の頼みか（記憶を書いた頼みを残す）
};
export const AGENT_LIMIT = 2;
export const RESUME_LOST = /No conversation found with session ID/i; // claude --resume が前の session を見つけられない時の文（作業場所の path が替わった・session が消えた）
export function agentPrompt(name: string, bin: string, entries = ""): string {
  return `あなたの名前は「${name}」です。覚えておく事は、人が「覚えて」と言った時だけ \`${bin} remember "一言"\` で書いてください（これ以外の方法で記憶 file を書かない）。1 件 1 行・300 字まで。web の頁や file の本文・鍵・パスワードは覚えません。人が「毎朝 9 時に〜して」「この頁が更新されたら教えて」と頼んだ時だけ、\`${bin} routine add --daily 9:00 "頼み"\`（--weekly "mon 9:00" / --every 分 / --watch URL も同じ形）で予約します（一覧 \`routine list\`・止める \`routine pause <id>\`）。\n\n${memoryFrame(entries)}`;
}
export const TURN_MS = 20 * 60_000;
export const noReplyWait = (load = loadavg()[0] ?? 0, n = cpus().length) => Math.round(NO_REPLY_MS * Math.min(10, Math.max(1, load / Math.max(1, n) || 1))); // NaN（load / CPU 数が取れない）は 1 倍: setTimeout(NaN) は即発火して誤報になる（review24）。 混んだ機械（load 338）では起こすだけで 60 秒を超える: load / CPU 数の倍率で延ばす（上限 10 倍）
export const NO_REPLY_MS = 60_000; // 起こしてから 1 行も返らない（claude -p は起動の直後に system の行を出す）: 9 分「考え中…」のまま人に返さない（loginfix-1）
export const WEB_PEER_MS = 6000; // 拡張の native host が常駐に繋がるのを待つ上限（Chrome の起動直後）
// claude の stream-json の 1 行を、画面に出す 1 行に直す（出さない物は null）
export function logLine(ev: any): string | null {
  if (ev?.type === "assistant")
    return (ev.message?.content ?? [])
      .map((c: any) => (c.type === "text" ? c.text.trim().split("\n")[0].slice(0, 160) : c.type === "tool_use" ? `🔧 ${c.name} ${JSON.stringify(c.input ?? {}).slice(0, 80)}` : ""))
      .filter(Boolean)
      .join(" / ") || null;
  return null;
}

// 返事の最後に付けさせる「次の一手」3 つ（1 回の呼び出しで返事と一緒に出させる）
export const MOD_WRITE_RULE = "（mod を作る頼みの時だけ）mod は `kangae mod-write <app> <名前> '{\"label\":\"札の文字(30字まで)\",\"permission\":\"read か write\",\"prompt\":\"手順\"}'` でだけ書けます（file を直接書かない）。書いた mod は必ず許可 off で、人が一覧で on にするまで動きません。人の値・画面の文字・鍵は書かない。外の API（MCP）が要る時だけ mcp に { 名前: { command, args } } を足す（env は名前だけで値は空）。";
export const NEXT_RULE = "\n\n---\n答えの最後に、次にこの人が押して進められる一手を 3 つ、1 つ 40 字以内の「そのまま次の一言として送れる文」で、次の形で付けてください（前置きや説明は付けない）:\n次の一手:\n1. …\n2. …\n3. …";

// 返事を本文と次の一手（最大 3 つ）に分ける。形が崩れていても壊れない（出せた数だけ・0 でもよい）
export function splitNext(text: string): { body: string; next: string[] } {
  const heads = [...text.matchAll(/^[#*>\s]*次の一手[*:：\s]*$/gm)];
  const h = heads.at(-1);
  if (!h) return { body: text.trim(), next: [] };
  const next = text
    .slice(h.index! + h[0].length)
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*・]|\d+[.)、])\s*/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean)
    .map((l) => l.slice(0, 80));
  return { body: text.slice(0, h.index).replace(/\n-{3,}\s*$/, "").trim(), next: [...new Set(next)].slice(0, 3) };
}

// 返事に埋めさせる「会話の中の card」の印（1 行ずつ）。本文からは隠し、画面が card に変える
// bar（open -g）が起こす常駐は USER / LOGNAME を持たない事がある。claude は Keychain の login を $USER の名前で探すので、無いと `auth status` が「loggedIn: false」になり
// 「claude の login が切れています」と誤判定して gemini に替える（EXP-1 再走 A・loginfix-1・実測: HOME+PATH だけ→ false / USER を足す→ true / LOGNAME だけ→ false）
// 名前は要る時だけ引く（userInfo() は passwd に無い uid で throw する＝常駐が起動できなくなる・review22）。引けなければ補わず進む
export const ensureUserEnv = (env: NodeJS.ProcessEnv = process.env, name: string | (() => string) = () => userInfo().username) => {
  if (env.USER && env.LOGNAME) return;
  let n = "";
  try { n = typeof name === "function" ? name() : name; } catch { return; }
  if (!n) return;
  if (!env.USER) env.USER = n;
  if (!env.LOGNAME) env.LOGNAME = n;
};
export const TAB_ASK = "[[ask: その頁の tab を渡してください | 渡しました]] と頼んで止まる";
export const EXT_ASK = `${EXT_HANDOFF} を 1 行書いて止まる（ブラウザの拡張がまだ Chrome から繋がっていないので、tab は渡せない。tab を渡してとは頼まない）`;
export const CARD_RULE = `\n\n（人が決めないと先へ進めない時・人だけができる操作を頼む時・できあがった物を渡す時だけ、返事の本文に次の印を 1 行で書いてよい。説明・助言・調べた結果だけの返事には書かない。印を書いても、下の「次の一手」は必ず付ける）承認や問い: [[ask: 聞く事 | 選択肢 | 選択肢]] ／ 人だけができる操作: [[handoff: 人がする事 | どこで（URL か窓）]]（login・2 段階認証・CAPTCHA・人の判断で進めない時は、人の代わりに入力せず、サイト名つきで [[handoff: ○○で login してください | どこで]] を 1 つ書いて止まる。終わったら人が「やりました」を押す） ／ 頁を読む道（面が渡されていない時）: 人の login の頁・手元の頁（http）は WebFetch / curl では読めず、curl や Bash の許可は人にも出せない。許可を頼まず、${TAB_ASK} ／ できあがった物: [[done: 結果の 1 行 | 物の名前]]`;

export type DmCard = { kind: "ask" | "handoff" | "done"; title: string; options: string[]; detail: string };

// 🤖 の返事から印を外して card にする。形が崩れた印・知らない印はそのまま本文に残す（壊さない）。人が打った行は見ない
export function splitCards(text: string): { body: string; cards: DmCard[] } {
  if (!text.startsWith("🤖")) return { body: text, cards: [] };
  const cards: DmCard[] = [];
  const body = text
    .replace(/\[\[\s*(ask|handoff|done)\s*[:：]?([^\]\n]*)\]\]/g, (_, kind: DmCard["kind"], rest: string) => {
      const [title = "", ...more] = rest.split(/[|｜]/).map((x) => x.trim());
      if (!title) return "";
      cards.push(
        kind === "ask" ? { kind, title: title.slice(0, 200), options: (more.filter(Boolean).length ? more.filter(Boolean) : ["進める", "やめる"]).slice(0, 3).map((o) => o.slice(0, 40)), detail: "" }
        : kind === "handoff" ? { kind, title: title.slice(0, 200), options: ["やりました", "やめる"], detail: (more[0] ?? "").slice(0, 200) }
        : { kind, title: title.slice(0, 200), options: [], detail: (more[0] ?? "").slice(0, 120) },
      );
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body, cards };
}

// 足りない物を 1 つの型で返す（画面は 1 枚で言う）。what = 何が足りないか / how = 次の一手 1 行
export type Need = { kind: "agent" | "login" | "limit"; what: string; how: string };
export function needOf(code: string | undefined, text: string): Need | null {
  if (code === "none") return { kind: "agent", what: "agent がいません", how: "claude か codex を入れてください。gemini は有料の API key がある時だけ使えます。入れたら、もう一度送ります" };
  if (/同時に動ける/.test(text)) return { kind: "limit", what: "いま動ける agent は 2 つまでです", how: "動いている会話が終わるか止めてから、もう一度送ってください" };
  if (/\/login|invalid api key|not logged in|please run .*login/i.test(text)) return { kind: "login", what: "agent の login が切れています", how: "ターミナルで claude と打って login してから、もう一度送ってください" };
  return null;
}

const folderName = (n: Node) => `${n.id} ${n.text.replace(/[\/:\\\n\r\t]+/g, " ").trim().slice(0, 30)}`.trim();

// agent が最初に読む文脈（その節までの道・先の木・結論・タブ・書き戻し方）
export function contextMarkdown(store: Store, id: number, bin: string, role?: { name: string; job: string; others: string[] }, browserUrl?: string | null): string {
  const n = store.get(id)!;
  const way = store.path(id).map((x, i) => `${i + 1}. ${x.text}`).join("\n");
  const kids = store.children(id);
  const concl = kids.filter((c) => c.kind === "conclusion").at(-1);
  const tabs = kids.filter((c) => c.kind === "tab");
  const comps = kids.filter((c) => c.kind === "component" && c.data);
  const root = store.path(id)[0] ?? n;
  const saved = store.children(root.id).filter((c) => c.kind === "tab").slice(0, 10);
  const recent = store.history(root.id, 10);
  const browser = !browserUrl ? [] : [
    "## このブラウザを操作する",
    "これはあなた専用のブラウザです（画面に出ない・人のブラウザとは別の profile・login は無い）。頁を読んで答える用途に使う。",
    ...(saved.length ? ["保存した tab:", ...saved.map((t) => `- ${t.url}`)] : ["保存した tab: まだ無い"]),
    ...(recent.length ? ["最近の履歴:", ...recent.map((v) => `- ${v.text} ${v.url}`)] : ["最近の履歴: まだ無い"]),
    `人のブラウザのログインが要る頁（マイページなど）は、パスワードを探さず \`${bin} carry <host>\` で人に頼む（人が「運ぶ」を押すまで待つ。cookie の値は見えない・出せない）。運べたら \`${bin} carry-read <url>\` でその頁を読む。「前に見た頁」を聞かれたら、\`carry\` の返事に付く履歴の一覧（人が許した時だけ付く）だけを読んで答える（無ければ「履歴は渡されていません」と答え、探しに行かない）。断られた・ログインが無いと返ったら、人に「ログインが要る」と 1 行で伝えて終える`,
    `決まり: この session の tab だけを使う（list_pages で探し、無ければ new_page）。投稿・送信・購入・削除・パスワードの変更は、下書き（入力まで）で止め、\`${bin} note ${id} "確認してください: …"\` で人に頼んで終える。ログインはブラウザに保存されたパスワードの自動入力だけを使い、パスワードを文字で読まない・書かない・書き戻さない。login の頁で password の欄に来たら、入れずに止まり \`${bin} vault-fill <その頁の URL>\` で人に頼む（人が金庫から入れる事を承諾した時だけ、値を見ないまま欄に入る。返事は「入れました」の 1 行・送信は自分で押す。断られたら人に入力を頼んで終える）`,
    "",
  ];
  return [
    `# Kangae: ${n.text}${role ? ` — ${role.name}` : ""}`,
    "",
    `この folder は「Kangae」の節 #${id}「${n.text}」の作業場所です。下の道と結論を踏まえて動いてください。`,
    "",
    ...(role ? ["## あなたの役割", `あなたは「${role.name}」です。${role.job}`, ...(role.others.length ? [`他の役割（その仕事には手を出さない）: ${role.others.join("、")}`] : []), ""] : []),
    "## 考えの道（古い順。最後がこの節）",
    way,
    "",
    ...(concl ? ["## 結論と次の一手（いちばん新しい物）", `結論: ${concl.text}`, ...store.children(concl.id).map((s) => `- [ ] ${s.text}`), ""] : []),
    ...(tabs.length ? ["## この節のタブ", ...tabs.map((t) => `- [${t.text}](${t.url})`), ""] : []),
    ...(comps.length ? ["## この節の部品（表・グラフ・todo・役割）", ...comps.map((c) => describe(c.text, c.data as Component) + "\n"), ""] : []),
    "## この節から先で考えた事（[番号] は節の番号）",
    familyText(store, id),
    "",
    ...(store.todoOf(id) ? ["## やること（この節の todo。人も見ている）", todoText(store.todoOf(id)!.data as Todo), ""] : []),
    ...browser,
    "## 画面の窓について",
    `人に見せたい物は chat に送れます（承認 card は出ません）: \`${bin} send screenshot\`（借りている画面で先に act window_image を撮った絵）・\`${bin} send file|image <作業場所の中の path>\`・\`${bin} send link <URL> [題]\`（http(s) だけ）。作業場所の外の file は送れません。`,
    `この会話の担当名を、最初に 1 回 \`${bin} role <短い名前>\` で付けてください（今の仕事を表す 20 字までの名前。例: sns・implementer・chief of staff・marketing operator）。人の Bar の一覧には、この名前と「動いている」だけが並びます（人が付けた名前は変えられません）。`
    + `あなたは自分で GUI の app や窓を open / osascript などで開かない（開いても人の画面を邪魔する・Bash では止まります）。web の頁を見る・操作する仕事は、まず \`${bin} act open_tab '{"url":"https://…"}'\`（裏の新しい tab・人に承認 card が出る）、Terminal の中身を見る・Terminal で command を実行する時は \`${bin} op Terminal read-front-tab\`（読む）/ \`${bin} op Terminal run-in-front-tab cmd=<command>\`（実行・毎回 人が承認・Terminal が起動していなければ人に起動を頼む）、Obsidian・Notes は \`${bin} op Obsidian list-vaults\`（読む・閉じていても可）/ \`op Obsidian append-to-note vault=… file=… text=…\`（毎回 人が承認・閉じていても可）/ \`op Obsidian open-note vault=… file=…\`・\`op Notes create-note name=… contents=…\`（起動済みの時だけ・毎回 人が承認）、app が要る時は人が登録した command（\`${bin} run <名前>\`）か GUI の app（\`${bin} launch <名前>\`）を使う。窓を起こす open_app は入口にしない（開くと app が自分で前に出て人の画面を奪うことがある）。編集器（Zed・VS Code・Cursor・Xcode・TextEdit など）は開かない: file の中身は作業場所の file を直接編集する。承認されない・開けない時は、理由と代わりの道（作業場所の file に書く・上のブラウザで頁を読む・人に窓を渡してもらう）を 1 行で返す。`,
    `Bash で通るのは \`${bin} …\`（note・todo・context・act・run など）だけです。find・ls・cat・cmake・open など他の command は「This command requires approval」で必ず止まり、人に承認 card は出ません（打っても待つだけ）。止まったら同じ command を繰り返さず、file は Read（作業場所と shots の中だけ）・app は act open_app・build や test は登録済みの \`${bin} run <名前>\` を使う。どれも無い時は人に 1 行で頼んで終える。`,
    "",
    "## Kangae に書き戻す",
    `- 分かった事・やった事は 1 行ずつ: \`${bin} note ${id} "一言"\`（この節の下に一言として出ます）`,
    `- やることを見る: \`${bin} todo ${id}\` / 足す: \`${bin} todo ${id} add "項目"\` / 済にする: \`${bin} todo ${id} done 番号\` / 戻す: \`${bin} todo ${id} undo 番号\``,
    `- 最新の文脈を読み直す: \`${bin} context ${id}\``,
    "",
  ].join("\n");
}

// todo の種（AI を使わない）: 結論があれば次の一手、無ければその段の次の一手
export function todoSeed(store: Store, id: number): string[] {
  const kids = store.children(id);
  const concl = kids.filter((c) => c.kind === "conclusion").at(-1);
  if (concl) return store.children(concl.id).map((s) => s.text);
  return kids.filter((c) => c.kind === "next").map((k) => k.text);
}

// 「続けて」で呼び直す時の頼み。前の操作権は戻らないので、面が要るなら人に渡し直しを頼ませる
export const RESUME_TEXT = "続けてください。人が代わったので、前に渡されていた面の操作権はもうありません。その面が続きに要るなら、act を試さず、人に「どの面をもう一度渡してほしいか」を理由つきで 1 行で頼んでください。";

export const todoText = (t: Todo) => (t.items.length ? t.items.map((i, n) => `${n + 1}. [${i.done ? "x" : " "}] ${i.text}`).join("\n") : "（まだ項目がありません）");

// その節から先の木の一覧（AI と agent に見せる）
export const familyText = (store: Store, id: number): string => outlineText(store.tree(id), id);

export function makeHandler(
  store: Store,
  getMouths: () => Promise<Mouth[]>,
  saveKey?: (p: Provider, key: string) => Promise<void>,
  ws: Workspace = defaultWorkspace(),
  opts: { openLink?: (url: string) => Promise<boolean>; openFile?: (path: string) => Promise<boolean>; uiHome?: string; dragPost?: DragPost; modsRoot?: string; leaseDriver?: (label: string) => Driver | null; webDriver?: Driver; broadcast?: (msg: { type: "ui"; ui: UiState } | { type: "desktop" } | { type: "leases" } | { type: "mods" } | { type: "drafts" } | { type: "roots" } | { type: "remote" } | { type: "history"; rootId: number } | { type: "web"; id: string; tool: string; args: Record<string, unknown> } | { type: "opened"; who: string; kind: "tab" | "app"; label: string } | PtyMsg) => void; awaitWebPeer?: boolean; noReplyMs?: number; webPeerMs?: number; routineDeps?: Partial<RoutineDeps>; carryMs?: number; isExtension?: (owner: unknown) => boolean | Refusal | Promise<boolean | Refusal>; unicast?:(to: Set<unknown>, msg: { type: "web"; id: string; tool: string; args: Record<string, unknown> }) => void; remote?: ReturnType<typeof createRemote> } = {},
) {
  const uiHome = () => opts.uiHome ?? home;
  const pushUi = (ui: UiState) => { opts.broadcast?.({ type: "ui", ui }); return ui; };
  const agents = makeAgents(uiHome());
  // routine（W8d）。起こす = その agent の会話へ tell（走っていれば列に並び、割り込まない）。満員なら false（次の timer で再試行）
  const sched = makeSched((owner) => [...runs.values()].some((r) => `s:${r.nodeId}` === owner && r.status === "running")); // W49: 「定時で起きた」は turn の印（review27: 人の turn・終わった後の turn に残さない）
  const routines = makeRoutines(uiHome(), {
    ...opts.routineDeps,
    onChange: () => opts.broadcast?.({ type: "leases" }),
    fire: (r, text) => {
      const a = agents.read(r.agent);
      if (!a) return true; // agent が消えた routine は何もしない（次の時刻へ進む）
      const run = [...runs.values()].filter((x) => x.nodeId === a.nodeId).at(-1);
      if (run?.status !== "running" && running() >= AGENT_LIMIT) return false;
      void handle(run ? { op: "instruct", runId: run.id, text, scheduled: true } : { op: "workspace", nodeId: a.nodeId, agent: true, text, scheduled: true }).catch(() => {}); // scheduled = この turn は定時で起きた（面を書く時、人がその面を見ていれば離れるまで待つ）
      return true;
    },
  });
  const mods = makeMods(opts.modsRoot ?? modsRoot());
  const offers = new Map<number, { app: string; d: NonNullable<ReturnType<typeof distill>> }>(); // 「mod にしますか」の候補（会話ごと・押されるまで file には何も書かない）
  const pressHub = makePressHub(); // W62: 「押す操作にしますか」の候補・止まった段の問い・走っている押し（常駐の間だけ）
  const aims = makeAims(); // W72: 記録に「的」（欄名・ボタン名・押した要素）を足す（lease.ts の記録は値しか持たない）
  const modNext = new Map<number, ModOk>(); // 押された mod → 次に起こす turn が受け取る（会話ごと）
  const done = new Map<string, Promise<Res>>();
  const pending = new Map<number, string>(); // 囲んだ画面（attach）。次の send で agent に渡す
  const att = makeAttach(uiHome()); // W75a: 人が載せた file / 画像（会話ごとの att/<owner>/ に 0600）
  const sends = new Map<string, number[]>(); // W75c: agent が人に送った時刻（会話ごと・1 分に 10 件まで）
  const attPend = new Map<number, string[]>(); // W75b: 載せたがまだ送っていない添付（会話ごと・次の send で agent に渡し、吹き出しに載る）
  gcAtt(uiHome(), (id) => store.get(id) ?? undefined); // 消して 30 日を過ぎた会話の添付・根の無い添付を片付ける
  const runs = new Map<string, Run & { proc?: Proc; found: Found }>();
  const running = () => [...runs.values()].filter((r) => r.status === "running").length;
  // 面の束縛表と門（lease.ts）。取り戻された持ち主（会話 s:<rootId>）の agent は止める
  // web の面の腕: 拡張（content script）へ流して返事を待つ。拡張が居ない・遅いなら timeout で data:null（門が「応答しません」と返す）
  const webWait = new Map<string, (r: { text: string; isError: boolean; data: any }) => void>();
  // 拡張の native host が常駐に繋がって「webHello」を送るまで、web の依頼は送らない（繋がる前に投げた依頼は誰にも届かず、8 秒待って「応答しません」になる・
  // Chrome を起こした直後に tab を渡す初めての道で 2/4 走が落ちた 2026-10-06）。繋がるまで待ち、繋がらなければ繋がっていない事を言う
  const webPeers = new Set<unknown>();
  const helloing = new Set<unknown>(); // webHello を確かめている最中の口
  let refusal: (Refusal & { at: number }) | null = null; // 最後に断った webHello（W8g-5b）
  const humanPeers = new Set<unknown>(); // bar の口（humanHello した口からだけ humanSeen を受ける）
  const webArrived: (() => void)[] = [];
  const peerWait = () => new Promise<void>((res) => { const t = setTimeout(res, opts.webPeerMs ?? WEB_PEER_MS); webArrived.push(() => { clearTimeout(t); res(); }); });
  // W8g-5c: webHello した口の確認（codesign・混んだ機械で数秒）が済むまでの口。確認中に送った頼みの返事は「確かめていない口」として捨てられ、8 秒で「応答しません」になる
  // （load 400 で実測）ので、頼みは確認が済んでから送る＝確認の時間を 8 秒に数えない。確認そのものの上限は peer.ts の codesign の打ち切り
  const verifying = new Map<unknown, Promise<true | Refusal | false>>();
  const web: Driver = {
    call: async (tool, args) => {
      if (verifying.size) await Promise.all(verifying.values()); // 確認中の口が居る間は送らない（その口の返事も、確認の時間も、8 秒に数えない）。確認の上限は peer.ts の CODESIGN_MS
      if (opts.awaitWebPeer && !webPeers.size) await peerWait();
      if (opts.awaitWebPeer && !webPeers.size) return { text: "ブラウザの拡張がまだ常駐に繋がっていません（Chrome を起こした直後は数秒かかります）。数秒待って、もう一度", isError: true, data: null };
      return webCall(tool, args);
    },
    close() {},
  };
  // 値つきの依頼の宛先 = その tab を持つ口 1 つ（拡張が 2 つの browser / profile に居ても、tab を持っている方にだけ運ぶ）。
  // vault_fill は同じ tab の下見（値なし）に「欄が 1 つ」と答えた口。cookie_get・history_get は tabId つきの依頼（tab_info など）に error なしで答えた最初の口。返事は送った口からの物だけ受ける（sentTo）
  const fillAsk = new Map<string, [number, boolean]>(), fillOwner = new Map<number, unknown>(), sentTo = new Map<string, unknown>();
  const webCall = (tool: string, args: Record<string, unknown>) =>
    new Promise<{ text: string; isError: boolean; data: any; unknown?: boolean }>((resolve) => {
      const id = crypto.randomUUID();
      if (tool === "vault_fill" && typeof args.value !== "string" && typeof args.tabId === "number") { fillAsk.set(id, [args.tabId, true]); fillOwner.delete(args.tabId); }
      if (typeof args.tabId === "number" && tool !== "vault_fill" && tool !== "cookie_get" && tool !== "history_get" && tool !== "cookie_names") fillAsk.set(id, [args.tabId, false]);
      const t = setTimeout(() => { webWait.delete(id); fillAsk.delete(id); sentTo.delete(id); resolve({ text: "ブラウザが応答しません", isError: true, data: null, unknown: true }); }, tool === "api_fetch" ? 35_000 : tool === "open_tab" ? 20_000 : 8000); // open_tab は拡張が読み込み終わり（15 秒まで）を待ってから返す・api_fetch は site の返事を待つ（上流の既定の締切 30 秒より長く）
      webWait.set(id, (r) => { clearTimeout(t); resolve(r); });
      // 値を運ぶ依頼（金庫の password）・値つきの返事を頼む依頼（cookie_get・history_get）は全 peer への broadcast に載せない（agent の CLI も peer）。webHello した拡張の口だけへ。口の送り方が無ければ送らない
      if (tool === "open_tab" || tool === "api_fetch" || tool === "cookie_get" || tool === "cookie_names" || tool === "history_get" || (tool === "vault_fill" && typeof args.value === "string")) { // open_tab: 全部の口に送ると browser / profile の数だけ tab が開く。今の面の tab を持つ口 1 つへ
        if (!opts.unicast) { clearTimeout(t); webWait.delete(id); resolve({ text: "拡張へ直接送る道がありません", isError: true, data: null }); return; }
        // 口が 1 つだけなら宛先は一意（取り違えは起きない）。2 つ以上の時だけ tab の持ち主を要求する（vault_fill は下見に答えた口のみ）
        const to = fillOwner.get(Number(tool === "open_tab" ? args.near : args.tabId)) ?? (tool !== "vault_fill" && webPeers.size === 1 ? [...webPeers][0] : undefined);
        if (!to || !webPeers.has(to)) { clearTimeout(t); webWait.delete(id); resolve({ text: "その tab を持つ拡張の口が分かりません。何も送っていません", isError: true, data: null }); return; }
        sentTo.set(id, to);
        opts.unicast(new Set([to]), { type: "web", id, tool, args });
      } else opts.broadcast?.({ type: "web", id, tool, args });
    });
  const apiTokens = new Map<string, string>(); // 印 → その call を頼んだ会話（W46-B: 貸した tab の中だけで再生する） // W35c: 今走っている api-anything の process だけが、tab での fetch（apiFetch）を頼める（process ごとの 1 回限りの印・終わったら消す）
  const leases = makeLeases(uiHome(), {
    authAuto: () => vault.unlocked(),
    authCanRegister: () => vault.unlocked(), // W76d: 登録は金庫が開いている時だけ（項目を探すため） // W76c: 自動認証は local agent（金庫）が開いている時だけ選択肢に出る
    authRegistered: (host, kind) => (kind === "password" || kind === "otp") && isRegistered(uiHome(), host, kind),
    onAuthCard: (c) => { if (c.web && (c.kind === "password" || c.kind === "otp") && vault.unlocked() && isAlways(uiHome(), c.host, c.kind)) void runAuto(c).catch(() => {}); }, // always allow の host×口は card を待たずに自動（失敗したら card が残る）
    driver: opts.leaseDriver,
    scheduled: sched.is,
    ...(opts.leaseDriver ? {} : { frontPid: frontPidNow, hidIdle: hidIdleNow }), // W60a: 窓へ書く直前に「人がその窓に入力していないか」を見る（本物の読み。driver を渡す試験は見ない）
    web: opts.webDriver ?? web,
    nameOf: (o) => { const m = /^s:(\d+)$/.exec(o); return m ? roleOf(uiHome(), Number(m[1])) : undefined; }, // W60b1: 断る文に、使っている担当の名前
    record: (e) => { try { appendOps(join(uiHome(), "ops.jsonl"), JSON.stringify(aims.tag(e))); } catch {} }, // W42a S3: 面・世代・操作名・値・結果
    dragPost: opts.dragPost ?? defaultDragPost(), // W54c: 常駐の起動時に注入器（~/.kangae/bin の .app）を準備し、自己確認が通った時だけ配る（無ければ・落ちたら今のまま）
    namedOnly: () => existsSync(join(uiHome(), "named-only")), // W42c: 人が「名前つき操作だけ」にした時だけ on（既定 off・この file がある時だけ）
    openMode: () => (existsSync(join(uiHome(), "open-allow")) ? "allow" : "ask"), // W78o: 開くだけの既定（既定 ask・この file がある時だけ allow）
    onOpened: (o) => opts.broadcast?.({ type: "opened", who: agents.list().find((a) => `s:${a.nodeId}` === o.owner)?.name ?? "agent", kind: o.kind, label: o.label }), // 聞かずに開いた時の知らせ（panel が toast にする）
    showCursor: () => existsSync(join(uiHome(), "cursor-overlay")), // W39: 仮想カーソルを見せる設定（既定 off・この file がある時だけ on）
    webReady: opts.webDriver ? undefined : () => webPeers.size > 0, // 拡張が繋がっていない時、open_tab は人に聞く前に「拡張を入れて」を返す
    onChange: () => opts.broadcast?.({ type: "leases" }),
    onRevoke: async (owner) => {
      const procs: Proc[] = [];
      const ag = agents.byNode(Number(owner.slice(2))); if (ag) routines.declineAgent(ag.name); // 取り戻し = その agent が足した承認待ちも断る
      for (const r of runs.values()) if (`s:${r.nodeId}` === owner) { r.queue = []; if (r.status === "running") { r.status = "stopped"; say(r, "■ 面を取り戻されたので止めました"); if (r.proc) procs.push(r.proc); r.proc?.kill(); } }
      await Promise.race([Promise.allSettled(procs.map((p) => p.exited)), Bun.sleep(3000)]); // 止まったと分かるまでが「停止要求中」（3 秒で打ち切り）
    },
  });
  // W8e 覗き窓: 渡した面の縮小絵（panel が見えている間だけ撮る）と、人が絵を押した時だけの前面化
  const peek = makePeek({ surface: (k) => leases.list().find((l) => l.key === k)?.surface, win: () => (opts.leaseDriver ?? cuaDriver)(`kangae-peek-${process.pid}`), web: () => opts.webDriver ?? web, raise: axRaiseHelper, read: axReadHelper });
  // 引き継ぎメモを会話に 1 枚（人が代わった・agent が止まった）。run の log と持っていた面から常駐が作る
  const memo = (r: Run, why: "handover" | "stopped" | "failed", line?: string) => {
    const at = store.get(r.nodeId);
    if (!at || at.deletedAt !== null) return;
    const apps = leases.facesOf(`s:${r.nodeId}`).map((l) => l.surface.app).join("・");
    store.add(r.nodeId, "user", memoText({ why, log: r.log, app: apps || undefined, line }), true);
  };
  // W8g: 人の Chrome のログインを、値を見せずに頼みごと専用の見えない context へ運ぶ（src/carry.ts・図 §45）
  const carry = makeCarry({ web: () => opts.webDriver ?? web, faces: (o) => leases.facesOf(o).flatMap((l) => ("tabId" in l.surface ? [{ tabId: l.surface.tabId }] : [])), browserUrl: () => ws.browserUrl(), onChange: () => opts.broadcast?.({ type: "leases" }), approvalMs: opts.carryMs, prefsFile: () => join(uiHome(), "carry-prefs.json") });
  // W8g-4: password は金庫（Bitwarden の CLI）から、値を agent に見せず agent 用 Chrome の欄へ（src/vault.ts・図 §49）
  const vault = makeVault({ web: () => opts.webDriver ?? web, faces: (o) => leases.facesOf(o).flatMap((l) => ("tabId" in l.surface ? [{ tabId: l.surface.tabId, gen: l.gen }] : [])), browserUrl: () => ws.browserUrl(), onChange: () => opts.broadcast?.({ type: "leases" }), approvalMs: opts.carryMs });
  // W76c: 認証 card の自動認証（allow / always allow）。入れるのは人の Chrome の面の password か認証コードだけ・値は金庫→拡張の 1 回→捨てる（agent・log・返事に出ない）。入れた後の送信は agent の通常の道（card・DANGER の線）
  const runAuto = async (c: AuthCard): Promise<{ ok: true } | { ok: false; hint: string }> => {
    if (!c.web || (c.kind !== "password" && c.kind !== "otp")) return { ok: false, hint: "この確認は人の操作だけです（自動にできません）" };
    const face = leases.facesOf(c.owner).find((l) => "tabId" in l.surface && `tab:${l.surface.tabId}` === c.key);
    const url = face && "tabId" in face.surface ? face.surface.url : undefined;
    if (!url) return { ok: false, hint: "その画面がもう渡されていません" };
    const r = await vault.fill(c.owner, url, { approved: true, kind: c.kind, itemId: ruleOf(uiHome(), c.host, c.kind)?.item });
    if (!r.ok) return { ok: false, hint: r.hint };
    const run = [...runs.values()].find((x) => `s:${x.nodeId}` === c.owner);
    if (run) await handle({ op: "instruct", runId: run.id, text: `${c.kind === "otp" ? "認証コード" : "password"}は local agent が入れました（値は見えません）。画面を読み直して、続きから進めてください。送信・確定は通常どおり確認が要ります` });
    else leases.humanDone(c.owner);
    return { ok: true };
  };
  const say = (r: Run, line: string) => { r.log.push(line); if (r.log.length > 200) r.log.splice(0, r.log.length - 200); r.updatedAt = Date.now(); };
  const agentTask = (role: string | undefined, id: number) =>
    `${role ? `あなたの役割（${role}）の仕事を` : "AGENTS.md の結論と次の一手を"}進めてください。分かった事・作った物は 1 つずつ \`${ws.bin} note ${id} "一言"\` で Kangae に書き戻してください。`;

  const blocked = new Map<Cli, { until: number; failed: "limit" | "login"; known: boolean }>(); // 止まった AI と、使えるようになる時刻（login は 10 分で見直す）
  const dead = new Map<Cli, string>(); // 起動できないと分かった AI（常駐の間は候補から外す）
  const allowedMetered = new Set<Cli>(); // 人が「従量でもよい」と許した AI（常駐の間だけ）

  // 止まった（上限・login）時: 入っている別の AI に、前の頼み・変えた file・今の頼みを渡して続けさせる。替えられなければ止めて理由と次の一手
  async function failover(r: Run & { proc?: Proc; found: Found }, stop: { failed: "limit" | "login"; until: number | null }, text: string, shown?: string, detail = "") {
    const now = Date.now();
    const from = r.cli as Cli;
    blocked.set(from, { until: stop.until ?? now + 10 * 60_000, failed: stop.failed, known: stop.until !== null });
    if (from === "gemini" && DEAD_GEMINI.test(detail)) dead.set("gemini", GEMINI_ENDED); // 個人向けの Gemini CLI は 2026-06-18 に終わった。以後は替え先にしない
    const all = await ws.clis();
    const gem = all.find((f) => f.cli === "gemini");
    if (gem && from !== "gemini" && !dead.has("gemini") && !ws.billing && !process.env.KANGAE_BILLING_GEMINI && geminiPersonal()) dead.set("gemini", GEMINI_ENDED); // 個人向け（oauth-personal）は終わっている。替え先にして 9 分待たせない（loginfix-1）
    if (gem && from !== "gemini" && !dead.has("gemini") && !process.env.KANGAE_NO_SANDBOX && !geminiReadDirs(gem.path)) { dead.set("gemini", "gemini の実体（または node）の場所が分からず、人の home を読ませない囲いの中で起動できません"); say(r, `⚠ ${dead.get("gemini")}。gemini には替えません`); }
    const list = all.filter((f) => f.cli === from || !dead.has(f.cli as Cli));
    const billing: Partial<Record<Cli, Billing>> = {};
    for (const f of list) if (f.cli !== from) billing[f.cli as Cli] = await (ws.billing ?? defaultBilling)(f);
    const unusable = [...blocked].filter(([c, b]) => c !== from && b.until > now).map(([c]) => c);
    const pick = chooseEngine({ current: from, order: list.map((f) => f.cli as Cli), billing, failed: stop.failed, until: stop.until, unusable, allowed: allowedMetered }, now);
    const why = stop.failed === "login" ? `${from} の login が切れています` : `${from} が上限`;
    if (pick.kind === "switch") {
      const to = list.find((f) => f.cli === pick.to)!;
      const root = store.path(r.nodeId)[0];
      const asks = root ? store.tree(root.id).filter((n) => n.kind === "user" && n.id !== root.id && !n.text.startsWith("🤖")).slice(0, -1).map((n) => rowView(n.text).text) : [];
      const spec = switchSpec(r.dir, from, why, asks, changedFiles(r.dir, r.startedAt), text);
      const held = leases.facesOf(`s:${r.nodeId}`);
      let faces = "";
      if (to.cli !== "claude") {
        // 替え先では kangae act / note / remember が通らない: 黙って失敗させず、面を持っていれば人に戻す
        const queue = r.queue;
        r.status = "idle";
        for (const l of held) leases.takeback(keyOf(l.surface));
        r.queue = queue;
        faces = `${to.cli} では渡された面の操作・覚える・Kangae への書き戻しはできません${held.length ? "（持っていた面はあなたに戻しました）" : ""}`;
      }
      r.home ??= from;
      r.homeSession = r.sessionId ?? r.homeSession;
      r.sessionId = undefined;
      if (r.agent) agents.finish(r.agent, { sessionId: undefined });
      r.found = to;
      r.cli = to.cli;
      r.switched = { from, to: to.cli as Cli, line: `${to.cli} に替わりました（${stop.failed === "login" ? `${from} の login が切れています・login すれば戻れます` : `${from} が上限・${backWords(stop.until, now)}`}）`, limits: faces };
      say(r, `🔀 ${r.switched.line}${faces ? `。${faces}` : ""}`);
      opts.broadcast?.({ type: "roots" });
      await turn(r, spec, shown ?? text);
      return;
    }
    if (pick.kind === "keep") return; // failed を渡しているので来ない
    // 替わった先でも止まった: 元の AI に戻しておく（次の頼みを、動かない替え先に送り続けない）
    const homeF = r.home && r.home !== r.cli ? list.find((f) => f.cli === r.home) : undefined;
    let line = pick.line;
    if (homeF) {
      const hb = blocked.get(homeF.cli as Cli);
      line = `${from} に替えましたが、${from} が使えませんでした（原文: ${detail || stop.failed}）。元の ${homeF.cli} は ${hb ? stopWords(homeF.cli as Cli, hb.failed, hb.known ? hb.until : null, now) : "使えるか分かりません"}。${homeF.cli} が使えるようになるまで待つか、${from} をターミナルで開いて確かめてください`;
      r.found = homeF; r.cli = homeF.cli; r.sessionId = r.homeSession; r.switched = undefined; r.home = undefined;
    }
    if (dead.has(from)) line = `${dead.get(from)}。${line}`;
    r.status = "failed";
    memo(r, "stopped", line);
    r.stop = { line, reason: pick.kind === "wait" ? "limit" : (pick as { reason: string }).reason, engine: pick.kind === "refuse" && pick.reason === "metered" ? list.find((f) => f.cli !== from && billing[f.cli as Cli]?.kind === "metered")?.cli as Cli : undefined };
    r.need = { kind: stop.failed === "login" ? "login" : "limit", what: line, how: "" };
    say(r, `⛔ ${line}`);
    if (r.agent) agents.finish(r.agent, { unread: true, answer: `⛔ ${line}`.slice(0, 200), answeredAt: Date.now() });
    opts.broadcast?.({ type: "roots" });
  }

  async function turn(r: Run & { proc?: Proc; found: Found }, text: string, shown?: string, scheduled?: boolean) {
    if (scheduled !== undefined) r.sched = scheduled; // 明示の時だけ替える（同じ turn のやり直しは前の印のまま）
    sched.begin(`s:${r.nodeId}`, !!r.sched);
    say(r, `👤 ${shown ?? text}`);
    r.stop = undefined;
    const orig = text;
    const errFile = join(tmpdir(), `kangae-err-${r.id}-${r.turns}`);
    // 前に上限で替わっていて、元の AI の戻る時刻を過ぎていれば元に戻る（時刻が読めなかった時は戻らない = ponytail: login し直したら新しい会話で）
    const back = r.home && r.cli !== r.home ? blocked.get(r.home) : undefined;
    if (r.home && back?.known && back.until <= Date.now() && !shown) {
      const h = (await ws.clis()).find((f) => f.cli === r.home);
      if (h) { r.found = h; r.cli = h.cli; r.sessionId = r.homeSession; r.switched = undefined; r.home = undefined; blocked.delete(h.cli as Cli); say(r, `🔀 ${h.cli} に戻りました（枠が戻りました）`); opts.broadcast?.({ type: "roots" }); }
    }
    if (modNext.has(r.nodeId)) { r.mod = modNext.get(r.nodeId); modNext.delete(r.nodeId); }
    r.turns = (r.turns ?? 0) + 1;
    const mine = r.turns; // この turn の番号。後始末の await の間に次の turn が始まったかを見る
    const turnAt = Date.now(); // W62: この turn の記録（ops.jsonl）を時刻で絞る
    r.status = "running";
    r.proc = undefined; // 止めた前の turn の process とは縁を切る（spawn までの間にその exit が届いても、この turn を潰させない）
    r.need = undefined;
    const f = r.found;
    let browser: string | null = null;
    if (f.cli === "claude") {
      try { browser = await ws.browserUrl(); } catch (e) { browser = null; text = `（${(e as Error).message}）\n\n${text}`; }
    }
    if (runs.get(r.id)?.status === "stopped") return;
    const faces = leases.facesOf(`s:${r.nodeId}`).filter((l) => l.confirmed);
    const lease = faces[0];
    if (lease) browser = null; // 面を持つ turn は agent 用ブラウザ（mcp__browser）も外す: 任意の URL へ移れる＝WebFetch と同じく頁の中身を外へ出せる道（review14）
    const screen = readEngine(uiHome());
    const dirAbs = realpathSync(r.dir).slice(1);
    // W37（user 承認済み）: 人が登録した（印が合う）command の「場所」の中も直接編集・読みしてよい（編集器を開かずに build まで進める）。app（GUI）の登録の場所・Kangae の置き場・鍵や home 全体と重なる場所は足さない。
    // 書き換えた file を走らせる被害は seatbelt（書けるのは場所と tmp だけ・通信なし）で包む。場所を読める turn は WebSearch / WebFetch を外す（.env などを外へ出す道）
    const cwds = [...new Set(loadCmds(uiHome()).filter((c) => !c.app && c.seal === sealOf(c) && existsSync(c.cwd)).map((c) => realpathSync(c.cwd)).filter((d) => !overlaps(d, realpathSync(uiHome())) && !cwdTooWide(d)))];
    const edits = `Edit(//${dirAbs}/**),Write(//${dirAbs}/**)${cwds.map((d) => `,Edit(//${d.slice(1)}/**),Write(//${d.slice(1)}/**)`).join("")}`; // 書けるのはこの agent の作業場所と、人が登録した場所の中だけ（E2。Write / Edit を無印で許すと外にも書ける・UC-o3 で実測）
    mkdirSync(join(uiHome(), "shots"), { recursive: true });
    const myWin = winDir(uiHome(), `s:${r.nodeId}`); // 窓の絵はこの会話の分だけ読める（他の会話の絵は shots の外・review17-2）
    mkdirSync(myWin, { recursive: true, mode: 0o700 });
    const myAtt = attDir(uiHome(), `s:${r.nodeId}`); // W75a: 人が載せた file はこの会話の分だけ読める（Read だけ・他の会話の添付は path を知っても読めない）
    mkdirSync(myAtt, { recursive: true, mode: 0o700 });
    const reads = `Read(//${dirAbs}/**)${cwds.map((d) => `,Read(//${d.slice(1)}/**)`).join("")},Read(//${realpathSync(join(uiHome(), "shots")).slice(1)}/**),Read(//${realpathSync(myWin).slice(1)}/**),Read(//${realpathSync(myAtt).slice(1)}/**)`; // 読めるのも作業場所と shots の中だけ（W11e-2。無印の Read / Glob / Grep は人の home のどこでも読める。Glob / Grep は Read 規則が効き、cwd の外は -p だと承認が取れず拒否）
    const web = lease || cwds.length ? "" : ",WebSearch,WebFetch"; // 面（lease）を持つ会話は人の login の頁を読むので、中身を任意の URL / 検索語に載せて出せる道（WebSearch / WebFetch）を外す = web は門を通る act fetch_url / render_url の同 site だけ。持たない調べ物は残す。lease はこの turn の頭で決まる（途中で渡された面は次の turn から = act もその時から使える）
    const apiReady = f.cli === "claude" && apiInstalled(home);
    const tools = `${reads},${edits}${web},Bash(${ws.bin} note:*),Bash(${ws.bin} todo:*),Bash(${ws.bin} context:*),Bash(${ws.bin} mod-write:*),Bash(${ws.bin} carry:*),Bash(${ws.bin} carry-read:*),Bash(${ws.bin} vault-fill:*)${r.agent ? `,Bash(${ws.bin} remember:*),Bash(${ws.bin} routine:*)` : ""},Bash(${ws.bin} op:*),Bash(${ws.bin} role:*),Bash(${ws.bin} send:*),Bash(${ws.bin} act:*),Bash(${ws.bin} press:*)${lease && screen !== "claude" ? `,Bash(${ws.bin} step:*)` : ""}${loadCmds(uiHome()).some((c) => !c.app) ? `,Bash(${ws.bin} run:*)` : ""}${loadCmds(uiHome()).some((c) => c.app) ? `,Bash(${ws.bin} launch:*)` : ""}${apiReady ? `,Bash(${ws.bin} api:*)` : ""}${browser ? ",mcp__browser" : ""}${f.cli === "claude" && r.mod ? Object.keys(r.mod.mcp).map((n) => `,mcp__${n}`).join("") : ""}`;
    if (f.cli === "claude" && /mod/i.test(orig)) text = `${MOD_WRITE_RULE.replace("kangae", ws.bin)}\n\n${text}`;
    if (r.mod) text = `${modFrame(r.mod, f.cli === "claude")}\n\n${text}`;
    const faceOf = (l: NonNullable<typeof lease>) => `${"tabId" in l.surface ? "web の tab" : "窓"}「${l.surface.app}${l.surface.title ? ` / ${l.surface.title}` : ""}」`;
    const names = faceNames(faces);
    const intro = faces.length > 1
      ? `あなたには面が ${faces.length} 枚渡されています: ${Object.entries(names).map(([n, t]) => `${n} = ${faceOf(faces.find((l) => tokenOf(l) === t)!)}`).join(" / ")}。操作は必ず \`${ws.bin} act --on <名前> <操作> '<JSON>'\` で面を指してください（--on を省くと実行されません。書き写すなら、読んだ面と書く面を取り違えないこと）。この ${faces.length} 枚だけを操作できます`
      : lease ? `あなたには${faceOf(lease)}が渡されています。この面だけを \`${ws.bin} act <操作> '<JSON>'\` で操作できます` : "";
    if (lease) text = `${intro}（まず \`act get_window_state '{}'\` で要素を読み、element_token で click / type_text / press_key / hotkey / scroll / set_value。名前つき操作が無い時は画面操作で済ませず \`${ws.bin} draft <操作名> 欄=値 --why <理由>\` で下書きを人に残して止まる。web の tab の面では欄・ボタンを見える名前で指す名前つき操作 \`act fill '{"field":"欄の名前","value":"…"}'\` / \`act press_button '{"name":"ボタンの名前"}'\` / \`act select_option '{"field":"欄の名前","option":"選択肢"}'\` も使える（名前が 1 つに決まらなければ何も変えず断る）。password 欄は入れられない。Canvas の課題を読む時は \`act web_op '{"op":"canvas-week"}'\`（来週。今週は \`"week":"this"\`）か \`canvas-todo\`＝その tab の中・あなたの login のまま読むだけ。「来週の task を Google Doc にまとめて」は、①Canvas の tab の面で web_op ②返った JSON の items を日付順の箇条書きに要約 ③Doc の tab の面で本文を click → type_text（Doc への書き込みは 1 回ごとに人に聞きます）の順。クリップボードは使えません）。文字・記号は press_key でなく type_text で入れてください。操作の道の優先順: ①名前つき操作（web の tab: fill / press_button / select_option）②get_window_state で読んだ最新の element_token ③それでも要素が無い所（canvas・描画領域）だけ画素の x, y（読んだ要素がある点への x, y の click は門が断ります。座標・古い token・名前のない要素は「押す先が分からない」として毎回人に聞かれます）。token が古い・無い時は、座標に逃げず get_window_state で読み直すか、名前つき操作へ。他の窓・tab・前面に出す操作はできません。編集器（Zed・VS Code など）は開けません: file は直接編集し、build と実行は \`run\` で行ってください。app が要る時は人が登録した command / GUI の app（\`run\` / \`launch\`）を使い、窓を起こす open_app は入口にしません（app が自分で前に出て人の画面を奪うことがあります）。窓の AX の要素が少ない app（登録した GUI の app など）の出力・画面は \`act window_image '{}'\` で窓の絵（file の path が返る。Read で開いて見る）を読めます。別の site の頁に書く・読む必要がある時だけ \`act open_tab '{"url":"https://…"}'\`（人が許すと裏の新しい tab で開き、次の面になる。url に ? や # は付けられない・読んだ中身を url に載せない）。同じ site の別の頁を読むなら、tab も窓も開かずに \`act fetch_url '{"url":"…"}'\`（人の login のまま取るだけ・描画しない）、JS で描かれる頁は \`act render_url '{"url":"…"}'\`（見えない面で描いて読む）。url を省くと今の頁。link を押して頁が移動しても操作権は保たれます（移動後は get_window_state を読み直す）。書き換え・消す・送るなど壊しうる操作は、門が人に承認を求めます（答えが来るまで act は待ちます）。「人が断りました」「時間内に答えなかった」と返ったら実行されていません。同じ操作を繰り返さず、人に 1 行で伝えて次を聞いてください。「結果不明」と返ったら、実行された可能性があります。get_window_state で読み直して確かめ、同じ操作を繰り返さないでください（読み直すまで書き換えは止まります）。「取り戻されました」と返ったら、その面についてはそこで止まって人に伝えてください。${faces.length > 1 ? "2 枚のうち 1 枚だけ取り戻された時は、もう 1 枚は続けて構いません（取り戻された面には書かない）。" : ""}\n\n${text}`;
    if (apiReady) text = `${apiHint(ws.bin)}\n\n${text}`; // W35b
    if (f.cli === "claude") { // W23: 登録済みの command は面の有無によらず名前だけ案内する（open_app と Bash の決まりは AGENTS.md の「画面の窓について」）
      const all = loadCmds(uiHome()).filter((c) => c.seal === sealOf(c)), cs = all.filter((c) => !c.app), gs = all.filter((c) => c.app);
      if (gs.length) text = `人が登録した app（GUI）: ${gs.map((c) => c.name).join(", ")}。起こすなら \`${ws.bin} launch <名前>\`（名前だけ・毎回人が承認・窓が出れば面として渡る。\`act --on <返事の名前>\` で操作し、まず \`act window_image\` で絵を読む）。患者・記録など「データを足す」仕事は、窓を click / type_text で操作せず、登録した場所の中の仕組みで行う: ①\`${ws.bin} run build\` ②足したい行の素の値（名前・年齢・症状のような人が決める値だけ）を、その app 用の入力 file に Edit で書く。priority・id・順番のように規則で決まる列は手で書かない（app の規則と食い違い、推測になる）。それを出すのは、app の source の規則（triage_core など）を使う小さな CLI で、人が登録した command を \`${ws.bin} run <名前>\` で走らせる。無い時は source に CLI の target を足して build し、人に登録の 1 行（cmd-add）を伝えて止まる（あなたは登録できない） ③app を起こす登録は起動引数つき（例 --load <file>）で、人が普通に起こした時の振る舞いは変えない。引数を読む行が無ければ source に足す ④\`${ws.bin} launch <名前>\` ⑤\`act window_image\` で絵を読み、足した物が見えるか確かめる（ImGui など自前描画の窓は要素が読めないので絵で）。\n\n${text}`;
      if (cs.length) text = `人が登録した command: ${cs.map((c) => c.name).join(", ")}。走らせるなら \`${ws.bin} run <名前>\`（名前だけ・引数は足せない・毎回人が承認します。面が要るので、無ければ人に面を渡してもらうか、登録した app を \`${ws.bin} launch\` で起こす。編集器は開かない）。返事に出力の末尾と全文の path が出るので、全文は Read で読めます。登録の無い command は走らせられません。\n\n${text}`;
    }
    if (!lease && !opts.webDriver && !webPeers.size) text = text.replace(TAB_ASK, EXT_ASK); // W16b: 拡張が繋がっていない間は、渡せない tab を頼まず拡張を入れる手順を頼む
    if (lease && screen !== "claude") text = `画面の 1 手（どの要素を押すか・どの欄に書くか）は、要素を自分で選ばず \`${ws.bin} step "<この段でしたい事>" [--text "<入れる文字>"]\` に任せてください（速い判定 model が窓の要素から選び、同じ門を通して実行します）。「実行しません」と返ったら、act で自分で選んで続けてください。何をするかの理解と段の分け、結果を読んで次へ進むか終わるかは、あなたが決めます。\n\n${text}`;
    const mcp: string[] = [];
    if (browser) {
      const cfg = join(r.dir, "browser-mcp.json");
      writeFileSync(cfg, JSON.stringify({ mcpServers: { browser: { command: "npx", args: ["-y", "chrome-devtools-mcp@1.10.1", "--browserUrl", browser, "--usageStatistics", "false"] } } }));
      mcp.push("--mcp-config", cfg);
    }
    // mod の MCP（人が on にした宣言の command だけ。modRun は必ず面を持つので、面で外すと mod の API が無くなる = on の時の人の許可が境（W11e-3）。env の値が入るので、agent が Read できる作業場所ではなく常駐の置き場に 0600 で置き、turn が終わったら消す（tmpdir は gemini の囲いが読みを戻すので置かない・review14）
    let polPath = ""; // gemini の policy（turn の間だけ要る＝終わりに消す。消さないと turn ごとに tmp に残った・tmpleak-1）
    const modCfg = f.cli === "claude" && r.mod && Object.keys(r.mod.mcp).length ? join(uiHome(), `kangae-mod-${r.id}-${r.turns}.json`) : null;
    if (modCfg) { writeFileSync(modCfg, JSON.stringify({ mcpServers: r.mod!.mcp }), { mode: 0o600 }); mcp.push("--mcp-config", modCfg); }
    const resumed = r.sessionId; // この spawn が --resume するか（W26b: 失敗した時に捨てて 1 回やり直す判断に使う）
    const nodesReal = () => { try { return realpathSync(ws.dir); } catch { return ws.dir; } };
    const cmd =
      f.cli === "claude"
        ? [f.path, "-p", text, ...(resumed ? ["--resume", resumed] : []), "--output-format", "stream-json", "--verbose",
            "--permission-mode", "acceptEdits", "--setting-sources", "project", "--allowedTools", tools, // user の設定（無印の Bash を許す人も居る）を読まない = 許す道具は上の tools だけ（E2・UC-o3 で実測）
            "--add-dir", join(uiHome(), "shots"), "--add-dir", myWin, "--add-dir", myAtt, ...mcp,
            ...(r.agent ? ["--append-system-prompt", agentPrompt(r.agent, ws.bin, agents.entries(r.agent))] : [])] // 記憶は config dir を替えず（login が外れる・実測）system prompt で渡す
        : f.cli === "codex"
          ? [f.path, "exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=false", text]
          : [f.path, "-p", text, "--approval-mode", "auto_edit"]; // 画面を出さず、file の編集だけ自動で許す（shell は許さない）
    if (f.cli !== "claude") { // 記憶は --append-system-prompt が無いので頼みの前に枠で付ける。止まりの文は stderr に出るので 1 本にまとめる
      const body = r.agent ? `${memoryFrame(agents.entries(r.agent))}\n\n${text}` : text;
      cmd[cmd.indexOf(text)] = body;
      cmd.unshift("/bin/sh", "-c", `exec "$0" "$@" 2>>'${errFile}'`); // 止まりの文は stderr に出る。答えには混ぜず、止まりの判定にだけ使う
      if (f.cli === "gemini" && !process.env.KANGAE_NO_SANDBOX) {
        const pol = polPath = join(tmpdir(), `kangae-gemini-policy-${r.id}.toml`);
        writeFileSync(pol, GEMINI_NO_WEB);
        cmd.push("--admin-policy", pol); // gemini の flag（sh の "$@" に入る）
        cmd.unshift("/usr/bin/sandbox-exec", "-p", writeSandbox(r.dir, geminiReadDirs(f.path) ?? [])); // 作業場所の外には OS が書かせず、人の home は読ませない
      }
    }
    const spawnEnv = { ...f.env, ...(f.cli === "gemini" ? { GEMINI_CLI_TRUST_WORKSPACE: "true" } : {}), KANGAE_OWNER: `s:${r.nodeId}`, KANGAE_ASK: orig.replace(/\s+/g, " ").slice(0, 40), ...(r.agent ? { KANGAE_AGENT: r.agent, KANGAE_TURN: `${r.turns}回目: ${text.replace(/\s+/g, " ").slice(0, 30)}` } : {}) };
    const p = ws.spawn(cmd, r.dir, lease ? { ...spawnEnv, KANGAE_LEASES: JSON.stringify(names), ...(faces.length === 1 ? { KANGAE_LEASE: tokenOf(lease) } : {}) } : spawnEnv);
    r.proc = p;
    const releaseBrowser = browser ? headlessHold(home) : null; // turn の間は agent 専用の Chrome を止めない
    const timer = setTimeout(() => { say(r, "⏱ 20 分を超えたので止めました"); p.kill(); }, TURN_MS);
    let heard = false;
    const silentMs = opts.noReplyMs ?? noReplyWait();
    let noReplyLine = "";
    const silent = setTimeout(() => { if (!heard) say(r, noReplyLine = `⏳ 起こして ${Math.round(silentMs / 1000)} 秒たっても ${r.cli} から応答がありません。原因の候補: login が切れている・ネットワークが無い・上限に達した。次の一手: 「止める」を押し、ターミナルで ${r.cli} を 1 回開いて確かめてください`); }, silentMs);
    let result = "";
    let isErr = false;
    const lines = lineReader((l) => {
      let ev: any;
      try { ev = JSON.parse(l); } catch { if (f.cli !== "claude") { result += l + "\n"; say(r, l.slice(0, 160)); } return; }
      if (ev.session_id) { r.sessionId = ev.session_id; if (r.agent) agents.finish(r.agent, { sessionId: r.sessionId, nodesDir: nodesReal() }); } // nodesDir = この session を作った時の作業場所（起動時に今と違えば捨てる・W26b）
      if (ev.type === "result") { result = String(ev.result ?? ""); isErr = ev.is_error === true; }
      const s = logLine(ev);
      if (s) say(r, s);
    });
    (async () => {
      for await (const c of p.stdout) {
        if (!heard) {
          heard = true; clearTimeout(silent);
          const i = noReplyLine ? r.log.indexOf(noReplyLine) : -1; // 文を出した後に返った＝誤報: 「遅れていました」に置き換える
          if (i >= 0) r.log[i] = `✅ 起こすのが ${r.cli} で遅れていました（機械が混んでいます）。動いています`;
        }
        lines(c);
      }
      const code = await p.exited;
      clearTimeout(timer);
      clearTimeout(silent);
      releaseBrowser?.();
      if (modCfg) try { unlinkSync(modCfg); } catch {}
      if (polPath) try { unlinkSync(polPath); } catch {}
      if (r.proc !== p) return; // 止めた turn の exit が、もう始まった次の turn（代わる → すぐ続けて）の後に届いた: 状態・持ち主の後始末は次の turn の物なので触らない（W7o・UC-h2）
      r.proc = undefined;
      const taken = leases.takeSteps(`s:${r.nodeId}`); // 操作の列（道具名・要素の種類だけ）を取り出して捨てる。蒸留は成功した走りだけ
      const wasMod = !!r.mod;
      vault.end(`s:${r.nodeId}`);
      await carry.end(`s:${r.nodeId}`); // 運んだログインは頼みの終わりで context ごと捨てる（止まった・失敗した turn でも）
      if (r.turns !== mine) return; // carry.end を待つ間に次の turn が始まった（exit が resume の直前に届いた）: 以降の後始末・failed は次の turn の物を潰す（review16-1・全 suite でだけ落ちた）
      leases.endTurn(`s:${r.nodeId}`); // 「この頼みの間」の許しはここで消える（止まった・失敗した turn でも）
      sched.end(`s:${r.nodeId}`); // 定時の印も turn の終わりで消える（次の人の turn に残さない）
      if (r.status === "stopped") { r.mod = undefined; return; }
      let err = "";
      if (f.cli !== "claude") { try { err = readFileSync(errFile, "utf8"); unlinkSync(errFile); } catch {} }
      if (f.cli === "claude" && resumed && RESUME_LOST.test(`${result}\n${err}`)) { // W26b: 前の続きが見つからない（作業場所の path が替わった等）。sessionId を捨てて、同じ頼みで 1 回だけ新しく始める（名前と記憶は残る）。次は --resume が付かないので繰り返さない
        r.sessionId = undefined;
        if (r.agent) agents.finish(r.agent, { sessionId: undefined, nodesDir: undefined });
        say(r, "↻ 前の続きが見つからないので、新しく始めます（名前と記憶は残っています）");
        await turn(r, orig, shown);
        return;
      }
      const stop = judgeStop(`${result}\n${err}`.trim(), code !== 0 || isErr || !result.trim());
      if (stop) { await failover(r, stop, orig, shown, ((ls) => (ls.find((l) => DEAD_GEMINI.test(l)) ?? ls.find((l) => l.trim()))?.slice(0, 120))(`${result}\n${err}`.split("\n"))); return; }
      r.mod = undefined;
      if (code !== 0 || !result.trim()) { r.status = "failed"; r.need = needOf(undefined, result) ?? undefined; say(r, `✗ 終わり方がおかしい（${code}）。指示を出すと続きから頼めます`); memo(r, "failed", "終わり方がおかしかった（指示を出すと続きから頼めます）"); if (r.agent) { agents.finish(r.agent, { unread: true, answer: "✗ うまく終われませんでした。指示を出すと続きから頼めます", answeredAt: Date.now() }); opts.broadcast?.({ type: "roots" }); } return; }
      const split = splitNext(result);
      say(r, `🤖 ${splitCards(`🤖 ${split.body || result}`).body.replace(/^🤖\s*/, "").trim().split("\n")[0]!.slice(0, 200)}`);
      const at = store.get(r.nodeId);
      if (at && at.deletedAt === null) {
        const reply = store.add(r.nodeId, "user", `🤖 ${r.role ?? r.cli}: ${(split.body || result.trim()).slice(0, 4000)}`, true);
        store.addNext(reply.id, split.next);
      }
      writeFileSync(join(r.dir, `agent-${new Date().toISOString().replace(/[:.]/g, "-")}.md`), result);
      r.status = "idle";
      const d = taken && !wasMod ? distill(taken.app, taken.steps) : null; // mod の走りは蒸留しない（同じ物を増やさない）
      if (taken && d) {
        const hit = mods.bump(taken.app, d.shape);
        if (hit) store.add(r.nodeId, "user", `🧩 同じ形の手順です。新しい mod は作らず「${hit.key}」に寄せました（${hit.count} 回）`, true);
        else { offers.set(r.nodeId, { app: taken.app, d }); store.add(r.nodeId, "user", `🧩 この手順を覚えますか（${taken.app}・${d.steps.length} 手）。歯車の「覚えた物」で「手順として覚える」を押すと、許可 off の下書きができます`, true); }
        opts.broadcast?.({ type: "mods" });
      }
      if (!wasMod && ![...pressHub.active.values()].some((x) => x.node === r.nodeId)) { const po = pressOffer(join(uiHome(), "ops.jsonl"), r.nodeId, turnAt, ((t) => (looksSecret(t) ? "" : t))(store.get(r.nodeId)?.text ?? "")); if (po) { pressHub.offers.set(r.nodeId, po.offer); store.add(r.nodeId, "user", po.line, true); } } // W62: 「覚えますか？」（押す操作の走りの中の turn は出さない）
      if (r.agent) { // 終わりの知らせ = 一覧の未読の印と答えの 1 行（bar の中だけ。OS の通知は出さない）
        agents.finish(r.agent, { unread: true, answer: (split.body || result).trim().split("\n")[0]!.slice(0, 200), answeredAt: Date.now() });
        opts.broadcast?.({ type: "roots" });
      }
      const next = r.queue.shift();
      if (next) {
        if (next.rowId != null) r.rowId = next.rowId;
        await turn(r, next.text, undefined, next.scheduled === true);
      }
    })();
  }

  const view = (r: Run) => ({ id: r.id, nodeId: r.nodeId, role: r.role, cli: r.cli, status: r.status, log: r.log.slice(-8), queue: r.queue.length, rowId: r.rowId, switched: r.switched, screen: r.screen, stop: r.stop, startedAt: r.startedAt, updatedAt: r.updatedAt, dir: r.dir, need: r.need });

  const ptys = makePtys((msg) => opts.broadcast?.(msg));

  const fromCli = (o: unknown) => typeof (o as { write?: unknown } | null)?.write === "function"; // unix socket（agent の CLI）から来た印。panel / 拡張の owner は {}（startWeb）
  async function handle(m: Msg, owner?: unknown): Promise<Res> {
    switch (m.op) {
      case "ping":
        return { ok: true };
      case "status":
        return { ok: true, mouths: (await getMouths()).map((x) => x.name) };
      case "setKey":
        if (!saveKey || !m.provider || !PROVIDERS.includes(m.provider)) return { ok: false, code: "failed", hint: "この操作は使えません" };
        await saveKey(m.provider, m.key ?? "");
        return { ok: true, mouths: (await getMouths()).map((x) => x.name) };
      case "extPlace": { // 人が押した時だけ: 拡張を置き場に写し、人の Chrome 用の host manifest を 1 file 書き、Finder で見せる（試験は KANGAE_CHROME_DIR で隔離・KANGAE_NO_OPEN で Finder を出さない）
        const hostBinary = hostBinaryOf(process.execPath, compiled);
        if (!hostBinary) return { ok: false, hint: "配る形（.app）で起きている時だけ置けます" };
        const r = placeExtension({ src: join(compiled ? join(dirname(process.execPath), "..") : join(import.meta.dir, ".."), "extension"), home, chromeDir: resolvePath("KANGAE_CHROME_DIR", () => join(homedir(), "Library/Application Support/Google/Chrome")), hostName: (await import("./launch.ts")).HOST_NAME, hostBinary, origin: EXT_ORIGIN });
        if (!process.env.KANGAE_NO_OPEN) Bun.spawn(["open", "-R", join(r.dest, "manifest.json")], { stdout: "ignore", stderr: "ignore" });
        return { ok: true, dir: r.dest, host: r.host };
      }
      case "add": {
        const text = (m.text ?? "").trim();
        if (!text) return { ok: false, hint: "一言を入れてください" };
        return { ok: true, node: store.add(null, "user", text, true) };
      }
      case "rename": {
        const text = (m.text ?? "").trim();
        if (!text) return { ok: false, hint: "名前を入れてください" };
        const before = m.rootId == null ? null : store.get(m.rootId);
        const node = m.rootId == null ? null : store.rename(m.rootId, text);
        if (!node || !before) return { ok: false, hint: "session が見つかりません" };
        // 作業場所は名前から決まる。前の名前の folder に作業の file があれば、新しい名前へ移す（新しい名前の folder が無い時だけ）
        try {
          const from = join(ws.dir, folderName(before));
          const to = join(ws.dir, folderName(node));
          if (from !== to && existsSync(from) && !existsSync(to)) renameSync(from, to);
        } catch {}
        opts.broadcast?.({ type: "roots" });
        opts.broadcast?.({ type: "desktop" });
        return { ok: true, node };
      }
      case "chat": {
        const root = m.rootId == null ? null : store.get(m.rootId);
        if (!root || root.parentId !== null) return { ok: false, hint: "session が見つかりません" };
        // 会話 = 根から下の一言と返事を古い順に 1 本。次の一手は、いちばん新しい行にぶら下がる押していない物だけ
        const rows = store.tree(root.id).filter((n) => n.kind === "user" && n.id !== root.id).map((n) => ({ id: n.id, ...rowView(n.text, (id) => att.meta(`s:${root.id}`, id)), createdAt: n.createdAt }));
        const last = rows.at(-1);
        const next = last ? store.children(last.id).filter((n) => n.kind === "next" && !n.chosen).slice(0, 3).map((n) => ({ id: n.id, text: n.text })) : [];
        return { ok: true, rows, next };
      }
      case "send": {
        const root = m.rootId == null ? null : store.get(m.rootId);
        if (!root || root.parentId !== null || root.deletedAt !== null) return { ok: false, hint: "session が見つかりません" };
        const sentAtts = (attPend.get(root.id) ?? []).map((id) => att.meta(`s:${root.id}`, id)).filter((x) => x);
        const text = (m.text ?? "").trim() || (sentAtts.length ? "添付を見てください" : "");
        if (!text) return { ok: false, hint: "一言を入れてください" };
        attPend.delete(root.id);
        const row = store.add(root.id, "user", (m.via === "phone" ? PHONE_MARK : "") + (sentAtts.length ? `${text}\n${sentAtts.map((x) => `[[att:${x!.id}]]`).join(" ")}` : text), true); // R2: スマホから送った行は「📱 」で始まる（Mac の画面で分かる。agent に渡す task は印なし）
        if (m.nodeId != null && store.get(m.nodeId)?.kind === "next") store.choose(m.nodeId); // 押した一手は、その回の 3 つから外れる
        const shot = pending.get(root.id);
        pending.delete(root.id);
        const notes = sentAtts.map((x) => attNote({ id: x!.id, kind: x!.kind, name: x!.name, size: x!.size, path: x!.path, view: x!.view })).join("\n");
        const task = ([shot, notes].filter(Boolean).join("\n") ? `${[shot, notes].filter(Boolean).join("\n")}\n\n${text}` : text) + CARD_RULE + NEXT_RULE;
        const plan = planUi(text);
        if (plan.kind === "color" || plan.kind === "text") {
          const ui = plan.kind === "color" ? writeUi(uiHome(), plan.color) : writeUi(uiHome(), null, plan.text);
          if (!ui) return { ok: false, row, gate: "ui", hint: UI_HINT };
          return { ok: true, row, ui: pushUi(ui) };
        }
        if (plan.kind === "fail") return { ok: false, row, gate: "ui", hint: UI_HINT };
        const existing = [...runs.values()].filter((r) => r.nodeId === root.id).at(-1);
        const work = existing
          ? await handle({ op: "instruct", runId: existing.id, text: task, rowId: row.id })
          : await handle({ op: "workspace", nodeId: root.id, agent: true, text: task, rowId: row.id });
        if (!work.ok) return { ok: false, row, hint: work.hint, need: needOf(work.code as string | undefined, String(work.hint ?? "")) };
        const runId = existing?.id ?? (work.run as { id: string } | undefined)?.id;
        return { ok: true, row, runId };
      }
      case "attach": {
        // bar が囲んだ画面（PNG の base64）と文脈を、今の会話（既定は最新の session）に貼る
        let root = m.rootId == null ? store.roots()[0] : store.get(m.rootId);
        if (!root && m.rootId == null) { // 初めて使う人: session が 1 つも無ければ作る
          root = store.add(null, "user", "囲んだ画面", true);
          opts.broadcast?.({ type: "roots" });
        }
        if (!root || root.parentId !== null || root.deletedAt !== null) return { ok: false, hint: "session が見つかりません" };
        const png = Buffer.from(String(m.image ?? ""), "base64");
        if (png.length < 8 || png.subarray(1, 4).toString() !== "PNG") return { ok: false, hint: "画像が空です" };
        const dir = join(uiHome(), "shots");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${Date.now()}.png`);
        writeFileSync(file, png);
        const ctx = (m.text ?? "").trim();
        const note = `📎 画面を囲んだ\n${ctx}\n画像: ${file}`;
        pending.set(root.id, `ユーザーが画面の一部を囲みました。画像（Read で開いて見る）: ${file}\n${ctx}`);
        const row = store.add(root.id, "user", note, true);
        opts.broadcast?.({ type: "history", rootId: root.id });
        return { ok: true, row, rootId: root.id, file };
      }
      case "attachChunk": { // W75a: panel の「＋」/ drop。512KB ずつ。会話の att/ に置き、次の送信で agent に path を渡す
        const root = m.rootId == null ? null : store.get(m.rootId);
        if (!root || root.parentId !== null || root.deletedAt !== null) return { ok: false, hint: "session が見つかりません" };
        const r = att.chunk(`s:${root.id}`, m);
        if (!r.ok || !r.done) return r;
        attPend.set(root.id, [...(attPend.get(root.id) ?? []), r.att.id]);
        return { ok: true, done: true, att: { id: r.att.id, kind: r.att.kind, name: r.att.name, size: r.att.size, view: r.att.view } };
      }
      case "attachList": { // まだ送っていない添付（panel を開き直しても chip が戻る）
        const root = m.rootId == null ? null : store.get(m.rootId);
        if (!root || root.parentId !== null || root.deletedAt !== null) return { ok: false, hint: "session が見つかりません" };
        const items = (attPend.get(root.id) ?? []).map((id) => att.meta(`s:${root.id}`, id)).filter((x) => x).map((x) => ({ id: x!.id, kind: x!.kind, name: x!.name, size: x!.size, view: x!.view }));
        return { ok: true, items };
      }
      case "attachThumb": { // 縮小絵 1 枚（その会話の画像だけ・押して拡げる時は w を大きく）
        const root = m.rootId == null ? null : store.get(m.rootId);
        if (!root || root.parentId !== null) return { ok: false, hint: "session が見つかりません" };
        const jpeg = att.thumb(`s:${root.id}`, m.attId, m.w);
        return jpeg ? { ok: true, jpeg } : { ok: false, hint: "絵は出せません" };
      }
      case "attachRead": { // W75d: 人が「保存」を押した時。512KB ずつ（1MB の壁）。その会話の添付だけ・人（panel）だけ
        const root = m.rootId == null ? null : store.get(m.rootId);
        if (!root || root.parentId !== null) return { ok: false, hint: "session が見つかりません" };
        const c = att.readChunk(`s:${root.id}`, m.attId, m.seq);
        return c ?? { ok: false, hint: "その添付は読めません" };
      }
      case "attachOpen": { // W91: pdf / video の chip を人が押した時。人の既定の app で開く（人の操作＝前面に出てよい・openLink と同じ道）。agent（CLI）の口からは開けない・開けるのは種類が pdf / video の file だけ（実行できる物は att に置かれない）
        const root = m.rootId == null ? null : store.get(m.rootId);
        if (!root || root.parentId !== null) return { ok: false, hint: "session が見つかりません" };
        const a = att.meta(`s:${root.id}`, m.attId);
        if (!a || (a.view !== "pdf" && a.view !== "video")) return { ok: false, hint: "その添付は、別の app では開けません（保存してください）" };
        const ok = await (opts.openFile ?? (async (x: string) => (await Bun.spawn(["open", x], { stdout: "ignore", stderr: "ignore" }).exited) === 0))(a.path);
        return ok ? { ok: true } : { ok: false, hint: "開けませんでした" };
      }
      case "openLink": { // W75d: agent が送った link を人が押した時（人の操作＝前面に出てよい）。http(s) だけ・agent（CLI）の口からは開けない
        const raw = String(m.url ?? "");
        let u: URL; try { u = new URL(raw); } catch { return { ok: false, hint: "URL が読めません" }; }
        if (!/^https?:$/.test(u.protocol) || raw.length > 2000 || u.username || u.password) return { ok: false, hint: "開けるのは http(s) の URL だけです" };
        const ok = await (opts.openLink ?? (async (x: string) => (await Bun.spawn(["open", x], { stdout: "ignore", stderr: "ignore" }).exited) === 0))(u.href);
        return ok ? { ok: true } : { ok: false, hint: "開けませんでした" };
      }
      case "authAnswer": { // W76a: 認証 card への返事（人の画面だけ）。done = 済ませた → agent に続きを頼む・deny = やめる（旗は残す）。自動（allow / always）と登録は W76c / d
        const t = leases.authTake(String(m.authId ?? ""), m.choice);
        if (!t.ok) return t;
        const run = [...runs.values()].find((x) => `s:${x.nodeId}` === t.card.owner);
        if (t.choice === "done") {
          if (run) await handle({ op: "instruct", runId: run.id, text: "認証は人が済ませました。画面を読み直して、続きから進めてください（入力欄の中身は見ていません）" });
          else leases.humanDone(t.card.owner);
          return { ok: true };
        }
        if (t.choice === "deny") {
          leases.authDismiss(t.card.owner);
          if (run) await handle({ op: "instruct", runId: run.id, keepGate: true, text: "人は認証をしないことにしました。この画面は人にしかできない確認が残っています。続けずに、ここで止まって、何ができなかったかを 1 行で人に伝えてください" });
          return { ok: true };
        }
        if (t.choice === "allow" || t.choice === "always") { // local agent が入れる。always は登録済みの host×口にだけ・人の画面から（agent の op には無い）
          const r = await runAuto(t.card);
          if (!r.ok) return { ok: false, hint: r.hint };
          if (t.choice === "always" && (t.card.kind === "password" || t.card.kind === "otp")) setAlways(uiHome(), t.card.host, t.card.kind, true);
          return { ok: true };
        }
        if (t.choice === "register" && t.card.web && (t.card.kind === "password" || t.card.kind === "otp")) { // W76d: この host×口 を金庫の項目に結ぶ（人の画面だけ・保存は項目の id の参照だけ）
          const host = new URL(t.card.host).hostname.toLowerCase();
          const c = await vault.candidates(host);
          if (!c.ok) return { ok: false, hint: c.hint };
          if (!c.items.length) return { ok: false, hint: `金庫に ${host} の項目がありません。Bitwarden に項目を作ってから、もう一度「登録する」を押してください` };
          const pick = typeof m.itemId === "string" ? c.items.find((x) => x.id === m.itemId) : c.items.length === 1 ? c.items[0] : undefined;
          if (!pick) return { ok: true, pick: c.items }; // 複数ある時は人が選ぶ（名前だけ見せる）
          registerAuth(uiHome(), host, t.card.kind, pick.id);
          opts.broadcast?.({ type: "leases" });
          return { ok: true, registered: true };
        }
        return { ok: false, hint: "その選択肢はまだ使えません" };
      }
      case "attachRemove": { // chip の ×。まだ送っていない物だけ（送った物は会話の記録なので消さない）
        const root = m.rootId == null ? null : store.get(m.rootId);
        if (!root || root.parentId !== null || root.deletedAt !== null) return { ok: false, hint: "session が見つかりません" };
        const mine = attPend.get(root.id) ?? [];
        if (typeof m.attId !== "string" || !mine.includes(m.attId)) return { ok: false, hint: "その添付はもうありません" };
        att.remove(`s:${root.id}`, m.attId);
        attPend.set(root.id, mine.filter((x) => x !== m.attId));
        return { ok: true };
      }
      case "leaseGive": {
        // bar で指した窓（pid + window_id）を、会話（その会話の agent）に渡す。同時に動ける agent は 2 つまで
        const root = m.rootId == null ? store.roots()[0] : store.get(m.rootId);
        if (!root || root.parentId !== null || root.deletedAt !== null) return { ok: false, hint: "session が見つかりません" };
        const title = String(m.title ?? "").slice(0, 120);
        let surface: Surface;
        let here: boolean | undefined;
        if (m.tabId != null) {
          // web の tab: 拡張に文書の印を取らせる（同時に人の入力の見張りも入る）。読めない tab（chrome:// など）は渡せない
          if (!Number.isInteger(m.tabId)) return { ok: false, hint: "tab が分かりません" };
          // 回数を残す理由: 1 回ごとが既に 8 秒の時間締切で、読むだけ（副作用なし）の問い合わせを 2 回送り直すだけ
          // 拡張の sw が冷えている・混んでいる時は最初の 1 回が 8 秒の返事待ちで落ちる（H7: load 100 超で web-lease / web-w2f が赤）。応答が無かった時だけ最大 3 回まで
          let got = await (opts.webDriver ?? web).call("tab_info", { tabId: m.tabId });
          for (let i = 0; i < 2 && !got.data && got.text === "ブラウザが応答しません"; i++) got = await (opts.webDriver ?? web).call("tab_info", { tabId: m.tabId });
          const info = got.data as { docId?: string; title?: string; url?: string; here?: boolean } | null;
          if (!info?.docId) return { ok: false, hint: `その tab は渡せません（chrome:// などの面・または読み込み中です）${got.text ? `［原文: ${got.text.slice(0, 200)}］` : ""}` };
          here = info.here; // 拡張が教える「人が今この tab を見ているか」（窓が前面で選択中）
          surface = { tabId: m.tabId!, docId: info.docId, app: "web", title: (title || info.title || info.url || "").slice(0, 120), url: info.url };
        } else {
          if (!Number.isInteger(m.pid) || !Number.isInteger(m.windowId)) return { ok: false, hint: "窓が分かりません" };
          if (/chrom/i.test(String(m.app ?? ""))) {
            // browser の窓を指した: 窓ではなく、その窓の今見ている tab を渡す（同じ 1 つの口。窓の題 = 「tab の題 - app 名」で引く）。1 つに決まらなければ渡さない
            const ids = ((await (opts.webDriver ?? web).call("tab_by_title", { title })).data as { tabIds?: number[] } | null)?.tabIds ?? [];
            if (ids.length !== 1) return { ok: false, hint: ids.length ? "同じ題の tab が複数あり、どれか決められません。panel の「今開いている tab を渡す」で渡してください" : "その窓の tab を見つけられませんでした（chrome:// などの面・または拡張が応答しません）" };
            return handle({ ...m, tabId: ids[0], pid: undefined, windowId: undefined });
          }
          surface = { pid: m.pid!, windowId: m.windowId!, app: String(m.app ?? "").slice(0, 80), title };
        }
        const g = leases.give(surface, `s:${root.id}`, here);
        return g.ok ? { ok: true, rootId: root.id, lease: g.lease } : { ok: false, hint: g.why };
      }
      case "urlTabs": { // H1: Bar（拡張の外）に落ちた URL。拡張に同じ URL の tab を聞く（人の操作なので無ければ裏で開く）。panel が 1 つに決めて leaseGive を打つ
        let url = "";
        try { const u = new URL(String(m.url ?? "")); if (u.protocol === "http:" || u.protocol === "https:") url = u.href; } catch {}
        if (!url) return { ok: false, hint: "http(s) の URL だけ渡せます" };
        if (!opts.webDriver && webPeers.size === 0) return { ok: false, hint: "Chrome の Kangae を開いてください" };
        const d = opts.webDriver ?? web;
        const found = await d.call("tabs_by_url", { url });
        if (found.isError) return { ok: false, hint: found.text || "Chrome の Kangae を開いてください" };
        const tabs = ((found.data as { tabs?: { id: number; title?: string }[] } | null)?.tabs ?? []).filter((t) => Number.isInteger(t.id));
        if (tabs.length) return { ok: true, tabs: tabs.map((t) => ({ id: t.id, title: String(t.title ?? "").slice(0, 120) })) };
        const opened = await d.call("open_tab", { url });
        const o = opened.data as { tabId?: number; title?: string } | null;
        if (opened.isError || !Number.isInteger(o?.tabId)) return { ok: false, hint: opened.text || "tab を開けませんでした" };
        return { ok: true, tabs: [{ id: o!.tabId!, title: String(o!.title ?? "").slice(0, 120) }] };
      }
      case "dropApp": { // H1: Finder の .app を落とした（名前だけ届く）。card 無しで裏で起こし、その窓をこの会話に渡す
        const root = m.rootId == null ? null : store.get(m.rootId);
        if (!root || root.parentId !== null || root.deletedAt !== null) return { ok: false, hint: "session が見つかりません" };
        const out = await leases.openAppHuman(`s:${root.id}`, String(m.name ?? "").replace(/\.app$/i, ""));
        return out.ok ? { ok: true, text: out.text } : { ok: false, hint: out.hint };
      }
      case "undoLast": // 一望の「1 手戻す」: 門の記録の最後の 1 手だけ（戻せる物だけ・理由 1 行）。人が押す物なので承認は挟まない
        return await leases.undo(`s:${m.rootId}`);
      case "leaseTakeback":
        return { ok: leases.takeback(String(m.key ?? "")) };
      case "webHello": // 拡張の native host が繋がった（以後の web の依頼はここへ送ってよい）。言うだけでは足りない: 口が browser の起こした host かを OS に聞く（W8g-5・src/peer.ts）。確かめる道が無ければ受けない
        helloing.add(owner);
        { // true 以外 = 断る（{app, why} は人に見せてよい理由・最後の 1 つだけ覚えて最初の画面に出す）。同じ口の確認は共有（W8g-5c）
          const p = verifying.get(owner) ?? Promise.resolve().then(() => opts.isExtension?.(owner)).then((ok) => ok ?? false, () => false as const);
          verifying.set(owner, p);
          const ok = await p;
          verifying.delete(owner);
          if (ok !== true) { helloing.delete(owner); refusal = { ...(typeof ok === "object" ? ok : { app: "別のソフト", why: "拡張の口だと確かめられませんでした" }), at: Date.now() }; return { ok: false, hint: `${refusal.app} から繋がろうとしましたが、断りました（${refusal.why}）` }; }
        }
        if (!helloing.delete(owner)) return { ok: false }; // 確かめている間に切れた口を webPeers に残さない（codesign は混むと数秒・残ると hasWebPeer が嘘を言い依頼が死んだ口へ行く・review15）
        refusal = null;
        webPeers.add(owner);
        for (const f of webArrived.splice(0)) f();
        return { ok: true };
      case "webResult": // 拡張からの返事（返事を待っている call に渡す。id の無い返事は無視・webHello した拡張の口以外からは受けない＝他の口が偽の返事で門の判断材料を差し替えられない）
        if (!webPeers.has(owner)) await verifying.get(owner); // 確認中の口の返事は、確認が済むのを待ってから受ける
        if (!webPeers.has(owner)) return { ok: false };
        { const id = String(m.callId), to = sentTo.get(id); if (to !== undefined && to !== owner) return { ok: false }; sentTo.delete(id); }
        { const tab = fillAsk.get(String(m.callId)); fillAsk.delete(String(m.callId)); if (tab && !m.error && (!tab[1] || (m.data as { n?: number } | null)?.n === 1) && !fillOwner.has(tab[0])) fillOwner.set(tab[0], owner); }
        webWait.get(String(m.callId))?.({ text: String(m.text ?? ""), isError: !!m.error, data: m.data ?? null });
        webWait.delete(String(m.callId));
        return { ok: true };
      case "humanHello": // bar が繋がった（以後の humanSeen はこの口からだけ受ける）
        humanPeers.add(owner);
        return { ok: true };
      case "humanSeen": // bar が見た人の今（前面の app / 窓の中を押した app の pid だけ・中身は読まない）。W11d・humanHello した口以外は捨てる
        if (!humanPeers.has(owner)) return { ok: false };
        if (m.kind === "front") leases.seeFront(Number(m.pid)); else leases.seeInput({ pid: Number(m.pid) });
        return { ok: true };
      case "webSeen": // 拡張が見た人の今: 窓が前面の browser で選択中の tab（browser が前面でなければ null）・webHello した口以外は捨てる
        if (!webPeers.has(owner)) await verifying.get(owner);
        if (!webPeers.has(owner)) return { ok: false };
        leases.seeTab(m.tab == null ? null : Number(m.tab));
        return { ok: true };
      case "webEvent": // 拡張が見た「人が触った」（tab を前面にした・窓を移した・入力した）か「tab が移動した」（agent が起こした移動なら操作権を保ち、それ以外は取り戻す）
        if (m.input) leases.seeInput({ tabId: Number(m.tabId) }); // 入力した面（どの tab かだけ）
        if (m.input && leases.authOpen(`tab:${Number(m.tabId)}`)) return { ok: true, taken: 0 }; // 人が認証 card の面で認証している間の入力（agent は旗で書けない）
        if (!m.nav && !m.input && peek.justFronted(`tab:${Number(m.tabId)}`)) return { ok: true, taken: 0 }; // 猶予は「前面にした」だけ。絵を押した直後でも、頁の中の人の入力（m.input）は取り戻す
        return { ok: true, taken: m.nav ? await leases.navigated(Number(m.tabId), m.nav) : leases.touchTab(Number(m.tabId)) };
      case "peek": // 一望の絵 1 枚。visible = panel が見えている
        return await peek.shot(String(m.key ?? ""), m.visible === true, m.big === true);
      case "peekFront": { // 人が絵を押した時だけ（押した時刻を残す＝直後の「人が触った」は取り戻しにしない）
        const r = await peek.front(String(m.key ?? ""));
        if (r.ok) leases.authFronted(String(m.key ?? "")); // 認証 card の絵だった時だけ「人が操作中」になる（card が無い面では何も起きない）
        return r;
      }
      case "leaseTouch":
        return { ok: true, taken: leases.touch(Number(m.pid), (k) => peek.justFronted(k) || leases.authOpen(k)) }; // 絵を押した窓だけ見逃す（同じ app の別の窓は取り戻す）
      case "leaseReconfirm": {
        const r = leases.reconfirm(String(m.key ?? ""));
        return r.ok ? { ok: true, lease: r.lease } : { ok: false, code: r.why, hint: r.why === "no-floor" ? "世代の記録が無いので再確認できません。取り戻して渡し直してください" : "その面は渡されていません" };
      }
      case "leaseList":
        return { ok: true, leases: leases.list(), approvals: leases.approvals(), auth: leases.authCards(), recoveries: leases.recoveries(), carries: [...carry.cards(), ...vault.cards().map((c) => ({ ...c, vault: true }))], routineCards: routines.pending(), modes: leases.modes() };
      case "carry": { // agent から: 人のログインを運ぶ（人が答えるまで待つ）。owner は env の KANGAE_OWNER
        const owner = String(m.owner ?? "");
        if (!/^s:\d+$/.test(owner)) return { ok: false, code: "bad", hint: "agent の頼みの中からだけ使えます" };
        const r = await carry.ask(owner, String(m.host ?? ""));
        return r.ok ? { ok: true, text: r.text } : { ok: false, code: "refused", hint: r.hint };
      }
      case "carryRead": {
        const owner = String(m.owner ?? "");
        if (!/^s:\d+$/.test(owner)) return { ok: false, code: "bad", hint: "agent の頼みの中からだけ使えます" };
        const r = await carry.read(owner, String(m.url ?? ""));
        return r.ok ? { ok: true, text: r.text } : { ok: false, code: "refused", hint: r.hint };
      }
      case "vaultFill": { // agent から: password を金庫から入れる（人が答えるまで待つ）。url は照合にだけ使い、入れる先は tab の実際の host
        const owner = String(m.owner ?? "");
        if (!/^s:\d+$/.test(owner)) return { ok: false, code: "bad", hint: "agent の頼みの中からだけ使えます" };
        const r = await vault.fill(owner, String(m.url ?? ""));
        return r.ok ? { ok: true, text: r.text } : { ok: false, code: "refused", hint: r.hint };
      }
      case "runCmd": { // agent から: 人が登録した command を名前で走らせる（毎回 card・面を持つ turn だけ・W17a）
        const owner = String(m.owner ?? "");
        if (!/^s:\d+$/.test(owner)) return { ok: false, code: "bad", hint: "agent の頼みの中からだけ使えます" };
        const r = [...runs.values()].find((x) => `s:${x.nodeId}` === owner);
        if (!r) return { ok: false, code: "bad", hint: "その頼みは動いていません" };
        const out = await leases.runCmd(owner, String(m.name ?? ""), { uiHome: uiHome(), workDir: realpathSync(r.dir), sock: socketPath() });
        recordOp(join(uiHome(), "ops.jsonl"), owner, `runCmd:${String(m.name ?? "")}`, [], out); // W62: 押す操作の材料
        return out.ok ? { ok: true, text: out.text, error: out.isError } : { ok: false, code: out.why, hint: out.hint };
      }
      case "op": { // agent から: desktop の op を名前で呼ぶ（W41・read は card 無し・write は毎回 card）
        const owner = String(m.owner ?? "");
        if (!/^s:\d+$/.test(owner)) return { ok: false, code: "bad", hint: "agent の頼みの中からだけ使えます" };
        const r = [...runs.values()].find((x) => `s:${x.nodeId}` === owner);
        if (!r || r.status !== "running") return { ok: false, code: "bad", hint: "その頼みは動いていません" };
        const out = await leases.opRun(owner, String(m.app ?? ""), String(m.name ?? ""), m.slots && typeof m.slots === "object" ? m.slots : {});
        recordOp(join(uiHome(), "ops.jsonl"), owner, `op:${String(m.app ?? "")}/${String(m.name ?? "")}`, Object.keys(m.slots ?? {}), out); // W62: 押す操作の材料
        return out.ok ? { ok: true, text: out.text, error: out.isError } : { ok: false, code: out.why, hint: out.hint };
      }
      case "sendOut": { // W75c: agent から人へ（kangae send）。card なし（人に見せるだけ）。送れるのは自分の作業場所の file・借りた面の絵（先に撮った window_image）・http(s) の URL だけ
        const o = String(m.owner ?? "");
        if (!fromCli(owner) || !/^s:\d+$/.test(o)) return { ok: false, code: "bad", hint: "agent の頼みの中からだけ使えます" };
        const run = [...runs.values()].find((x) => `s:${x.nodeId}` === o && x.status === "running");
        const root = run ? store.get(run.nodeId) : null;
        if (!run || !root || root.parentId !== null || root.deletedAt !== null) return { ok: false, code: "bad", hint: "その頼みは動いていません" };
        const sent = (sends.get(o) ?? []).filter((t) => Date.now() - t < 60_000);
        if (sent.length >= 10) return { ok: false, code: "bad", hint: "短い間に送りすぎです（1 分に 10 件まで）。まとめて 1 つにしてください" };
        const cap = shownText(m.text ?? "", 200);
        const who = run.role ?? run.cli;
        let marker: string;
        if (m.kind === "link") {
          let u: URL; const raw = String(m.arg ?? "");
          try { u = new URL(raw); } catch { return { ok: false, code: "bad", hint: "URL が読めません" }; }
          if (!/^https?:$/.test(u.protocol) || raw.length > 2000 || u.username || u.password) return { ok: false, code: "bad", hint: "送れるのは http(s) の URL だけです（認証情報つき・javascript: ・file: は送れません）" };
          marker = `[[link: ${u.href.replace(/[\]|｜\n]/g, encodeURIComponent)} | ${shownText(m.title ?? "", 80).replace(/[\]|｜]/g, " ")}]]`;
        } else if (m.kind === "screenshot" || m.kind === "file" || m.kind === "image") {
          const wd = winDir(uiHome(), o);
          let src = String(m.arg ?? "");
          if (m.kind === "screenshot") {
            const imgs = (() => { try { return readdirSync(wd).filter((f) => /\.(png|jpe?g)$/i.test(f)).map((f) => ({ f, t: statSync(join(wd, f)).mtimeMs })).sort((a, b) => b.t - a.t); } catch { return []; } })();
            if (!imgs.length) return { ok: false, code: "bad", hint: "送れる画面の絵がありません。借りている画面で先に `act window_image '{}'` を撮ってから送ってください（新しくは撮りません。web の tab は絵を撮る道がありません）" };
            src = join(wd, imgs[0]!.f);
          }
          const c = att.copyIn(o, src, [run.dir, attDir(uiHome(), o), wd], m.kind === "file" ? undefined : "image");
          if (!c.ok) return { ok: false, code: "bad", hint: c.hint };
          marker = `[[att:${c.att.id}]]`;
        } else return { ok: false, code: "bad", hint: "種類は screenshot / file / image / link です" };
        sends.set(o, [...sent, Date.now()]);
        const row = store.add(root.id, "user", `🤖 ${who}: ${cap ? `${cap}\n` : ""}${marker}`, true);
        opts.broadcast?.({ type: "history", rootId: root.id });
        return { ok: true, row: row.id };
      }
      case "role": { // W60b2: 担当名。agent（CLI・kangae role）は自分の会話の名前だけ・人（panel）は rootId の会話の名前を付け直す / 消す。人が付けた名前を agent は変えられない
        if (fromCli(owner) || m.owner != null) {
          const o = String(m.owner ?? "");
          if (!/^s:\d+$/.test(o)) return { ok: false, code: "bad", hint: "agent の頼みの中からだけ使えます" };
          if (![...runs.values()].some((x) => `s:${x.nodeId}` === o && x.status === "running")) return { ok: false, code: "bad", hint: "その頼みは動いていません" };
          const g = setRole(uiHome(), Number(o.slice(2)), m.role, "agent");
          if (g.ok) opts.broadcast?.({ type: "roots" });
          return g.ok ? { ok: true, role: g.role } : { ok: false, code: "bad", hint: g.hint };
        }
        const root = m.rootId == null ? null : store.get(m.rootId);
        if (!root || root.parentId !== null || root.deletedAt !== null) return { ok: false, hint: "session が見つかりません" };
        const g = setRole(uiHome(), root.id, m.role, "human");
        if (g.ok) opts.broadcast?.({ type: "roots" });
        return g.ok ? { ok: true, role: g.role } : { ok: false, hint: g.hint };
      }
      case "launchApp": { // agent から: 人が登録した app を名前で待たずに起こす（毎回 card・面を持つ turn だけ・W17a）
        const owner = String(m.owner ?? "");
        if (!/^s:\d+$/.test(owner)) return { ok: false, code: "bad", hint: "agent の頼みの中からだけ使えます" };
        const r = [...runs.values()].find((x) => `s:${x.nodeId}` === owner);
        if (!r || r.status !== "running") return { ok: false, code: "bad", hint: "その頼みは動いていません" }; // 終わった turn の名残の process が env の owner で呼んでも起こさない（review23）
        const out = await leases.launchApp(owner, String(m.name ?? ""), { uiHome: uiHome(), workDir: realpathSync(r.dir), sock: socketPath() });
        return out.ok ? { ok: true, text: out.text, error: out.isError } : { ok: false, code: out.why, hint: out.hint };
      }
      case "apiRun": { // agent から: api-anything（読む call は card 無し・add / capture / login は毎回 card・W35）
        const owner = String(m.owner ?? "");
        if (!/^s:\d+$/.test(owner)) return { ok: false, code: "bad", hint: "agent の頼みの中からだけ使えます" };
        const r = [...runs.values()].find((x) => `s:${x.nodeId}` === owner);
        if (!r || r.status !== "running") return { ok: false, code: "bad", hint: "その頼みは動いていません" };
        const out = await runApi(String(m.verb ?? ""), Array.isArray(m.args) ? (m.args as unknown[]).map(String) : [], {
          vendor: join(home, "vendor/api-anything"), dataHome: join(home, "api-anything"),
          ask: async (d) => (await leases.confirmApi(owner, d)) ?? { ok: true },
          cdpUrl: () => ws.browserUrl(true),
          run: async (cmd, env) => {
            const { API_ANYTHING_TAB, ...rest } = env, token = API_ANYTHING_TAB ? crypto.randomUUID() : ""; // W35c: call は人の tab の中で再生する（process ごとの印つき）
            if (token) apiTokens.set(token, owner);
            try {
              const p = Bun.spawn(cmd, { env: { ...(process.env as Record<string, string>), ...rest, ...(token ? { API_ANYTHING_TAB_SOCK: socketPath(), API_ANYTHING_TAB_TOKEN: token } : {}) }, stdout: "pipe", stderr: "pipe" });
              const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
              return { code: await p.exited, out: o || e };
            } finally { apiTokens.delete(token); }
          },
        });
        if (m.verb === "call" && Array.isArray(m.args)) { const a = (m.args as unknown[]).map(String); recordOp(join(uiHome(), "ops.jsonl"), owner, `api:${a[0] ?? ""}/${a[1] ?? ""}`, a.slice(2).map((x) => x.split("=")[0]!), out.ok ? out : { ok: false, why: "api" }); } // W62: 押す操作の材料
        return out.ok ? { ok: true, text: out.out } : { ok: false, code: "api", hint: out.hint };
      }
      case "apiFetch": { // W35c / W46-B: 走っている api-anything（印つき）から: 読む request だけを、その会話に貸した tab の中で fetch する（cookie は Chrome に残る・貸していない site の tab は最初の 1 回だけ card で「貸す」と聞く）
        const owner = typeof m.token === "string" ? apiTokens.get(m.token) : undefined;
        if (!owner) return { ok: false, code: "bad", hint: "api の呼び出しの中からだけ使えます" };
        const method = String(m.method ?? "GET").toUpperCase();
        if (!["GET", "HEAD"].includes(method)) return { ok: false, code: "bad", hint: `api の call は読むだけです（${method} は通しません）。書く操作は tab の名前つき操作（fill / press_button）で、人の承認のもとに` };
        let origin = "";
        try { const u = new URL(String(m.url)); if (!/^https?:$/.test(u.protocol)) throw 0; origin = u.origin; } catch { return { ok: false, code: "bad", hint: "http(s) の URL だけです" }; }
        const tab = await leases.apiTab(owner, origin);
        if (!tab.ok) return { ok: false, code: "api", hint: tab.hint };
        const hs = m.headers && typeof m.headers === "object" ? Object.fromEntries(Object.entries(m.headers as Record<string, unknown>).filter(([k, v]) => typeof v === "string" && k.toLowerCase() !== "cookie")) : {};
        const r = await web.call("api_fetch", { url: m.url, method, headers: hs, tabId: tab.tabId });
        return r.isError ? { ok: false, code: "api", hint: r.text } : { ok: true, res: r.data };
      }
      case "touchCmds": // 人の cmd-add の直後: 登録した場所を 1 回開く（確認は人が居る今ここで出す）。答えを待たずに返す
        void touchCmdDirs(uiHome());
        return { ok: true, dirs: loadCmds(uiHome()).length };
      case "editors": { // W38: 「見る」で開く app の候補（/Applications を読むだけ・app は起こさない）と今の選択
        const list = listEditors();
        return { ok: true, editors: list, current: readViewer(uiHome(), list) };
      }
      case "viewer": { // W38: 人が「見る」で開く app を選ぶ（候補に無い名前は書かない・agent の CLI からは変えられない）
        return writeViewer(uiHome(), String(m.app ?? ""), listEditors()) ? { ok: true } : { ok: false, code: "bad", hint: "その app は候補にありません" };
      }
      case "remembered": { // W78p: 歯車の「覚えた許し」。覚えた許しを 1 画面に（認証の always・聞かずに開く・書き込みの always allow）。host / app の名前と口の種類だけ（値も item の参照も出さない）
        const items = [
          ...alwaysList(uiHome()).map((x) => ({ id: `auth|${x.host}|${x.kind}`, label: `${x.host} の${x.kind === "otp" ? "認証コード" : "パスワード"}の入力` })),
          ...(existsSync(join(uiHome(), "open-allow")) ? [{ id: "open", label: "必要な tab や app を、聞かずに裏で開く" }] : []),
          ...Object.entries(leases.modes()).filter(([k, v]) => k !== "default" && v === "allow").map(([app]) => ({ id: `write|${app}`, label: `${app} の操作` })),
        ];
        return { ok: true, items };
      }
      case "forget": { // 覚えた許しを 1 件だけ戻す（聞くに戻す）。人だけ（agent の CLI・owner つきは不可）。id は一覧で返した物だけ・無い id は何もしない
        const [what, a1, a2] = String(m.id ?? "").split("|");
        if (what === "auth" && a1 && (a2 === "password" || a2 === "otp")) { if (!alwaysList(uiHome()).some((x) => x.host === a1 && x.kind === a2)) return { ok: false, hint: "もう覚えていません" }; setAlways(uiHome(), a1, a2, false); }
        else if (what === "open" && m.id === "open") { try { unlinkSync(join(uiHome(), "open-allow")); } catch { return { ok: false, hint: "もう覚えていません" }; } }
        else if (what === "write" && a1 && (leases.modes() as Record<string, string>)[a1] === "allow") leases.setMode(a1, "ask");
        else return { ok: false, hint: "もう覚えていません" };
        return handle({ op: "remembered" }, owner);
      }
      case "openMode": { // W78o: agent が必要な tab / app を聞かずに裏で開く（既定は聞く＝ask）。人が Bar で切り替える（agent の CLI・owner つきは変えられない）。on = open-allow file の有無（lease の openMode が読む・書く操作の Mode とは別の値）
        const f = join(uiHome(), "open-allow");
        if (m.on === undefined) return { ok: true, on: existsSync(f) };
        try { if (m.on === true) writeFileSync(f, ""); else if (m.on === false) { if (existsSync(f)) unlinkSync(f); } else return { ok: false, code: "bad", hint: "on は true / false" }; } catch { return { ok: false, code: "failed", hint: "設定を書けませんでした" }; }
        return { ok: true, on: existsSync(f) };
      }
      case "namedOnly": { // W42c: tab で名前つき操作（press_button / fill / select_option）で済む相手への生の click / type_text を断る設定（既定 off）。人が Bar で切り替える（agent の CLI・owner つきは変えられない）。on = named-only file の有無（lease の namedOnly が読む）
        const f = join(uiHome(), "named-only");
        if (m.on === undefined) return { ok: true, on: existsSync(f) };
        try { if (m.on === true) writeFileSync(f, ""); else if (m.on === false) { if (existsSync(f)) unlinkSync(f); } else return { ok: false, code: "bad", hint: "on は true / false" }; } catch { return { ok: false, code: "failed", hint: "設定を書けませんでした" }; }
        return { ok: true, on: existsSync(f) };
      }
      case "cursorOverlay": { // W39c: agent のカーソルを見せる（既定 off）。人が Bar の歯車で切り替える（agent の CLI・owner つきは変えられない）。on = cursor-overlay file の有無（lease の showCursor が読む）
        const f = join(uiHome(), "cursor-overlay");
        if (m.on === undefined) return { ok: true, on: existsSync(f) };
        try { if (m.on === true) writeFileSync(f, ""); else if (m.on === false) { if (existsSync(f)) unlinkSync(f); } else return { ok: false, code: "bad", hint: "on は true / false" }; } catch { return { ok: false, code: "failed", hint: "設定を書けませんでした" }; }
        return { ok: true, on: existsSync(f) };
      }
      case "remote": { // R1: スマホで操作（QR を出す・「このスマホを許可」・解除）。人（Bar / 拡張）だけ＝agent の CLI・owner つきは断る（agent が自分で「許可」を押せない）
        const r = opts.remote;
        if (!r) return { ok: false, code: "failed", hint: "この常駐ではスマホで操作は使えません" };
        switch (m.action) {
          case "start": return r.start();
          case "allow": return r.allow();
          case "cancel": return r.cancel();
          case "revoke": return r.revoke(m.id == null ? undefined : String(m.id));
          case "resumeAllow": return Number.isInteger(m.rootId) && typeof m.on === "boolean" ? r.setResume(m.rootId!, m.on) : { ok: false, code: "bad", hint: "rootId と on（true / false）を渡してください" };
          default: return r.status();
        }
      }
      case "draft": { // W42a S1: カタログに無い操作の下書き（agent の頼みの中から・実行 0・人に残して止まる）
        const owner = String(m.owner ?? "");
        if (!/^s:\d+$/.test(owner)) return { ok: false, code: "bad", hint: "agent の頼みの中からだけ使えます" };
        const r = [...runs.values()].find((x) => `s:${x.nodeId}` === owner);
        if (!r || r.status !== "running") return { ok: false, code: "bad", hint: "その頼みは動いていません" };
        const own = leases.facesOf(owner).filter((x) => x.confirmed), tok = m.on != null ? faceNames(own)[String(m.on)] : undefined;
        const l = tok ? own.find((x) => tokenOf(x) === tok) : own[0];
        const out = addDraft(uiHome(), { owner, face: l ? `${l.surface.app}${"tabId" in l.surface ? "（tab）" : ""}` : "面なし", gen: l?.gen ?? null, op: String(m.op_name ?? ""), fields: m.fields && typeof m.fields === "object" && !Array.isArray(m.fields) ? (m.fields as Record<string, unknown>) : {}, why: String(m.why ?? "") });
        if (!out.ok) return { ok: false, code: "bad", hint: out.hint };
        try { appendOps(join(uiHome(), "ops.jsonl"), JSON.stringify({ at: Date.now(), face: l ? keyOf(l.surface) : "", app: l?.surface.app ?? "", owner, where: String(l?.surface.title ?? "").replace(/\s+/g, " ").slice(0, 40), gen: l?.gen ?? 0, op: `draft:${out.draft.op}`, value: out.draft.fields.join(","), result: "draft" }));  } catch {}
        store.add(r.nodeId, "user", draftLine(out.draft), true); // Bar の会話に見える
        opts.broadcast?.({ type: "drafts" });
        return { ok: true, text: `下書き「${out.draft.op}」を人に残しました（実行していません）。人が名前つき操作にするまで進めません。画面操作（click / type_text）で代わりに済ませないでください。ここで止まって、人に伝えてください` };
      }
      case "press": { // W62: 押す操作（list / save / run / answer / rm・中身は src/press-cli.ts）。agent の呼びは list と run だけ。再生は必ず同じ門（leases.act / opRun / runCmd・面は会話が持つ物から app で毎回引く）
        const agent = fromCli(owner) || m.owner != null, o = /^s:(\d+)$/.exec(String(m.owner ?? ""));
        const node = agent ? (o ? Number(o[1]) : null) : (m.rootId ?? store.roots()[0]?.id ?? null);
        const face = (n: number, app: string) => leases.facesOf(`s:${n}`).find((l) => l.confirmed && l.surface.app === app);
        const gate = (r: { ok: true; text: string; isError: boolean } | { ok: false; hint: string }) => (r.ok ? { ok: !r.isError, text: r.text } : { ok: false, text: r.hint });
        const runOf = (n: number) => [...runs.values()].filter((x) => x.nodeId === n).at(-1);
        return handlePress(m, { home: uiHome(), hub: pressHub, agent, node, ext: () => webPeers.size > 0, busy: (n) => runOf(n)?.status === "running", say: (n, line) => void store.add(n, "user", line, true), deps: (n, fromAgent) => ({
          act: async (app, tool, args) => { const l = face(n, app); return l ? gate(await aims.act(leases, tokenOf(l), tool, args)) : { ok: false, text: "面がありません", noFace: true }; },
          read: async (app) => { const l = face(n, app); if (!l) return null; const r = await leases.act(tokenOf(l), "get_window_state", {}); return r.ok && !r.isError ? viewOf(String(l.surface.title ?? ""), r.text) : null; },
          op: async (app, name, slots) => gate(await leases.opRun(`s:${n}`, app, name, slots)),
          runCmd: async (name) => { const r = runOf(n); return r ? gate(await leases.runCmd(`s:${n}`, name, { uiHome: uiHome(), workDir: realpathSync(r.dir), sock: socketPath() })) : { ok: false, text: "この会話の作業場所がまだありません" }; },
          api: async () => ({ ok: false, text: "api の段の再生はまだありません" }), // ponytail: runApi の deps は apiRun の case に埋まっている。探し直し（agent）が kangae api で済ませる
          openTab: async (url) => gate(await leases.openTabFree(`s:${n}`, { url })),
          askAgent: async (text) => { // その会話の agent の 1 turn（agent 自身の押しの中では探し直さない＝同じ turn を待って詰まる）
            if (fromAgent) return { ok: false, text: "agent の頼みの中の押しなので、探し直しは agent 自身がします" };
            const ex = runOf(n), w = ex ? await handle({ op: "instruct", runId: ex.id, text }) : await handle({ op: "workspace", nodeId: n, agent: true, text });
            if (!w.ok) return { ok: false, text: String(w.hint ?? "agent を起こせませんでした") };
            for (let i = 0; i < TURN_MS / 500 && runOf(n)?.status === "running"; i++) await Bun.sleep(500); // ponytail: turn の終わりを 0.5 秒ごとに見る（turn に終わりの知らせが無い）
            const r = runOf(n);
            return { ok: r?.status === "idle", text: r?.log.at(-1) ?? "" };
          },
          now: Date.now,
        }) });
      }
      case "draftList": return { ok: true, drafts: readDrafts(uiHome()) }; // 読むだけ（人の一覧）
      case "draftDrop": { // 人だけが捨てる（agent の CLI・owner つきは断る）
        return dropDraft(uiHome(), String(m.draftId ?? "")) ? { ok: true } : { ok: false, code: "bad", hint: "その下書きはありません" };
      }
      case "opsRecent": { // W50: 人が Bar の agent の行で、その agent の直近の操作を見る（人の panel だけ・agent の呼びは断る）。ops.jsonl の読みだけ
        const at = m.rootId == null ? null : store.get(Number(m.rootId));
        if (!at || at.kind !== "user") return { ok: false, code: "failed", hint: "会話が見つかりません" };
        return { ok: true, items: recentFor(join(uiHome(), "ops.jsonl"), `s:${at.id}`) };
      }
      case "openFolder": { // W38: 人が Bar の agent の行の「見る」を押した: その agent が触った folder（作業場所と、run で人が許した登録 cwd）を、選んだ app で前に開く。人の押しだけ（agent の呼びは断る・path も app 名も受けない＝常駐が引く）
        const at = m.rootId == null ? null : store.get(Number(m.rootId));
        if (!at || at.kind !== "user") return { ok: false, code: "failed", hint: "会話が見つかりません" };
        const dirs = [...new Set([...leases.touchedOf(`s:${at.id}`), join(ws.dir, folderName(at))])].filter((d) => existsSync(d));
        if (!dirs.length) return { ok: false, code: "failed", hint: "この agent はまだ folder を触っていません" };
        const list = listEditors(), app = readViewer(uiHome(), list);
        const okAll = (await Promise.all(openArgs(app, dirs).map((a) => ws.open(a)))).every(Boolean);
        return okAll ? { ok: true, app, opened: dirs } : { ok: false, code: "failed", hint: `${app} で開けませんでした（${dirs.map((d) => d.replace(homedir(), "~")).join(" / ")}）。app が入っているか確かめてください` };
      }
      case "cmdList": // panel の「登録した command」の一覧（読むだけ・登録は人の shell の cmd-add だけ・W17b）。印が合わない物は ok:false で出す
        return { ok: true, items: loadCmds(uiHome()).map((c) => ({ name: c.name, cwd: c.cwd, line: c.argv.join(" "), at: c.at, app: c.app === true, network: c.network === true, reads: c.reads ?? [], ok: c.seal === sealOf(c) })) };
      case "vaultKey": // 人の `bw unlock --raw | kangae vault-key`: 鍵は常駐の memory だけ
        return vault.setKey(String(m.key ?? "")) ? { ok: true } : { ok: false, code: "bad", hint: "鍵の形が違います" };
      case "vaultLock": // 金庫を閉じる: 鍵を捨てる
        vault.lock();
        return { ok: true };
      case "carryForget": // card の「覚えない」: 前回の domain を消す
        return { ok: carry.forget(String(m.id ?? "")) };
      case "routineAnswer": // 人が routine の承認 card を押した（その 1 件だけ）
        return { ok: routines.answer(String(m.id ?? ""), m.yes === true) };
      case "carryAnswer": // 人が運ぶ card を押した（その 1 件だけ）
        return { ok: carry.answer(String(m.id ?? ""), m.yes === true, m.history === true) || vault.answer(String(m.id ?? ""), m.yes === true, m.vault === true) };
      case "approvalAnswer": // 人が承認の card を押した（その 1 件だけ）
        return { ok: leases.answer(String(m.id ?? ""), m.yes === true, m.scope === "turn") };
      case "leaseMode": { // 承認の表（許す / 先に聞く / 切る）。key があればその面だけ・無ければ app 単位（人が明示）・app "*" = 既定
        const mode = String(m.mode);
        if (!["allow", "ask", "off"].includes(mode) || typeof m.app !== "string" || !m.app) return { ok: false, hint: "allow / ask / off のどれかを app 名と一緒に" };
        leases.setMode(m.app, mode as "allow" | "ask" | "off", typeof m.key === "string" && m.key ? m.key : undefined); // key = 面（その窓だけ）。無ければ app 単位＝「この app の全部の窓」と人が明示した時
        return { ok: true, modes: leases.modes() };
      }
      case "mods": { // 一覧（置いた mod・on / off・読めません）。app = 前面の app 名（札に出す物に印を付ける）
        const front = typeof m.app === "string" ? m.app.toLowerCase() : "";
        const of = typeof m.rootId === "number" ? offers.get(m.rootId) : undefined;
        return { ok: true, offer: of ? { app: of.app, steps: of.d.steps.length } : null, mods: mods.list().map((x) => !x.ok ? x : { ok: true, key: x.key, app: x.app, name: x.name, label: x.label, permission: x.permission, on: x.on, runs: x.runs, origin: x.origin, seen: x.seen, front: !!front && x.app.toLowerCase() === front }) };
      }
      case "distillMake": { // 「mod にしますか」→ 押した: 下書きを off で置く（on の記録は作らない）
        const of = offers.get(Number(m.rootId));
        if (!of) return { ok: false, hint: "作れる手順がありません" };
        const title = store.get(Number(m.rootId))?.text.replace(/\s+/g, " ").slice(0, 30) ?? "";
        const g = mods.write(of.app, of.d.name, { label: of.d.label, permission: of.d.permission, prompt: of.d.prompt }, { by: "distill", note: looksSecret(title) ? "" : title }, { shape: of.d.shape, count: 1 });
        if (g.ok) { offers.delete(Number(m.rootId)); opts.broadcast?.({ type: "mods" }); }
        return g;
      }
      case "distillNo": offers.delete(Number(m.rootId)); opts.broadcast?.({ type: "mods" }); return { ok: true };
      case "modWrite": { // AI が mod を書く唯一の口（kangae mod-write）。形・秘密をここで見て、必ず off・出所に頼みの 1 行目を残す
        const by = String(m.by ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        const g = mods.write(String(m.app ?? ""), String(m.name ?? ""), m.spec && typeof m.spec === "object" ? m.spec : {}, { by: "ai", note: looksSecret(by) ? "" : by });
        if (g.ok) opts.broadcast?.({ type: "mods" });
        return g;
      }
      case "modOn": {
        const r = mods.setOn(String(m.key ?? ""), m.yes === true);
        if (r.ok) opts.broadcast?.({ type: "mods" });
        return r;
      }
      case "modRun": { // 札を押した: 人がその窓を渡したのと同じ扱い（leaseGive と同じ口）で、mod の手順をこの会話の agent に頼む
        const mod = mods.get(String(m.key ?? ""));
        if (!mod) return { ok: false, hint: "その mod は見つかりません" };
        if (!mod.ok) return { ok: false, hint: `読めません: ${mod.error}` };
        if (!mod.on) return { ok: false, hint: "この mod は許可が off です（一覧で on にすると動きます）" };
        if (mod.app.toLowerCase() !== String(m.app ?? "").toLowerCase()) return { ok: false, hint: `この mod は「${mod.app}」用です` };
        const root = m.rootId == null ? store.roots()[0] : store.get(m.rootId);
        if (!root || root.parentId !== null || root.deletedAt !== null) return { ok: false, hint: "session が見つかりません" };
        if ([...runs.values()].some((x) => x.nodeId === root.id && x.status === "running")) return { ok: false, hint: "この会話の agent がいま動いています。終わってから押してください" };
        let windowId = m.windowId;
        if (!Number.isInteger(m.pid)) return { ok: false, hint: "窓が分かりません" };
        if (windowId == null) { // 窓は常駐が pid から引く（bar に新しい口を足さない）
          const d = (opts.leaseDriver ?? cuaDriver)(`kangae-mod-${process.pid}-${crypto.randomUUID()}`);
          if (!d) return { ok: false, hint: "画面を読む道具（cua-driver）が見つかりません" };
          try {
            const wins = ((await d.call("list_windows", {})).data?.windows ?? []) as { pid: number; window_id: number; on_current_space?: boolean }[];
            windowId = (wins.find((w) => w.pid === m.pid && w.on_current_space !== false) ?? wins.find((w) => w.pid === m.pid))?.window_id;
          } finally { d.close(); }
          if (windowId == null) return { ok: false, hint: `「${mod.app}」の窓が見つかりません` };
        }
        const g = await handle({ op: "leaseGive", rootId: root.id, pid: m.pid, windowId, app: mod.app, title: m.title });
        if (!g.ok) return g;
        leases.setCap(`s:${root.id}`, mod.permission === "read" ? "read" : undefined);
        modNext.set(root.id, mod);
        const row = store.add(root.id, "user", `🧩 ${mod.label}`, true);
        const task = `「${mod.label}」を進めてください。` + CARD_RULE + NEXT_RULE;
        const existing = [...runs.values()].filter((x) => x.nodeId === root.id).at(-1);
        const work = existing
          ? await handle({ op: "instruct", runId: existing.id, text: task, rowId: row.id })
          : await handle({ op: "workspace", nodeId: root.id, agent: true, text: task, rowId: row.id });
        if (!work.ok) { modNext.delete(root.id); leases.setCap(`s:${root.id}`, undefined); return { ok: false, row, hint: work.hint }; }
        return { ok: true, row, runId: existing?.id ?? (work.run as { id: string } | undefined)?.id };
      }
      case "stopAll": { // 全停止: 全部の面の操作権を取り戻し（承認待ちも実行しない）、動いている全 agent の turn を止める
        const taken = leases.stopAll();
        for (const r of routines.pending()) routines.declineAgent(r.agent);
        vault.endAll();
        await carry.endAll();
        let stopped = 0;
        for (const r of runs.values()) { r.queue = []; if (r.status === "running") { r.status = "stopped"; say(r, "■ 全部止めました"); r.proc?.kill(); stopped++; } }
        return { ok: true, taken, stopped };
      }
      case "act": {
        // W23: 面を 1 枚も持たない会話の agent が最初の app / tab を開く（open_app・open_tab だけ。承認 card は毎回）。他の操作は面が要る
        if (!m.lease && m.on == null && (m.tool === "open_app" || m.tool === "open_tab") && /^s:\d+$/.test(String(m.owner ?? ""))) { // W40: 最初の一手は open_app か open_tab
          const r = await (m.tool === "open_tab" ? leases.openTabFree : leases.openAppFree)(String(m.owner), m.args && typeof m.args === "object" ? m.args : {});
          return r.ok ? { ok: true, text: r.text, error: r.isError } : { ok: false, code: r.why, hint: r.hint };
        }
        // W16b: turn の途中で開いた面（open_tab）は env の名前に無い。その名前だけ、常駐が持ち主（env の KANGAE_OWNER）の今の面の名前で引く（生の token は受けない）
        // W30: open_app の返事は `act --on '<token>'` と案内する（面なしで始めた turn は env に面が無く、CLI は token を送れず owner と on だけを送る）。on が名前でなく**持ち主が今持っている面の token と完全に一致**する時だけ、その token で通す（他人の token・世代の違う token・作った token は一致せず「という面はありません」）
        const own = /^s:\d+$/.test(String(m.owner ?? "")) ? leases.facesOf(String(m.owner)).filter((l) => l.confirmed) : [];
        const tok = m.on != null && /^s:\d+$/.test(String(m.owner ?? "")) ? faceNames(own)[String(m.on)] ?? own.map(tokenOf).find((t) => t === String(m.on)) : String(m.lease ?? "");
        if (tok === undefined) return { ok: false, code: "face", hint: `「${String(m.on)}」という面はありません。持っている面: ${Object.keys(faceNames(own)).join(" / ") || "無し"}` };
        const r = await aims.act(leases, tok, String(m.tool ?? ""), m.args && typeof m.args === "object" ? m.args : {});
        return r.ok ? { ok: true, text: r.text, error: r.isError } : { ok: false, code: r.why, hint: r.hint };
      }
      case "step": { // W5c: 画面の 1 手を decision model に選ばせる。実行は必ず門（leases.act）を通す
        const tok = String(m.lease ?? "");
        const l = leases.list().find((x) => x.token === tok);
        if (!l) return { ok: false, code: "bad", hint: "操作権がありません（面を渡された会話の agent だけが動かせます）" };
        const engine = readEngine(uiHome());
        const run = [...runs.values()].filter((x) => `s:${x.nodeId}` === l.owner).at(-1);
        const stat = run ? (run.screen ??= { engine, steps: 0, ms: 0 }) : undefined;
        if (stat) stat.engine = engine;
        const r = await screenStep({ engine, home: uiHome(), gate: (tool, args) => leases.act(tok, tool, args), what: String(m.what ?? ""), text: typeof m.text === "string" ? m.text : undefined, app: l.surface.app, title: l.surface.title, stat });
        if (stat) opts.broadcast?.({ type: "roots" });
        return { ok: true, text: r.text, error: !r.ok };
      }
      case "screenEngine": { // 画面の操作を誰に任せるか（既定 claude）。d1 / jev にする時は窓の文字が外へ出る事を返す
        if (m.engine !== undefined) {
          if (!ENGINES.includes(m.engine as Engine)) return { ok: false, hint: "claude / d1 / jev のどれかを" };
          writeEngine(uiHome(), m.engine as Engine);
        }
        const engine = readEngine(uiHome());
        return { ok: true, engine, sends: sendsLine(engine) };
      }
      case "setUi": {
        const ui = typeof m.color === "string" ? writeUi(uiHome(), m.color) : null;
        if (!ui) return { ok: false, hint: "色の名前か #RGB を書いてください" };
        return { ok: true, ui: pushUi(ui) };
      }
      case "clearUi":
        return { ok: true, ui: pushUi(clearUi(uiHome())) };
      case "ui":
        return { ok: true, ui: readUi(uiHome()) };
      case "desktopPlace": {
        const cards = readDesktop(uiHome());
        let card: Card;
        if (m.kind === "session" || m.kind === "terminal") {
          const root = m.rootId == null ? null : store.get(m.rootId);
          if (!root || root.parentId !== null || root.deletedAt !== null) return { ok: false, code: "failed", hint: "その session は無い" };
          card = { key: `${m.kind === "session" ? "s" : "x"}:${root.id}`, kind: m.kind, rootId: root.id, x: 0, y: 0 };
        } else if (m.kind === "tab") {
          if (!isWeb(m.url)) return { ok: false, code: "failed", hint: "http か https の頁だけ置けます" };
          let host = m.url!;
          try { host = new URL(m.url!).host; } catch {}
          card = { key: `t:${m.url}`, kind: "tab", url: m.url, title: (m.title ?? "").trim() || host, ...(isWeb(m.icon) ? { icon: m.icon } : {}), x: 0, y: 0 };
        } else return { ok: false, code: "failed", hint: "session・tab・terminal を置けます" };
        const name = card.kind === "tab" ? card.title! : card.kind === "terminal" ? `${store.get(card.rootId!)!.text} のターミナル` : store.get(card.rootId!)!.text;
        if (cards.some((c) => c.key === card.key)) return { ok: true, already: true, key: card.key, name };
        const spot = unitOf(m.x) !== null && unitOf(m.y) !== null ? { x: unitOf(m.x)!, y: unitOf(m.y)! } : freeSpot(cards);
        writeDesktop(uiHome(), [...cards, { ...card, ...spot }]);
        opts.broadcast?.({ type: "desktop" });
        return { ok: true, key: card.key, name };
      }
      case "desktopMove": {
        const x = unitOf(m.x), y = unitOf(m.y);
        const cards = readDesktop(uiHome());
        if (x === null || y === null || !cards.some((c) => c.key === m.key)) return { ok: false, code: "failed", hint: "その札は無い" };
        writeDesktop(uiHome(), cards.map((c) => (c.key === m.key ? { ...c, x, y } : c)));
        opts.broadcast?.({ type: "desktop" });
        return { ok: true };
      }
      case "desktopWindow": {
        const win = winOf(m.win);
        const cards = readDesktop(uiHome());
        if (!win || !cards.some((c) => c.key === m.key)) return { ok: false, code: "failed", hint: "その札は無い" };
        writeDesktop(uiHome(), cards.map((c) => (c.key === m.key ? { ...c, win } : c)));
        opts.broadcast?.({ type: "desktop" });
        return { ok: true };
      }
      case "desktopRemove": {
        const cards = readDesktop(uiHome());
        if (!cards.some((c) => c.key === m.key)) return { ok: true };
        writeDesktop(uiHome(), cards.filter((c) => c.key !== m.key));
        opts.broadcast?.({ type: "desktop" });
        return { ok: true };
      }
      case "desktopList": {
        const out = readDesktop(uiHome()).flatMap((c): Record<string, unknown>[] => {
          if (c.kind === "tab") return [{ key: c.key, kind: c.kind, name: c.title || c.url, url: c.url, icon: c.icon, x: c.x, y: c.y, win: c.win }];
          const root = store.get(c.rootId!);
          return root && root.parentId === null && root.deletedAt === null ? [{ key: c.key, kind: c.kind, rootId: c.rootId, name: c.kind === "terminal" ? `${root.text} のターミナル` : root.text, x: c.x, y: c.y, win: c.win }] : [];
        });
        return { ok: true, cards: out };
      }
      case "providers":
        return { ok: true, providers: await findProviders() };
      case "roots":
        // 一覧の行の元: 最後の行（人の行か返事か）・時刻・「あなたの番」（最後が返事で、答えを待つ card が付いている）
        const named = agents.list(); // 2 秒ごとの poll で会話の数だけ file を読まない
        const roles = rolesOf(uiHome()); // W60b2: 担当名（1 回だけ読む）
        return {
          ok: true,
          roots: store.roots().map((r) => {
            const l = store.tree(r.id).filter((n) => n.kind === "user" && n.id !== r.id).at(-1);
            const v = l && rowView(l.text);
            const a = named.find((x) => x.nodeId === r.id);
            return { ...r, role: roles.get(r.id) ?? null, agent: a && { name: a.name, unread: a.unread, answer: a.answer ?? null, answeredAt: a.answeredAt ?? null, routines: routines.of(a.name).map((x) => ({ id: x.id, label: specLabel(x.spec), enabled: x.enabled, note: x.note ?? null })) }, last: l ? { id: l.id, text: v!.text.replace(/^🤖\s*[^:：]+[:：]\s*/, ""), at: l.createdAt, mine: !l.text.startsWith("🤖"), turn: v!.cards.some((c) => c.kind !== "done") } : null };
          }),
        };
      case "all":
        return { ok: true, nodes: store.all() };
      case "addTabs": {
        const at = m.nodeId == null ? null : store.get(m.nodeId);
        if (!at || at.kind !== "user") return { ok: false, code: "failed", hint: "タブを入れられるのは一言の段だけです" };
        return { ok: true, added: store.addTabs(at.id, m.tabs ?? []) };
      }
      case "todo": {
        // 人（画面）と agent（kangae todo）が同じ todo を動かす。AI は使わない
        const at = m.nodeId == null ? null : store.get(m.nodeId);
        if (!at || at.kind !== "user") return { ok: false, code: "failed", hint: "todo を持てるのは一言の段だけです" };
        const cur = store.todoOf(at.id);
        const t: Todo = (cur?.data as Todo | null) ?? { type: "todo", items: [] };
        const text = (m.text ?? "").trim();
        const i = Number(m.index) - 1;
        const save = (next: Todo) => (cur ? store.setData(cur.id, next)! : store.addComponent(at.id, "やること", next));
        switch (m.action ?? "list") {
          case "list":
            return { ok: true, node: cur, text: todoText(t) };
          case "make": {
            // その節に無ければ作り、あれば足りない項目だけ足す
            const have = new Set(t.items.map((x) => x.text));
            const add = todoSeed(store, at.id).filter((x) => !have.has(x));
            const node = save({ type: "todo", items: [...t.items, ...add.map((x) => ({ text: x, done: false }))] });
            return { ok: true, node, added: add.length, created: !cur };
          }
          case "add":
            if (!text) return { ok: false, code: "empty", hint: "項目を書いてください" };
            return { ok: true, node: save({ type: "todo", items: [...t.items, { text: text.slice(0, 200), done: false }] }), text: todoText({ type: "todo", items: [...t.items, { text, done: false }] }) };
          case "done":
          case "undo": {
            if (!t.items[i]) return { ok: false, code: "failed", hint: `${m.index} 番の項目がありません（${t.items.length} 個）` };
            const next: Todo = { type: "todo", items: t.items.map((x, n) => (n === i ? { ...x, done: m.action === "done" } : x)) };
            return { ok: true, node: save(next), text: todoText(next) };
          }
          default:
            return { ok: false, code: "failed", hint: `知らない操作: ${m.action}` };
        }
      }
      case "note": {
        // agent からの書き戻し。その節の下に一言として足す
        const at = m.nodeId == null ? null : store.get(m.nodeId);
        const text = (m.text ?? "").trim();
        if (!at || at.deletedAt !== null || !text) return { ok: false, code: "failed", hint: "節の番号と一言を渡してください" };
        return { ok: true, node: store.add(at.kind === "user" ? at.id : at.parentId, "user", `🤖 メモ: ${text.slice(0, 500)}`, true) }; // agent の書き戻しは相手の発言（自分の吹き出しにしない）
      }
      case "context": {
        const at = m.nodeId == null ? null : store.get(m.nodeId);
        if (!at) return { ok: false, code: "failed", hint: "節が見つかりません" };
        let browser: string | null = null;
        try { browser = await ws.browserUrl(false); } catch { browser = null; }
        return { ok: true, text: contextMarkdown(store, at.id, ws.bin, undefined, browser) };
      }
      case "workspace": {
        // 役割の部品から起こす時は、その役割の作業場所（節の作業場所の下）
        const picked = m.nodeId == null ? null : store.get(m.nodeId);
        const roles = picked?.kind === "component" && (picked.data as Component | null)?.type === "roles" ? (picked.data as Roles).roles : null;
        const role = roles && m.role != null ? roles[m.role] : undefined;
        const at = roles ? (picked!.parentId == null ? null : store.get(picked!.parentId)) : picked;
        if (!at || at.kind !== "user" || (roles && !role)) return { ok: false, code: "failed", hint: "作業場所を持てるのは一言の段と役割だけです" };
        const base = join(ws.dir, folderName(at));
        const dir = role ? join(base, role.name.replace(/[\/:\\\n\r\t]+/g, " ").trim().slice(0, 30)) : base;
        mkdirSync(dir, { recursive: true });
        let browser: string | null = null;
        try { browser = await ws.browserUrl(false); } catch { browser = null; }
        writeFileSync(join(dir, "AGENTS.md"), contextMarkdown(store, at.id, ws.bin, role && { ...role, others: roles!.filter((r) => r !== role).map((r) => r.name) }, browser));
        writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
        if (m.dirOnly) return { ok: true, dir };
        if (!m.agent) return (await ws.open(["-a", "Terminal", dir])) ? { ok: true, dir } : { ok: false, code: "failed", hint: `ターミナルを開けませんでした（${dir}）` };
        const cli = (await ws.clis())[0];
        if (!cli) return { ok: false, code: "none", hint: "agent がいません。claude か codex を入れてください。gemini は有料の API key がある時だけ使えます", dir };
        if (running() >= AGENT_LIMIT) return { ok: false, code: "failed", hint: `同時に動ける agent は ${AGENT_LIMIT} つまでです。終わるか止めてから` };
        const rec = role ? null : agents.byNode(at.id); // 名前を持つ会話なら、常駐を再起動した後でも名前・記憶・前の続き（sessionId）を引き継ぐ
        const r = { id: crypto.randomUUID(), nodeId: at.id, role: role?.name, dir, agent: rec?.name, sessionId: rec?.sessionId, cli: cli.cli, found: cli, status: "idle" as const, log: [], queue: [], rowId: m.rowId ?? null, startedAt: Date.now(), updatedAt: Date.now() };
        runs.set(r.id, r);
        await turn(r, (m.text ?? "").trim() || agentTask(role?.name, at.id), undefined, m.scheduled === true);
        return { ok: true, dir, agent: cli.cli, run: view(r) };
      }
      case "ptyOpen": {
        const w = await handle({ op: "workspace", nodeId: m.rootId, dirOnly: true });
        if (!w.ok) return w;
        const r = ptys.open(owner, m.from, w.dir as string, m.cols, m.rows);
        return r.ok ? { ...r, dir: w.dir } : r;
      }
      case "ptyWrite":
        return { ok: ptys.write(m.ptyId ?? -1, m.data) };
      case "ptyResize":
        return { ok: ptys.resize(m.ptyId ?? -1, m.cols, m.rows) };
      case "ptyDrop":
        ptys.dropOwner(owner, m.from);
        return { ok: true };
      case "ptyClose":
        return { ok: ptys.close(m.ptyId ?? -1) };
      case "instruct": {
        // 動いている agent に指示: 動いていれば列に並べ、待機・失敗・止めたなら続きとして頼む
        const r = m.runId ? runs.get(m.runId) : undefined;
        const text = (m.text ?? "").trim();
        if (!r || !text) return { ok: false, code: "failed", hint: "agent と指示を渡してください" };
        if (m.keepGate !== true) leases.humanDone(`s:${r.nodeId}`); // 人が「続けて」「やりました」と言った＝人にしかできない確認の旗を落とす（読み直すまで書けない・図 §47）
        if (r.status === "running") { r.queue.push({ text, rowId: m.rowId ?? null, scheduled: m.scheduled === true }); say(r, `⏳ 列に並べた: ${text.slice(0, 60)}`); return { ok: true, run: view(r) }; }
        if (running() >= AGENT_LIMIT) return { ok: false, code: "failed", hint: `同時に動ける agent は ${AGENT_LIMIT} つまでです` };
        if (m.rowId != null) r.rowId = m.rowId;
        await turn(r, text, undefined, m.scheduled === true);
        return { ok: true, run: view(r) };
      }
      case "allowMetered": { // 「従量でもよい」: 人がお金がかかると知って許した AI だけ、替え先に数える（常駐の間だけ）
        if (!["claude", "codex", "gemini"].includes(String(m.engine))) return { ok: false, hint: "claude・codex・gemini のどれかを指定してください" };
        allowedMetered.add(m.engine as Cli);
        return { ok: true };
      }
      case "stopRun": {
        const r = m.runId ? runs.get(m.runId) : undefined;
        if (!r) return { ok: false, code: "failed", hint: "agent が見つかりません" };
        r.queue = [];
        if (r.status === "running") { r.status = "stopped"; say(r, "■ 止めました"); r.proc?.kill(); }
        return { ok: true, run: view(r) };
      }
      case "handover": { // 一望の「代わる」: この会話の agent だけ止め、持っていた面の操作権を人に戻す（別の会話の agent・面は触らない）
        const owner = `s:${m.rootId}`;
        const wasRunning = [...runs.values()].filter((r) => r.nodeId === m.rootId && r.status === "running").length; // revoke が先に止めるので、前に数える
        for (const r of runs.values()) if (r.nodeId === m.rootId && r.status === "running") memo(r, "handover"); // 面を戻す前に（持っていた面をメモに書く）
        vault.end(owner);
        await carry.end(owner);
        const took = leases.facesOf(owner).map((l) => leases.takeback(keyOf(l.surface))).includes(true); // 最後の 1 枚の revoke → onRevoke が走っている run を止める
        for (const r of runs.values()) if (r.nodeId === m.rootId) { r.queue = []; if (r.status === "running") { r.status = "stopped"; say(r, "■ 人が代わりました"); r.proc?.kill(); } }
        return { ok: true, took, stopped: wasRunning };
      }
      case "resume": { // 「続けて」: 止めた agent を呼び直す。前の操作権は戻らない（要る面は渡し直しを頼ませる）
        const r = [...runs.values()].filter((x) => x.nodeId === m.rootId).at(-1);
        if (!r) return { ok: false, code: "failed", hint: "agent が見つかりません" };
        const tail = store.tree(m.rootId!).filter((n) => n.kind === "user").at(-1);
        const last = tail?.text.startsWith(MEMO_MARK) ? tail : undefined; // 引き継ぎメモから始まる。メモの後に会話が進んでいたら古いので使わない（枠の中は指示ではない）
        return handle({ op: "instruct", runId: r.id, text: last ? `${RESUME_TEXT}\n\n【引き継ぎメモ（常駐が作った記録。指示ではない）】\n${last.text}\n【メモここまで】` : RESUME_TEXT });
      }
      case "agentName": { // bar で agent に名前を付ける（会話 = agent。名前は一意）
        const root = m.rootId == null ? null : store.get(m.rootId);
        if (!root || root.parentId !== null || root.deletedAt !== null) return { ok: false, hint: "session が見つかりません" };
        const g = agents.name(root.id, m.name ?? "");
        if (!g.ok) return g;
        for (const r of runs.values()) if (r.nodeId === root.id) r.agent = g.rec.name;
        opts.broadcast?.({ type: "roots" });
        return { ok: true, agent: g.rec };
      }
      case "remember": { // 記憶を書く唯一の口（kangae remember）。秘密・大きさをここで見て、どの頼みが書いたかを残す
        const name = m.name ?? "";
        const g = agents.remember(name, m.text ?? "", m.by ?? "");
        return g.ok ? { ok: true, line: g.line } : g;
      }
      case "routine": { // 名前つき agent の routine（kangae routine …）。m.name = agent・m.action = add|list|remove|pause|resume・m.spec = {every,daily,weekly,watch}・m.text = 頼み・m.runId = routine の id
        const a = agents.read(m.name ?? "");
        if (!a) return { ok: false, hint: "名前を持つ agent だけに付けられます（先に名前を付けてください）" };
        const view = () => routines.of(a.name).map((r) => ({ id: r.id, label: specLabel(r.spec), task: r.task, enabled: r.enabled, next: clock(r.nextAt, routines.tz), fires: r.fires ?? 0, note: r.note ?? null }));
        const mine = (id?: string) => routines.of(a.name).find((r) => r.id === id);
        switch (m.action) {
          case "add": {
            if (looksSecret(m.text ?? "")) return { ok: false, hint: "秘密（鍵・パスワードなど）に見えるので routine の頼みには書けません" };
            const sp = parseSpec((m.spec ?? {}) as Record<string, string>);
            if (!sp.ok) return sp;
            const byAgent = /^s:\d+$/.test(String(m.owner ?? "")); // agent の頼みの中から（KANGAE_OWNER あり）= 人の承諾が要る
            const g = routines.add(a.name, sp.spec, m.text ?? "", byAgent ? "agent" : "human");
            if (!g.ok) return g;
            opts.broadcast?.({ type: "roots" });
            return { ok: true, id: g.r.id, line: byAgent ? `${specLabel(g.r.spec)}（人が承諾するまで鳴りません。panel に確認が出ています）` : `${specLabel(g.r.spec)}（次は ${clock(g.r.nextAt, routines.tz)}）`, routines: view() };
          }
          case "list": return { ok: true, routines: view() };
          case "remove": if (!mine(m.runId)) return { ok: false, hint: "その routine はありません" }; routines.remove(m.runId!); opts.broadcast?.({ type: "roots" }); return { ok: true, routines: view() };
          case "pause": case "resume": {
            if (!mine(m.runId)) return { ok: false, hint: "その routine はありません" };
            routines.setEnabled(m.runId!, m.action === "resume");
            if (m.action === "pause") for (const r of runs.values()) if (r.nodeId === a.nodeId) { r.queue = []; if (r.status === "running") { r.status = "stopped"; say(r, "■ routine を止めました"); r.proc?.kill(); } } // pause = routine と走っている run をまとめて止める
            opts.broadcast?.({ type: "roots" });
            return { ok: true, routines: view() };
          }
          default: return { ok: false, hint: "add / list / remove / pause / resume のどれかです" };
        }
      }
      case "routineTick": // 試験用: 時計を進めた後に今すぐ見直させる（試験の時計がある時だけ）
        if (!process.env.KANGAE_CLOCK_FILE) return { ok: false, hint: "試験用です" };
        await routines.tick();
        return { ok: true };
      case "routineWakes": // 試験用: routine の timer が鳴った回数（待つ間の発火を数える。試験の時計がある時だけ）
        if (!process.env.KANGAE_CLOCK_FILE) return { ok: false, hint: "試験用です" };
        return { ok: true, wakes: routines.wakes() };
      case "agentRead": { // 一覧で開いた = 既読
        const a = m.rootId == null ? null : agents.byNode(m.rootId);
        if (a?.unread) { agents.finish(a.name, { unread: false }); opts.broadcast?.({ type: "roots" }); }
        return { ok: true };
      }
      case "unread": { // bar の丸い icon の赤い数: まだ見ていない報告（新しい順の root 番号）。見る = agentRead で減る
        const ids = agents.list().filter((a) => a.unread).sort((x, y) => (y.answeredAt ?? 0) - (x.answeredAt ?? 0)).map((a) => a.nodeId);
        return { ok: true, n: ids.length, rootIds: ids };
      }
      case "runs": {
        const ids = new Set(m.nodeIds ?? []);
        return { ok: true, runs: [...runs.values()].filter((r) => ids.has(r.nodeId)).map(view) };
      }
      case "remove": {
        const n = m.nodeId == null ? null : store.remove(m.nodeId);
        if (n) leases.touchedDrop(`s:${n.id}`); // W38: 消した会話の「触った folder」も忘れる
        return n ? { ok: true, node: n } : { ok: false, code: "failed", hint: "消せませんでした" };
      }
      case "restore": {
        const n = m.nodeId == null ? null : store.restore(m.nodeId);
        return n ? { ok: true, node: n, rootId: store.path(n.id)[0]!.id } : { ok: false, code: "failed", hint: "戻せませんでした" };
      }
      case "visit": {
        const node = m.rootId == null ? null : store.visit(m.rootId, m.url ?? "", m.title ?? "");
        if (node) opts.broadcast?.({ type: "history", rootId: node.parentId! });
        return { ok: true, node };
      }
      case "history":
        return { ok: true, visits: m.rootId == null ? [] : store.history(m.rootId, m.limit ?? 20) };
      case "tree":
        return { ok: true, nodes: store.tree(m.rootId ?? 0) };
      default:
        return { ok: false, code: "failed", hint: `知らない操作: ${m.op}` };
    }
  }

  // 外から入る口は run だけ（handle は中の呼び出し）。sec1: 人が押す op の入口の判定（図 §S1）は、再送の控え（done）より前に置く＝断りは控えに残らない。
  // approvalAnswer などの id は card の id（panel の call は {id: randomUUID(), op, ...extra} で extra.id が上書きする）なので、agent が card の id を先回りで送っても人の答えを塞げないよう、控えの鍵に op も入れる。
  // 人の口 = panel / Bar（startWeb の owner {}）・スマホ（remoteBridge は owner 無しで呼ぶ）・拡張（native host の 1 本の口＝webPeers）
  const run = async (m: Msg, owner?: unknown): Promise<Res> => {
    const human = Object.hasOwn(HUMAN_OPS, m.op) ? HUMAN_OPS[m.op] : undefined;
    if (human) {
      if (fromCli(owner) && !webPeers.has(owner)) await verifying.get(owner); // webHello の確認の最中の拡張の口を、agent と読まない
      if ((fromCli(owner) && !webPeers.has(owner)) || m.owner != null || m.agent) return { ok: false, code: "bad", hint: `${human}は人が押す物です（agent からは押せません）`, id: m.id };
    }
    // 同じ id の再送は、保存した結果をそのまま返す（LLM を 2 回呼ばない）
    const key = m.id ? `${m.op}:${m.id}` : undefined;
    const cached = key ? done.get(key) : undefined;
    if (cached) return cached;
    const p = handle(m, owner)
      .catch((e): Res => {
        if (e instanceof LlmError) return { ok: false, code: e.code, hint: e.hint };
        return { ok: false, code: "failed", hint: String(e?.message ?? e) };
      })
      .then((r) => ({ ...r, id: m.id }));
    if (key) {
      done.set(key, p);
      if (done.size > 200) done.delete(done.keys().next().value!);
    }
    return p;
  };
  return Object.assign(run, { hasWebPeer: () => webPeers.size > 0, lastRefusal: () => refusal, dropOwner: (owner: unknown) => { webPeers.delete(owner); helloing.delete(owner); for (const [tab, o] of fillOwner) if (o === owner) fillOwner.delete(tab); /* 切れた口を tab の持ち主に残さない（繋ぎ直した拡張が二度と選ばれない・review14） */humanPeers.delete(owner); ptys.dropOwner(owner); }, closeLeases: () => { peek.close(); leases.closeAll(); }, routines });
}

// Bun の socket.write は入りきらない分を捨てずに「書けた長さ」だけ返す。溜めて drain で続きを書く
const backlog = new WeakMap<object, Uint8Array>();
type Writable = { write(d: Uint8Array | string): number };
export function sendAll(sock: Writable, data: string) {
  const buf = Buffer.concat([backlog.get(sock) ?? Buffer.alloc(0), Buffer.from(data)]);
  backlog.set(sock, buf.subarray(sock.write(buf)));
}
export function fanout(socks: Iterable<Writable>, data: string) {
  for (const s of socks) sendAll(s, data);
}
export function flush(sock: Writable) {
  const buf = backlog.get(sock);
  if (buf?.length) backlog.set(sock, buf.subarray(sock.write(buf)));
}

function lineReader(onLine: (l: string) => void) {
  let buf = "";
  return (chunk: Uint8Array | string) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l) onLine(l);
    }
  };
}

async function alive(path: string): Promise<boolean> {
  try {
    const s = await Bun.connect({ unix: path, socket: { data() {}, error() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

// bar（浮く窓）が読む「住所と token」。別 instance（KANGAE_SOCK を替えた試験）は KANGAE_BAR を決めない限り書かない
export const barPath = () => (process.env.KANGAE_BAR || !process.env.KANGAE_SOCK ? resolvePath("KANGAE_BAR", () => join(homedir(), ".kangae/bar.json")) : null);

const sameToken = (a: string | null | undefined, b: string) => {
  const x = Buffer.from(a ?? ""), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// 127.0.0.1 だけの HTTP + WebSocket。/panel（拡張の panel.html を、assets を /x/<token>/ に向けて配る）と /ws（unix socket と同じ {id, op} を 1 message 1 件）
export function startWeb(handler: ReturnType<typeof makeHandler>, wsPeers: Set<{ send(d: string): unknown }>, token: string, extDir: string) {
  const forbidden = () => new Response("forbidden", { status: 403 });
  const server = Bun.serve<{ owner: object }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const u = new URL(req.url);
      if (u.pathname === "/") return Response.redirect(`/panel${u.search}`, 302);
      if (u.pathname === "/ws") {
        if (!sameToken(u.searchParams.get("token"), token)) return forbidden();
        return srv.upgrade(req, { data: { owner: {} } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (u.pathname === "/first") { // 初めての 1 枚（足りない物の一覧）。token が要る
        if (!sameToken(u.searchParams.get("token"), token)) return forbidden();
        return Response.json(await collectFirstRun(home, handler.hasWebPeer(), handler.lastRefusal()), { headers: { "cache-control": "no-store" } });
      }
      if (u.pathname === "/panel") {
        if (!sameToken(u.searchParams.get("token"), token)) return forbidden();
        const html = (await Bun.file(join(extDir, "panel.html")).text())
          .replace("<title>", `<base href="/x/${token}/"><meta name="kangae-token" content="${token}"><title>`)
          .replace("<html ", `<html data-bar `); // bar（浮く窓）の時だけ、頁の地をすりガラスに透かす
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      const m = u.pathname.match(/^\/x\/([0-9a-f]+)\/([\w.-]+)$/);
      if (!m || !sameToken(m[1], token)) return forbidden();
      const f = Bun.file(join(extDir, m[2]!));
      return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
    },
    websocket: {
      open: (ws) => void wsPeers.add(ws),
      message: async (ws, raw) => {
        let m: Msg;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        ws.send(JSON.stringify(await handler(m, ws.data.owner)));
      },
      close: (ws) => {
        wsPeers.delete(ws);
        handler.dropOwner(ws.data.owner);
      },
    },
  });
  return server;
}

// W8g-5: webHello してよい口 = 製品の Chromium（製品の profile）か人の Google Chrome（profile 指定無し）が起こした host。/ws の口は fd が無いので受けない。
// KANGAE_TEST_TRUST_EXT=1 は偽の拡張を使う試験だけ: source で起こし、かつ保存場所が owner の場所でない常駐だけが読む（compile した製品・本物の home の常駐は無視して 1 行 log）。
// 拒否は理由を 1 行 stderr へ（値は含まない）
export async function extensionPeer(owner: unknown, env: Record<string, string | undefined> = process.env, isCompiled = compiled, homeDir = home): Promise<true | Refusal> {
  if (env.KANGAE_TEST_TRUST_EXT === "1") {
    if (!isCompiled && !pointsAtOwner(homeDir)) return true;
    console.error("KANGAE_TEST_TRUST_EXT は試験の本体だけ（製品・本物の保存場所では無視）");
  }
  const t0 = performance.now();
  const r = await browserHost((owner as { fd?: unknown } | null)?.fd, {
    browsers: [...new Set([openLaunchOpts(home, "", isCompiled, "", env).app, join(homedir(), "Library/Application Support/Kangae/Chromium.app")])].map((a) => join(a, "Contents/MacOS/Chromium")).concat("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), // 読むだけの比較（launch.ts の CHROMIUM_APP の既定も）
    profiles: [resolvePath("KANGAE_PROFILE", () => join(home, "profile"), env)],
    origin: EXT_ORIGIN,
  });
  console.error(`webHello の口の確認 ${Math.round(performance.now() - t0)}ms${r.cached ? "（同じ口の前の確認を使った）" : ""}: ${r.ok ? "通した" : `断った: ${r.why}`}`);
  return r.ok || r.who || { app: "別のソフト", why: "拡張の口だと確かめられませんでした" };
}

// 試験が起こした常駐だけが KANGAE_PARENT_PID を持つ（test/spawn-daemon.ts）。親が居なくなったら自分で止まる。製品の起動（bar・LaunchAgent・.app）は渡さないので付かない
export function watchParent(env: Record<string, string | undefined>, stop: () => void, ms = 3000, isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; } }) {
  const pid = Number(env.KANGAE_PARENT_PID);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const t = setInterval(() => isAlive(pid) || stop(), ms);
  t.unref();
  return t;
}

// R1: スマホに見せる一覧の 1 行 = 担当名と今の状態だけ（会話の本文・最後の文は渡さない）。状態の語は panel の rowState と同じ
// 一覧の「最後の 1 文」: 1 行目だけ・60 字まで・秘密に見える物は出さない
const lastLine = (t: unknown) => { const l = String(t ?? "").replace(PHONE_MARK, "").split("\n")[0]!.trim(); return !l || looksSecret(l) ? "" : l.length > 60 ? `${l.slice(0, 60)}…` : l; };
export async function remoteRows(h: ReturnType<typeof makeHandler>, allowed: number[] = []): Promise<Row[]> {
  const r = (await h({ op: "roots" })) as { ok: boolean; roots?: any[] };
  if (!r.ok || !r.roots) return [];
  const u = (await h({ op: "runs", nodeIds: r.roots.map((x) => x.id) })) as { runs?: any[] };
  return r.roots.map((x): Row => {
    const run = (u.runs ?? []).filter((y) => y.nodeId === x.id).at(-1);
    const name = String(x.role ?? x.agent?.name ?? String(x.text ?? "").split("\n")[0]).trim().slice(0, 40) || "agent";
    const [state, label]: [Row["state"], string] =
      x.last?.turn ? ["turn", "あなたの番です"]
      : run?.status === "running" ? ["work", "動いています"]
      : run?.status === "failed" || /^[✗⛔]/.test(x.agent?.answer ?? "") ? ["fail", "失敗"]
      : run?.status === "stopped" ? ["neutral", "止まりました"]
      : x.last && !x.last.mine ? ["neutral", "終わりました"]
      : ["neutral", "まだ何も話していません"];
    return { id: x.id, name, state, label, last: lastLine(x.last?.text), stopped: run?.status === "stopped", canResume: allowed.includes(x.id) };
  });
}

// R3: スマホから再開してよい担当（root の id）。Mac の画面だけが書く・既定は 1 つも無い。鍵ではないので普通の file（0600）
const resumeFile = (home: string) => join(home, "remote-resume.json");
export function readResume(home: string): number[] {
  try { const j = JSON.parse(readFileSync(resumeFile(home), "utf8")); return Array.isArray(j.allow) ? j.allow.filter((x: unknown) => Number.isInteger(x)) : []; } catch { return []; }
}
function writeResume(home: string, id: number, on: boolean) {
  const next = [...new Set([...readResume(home).filter((x) => x !== id), ...(on ? [id] : [])])];
  writeFileSync(resumeFile(home), JSON.stringify({ allow: next }), { mode: 0o600 });
}

// R2: スマホの「会話を読む・送る・承認に答える」。人の panel と同じ op（chat の元・send・leaseList・approvalAnswer）を呼ぶ＝別の道を作らない。
// 承認に答えるのは「今回だけ」（always も「この頼みの間」も呼べない）・danger（取り返しがつかないかもしれない）は Mac でだけ。答えた端末は ops.jsonl に残す
export function remoteBridge(store: Store, h: () => ReturnType<typeof makeHandler>, home: string, bar: BarProbe = realProbe()): Bridge {
  const audit = (op: string, owner: string, device: { id: string; name: string }, value: string, result: string) => { try { appendOps(join(home, "ops.jsonl"), JSON.stringify({ at: Date.now(), face: "", app: "", owner, where: "", gen: 0, op, value: `${device.name}（${device.id.slice(0, 6)}）${value}`.slice(0, 80), result })); } catch {} };
  const latest = async (id: number) => (((await h()({ op: "runs", nodeIds: [id] })) as { runs?: any[] }).runs ?? []).at(-1);
  const clip = (t: string) => t.length > 1500 ? `${t.slice(0, 1500)}…` : t;
  const shape = (n: Node) => {
    const raw = n.text;
    if (raw.startsWith("🤖")) {
      const mm = /^🤖\s*([^:：]+)[:：]\s*/.exec(raw);
      return { id: n.id, mine: false, via: null, name: mm?.[1]?.trim().slice(0, 40) || "agent", text: clip(rowView(mm ? raw.slice(mm[0].length) : raw.slice(2)).text), at: n.createdAt };
    }
    const phone = raw.startsWith(PHONE_MARK);
    return { id: n.id, mine: true, via: phone ? ("phone" as const) : null, name: "", text: clip(rowView(phone ? raw.slice(PHONE_MARK.length) : raw).text), at: n.createdAt };
  };
  const approvals = async (id: number) => (((await h()({ op: "leaseList" })) as { approvals?: any[] }).approvals ?? []).filter((a) => a.owner === `s:${id}`);
  return {
    async messages(id, before, limit): Promise<Conv | null> {
      const root = store.get(id);
      if (!root || root.parentId !== null || root.deletedAt !== null) return null;
      const all = store.tree(root.id).filter((n) => n.kind === "user" && n.id !== root.id).filter((n) => before == null || n.id < before);
      const row = (await remoteRows(h())).find((x) => x.id === id);
      return {
        name: row?.name ?? "agent", state: row?.state ?? "neutral", label: row?.label ?? "",
        rows: all.slice(-limit).map(shape).filter((x) => x.text),
        more: all.length > limit,
        approvals: (await approvals(id)).map((a) => ({ id: String(a.id), ver: Number(a.at), text: String(a.what || a.title || a.tool).slice(0, 200), app: String(a.app ?? "").slice(0, 40), danger: !!a.danger })),
      };
    },
    async send(id, text, _device) {
      const r = (await h()({ op: "send", rootId: id, text, via: "phone" })) as { ok: boolean; hint?: string; row?: { id: number } };
      return { ok: !!r.ok, hint: r.ok ? undefined : String(r.hint ?? "送れませんでした"), row: r.row?.id };
    },
    // R3: 止まった担当の再開。許した担当だけ・今の状態が見たものと同じ時だけ・Mac で動き出したのを見てから running と言う。shell・install・権限は触らない（呼ぶのは人の「続けて」と同じ op resume だけ）
    async resume(conv, expected, device) {
      const root = store.get(conv);
      if (!root || root.parentId !== null || root.deletedAt !== null) return { result: "gone", hint: "この担当は見つかりません" };
      if (!readResume(home).includes(conv)) return { result: "needsLocalApproval", hint: "この担当は、Mac の「スマホで操作」で「スマホから再開してよい」を入れると再開できます" };
      const before = await latest(conv);
      if (!before) return { result: "gone", hint: "この担当は再開できません。会話から送ってください" };
      if (before.status === "running") return { result: "running" }; // もう動いている（二重に起こさない）
      if (before.status !== expected) return { result: "stale", hint: "状態が変わりました。もう一度見てください" };
      const r = (await h()({ op: "resume", rootId: conv })) as { ok: boolean; hint?: string; need?: unknown };
      audit("remote:resume", `s:${conv}`, device, "", r.ok ? "ok" : "error");
      if (!r.ok) return r.need ? { result: "needsLocalApproval", hint: String(r.hint ?? "Mac で確かめてください") } : { result: "helperUnavailable", hint: String(r.hint ?? "この Mac で担当を動かせませんでした") };
      for (let i = 0; i < 30; i++) { // 動き出したのを Mac で見てから（最大 3 秒）
        const x = await latest(conv);
        if (x?.status === "running") return { result: "running" };
        if (x?.status === "failed") return { result: "helperUnavailable", hint: "動き出せませんでした。Mac で確かめてください" };
        await Bun.sleep(100);
      }
      return { result: "starting" };
    },
    async launch(device) {
      const r = await launchBar(bar);
      audit("remote:launch", "", device, "", r === "helperUnavailable" ? "error" : "ok");
      return r === "helperUnavailable" ? { result: r, hint: "Kangae Bar が見つからないか、起こせませんでした。Mac で開いてください" } : { result: r };
    },
    bar: async () => (bar.app ? bar.running() : null),
    allowed: () => readResume(home),
    setAllowed: (id, on) => writeResume(home, id, on),
    async answer(conv, approval, allow, ver, device): Promise<Answered> {
      const a = (await approvals(conv)).find((x) => x.id === approval);
      if (!a) return "already"; // Mac が先に答えた・期限が切れた・もう無い
      if (Number(a.at) !== ver) return "stale";
      if (a.danger) return "mac-only";
      const r = (await h()({ op: "approvalAnswer", id: approval, yes: allow })) as { ok: boolean }; // scope を渡さない = 今回の 1 件だけ
      if (!r.ok) return "already";
      try { appendOps(join(home, "ops.jsonl"), JSON.stringify({ at: Date.now(), face: "", app: String(a.app ?? ""), owner: a.owner, where: "", gen: 0, op: `remote:${allow ? "allow" : "deny"}`, value: `${device.name}（${device.id.slice(0, 6)}）・${String(a.tool ?? "").slice(0, 30)}`, result: allow ? "ok" : "refused:denied" })); } catch {}
      return "answered";
    },
  };
}

export async function startDaemon(path = socketPath()) {
  void touchCmdDirs(home).catch(() => {}); // 登録済みの場所を 1 回開く（cmd-add の時に常駐が居なかった分の確認を、起きた今出す・W34）
  sweepOrphans(); // 前の常駐が SIGKILL で死んで残した、起こした command / GUI（親が pid 1）を止める（review23）
  ensureUserEnv(); // 子（claude・gemini・codex）が引き継ぐ
  if (await alive(path)) return null;
  if (existsSync(path)) unlinkSync(path);
  const dbFile = join(home, "kangae.db");
  const store = openStoreKeeping(dbFile); // 読めない記録は消さず取っておき、空から起こす（落ちて「繋がりません」だけになるより）
  let mouths: Promise<Mouth[]> | null = null;
  const peers = new Set<Writable>();
  const wsPeers = new Set<{ send(d: string): unknown }>();
  const clockFile = process.env.KANGAE_CLOCK_FILE; // 試験用の時計（時刻を file で進める。9 時を待たない）。無ければ本物の時計
  const extDir = join(compiled ? join(dirname(process.execPath), "..") : join(import.meta.dir, ".."), "extension");
  // R1: スマホで操作。一覧の元は panel と同じ roots / runs（名前と状態だけを渡す）。別 instance（試験）は本物の鍵束に触らない
  let handler!: ReturnType<typeof makeHandler>;
  const remote = createRemote({
    list: () => remoteRows(handler, readResume(home)),
    conv: remoteBridge(store, () => handler, home),
    extDir,
    store: process.env.KANGAE_SOCK ? memoryStore() : keychainStore(),
    onChange: () => { const j = JSON.stringify({ type: "remote" }); fanout(peers, j + "\n"); for (const w of wsPeers) w.send(j); },
  });
  handler = makeHandler(
    store,
    () => (mouths ??= loadKeyMouth().then((k) => pickMouths(k))),
    async (p, key) => {
      await setKey(p, key);
      mouths = null;
    },
    defaultWorkspace(),
    { uiHome: home, awaitWebPeer: true, isExtension: extensionPeer, routineDeps: clockFile ? { now: () => Number(readFileSync(clockFile, "utf8")) } : undefined, broadcast: (msg) => { fanout(peers, JSON.stringify(msg) + "\n"); for (const w of wsPeers) w.send(JSON.stringify(msg)); }, unicast: (to, msg) => { for (const s of peers) if (to.has(s)) sendAll(s, JSON.stringify(msg) + "\n"); }, remote },
  );
  handler.routines.start(); // 常駐が居る間だけ timer 1 本。居ない間に過ぎた分は起きた時に 1 回だけ追いつく
  const token = randomBytes(32).toString("hex");
  const web = startWeb(handler, wsPeers, token, extDir);
  const stopRemote = () => remote.stop(); // cloudflared（子 process）も一緒に止める
  process.on("exit", stopRemote);
  // 人が押した「全部終わる」（bar の quitAll が <home>/quit を置いてから SIGTERM）で止めた常駐は、人が起こすまで拡張の再接続で起き直さない（relay が見る印）。起きたら印を消す
  // （bar.json を持たない常駐 = relay が起こした物でも同じに効くよう、if (bar) の外に置く）
  try { unlinkSync(quitMark()); } catch {}
  // 試験が同じ process で startDaemon を起こすことがある（holes8）。stop() で下の終了の仕掛けを全部外し、bun test 自体が黙って exit 0 しないようにする（holes-21）
  const quit = () => process.exit(0);
  const sigs = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const sig of sigs) process.on(sig, quit); // 印は書かない: logout / shutdown の SIGTERM でも印が残ると、次の起動で拡張が繋がらない。書くのは人が押した「全部終わる」（bar の quitAll）だけ
  const readers = new WeakMap<object, (c: Uint8Array) => void>();
  // socket の file が消えたら（tmp の掃除・試験の後始末）、誰も繋げないので自分も終わる
  const sockWatch = setInterval(() => existsSync(path) || quit(), 10_000);
  sockWatch.unref();
  const parentWatch = watchParent(process.env, quit);
  const server = Bun.listen({
    unix: path,
    socket: {
      open(sock) {
        peers.add(sock);
        readers.set(
          sock,
          lineReader(async (l) => {
            let m: Msg;
            try {
              m = JSON.parse(l);
            } catch {
              return;
            }
            sendAll(sock, JSON.stringify(await handler(m, sock)) + "\n");
          }),
        );
      },
      data(sock, chunk) {
        readers.get(sock)?.(chunk);
      },
      drain: flush,
      close(sock) {
        peers.delete(sock);
        handler.dropOwner(sock);
      },
      error() {},
    },
  });
  // bar.json は「繋いでよい」の合図なので、socket が listen してから書く（先に書くと、見て繋ぎに来た側が ENOENT になる・holes-10b）。単一 instance の印は alive(path) で、bar.json ではない
  const bar = barPath();
  if (bar) {
    mkdirSync(dirname(bar), { recursive: true });
    // 空の瞬間を見せない: tmp に書いて rename（writeFileSync は先に 0 byte に切るので、load が高いと読み手が JSON の EOF を踏む・W7f）
    writeFileSync(`${bar}.${process.pid}.tmp`, JSON.stringify({ port: web.port, token, pid: process.pid, version: VERSION }), { mode: 0o600 });
    renameSync(`${bar}.${process.pid}.tmp`, bar);
    // 自分が書いた物だけ消す（後から起きた常駐が上書きしていたら触らない）
    const rm = () => { try { if (JSON.parse(readFileSync(bar, "utf8")).pid === process.pid) unlinkSync(bar); } catch {} };
    process.on("exit", () => { rm(); handler.closeLeases(); });
  }
  const stop = server.stop.bind(server);
  server.stop = (force?: boolean) => {
    clearInterval(sockWatch);
    if (parentWatch) clearInterval(parentWatch);
    for (const sig of sigs) process.off(sig, quit);
    process.off("exit", stopRemote);
    remote.stop();
    return stop(force);
  };
  return server;
}

// ---------- 中継役（Chromium が native messaging の host として起こす） ----------
const quitMark = () => join(home, "quit");
async function connectOrStart(path: string) {
  // 回数ではなく締切: 混んだ機械で 1 周が遅くなっても待つ総時間は変わらない（40 回では load 500 の下で 26 秒で諦め、host が落ちて「host closed」になった）
  const t0 = Date.now(), until = t0 + Number(process.env.KANGAE_CONNECT_MS ?? 60_000);
  for (let i = 0; Date.now() < until; i++) {
    if (i === 1 && !existsSync(quitMark())) {
      const cmd = compiled ? [process.execPath, "--daemon"] : [process.execPath, Bun.main, "--daemon"];
      Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
    }
    if (await alive(path)) return;
    await Bun.sleep(150);
  }
  throw new Error(`裏の常駐に繋がりません（${Date.now() - t0}ms 待った）`);
}

function frame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}

async function relay() {
  const path = socketPath();
  // 印があって常駐が居ない = 人が「全部終わる」で止めた。起こさず、待たず、拡張に「止まっている」と知らせて即終わる（拡張が 6.5 秒ごとに起こし直さないように）
  if (existsSync(quitMark()) && !(await alive(path))) await new Promise<void>(() => process.stdout.write(frame({ type: "stopped" }), () => process.exit(0)));
  await connectOrStart(path);
  const sock = await Bun.connect({
    unix: path,
    socket: {
      data: (() => {
        const r = lineReader((l) => process.stdout.write(frame(JSON.parse(l))));
        return (_s: unknown, c: Uint8Array) => r(c);
      })(),
      drain: flush,
      close() {
        process.exit(0);
      },
      error() {},
    },
  });
  let pending = Buffer.alloc(0);
  for await (const chunk of Bun.stdin.stream()) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const n = pending.readUInt32LE(0);
      if (pending.length < 4 + n) break;
      const msg = pending.subarray(4, 4 + n).toString("utf8");
      pending = pending.subarray(4 + n);
      sendAll(sock, msg + "\n");
    }
  }
  process.exit(0);
}

// ---------- 入口 ----------
if (import.meta.main) {
  // compile 後は argv に実行 file の path が 1 つ増えるので、先頭に決め打たず全体から見る
  const isHost = process.argv.slice(1).includes(EXT_ORIGIN);
  if (isHost) await relay();
  else if (process.argv.includes("--open")) {
    // 入口の app から呼ばれる。動いていなければ起こし、動いていれば（窓が 0 枚でも）新しい窓を開く
    const { openKangae } = await import("./launch.ts");
    const repo = compiled ? join(dirname(process.execPath), "..") : join(import.meta.dir, "..");
    await openKangae(openLaunchOpts(home, repo, compiled, process.execPath), sessionUrl(process.argv));
    process.exit(0);
  } else if (process.argv[2] === "version" || process.argv[2] === "--version") {
    // この kangae の版と、動いている常駐の版（bar.json）。版が違えば「開き直す」を案内する（W55: 古い常駐が残ったままの再走を見分ける）
    let bar: { pid?: unknown; version?: unknown } | null = null;
    try { const bp = barPath(); if (bp) bar = JSON.parse(readFileSync(bp, "utf8")); } catch {}
    let alive = false;
    alive = typeof bar?.pid === "number" && isDaemonPid(bar.pid);
    console.log(versionReport(VERSION, bar, alive).join("\n"));
    process.exit(0);
  } else if (process.argv[2] === "act") {
    // agent から: kangae act <操作> ['{"element_token":…}']。操作権は env の KANGAE_LEASE。門が通した時だけ窓が動く
    const path = socketPath();
    await connectOrStart(path);
    const av = process.argv.slice(3);
    const oi = av.indexOf("--on");
    const on = oi >= 0 ? av.splice(oi, 2)[1] : undefined;
    const pick = pickLease(process.env, on);
    // W25: 面を持たない turn は KANGAE_LEASES が無く、pickLease は ok:true・token "" を返す（旧版はこれを「面あり」と読み、owner を送らずに常駐の「操作権がありません」で終わった＝面なしの open_app が一度も常駐に届かなかった）
    const hasTok = pick.ok && pick.token !== "";
    const late = !hasTok && on && process.env.KANGAE_OWNER; // この turn の途中で開いた面（open_tab）。名前は常駐が引く
    const first = !hasTok && !on && (av[0] === "open_app" || av[0] === "open_tab") && process.env.KANGAE_OWNER; // W23 / W40: 面を持たない agent の最初の open_app / open_tab
    if (!hasTok && !late && !first) { console.error(`拒否(face): ${pick.ok ? "面を持っていません。web の頁なら先に \`act open_tab\`（承認 card が出ます）、app なら人に窓を渡してもらうか、登録した app を \`launch\` で起こしてください" : pick.hint}`); process.exit(1); }
    let args: unknown = {};
    try { args = JSON.parse(av[1] ?? "{}"); } catch { console.error("引数は JSON で渡してください"); process.exit(2); }
    const id = crypto.randomUUID();
    const reply = await new Promise<Res>((resolve) => {
      const r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); }); // 常駐は他の面の通知（web の依頼など）も同じ socket に流す。自分の返事だけを読む
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) => s.write(JSON.stringify({ id, op: "act", ...(hasTok && pick.ok ? { lease: pick.token } : { owner: process.env.KANGAE_OWNER, on }), tool: av[0], args }) + "\n"));
    });
    if (!reply.ok) { console.error(`拒否(${reply.code}): ${reply.hint}`); process.exit(1); }
    console.log(reply.text);
    process.exit(reply.error ? 1 : 0);
  } else if (process.argv[2] === "draft") {
    // agent から: kangae draft <操作名> [欄=値 …] --why <理由> [--on 面]。カタログに無い操作は画面操作に落とさず、下書きを人に残して止まる（W42a）。値は保存しない（欄の名前だけ）
    const a = process.argv.slice(3);
    const wi = a.indexOf("--why");
    const why = wi >= 0 ? a.splice(wi, 2)[1] ?? "" : "";
    const oi = a.indexOf("--on");
    const on = oi >= 0 ? a.splice(oi, 2)[1] : undefined;
    const [op, ...kv] = a;
    const fields = Object.fromEntries(kv.map((x) => { const i = x.indexOf("="); return i > 0 ? [x.slice(0, i), x.slice(i + 1)] : [x, ""]; }));
    const path = socketPath();
    await connectOrStart(path);
    const id = crypto.randomUUID();
    const reply = await new Promise<Res>((resolve) => {
      const r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); });
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) => s.write(JSON.stringify({ id, op: "draft", owner: process.env.KANGAE_OWNER, on, op_name: op, fields, why }) + "\n"));
    });
    if (!reply.ok) { console.error(`拒否(${reply.code}): ${reply.hint}`); process.exit(1); }
    console.log(reply.text);
    process.exit(0);
  } else if (process.argv[2] === "step") {
    // agent から: kangae step "<この段でしたい事>" [--text "<文字>"]。1 手は decision model が選び、門を通して実行する
    const a = process.argv.slice(3);
    const ti = a.indexOf("--text");
    const text = ti >= 0 ? a.splice(ti, 2)[1] : undefined;
    const oi = a.indexOf("--on");
    const pick = pickLease(process.env, oi >= 0 ? a.splice(oi, 2)[1] : undefined);
    if (!pick.ok) { console.error(`拒否(face): ${pick.hint}`); process.exit(1); }
    const path = socketPath();
    await connectOrStart(path);
    const id = crypto.randomUUID();
    const reply = await new Promise<Res>((resolve) => {
      const r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); });
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) => s.write(JSON.stringify({ id, op: "step", lease: pick.token, what: a.join(" "), text }) + "\n"));
    });
    if (!reply.ok) { console.error(`拒否(${reply.code}): ${reply.hint}`); process.exit(1); }
    console.log(reply.text);
    process.exit(reply.error ? 1 : 0);
  } else if (process.argv[2] === "carry" || process.argv[2] === "carry-read") {
    // agent から: kangae carry <host> / kangae carry-read <url>。人のログイン（cookie）を、値を見せずに頼み専用の見えないブラウザへ運ぶ。owner は env の KANGAE_OWNER
    const read = process.argv[2] === "carry-read";
    const path = socketPath();
    await connectOrStart(path);
    const reply = await new Promise<Res>((resolve) => {
      const id = crypto.randomUUID();
      const r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); });
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) =>
        s.write(JSON.stringify({ id, op: read ? "carryRead" : "carry", owner: process.env.KANGAE_OWNER ?? "", host: process.argv[3], url: process.argv[3] }) + "\n"),
      );
    });
    if (!reply.ok) { console.error(`運べません: ${reply.hint}`); process.exit(1); }
    console.log(reply.text);
    process.exit(0);
  } else if (process.argv[2] === "vault-fill" || process.argv[2] === "vault-key" || process.argv[2] === "vault-lock") {
    // vault-fill <url>: agent から（unix socket）。vault-key: 人が `bw unlock --raw | kangae vault-key`（鍵は stdin から常駐の memory へ・argv にも file にも出さない）。vault-lock: 鍵を捨てる。
    // vault-key / vault-lock は人が押す op（HUMAN_OPS）= unix socket（agent の口）では断られる。人の口（bar.json の port と token で /ws・panel と同じ）へ送る。agent の turn の中（KANGAE_OWNER あり）では打たない
    const cmd = process.argv[2];
    if (cmd !== "vault-fill" && process.env.KANGAE_OWNER) { console.error(`${cmd} は、あなた（人）が自分のターミナルで打ちます。agent からは使えません`); process.exit(1); }
    const key = cmd === "vault-key" ? (await Bun.stdin.text()).trim() : "";
    const path = socketPath();
    await connectOrStart(path);
    const op = cmd === "vault-fill" ? "vaultFill" : cmd === "vault-key" ? "vaultKey" : "vaultLock";
    const reply = await new Promise<Res>(async (resolve) => {
      const id = crypto.randomUUID();
      if (cmd === "vault-fill") {
        const r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); });
        Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) => s.write(JSON.stringify({ id, op, owner: process.env.KANGAE_OWNER ?? "", url: process.argv[3] }) + "\n"));
        return;
      }
      const bar = barPath(); // bar.json は常駐が listen した後に書く（起こした直後は少し待つ）
      const a = bar ? await pollUntil(() => { try { return JSON.parse(readFileSync(bar, "utf8")) as { port: number; token: string }; } catch { return null; } }, 5000, 100) : undefined;
      if (!a) return resolve({ ok: false, hint: "本体の住所（bar.json）が読めません。本体を起こしてからもう一度" });
      const ws = new WebSocket(`ws://127.0.0.1:${a.port}/ws?token=${encodeURIComponent(a.token)}`);
      ws.onopen = () => ws.send(JSON.stringify({ id, op, key }));
      ws.onmessage = (e) => { const j = JSON.parse(String(e.data)); if (j.id === id) { ws.close(); resolve(j); } };
      ws.onerror = () => resolve({ ok: false, hint: "本体に繋がりません" });
    });
    if (!reply.ok) { console.error(`入れられません: ${reply.hint}`); process.exit(1); }
    console.log(cmd === "vault-fill" ? reply.text : cmd === "vault-key" ? "金庫の鍵を本体に渡しました（memory だけ・~/.kangae/bin/kangae vault-lock で捨てます）" : "金庫の鍵を捨てました");
    process.exit(0);
  } else if (process.argv[2] === "remember") {
    // agent から: kangae remember "一言"（名前と頼みは環境から）。記憶を書く唯一の口
    const path = socketPath();
    await connectOrStart(path);
    const reply = await new Promise<Res>((resolve) => {
      const r = lineReader((l) => resolve(JSON.parse(l)));
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) =>
        s.write(JSON.stringify({ id: crypto.randomUUID(), op: "remember", name: process.env.KANGAE_AGENT ?? "", by: process.env.KANGAE_TURN ?? "", text: process.argv.slice(3).join(" ") }) + "\n"),
      );
    });
    if (!reply.ok) { console.error(reply.hint); process.exit(1); }
    console.log("覚えました");
    process.exit(0);
  } else if (process.argv[2] === "routine") {
    // agent から: kangae routine add --daily 9:00 "頼み" / add --watch URL [--every N] "頼み" / list / pause|resume|remove <id>
    const argv = process.argv.slice(3);
    const action = argv.shift() ?? "list";
    const spec: Record<string, string> = {}; const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) { const k = /^--(every|daily|weekly|watch)$/.exec(argv[i]!); if (k) spec[k[1]!] = argv[++i] ?? ""; else rest.push(argv[i]!); }
    const path = socketPath();
    await connectOrStart(path);
    const reply = await new Promise<Res>((resolve) => {
      const r = lineReader((l) => resolve(JSON.parse(l)));
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) =>
        s.write(JSON.stringify({ id: crypto.randomUUID(), op: "routine", action, owner: process.env.KANGAE_OWNER, name: process.env.KANGAE_AGENT ?? "", spec, text: action === "add" ? rest.join(" ") : "", runId: action === "add" ? undefined : rest[0] }) + "\n"),
      );
    });
    if (!reply.ok) { console.error(reply.hint); process.exit(1); }
    console.log(reply.line ? `付けました: ${reply.line}` : (reply.routines as { id: string; label: string; task: string; enabled: boolean; next: string }[]).map((x) => `${x.id} ${x.enabled ? x.label + "（次 " + x.next + "）" : "止めています"} ${x.task}`).join("\n") || "routine はありません");
    process.exit(0);
  } else if (process.argv[2] === "cmd-add" || process.argv[2] === "cmd-list" || process.argv[2] === "cmd-rm") {
    // 人の shell から: 走らせてよい command の登録（W17a）。agent の turn の中（KANGAE_OWNER あり）からは登録できない
    const [sub, name = "", ...rest] = process.argv.slice(2);
    if (process.env.KANGAE_OWNER) { console.error(`登録は、あなた（人）が自分のターミナルで打ちます。agent からは登録できません。人に「${CLI} cmd-add …」を打ってもらってください`); process.exit(1); }
    const h = home;
    if (sub === "cmd-list") {
      const all = loadCmds(h);
      if (!all.length) console.log(`まだ何も登録していません。agent に走らせたい command は、先にあなたが登録します。例:\n  ${CLI} cmd-add build --cwd ~/my-project -- cmake --build build`);
      for (const c of all) console.log(`${c.name}${c.app ? "（app）" : ""}\n  場所: ${c.cwd}\n  実行する行: ${c.argv.join(" ")}\n  ネットワーク: ${c.network ? "あり" : "なし"}${c.reads?.length ? `\n  読みを許す所: ${c.reads.join(" / ")}` : ""}${c.seal === sealOf(c) ? "" : `\n  ※ 登録が書き換えられているので動かしません。「${CLI} cmd-rm ${c.name}」で外して、登録し直してください`}`);
    } else if (sub === "cmd-rm") {
      if (!rmCmd(h, name)) { console.error(`「${name}」は登録されていません。今の登録を見るには「${CLI} cmd-list」`); process.exit(1); }
      console.log(`外しました: ${name}`);
    } else {
      const di = rest.indexOf("--"), ci = rest.indexOf("--cwd");
      const cwd = ci >= 0 && ci < di ? rest[ci + 1] : undefined, ti = rest.indexOf("--timeout");
      if (di < 0 || !cwd) { console.error(`使い方: ${CLI} cmd-add <名前> --cwd <フォルダ> -- <実行する command>\n例:    ${CLI} cmd-add build --cwd ~/my-project -- cmake --build build\n（-- の後ろは、そのままターミナルで打つ形です。時間切れは --timeout 秒、通信が要る時は --network、道具の置き場を読ませる時は --read <フォルダ>（何度でも）を、-- の前に）`); process.exit(2); }
      const head = rest.slice(0, di), reads = head.flatMap((a, i) => (a === "--read" && head[i + 1] ? [head[i + 1]!] : []));
      const r = addCmd(h, name, cwd, rest.slice(di + 1), ti >= 0 && ti < di ? Number(rest[ti + 1]) : undefined, Date.now(), { network: head.includes("--network"), reads, app: head.includes("--app") });
      if (!r.ok) { console.error(r.hint); process.exit(1); }
      const sockPath = socketPath(), up = await alive(sockPath); // 常駐を起こすのは人の terminal の下になり、許可が terminal に付いてしまう。居る時だけ頼む
      if (up) await Bun.connect({ unix: sockPath, socket: { data() {}, error() {} } }).then((s) => { s.write(JSON.stringify({ id: crypto.randomUUID(), op: "touchCmds" }) + "\n"); setTimeout(() => s.end(), 200); }).catch(() => {});
      console.log(up ? "（登録した場所を 1 回開きます。macOS の確認が出たら「許可」を押してください）" : "（Kangae がまだ動いていません: 次に Kangae が起きた時に、登録した場所を 1 回開きます。その時に macOS の確認が出たら「許可」を押してください）"); // W12-10: 人に出る文に『常駐』を使わない
      console.log(`登録しました: ${r.cmd.name}\n  場所: ${r.cmd.cwd}\n  実行する行: ${r.cmd.argv.join(" ")}\n  種類: ${r.cmd.app ? "app（GUI・kangae launch で待たずに起こす）" : "command（kangae run）"}\n  ネットワーク: ${r.cmd.network ? "あり（承認の card に出ます）" : "なし"}${r.cmd.reads?.length ? `\n  読みを許す所: ${r.cmd.reads.join(" / ")}` : ""}\nagent が「kangae run ${r.cmd.name}」と頼むたびに、承認の card が出ます。あなたが許すまで何も走りません。外すには「${CLI} cmd-rm ${r.cmd.name}」`);
    }
    process.exit(0);
  } else if (process.argv[2] === "run") {
    // agent から: kangae run <名前>。引数は取らない。常駐が card を出し、許されたら走らせて出力の末尾と全文の path を返す
    if (process.argv.length !== 4) { console.error("使い方: kangae run <登録済みの名前>（引数は足せません）。どんな名前があるかは、人に聞いてください"); process.exit(2); }
    const path = socketPath();
    await connectOrStart(path);
    const reply = await new Promise<Res>((resolve) => {
      const id = crypto.randomUUID();
      const r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); });
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) => s.write(JSON.stringify({ id, op: "runCmd", owner: process.env.KANGAE_OWNER ?? "", name: process.argv[3] }) + "\n"));
    });
    if (!reply.ok) { console.error(`拒否(${reply.code}): ${reply.hint}`); process.exit(1); }
    console.log(reply.text);
    process.exit(reply.error ? 1 : 0);
  } else if (process.argv[2] === "launch") {
    // agent から: kangae launch <名前>。引数は取らない。常駐が card を出し、許されたら app を前に出さず起こして、窓を面として渡す（W31a）
    if (process.argv.length !== 4) { console.error("使い方: kangae launch <登録済みの app の名前>（引数は足せません）。どんな名前があるかは、人に聞いてください"); process.exit(2); }
    const path = socketPath();
    await connectOrStart(path);
    const reply = await new Promise<Res>((resolve) => {
      const id = crypto.randomUUID();
      const r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); });
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) => s.write(JSON.stringify({ id, op: "launchApp", owner: process.env.KANGAE_OWNER ?? "", name: process.argv[3] }) + "\n"));
    });
    if (!reply.ok) { console.error(`拒否(${reply.code}): ${reply.hint}`); process.exit(1); }
    console.log(reply.text);
    process.exit(reply.error ? 1 : 0);
  } else if (process.argv[2] === "send") {
    // agent から: kangae send screenshot|file|image|link [path/URL] [説明]（W75c）。人の chat に出す。card なし。file は作業場所の中だけ
    const [, , , kind = "", arg0 = "", ...rest] = process.argv;
    const isShot = kind === "screenshot";
    if (!["screenshot", "file", "image", "link"].includes(kind) || (!isShot && !arg0)) { console.error("使い方: kangae send screenshot [説明] ／ send file|image <作業場所の中の path> [説明] ／ send link <URL> [題]"); process.exit(2); }
    const arg = kind === "link" || isShot ? arg0 : (await import("node:path")).resolve(process.cwd(), arg0);
    const text = (isShot ? [arg0, ...rest] : rest).join(" ").trim();
    const path = socketPath();
    await connectOrStart(path);
    const reply = await new Promise<Res>((resolve) => {
      const id = crypto.randomUUID();
      const r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); });
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) => s.write(JSON.stringify({ id, op: "sendOut", owner: process.env.KANGAE_OWNER ?? "", kind, arg: isShot ? "" : arg, ...(kind === "link" ? { title: text } : { text }) }) + "\n"));
    });
    if (!reply.ok) { console.error(`拒否(${reply.code}): ${reply.hint}`); process.exit(1); }
    console.log("人の chat に送りました");
    process.exit(0);
  } else if (process.argv[2] === "role") {
    // agent から: kangae role <短い名前>（W60b2）。この会話の担当名を付ける。Bar の一覧に出る名前
    const role = process.argv.slice(3).join(" ").trim();
    if (!role) { console.error("使い方: kangae role <短い担当名>（例: kangae role sns）"); process.exit(2); }
    const path = socketPath();
    await connectOrStart(path);
    const reply = await new Promise<Res>((resolve) => {
      const id = crypto.randomUUID();
      const r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); });
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) => s.write(JSON.stringify({ id, op: "role", owner: process.env.KANGAE_OWNER ?? "", role }) + "\n"));
    });
    if (!reply.ok) { console.error(`拒否(${reply.code}): ${reply.hint}`); process.exit(1); }
    console.log(`担当名: ${reply.role}`);
    process.exit(0);
  } else if (process.argv[2] === "op") {
    // agent から: kangae op <app> <名前> k=v…（W41）。名前と欄だけ。pid・窓・tab 番号は渡せない。常駐が起動済みを確かめ、write は card を出して osascript を打つ
    const [, , , app, name, ...kvs] = process.argv;
    if (!app || !name) { console.error("使い方: kangae op <app> <op の名前> [欄=値 …]（例: kangae op Terminal read-front-tab）"); process.exit(2); }
    const slots: Record<string, string> = {};
    for (const a of kvs) { const i = a.indexOf("="); if (i < 1) { console.error(`欄は 名前=値 で渡してください: ${a.slice(0, 40)}`); process.exit(2); } slots[a.slice(0, i)] = a.slice(i + 1); }
    const path = socketPath();
    await connectOrStart(path);
    const reply = await new Promise<Res>((resolve) => {
      const id = crypto.randomUUID();
      const r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); });
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) => s.write(JSON.stringify({ id, op: "op", owner: process.env.KANGAE_OWNER ?? "", app, name, slots }) + "\n"));
    });
    if (!reply.ok) { console.error(`拒否(${reply.code}): ${reply.hint}`); process.exit(1); }
    console.log(reply.text);
    process.exit(reply.error ? 1 : 0);
  } else if (process.argv[2] === "api") {
    // agent から: kangae api list [<site>] / <site> <op> k=v… / add|capture|login …（W35b）。中身は op apiRun だけ。読みは card 無し・覚える・login は毎回 card
    const { verb, args } = apiVerb(process.argv.slice(3));
    const path = socketPath();
    await connectOrStart(path);
    const reply = await new Promise<Res>((resolve) => {
      const id = crypto.randomUUID();
      const r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); });
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) => s.write(JSON.stringify({ id, op: "apiRun", owner: process.env.KANGAE_OWNER ?? "", verb, args }) + "\n"));
    });
    if (!reply.ok) { console.error(`拒否(${reply.code}): ${reply.hint}`); process.exit(1); }
    console.log(reply.text);
    process.exit(0);
  } else if (process.argv[2] === "press") { // W62: kangae press list|show|run|rm（中身は src/press-cli.ts）
    process.exit(await pressArgv(process.argv.slice(3), { home, owner: process.env.KANGAE_OWNER, out: (x) => console.log(x), err: (x) => console.error(x), send: async (msg) => { const path = socketPath(); await connectOrStart(path); return new Promise<Res>((resolve) => { const id = crypto.randomUUID(), r = lineReader((l) => { const j = JSON.parse(l); if (j.id === id) resolve(j); }); Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) => s.write(JSON.stringify({ ...msg, id }) + "\n")); }); } }));
  } else if (process.argv[2] === "mod-write") {
    // agent から: kangae mod-write <app> <名前> '<JSON>'。AI が mod を書く唯一の口（頼みは環境から）
    let spec: unknown;
    try { spec = JSON.parse(process.argv[5] ?? ""); } catch { console.error("3 つ目は JSON で渡してください: {\"label\":…,\"permission\":\"read|write\",\"prompt\":…}"); process.exit(2); }
    const path = socketPath();
    await connectOrStart(path);
    const reply = await new Promise<Res>((resolve) => {
      const r = lineReader((l) => resolve(JSON.parse(l)));
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) =>
        s.write(JSON.stringify({ id: crypto.randomUUID(), op: "modWrite", app: process.argv[3], name: process.argv[4], spec, by: process.env.KANGAE_ASK ?? "" }) + "\n"),
      );
    });
    if (!reply.ok) { console.error(reply.hint); process.exit(1); }
    console.log("mod を書きました（許可は off です。人が一覧で on にするまで動きません）");
    process.exit(0);
  } else if (["note", "context", "todo"].includes(process.argv[2] ?? "")) {
    // agent から: kangae note <番号> "一言" / kangae context <番号> / kangae todo <番号> [add "項目" | done 番号 | undo 番号]
    const [op, id, ...args] = process.argv.slice(2);
    const action = op === "todo" ? (["add", "done", "undo"].includes(args[0] ?? "") ? args.shift()! : "list") : undefined;
    const rest = args;
    const path = socketPath();
    await connectOrStart(path);
    const reply = await new Promise<Res>((resolve) => {
      const r = lineReader((l) => resolve(JSON.parse(l)));
      Bun.connect({ unix: path, socket: { data: (_s, c) => r(c), error() {} } }).then((s) =>
        s.write(JSON.stringify({ id: crypto.randomUUID(), op, nodeId: Number(id), text: rest.join(" "), action, index: Number(rest[0]) }) + "\n"),
      );
    });
    if (!reply.ok) { console.error(reply.hint); process.exit(1); }
    console.log(op === "note" ? `Kangae に書き戻しました（#${(reply.node as Node).id}）` : reply.text);
    process.exit(0);
  } else if (process.argv.includes("--daemon")) {
    ensureCliLink(homedir(), process.execPath); // W12-9: bar 版だけ入れた人にも ~/.kangae/bin/kangae を置く（無い時だけ・同梱の kangae の時だけ）
    if (migrateNodesDir() === "moved") makeAgents(home).forgetSessions();
    { const nd = resolvePath("KANGAE_NODES_DIR", () => nodesDefault()); makeAgents(home).forgetStale((() => { try { return realpathSync(nd); } catch { return nd; } })()); } // W26b: 手で移した時も、今の作業場所では続けられない session は捨てる // W26: 旧 ~/Documents/考えの空 を新しい既定へ 1 回だけ rename（旧の場所には symlink が残る）。path が替わるので前の session の続きは捨てる
    const s = await startDaemon();
    if (!s) process.exit(0);
  }
}
