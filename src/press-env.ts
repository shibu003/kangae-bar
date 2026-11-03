// W63: 押す操作の「要る物」を、相手の環境に結び付ける（契約 = docs/SPEC-press.md §5）。実機は見ない・全部 deps で差し替える
// 結び付かない物は「押す前の card」の行（人向けの文）になる。login は分からないので常に行になる
import type { Requirement } from "./press";
import { clean } from "./press-card";

export type EnvDeps = { exists(path: string): boolean; which(bin: string): boolean; extensionConnected(): boolean; appInstalled(bundle: string): boolean; cmds: string[] };
export type Missing = { req: Requirement; line: string };

const BREW = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

// 主画面に出る文なので PRESS_BANNED の語（adb など）は使わない。技術名は card の「詳しく」が持つ
export function lineOf(req: Requirement): string {
  if (req === "chromium-ext") return "Chrome の拡張機能がつながっていません。拡張機能を入れた Chrome を開いてください";
  if (req === "brew") return "Homebrew（道具を入れるための道具）が入っていません";
  if (req === "adb") return "スマホとつなぐための道具が入っていません";
  if (req === "bw") return "パスワード管理の道具（Bitwarden）が入っていません";
  if (req.startsWith("login:")) return `${clean(req.slice(6), 60)} に login した tab が要ります。押す前に開いて login してください`;
  if (req.startsWith("app:")) return `「${clean(req.slice(4), 60)}」の app が入っていません`;
  return "PC に道具が要ります（詳しくは「詳しく」）"; // cmd:<name> の名前は card の detail にだけ出す（W70）
}

export function resolveRequirements(reqs: Requirement[], deps: EnvDeps): { ok: Requirement[]; missing: Missing[] } {
  const ok: Requirement[] = [], missing: Missing[] = [];
  for (const req of reqs) {
    let has: boolean;
    if (req === "chromium-ext") has = deps.extensionConnected();
    else if (req === "brew") has = BREW.some((p) => deps.exists(p));
    else if (req === "adb") has = deps.which("adb") || deps.exists("/opt/homebrew/bin/adb");
    else if (req === "bw") has = deps.which("bw");
    else if (req.startsWith("login:")) has = false; // どの tab に login しているかは見えない: 押す前の card で聞く
    else if (req.startsWith("app:")) has = deps.appInstalled(req.slice(4));
    else if (req.startsWith("cmd:")) has = deps.cmds.includes(req.slice(4));
    else has = false; // 知らない種類は結び付けない（黙って通さない）
    if (has) ok.push(req); else missing.push({ req, line: lineOf(req) });
  }
  return { ok, missing };
}
