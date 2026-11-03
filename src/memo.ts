import { looksSecret } from "./agents.ts";

// 引き継ぎメモ（W8b）。人が「代わる」を押した / agent が止まった時に、常駐が run の log と持っていた面から会話に 1 枚作る。
// agent には書かせない（嘘と秘密が混ざる）。「やった事」は道具名と回数だけ・面は app 名だけ。人の画面の文字・入力の値・頁の本文は入れない（F4）。
export type MemoIn = { why: "handover" | "stopped" | "failed"; log: string[]; app?: string; line?: string };
export const MEMO_MARK = "📋 引き継ぎメモ";
const TOOL = /^🔧 ([\w:.-]{1,60})/;
const safe = (s: string) => (!s.trim() ? "" : looksSecret(s) ? "（秘密に見えるので伏せました）" : s.replace(/\s+/g, " ").trim().slice(0, 100));

export function memoText(i: MemoIn): string {
  const tools = i.log.map((l) => TOOL.exec(l)?.[1]).filter((t): t is string => !!t);
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  const did = counts.size ? [...counts].slice(0, 6).map(([t, n]) => `${t} ×${n}`).join("・") : "まだ道具は使っていません";
  const last = tools.at(-1);
  const where = i.why === "handover" ? `人が代わりました${last ? `（最後に使った道具: ${last}）` : ""}` : safe(i.line ?? "") || "うまく終われませんでした";
  return [
    `${MEMO_MARK}（${i.why === "handover" ? "人が代わりました" : "agent が止まりました"}）`,
    `やった事: 道具 ${did}`,
    `止まった所: ${where}`,
    "次の一手: 「続けて」を押すと、このメモから agent が戻ります（面が要る時は agent が渡し直しを頼みます）",
    `触っていた面: ${i.app ? safe(i.app) || "なし" : "なし"}`,
  ].join("\n");
}
