// rules-lint — この project の決まりのうち機械で見られる物を、commit の前に staged の「足した行」だけで見る（正本 docs/BRIEF-ruleslint.md）
// 使い方: bun tools/rules-lint.ts --staged（.githooks/pre-commit の最初）/ --all（追跡中の全 file の全行を 1 回数える・止めない）
// 逃げ道: KANGAE_SKIP_RULES=<理由> git commit …（理由は commit message の Skip-rules: に残る）・1 行だけなら同じ行に `rules-ok: <理由>`
// 新しい規則は RULES に 1 行足す（原文・日付・正本・違反の例を必ず持たせる）
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Line = { file: string; line: number; text: string };
type Rule = {
  id: string;
  says: string; // CEO の原文と日付
  source: string; // 正本の場所
  example: string; // 違反の例
  files: (file: string) => boolean; // 見る file
  hit: (text: string, staged: string[]) => boolean;
};

const CODE = /\.(ts|js|mjs|sh|swift|py)$|(^|\/)\.githooks\//;
const TRIAL = /^(test|tools|docs\/verify)\//; // 試験・道具
const trialCode = (f: string) => TRIAL.test(f) && CODE.test(f);
const code = (f: string) => CODE.test(f);
// /* … */ の後ろに code が続く行は comment ではない（review15: `/* */ pkill -f kangae` で抜けられた）
const comment = (t: string) => /^\s*(\/\/|#)/.test(t) || (/^\s*\/?\*/.test(t) && !/\*\/\s*\S/.test(t));

export const RULES: Rule[] = [
  {
    id: "headless",
    says: "2026-10-07 CEO「前面に出てきて居るよ」",
    source: "business/ai-browser-dispatch.md §1 5-B",
    example: 'launch({ ...opts, extraArgs: ["about:blank"] })',
    files: trialCode,
    // ponytail: 行単位。args を変数の spread で渡す行は見えないので赤になる → headless を足すか rules-ok: に理由
    hit: (t) => !comment(t) && !/^\s*expect\(/.test(t) && /extraArgs\s*:\s*\[|\b(spawn|open)\b.*(Google Chrome|Chromium|CHROMIUM_APP)/.test(t) && !/--headless=new/.test(t),
  },
  {
    id: "shared-kill",
    says: "共有の名前で process を止めない（自分が起こした PID か、その run の一時 dir を変数で渡す時だけ）",
    source: "business/ai-browser-dispatch.md §1 5-B",
    example: "pkill -f kangae",
    files: code,
    hit: (t) => !comment(t) && /\bpkill\s+-f\s+(?!\s)(?!(--\s+)?("[^"]*\$|'[^']*\$|\$))|\bkillall\b|\bpgrep\s+-f\b.*\|\s*xargs\s+kill|["']pkill["']\s*,\s*["']-f["']\s*,\s*["'][^$]|["']killall["']/.test(t),
  },
  {
    id: "front",
    says: "2026-10-06 前に出す命令を使わない",
    source: "business/ai-browser-dispatch.md §1 5-B",
    example: 'Bun.spawn(["open", "-a", CHROMIUM_APP])',
    files: trialCode,
    hit: (t) => !comment(t) && (/\bto activate\b|\bactivate\s*\(|activateIgnoringOtherApps|set frontmost to true/.test(t) || ((/\bopen\s+(-\w+\s+)*-a\b|["']open["']\s*,.*["']-a["']/.test(t)) && !/(\s|["'])-g\b/.test(t))),
  },
  {
    id: "git-write",
    says: "2026-10-08 git の事故 2 回（本物の repo で git stash / init / config を打たない）",
    source: "docs/BRIEF-ruleslint.md §1・implementor 備考 4",
    example: 'sh(["git", "config", "user.name", "t"])',
    files: trialCode,
    hit: (t) => !comment(t) && /\bgit(\s+-\S+(\s+(?!-)("[^"]*"|'[^']*'|\S+))?)*\s+(stash|init|config)\b|["']git["']\s*,.*["'](stash|init|config)["']/.test(t),
  },
  {
    id: "real-machine",
    says: "2026-10-08 CEO「実機確認はshellではなく、computeruseです」",
    source: "docs/SHELL-RUNNER.md・~/.claude/CLAUDE.md §owner の規則 4",
    example: "UC を runner で回し、実機で確かめた（docs/verify/ の写真なし）",
    files: (f) => /^docs\/(REPORT|HANDOFF)-[^/]*\.md$/.test(f),
    // ponytail: 写真が cua-driver で撮った物かまでは見ない（同じ commit に docs/verify/ の画像が在るかだけ）
    hit: (t, staged) => /実機で(確かめ|確認し)|実機確認(しました|済|した)/.test(t) && !staged.some((f) => /^docs\/verify\/.+\.(png|jpe?g)$/i.test(f)),
  },
  {
    id: "owner-home",
    says: "owner の home の物を試験で読まない",
    source: "business/ai-browser-dispatch.md §1 5-B",
    example: 'join(homedir(), ".kangae", "token")',
    files: (f) => /^(test|docs\/verify)\//.test(f) && code(f),
    hit: (t) => !comment(t) && /Application Support\/Kangae|["']Application Support["']\s*,\s*["']Kangae["']|~\/\.kangae\b|["']\.kangae["']|(^|[\s"'`~])\/Applications\/Kangae Bar\.app/.test(t),
  },
];

// 表そのものと、その試験（違反の例を文字列で持つ）は見ない
const SELF = new Set(["tools/rules-lint.ts", "test/rules-lint.test.ts"]);

export function lint(lines: Line[], staged: string[]) {
  const out: { rule: Rule; at: Line }[] = [];
  for (const at of lines) {
    if (SELF.has(at.file) || /rules-ok:\s*\S/.test(at.text)) continue;
    for (const rule of RULES) if (rule.files(at.file) && rule.hit(at.text, staged)) out.push({ rule, at });
  }
  return out;
}

// `git diff -U0` の出力から足した行だけを取る
export function addedLines(diff: string): Line[] {
  const out: Line[] = [];
  let file = "", n = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) file = l.startsWith("+++ b/") ? l.slice(6) : "";
    else if (l.startsWith("@@")) n = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    else if (l.startsWith("+") && file) out.push({ file, line: n++, text: l.slice(1) });
  }
  return out;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const git = (...a: string[]) => {
    const p = Bun.spawnSync(["git", "-C", root, "-c", "core.quotepath=false", ...a]); // 日本語の file 名を "b/\346…" に化けさせない（化けると file が空＝見ない・review15）
    if (p.exitCode !== 0) { console.error(`rules-lint: git ${a.join(" ")} が失敗: ${p.stderr}`); process.exit(2); }
    return p.stdout.toString();
  };
  const all = process.argv.includes("--all");
  if (!all && process.env.KANGAE_SKIP_RULES) { console.error(`rules-lint: skip（${process.env.KANGAE_SKIP_RULES}）`); process.exit(0); }
  let lines: Line[], staged: string[];
  if (all) {
    staged = git("ls-files").split("\n").filter(Boolean);
    lines = staged.flatMap((file) => {
      let s: string;
      try { s = readFileSync(join(root, file), "utf8"); } catch { return []; }
      return s.split("\n").map((text, i) => ({ file, line: i + 1, text }));
    });
  } else {
    staged = git("diff", "--cached", "--name-only", "--diff-filter=ACMR").split("\n").filter(Boolean);
    lines = addedLines(git("diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR"));
  }
  const bad = lint(lines, staged);
  for (const { rule, at } of bad) console.error(`${at.file}:${at.line} [${rule.id}] ${rule.says}（正本 ${rule.source}・例 ${rule.example}）\n    ${at.text.trim().slice(0, 160)}`);
  if (all) {
    const by: Record<string, number> = {};
    for (const { rule } of bad) by[rule.id] = (by[rule.id] ?? 0) + 1;
    console.log(`rules-lint --all: ${bad.length} 件 ${JSON.stringify(by)}`);
    process.exit(0);
  }
  if (bad.length) {
    console.error(`rules-lint: 決まりに反する足した行が ${bad.length} 件。直すか、同じ行に rules-ok: <理由>、全部なら KANGAE_SKIP_RULES=<理由>`);
    process.exit(1);
  }
  process.exit(0);
}
