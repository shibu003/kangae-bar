import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type Reply = { component?: unknown };
export type Task = { component: string; want?: string };
export type LlmErrorCode = "none" | "slow" | "failed" | "empty" | "login" | "update";

// hint は画面にそのまま出す「次の一手」の 1 行
export class LlmError extends Error {
  constructor(
    public code: LlmErrorCode,
    public hint: string,
  ) {
    super(`${code}: ${hint}`);
  }
}

export const TIMEOUT_MS = 30_000;
// 部品（表・todo など）は返事が長いので待つ時間も長い
export const limitFor = (_task?: Task) => 90_000;
const CLIS = ["claude", "codex", "gemini"] as const;
export type Cli = (typeof CLIS)[number];
const COMMON_DIRS = [
  join(homedir(), ".claude/local"),
  join(homedir(), ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

const SCHEMA = {
  type: "object",
  properties: {
    component: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["table", "chart", "todo", "roles"] },
        title: { type: "string" },
        columns: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "array", items: { type: "string" } } },
        kind: { type: "string", enum: ["bar", "line", "pie"] },
        labels: { type: "array", items: { type: "string" } },
        series: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } }, required: ["name", "values"], additionalProperties: false },
        },
        items: { type: "array", items: { type: "string" } },
        roles: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, job: { type: "string" } }, required: ["name", "job"], additionalProperties: false },
        },
      },
      required: ["type", "title"],
      additionalProperties: false,
    },
  },
  required: ["component"],
  additionalProperties: false,
};

export function buildPrompt(path: string[], outline: string | undefined, task: Task): string {
  const lines = path.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const want = task.want ? `型は ${task.want} に決まっています。` : "頼まれた事に合う型を 1 つ選ぶ。";
  return [
    "あなたは、考えを表・グラフ・todo・役割の部品にまとめる相手です。",
    "これは、その人の考えの道です（古い順。最後が部品を置く節）:",
    lines,
    "",
    ...(outline ? ["その節から先で考えた事と、既にある部品です:", outline, ""] : []),
    `頼まれた事: ${task.component}`,
    "",
    "次のどれか 1 つを作り、component に入れて返してください。" + want,
    '- 表: {"type":"table","title":"…","columns":["…"],"rows":[["…"]]}（中身は具体的に。分からない所は空にせず目安を書き、title に「目安」と付ける）',
    '- グラフ: {"type":"chart","title":"…","kind":"bar か line か pie","labels":["…"],"series":[{"name":"…","values":[数]}]}（数が無ければもっともらしい目安で、title に「目安」）',
    '- todo: {"type":"todo","title":"…","items":["今日から動ける具体的な行動"]}（5〜10 個。考えの道を行動に直す）',
    '- 役割: {"type":"roles","title":"…","roles":[{"name":"〜役","job":"その役がやる仕事を 1〜2 文"}]}（AI の agent に任せる前提で、仕事が重ならないよう 3〜5 個）',
    '{"component": {…}} の JSON だけを返す。',
  ].join("\n");
}

// shell-env（sindresorhus・MIT）の考え方: GUI から起きても login shell の PATH で CLI を探す
async function run(cmd: string[], opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {}) {
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env ?? (process.env as Record<string, string>),
    cwd: opts.cwd,
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, opts.timeoutMs ?? TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { stdout, stderr, code, timedOut };
}

async function shellPath(flags: string): Promise<string | null> {
  const shell = process.env.SHELL || "/bin/zsh";
  const env = { ...(process.env as Record<string, string>), DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTART: "false" };
  const r = await run([shell, flags, 'printf "%s" "$PATH"'], { env, timeoutMs: 5000 });
  return r.code === 0 && r.stdout ? r.stdout : null;
}

export type Found = { cli: Cli; path: string; env: Record<string, string> };

export async function findClis(): Promise<Found[]> {
  if (process.env.KANGAE_CLIS === "none") return []; // 試験用: agent が 1 つも無い機械を作る
  const paths: string[] = [];
  const first = await shellPath("-lc");
  if (first) paths.push(first);
  let dirs = new Set(paths.flatMap((p) => p.split(":")));
  const found: Found[] = [];
  const look = (extra: string[] = []) => {
    const all = [...dirs, ...extra];
    for (const cli of CLIS) {
      if (found.some((f) => f.cli === cli)) continue;
      const dir = all.find((d) => d && existsSync(join(d, cli)));
      if (dir) found.push({ cli, path: join(dir, cli), env: { PATH: all.join(":") } });
    }
  };
  look();
  if (found.length < CLIS.length) {
    const second = await shellPath("-ilc");
    if (second) dirs = new Set([...dirs, ...second.split(":")]);
    look();
  }
  if (found.length === 0) look(COMMON_DIRS);
  return CLIS.map((c) => found.find((f) => f.cli === c)).filter((f): f is Found => !!f);
}

// 画面の provider。起こす CLI（CLIS）とは別。Gemini は出さない。OpenRoly の detectCmd と同じ名前を、login shell の PATH と決まった install 先で 1 回探す。
const PROVIDER_CMDS: { id: string; cmd: string; label: string; also?: readonly string[] }[] = [
  { id: "claude", cmd: "claude", label: "Claude" },
  { id: "claude-agent-teams", cmd: "orca", label: "Claude Agent Teams", also: ["claude"] },
  { id: "openclaude", cmd: "openclaude", label: "OpenClaude" },
  { id: "codex", cmd: "codex", label: "Codex" },
  { id: "autohand", cmd: "autohand", label: "Autohand Code" },
  { id: "opencode", cmd: "opencode", label: "OpenCode" },
  { id: "opencode2", cmd: "opencode2", label: "OpenCode 2" },
  { id: "mimo-code", cmd: "mimo", label: "MiMo Code" },
  { id: "pi", cmd: "pi", label: "Pi" },
  { id: "omp", cmd: "omp", label: "OMP" },
  { id: "prime-agent", cmd: "prime-agent", label: "Prime Agent" },
  { id: "antigravity", cmd: "agy", label: "Antigravity" },
  { id: "aider", cmd: "aider", label: "Aider" },
  { id: "goose", cmd: "goose", label: "Goose" },
  { id: "amp", cmd: "amp", label: "Amp" },
  { id: "kilo", cmd: "kilo", label: "Kilocode" },
  { id: "kiro", cmd: "kiro-cli", label: "Kiro" },
  { id: "crush", cmd: "crush", label: "Charm" },
  { id: "aug", cmd: "auggie", label: "Auggie" },
  { id: "cline", cmd: "cline", label: "Cline" },
  { id: "codebuff", cmd: "codebuff", label: "Codebuff" },
  { id: "command-code", cmd: "command-code", label: "Command Code" },
  { id: "continue", cmd: "cn", label: "Continue" },
  { id: "cursor", cmd: "cursor-agent", label: "Cursor" },
  { id: "droid", cmd: "droid", label: "Droid" },
  { id: "kimi", cmd: "kimi", label: "Kimi" },
  { id: "mistral-vibe", cmd: "vibe", label: "Mistral Vibe" },
  { id: "qwen-code", cmd: "qwen", label: "Qwen Code" },
  { id: "rovo", cmd: "rovo", label: "Rovo Dev" },
  { id: "hermes", cmd: "hermes", label: "Hermes" },
  { id: "openclaw", cmd: "openclaw", label: "OpenClaw" },
  { id: "copilot", cmd: "copilot", label: "GitHub Copilot" },
  { id: "grok", cmd: "grok", label: "Grok" },
  { id: "devin", cmd: "devin", label: "Devin" },
  { id: "ante", cmd: "ante", label: "Ante" },
  { id: "trae", cmd: "traecli", label: "Trae" },
  { id: "muse", cmd: "muse", label: "Muse" },
  { id: "zcode", cmd: "zcode", label: "ZCode" },
];

export function providersFromHits(hits: ReadonlySet<string>): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const p of PROVIDER_CMDS) {
    if (seen.has(p.id) || !hits.has(p.cmd) || p.also?.some((c) => !hits.has(c))) continue;
    seen.add(p.id);
    out.push({ id: p.id, label: p.label });
  }
  return out;
}

export async function findProviders(): Promise<{ id: string; label: string }[]> {
  if (process.env.KANGAE_CLIS === "none") return [];
  const cmds = [...new Set(PROVIDER_CMDS.flatMap((p) => [p.cmd, ...(p.also ?? [])]))];
  const paths: string[] = [];
  const first = await shellPath("-lc");
  if (first) paths.push(first);
  let dirs = new Set(paths.flatMap((p) => p.split(":")));
  const hits = new Set<string>();
  const look = (extra: string[] = []) => {
    const all = [...dirs, ...extra];
    for (const cmd of cmds) {
      if (hits.has(cmd)) continue;
      if (all.some((d) => d && existsSync(join(d, cmd)))) hits.add(cmd);
    }
  };
  look();
  if (hits.size < cmds.length) {
    const second = await shellPath("-ilc");
    if (second) dirs = new Set([...dirs, ...second.split(":")]);
    look();
  }
  if (hits.size === 0) look(COMMON_DIRS);
  return providersFromHits(hits);
}

export function parseReply(text: string): Reply {
  // gemini は ```json の囲みを付けて返す事がある
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let o: unknown;
  try {
    o = JSON.parse(body);
  } catch {
    throw new LlmError("empty", "返事が読めませんでした。もう一度送ってください");
  }
  const comp = (o as { component?: unknown }).component;
  if (!comp || typeof comp !== "object") throw new LlmError("empty", "返事が空でした。もう一度送ってください");
  return { component: comp };
}

async function callCli(f: Found, prompt: string, timeoutMs = TIMEOUT_MS): Promise<Reply> {
  const cwd = mkdtempSync(join(tmpdir(), "kangae-"));
  const env = { ...(process.env as Record<string, string>), ...f.env };
  try {
    let cmd: string[];
    if (f.cli === "claude") {
      cmd = [f.path, "-p", "--safe-mode", "--tools", "", "--disallowedTools", "mcp__*", "--no-session-persistence",
        "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA), "--", prompt];
    } else if (f.cli === "codex") {
      const schemaFile = join(cwd, "schema.json");
      writeFileSync(schemaFile, JSON.stringify(SCHEMA));
      cmd = [f.path, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--output-schema", schemaFile, prompt];
    } else {
      cmd = [f.path, "-p", prompt, "--output-format", "json"];
    }
    const r = await run(cmd, { env, cwd, timeoutMs });
    if (r.timedOut) throw new LlmError("slow", `${f.cli} の返事が ${timeoutMs / 1000} 秒以内に来ませんでした。少し待ってからもう一度`);
    if (r.code !== 0) {
      if (f.cli === "claude") {
        if (/unknown option/i.test(r.stderr)) throw new LlmError("update", "claude を更新してください");
        const a = await run([f.path, "auth", "status"], { env, cwd, timeoutMs: 10_000 });
        if (a.code !== 0) throw new LlmError("login", "terminal で claude を開いて login してください");
      }
      throw new LlmError("failed", `${f.cli} が失敗しました（${r.stderr.trim().split("\n").pop()?.slice(0, 120) ?? r.code}）`);
    }
    return parseReply(extractText(f.cli, r.stdout));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function extractText(cli: Cli, stdout: string): string {
  if (cli === "codex") return stdout.trim().split("\n").pop() ?? "";
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    if (j.structured_output && typeof j.structured_output === "object") return JSON.stringify(j.structured_output);
    if (typeof j.result === "string") return j.result;
    if (typeof j.response === "string") return j.response;
  } catch {}
  return stdout;
}

export type Mouth = { name: string; call(path: string[], outline: string | undefined, task: Task): Promise<Reply> };

// 選ぶ順: 鍵の口 → claude → codex → gemini。無ければ送り先が無い知らせ
export async function pickMouths(keyMouth: Mouth | null, found?: Found[]): Promise<Mouth[]> {
  const list = found ?? (await findClis());
  const mouths: Mouth[] = [];
  if (keyMouth) mouths.push(keyMouth);
  for (const f of list) mouths.push({ name: f.cli, call: (path, outline, task) => callCli(f, buildPrompt(path, outline, task), limitFor(task)) });
  return mouths;
}

export async function ask(mouths: Mouth[], path: string[], outline: string | undefined, task: Task): Promise<{ via: string; reply: Reply }> {
  const first = mouths[0];
  if (!first) throw new LlmError("none", "送り先がありません。API の鍵を入れるか、claude か codex を入れてください。gemini は有料の API key がある時だけ使えます");
  return { via: first.name, reply: await first.call(path, outline, task) };
}
