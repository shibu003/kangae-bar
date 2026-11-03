// W63: 押す操作を、非エンジニアが読める card の文にする（契約 = docs/SPEC-press.md §5）
// 作り手の自由文は使わない: 各段の goal と、opsview.ts:46 の DO の語（非 export なので、ここに同じ語の写し）から組む。技術語は detail（「詳しく」）にだけ
import type { Press, Requirement, Stage } from "./press";
import type { Missing } from "./press-env";

export type Step = { who: "agent" | "you"; text: string; state: "done" | "now" | "wait" | "stopped" };
export type Card = { title: string; lines: string[]; steps: Step[]; detail: string[] };

export const PRESS_BANNED = ["adb", "pairing", "ペアリング", "IP", "port", "ポート", "build", "ビルド", "ワイヤレスデバッグ", "アカウント", "token", "cookie", "sandbox", "CDP", "DOM", "AX", "lease", "gen", "worktree", "commit"];
const ASCII = /^[A-Za-z]+$/;
// 英字の語は前後が英数字でない所だけ（"support" の port・"release" の lease に当てない）。全角・制御文字で隠した語も、正規化してから見る
const BANNED_RE = PRESS_BANNED.map((w) => ({ w, re: ASCII.test(w) ? new RegExp(`(?<![A-Za-z0-9])${w}(?![A-Za-z0-9])`, "i") : new RegExp(w, "i") }));
export function checkCardText(card: Pick<Card, "title" | "lines" | "steps">): { ok: true } | { ok: false; words: string[] } {
  const text = [card.title, ...card.lines, ...card.steps.map((s) => s.text)].map((s) => s.replace(/[\p{Cc}\p{Cf}]/gu, "").normalize("NFKC")).join("\n");
  const words = BANNED_RE.filter(({ re }) => re.test(text)).map(({ w }) => w);
  return words.length ? { ok: false, words } : { ok: true };
}

// 主画面の文から禁止語を伏せる（検査と同じ正規化の後で・語の綴りの違いも同じ表で）。detail は触らない
const GLOBAL_RE = PRESS_BANNED.map((w) => new RegExp(ASCII.test(w) ? `(?<![A-Za-z0-9])${w}(?![A-Za-z0-9])` : w, "gi"));
const mask = (s: string) => GLOBAL_RE.reduce((t, re) => t.replace(re, "◯◯"), s.replace(/[\p{Cc}\p{Cf}]/gu, "").normalize("NFKC"));
export const maskCard = (c: Card): Card => ({ ...c, title: mask(c.title), lines: c.lines.map(mask), steps: c.steps.map((s) => ({ ...s, text: mask(s.text) })) });

export const clean = (s: unknown, n = 80): string => String(s ?? "").replace(/\p{Cf}/gu, "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, n); // 書式の文字（RTL の U+202E・零幅など Cf）は詰めて消し、制御文字は空白にする（review19）。詰めるので「a​db」のように隠した語も 1 語に戻って検査に掛かる
const DO: Record<string, string> = { click: "押す", double_click: "ダブルクリックする", right_click: "右クリックする", type_text: "文字を入れる", press_key: "キーを押す", hotkey: "ショートカットを押す", set_value: "値を書き換える", drag: "ドラッグする", scroll: "スクロールする", fill: "欄に入れる", press_button: "ボタンを押す", select_option: "選択肢を選ぶ", get_window_state: "画面を読む", fetch_url: "同じ site の頁を読む", render_url: "頁を描いて読む", open_tab: "新しい tab を開く", open_app: "app を開く", window_image: "窓の絵を読む", web_op: "頁の操作をする" };
const MISMATCH = { ask: "予定と違う時は、止まってあなたに聞きます", skip: "予定と違う時は、その段を飛ばして続けます", alt: "予定と違う時は、別の押す操作を試します" };

// その段が触る物（人向け）。DO に無い手は goal を使う（「<op> をした」とは書かない）
const touches = (s: Stage): string => {
  const w = s.way;
  if (w.kind === "act") return clean(w.app, 40);
  if (w.kind === "op") return clean(w.app, 40);
  if (w.kind === "api") return clean(w.site, 40);
  if (w.kind === "runCmd") return clean(s.goal, 40) || "PC（道具を入れる）"; // command 名は主画面に出さない（detail にだけ・W70）
  return "";
};
const doOf = (s: Stage): string => s.way.kind === "act" ? DO[s.way.tool] ?? "" : "";
const askLabels = (p: Press): string[] => Object.entries(p.fields).filter(([, f]) => "ask" in f).map(([k, f]) => clean(("label" in f && f.label) || k, 30));
const usedFields = (p: Press): Set<string> => {
  const used = new Set<string>();
  for (const s of p.stages) {
    const refs = s.way.kind === "act" ? s.way.args : s.way.kind === "op" ? s.way.slots : s.way.kind === "api" ? s.way.params : {};
    for (const r of Object.values(refs)) if ("field" in r) used.add(r.field);
  }
  return used;
};

export function cardText(press: Press, resolved: { ok: Requirement[]; missing: Missing[] }): Card {
  const goals = press.stages.map((s) => clean(s.goal, 60)).filter(Boolean);
  const asks = askLabels(press);
  const apps = [...new Set(press.stages.map(touches).filter(Boolean))];
  const lines: string[] = [];
  lines.push(`何をする: ${goals.length ? goals.join(" → ") : "（段がありません）"}`);
  lines.push(`あなたがする事: ${[...asks.map((a) => `「${a}」を決める`), ...resolved.missing.map((m) => m.line)].join("・") || "なし"}`);
  lines.push(`触る物: ${apps.join("・") || "なし"}`);
  lines.push("しない事: あなたが決めた欄以外の値は入れません。中身をどこにも送りません");
  lines.push(`止まる時: ${MISMATCH[press.onMismatch]}`);
  lines.push(`戻せる物: ${press.claims?.map((c) => clean(c, 60)).filter(Boolean).join("・") || "作り手は宣言していません"}`);
  lines.push(`送り手: ${press.madeBy ? `指紋 ${press.madeBy.fp.slice(0, 8)} の人` : "あなた自身"}`);
  const lim = press.limits;
  const when = [lim.expires ? `${new Date(lim.expires).toISOString().slice(0, 10)} まで` : "", lim.maxRuns ? `${lim.maxRuns} 回まで` : "", lim.priceMax != null ? `お金は ${lim.priceMax} 円まで` : ""].filter(Boolean);
  lines.push(`期限: ${when.join("・") || "なし"}`);

  // 段の一覧: あなた（先に済ませる事）→ agent（段ごと）。あなたの行 = 決める欄・結び付かない要る物（login など）
  const steps: Step[] = [
    ...resolved.missing.map((m): Step => ({ who: "you", text: m.line, state: "wait" })),
    ...asks.map((a): Step => ({ who: "you", text: `「${a}」を決めて入れる`, state: "wait" })),
    ...press.stages.map((s): Step => ({ who: "agent", text: `${clean(s.goal, 60)}${doOf(s) ? `（${doOf(s)}）` : ""}`, state: "wait" })),
  ];
  const unused = [...usedFields(press)].filter((f) => !(f in press.fields));
  const detail = [
    `id: ${press.id}`,
    ...press.stages.map((s) => `段 ${s.n}（${s.kind}）: ${clean(s.goal, 80)} / 手: ${s.way.kind}${s.way.kind === "act" ? ` ${clean(s.way.tool, 30)}` : s.way.kind === "op" ? ` ${clean(s.way.name, 30)}` : s.way.kind === "api" ? ` ${clean(s.way.op, 30)}` : s.way.kind === "runCmd" ? ` ${clean(s.way.name, 30)}` : ""} / 要る物: ${(s.requires ?? []).join(", ") || "なし"}`),
    `要る物（結び付いた）: ${resolved.ok.join(", ") || "なし"}`,
    `要る物（結び付かない）: ${resolved.missing.map((m) => m.req).join(", ") || "なし"}`,
    ...(press.madeBy ? [`送り手の指紋: ${press.madeBy.fp}`] : []),
    ...(unused.length ? [`欄の宣言が無い参照: ${unused.join(", ")}`] : []),
  ];
  return { title: `「${clean(press.name, 40)}」を押す`, lines, steps, detail };
}
