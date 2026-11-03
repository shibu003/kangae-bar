// AI を替える判定（W5）。上流 OpenRoly operator/engine-choice.ts の形（keep / switch / wait / refuse・理由 5 つ・
// 「unknown では替えない」「従量課金は人が許すまで替えない」）を写した純関数。process も file も触らない。
// 上流と違う所: 利用枠の窓の数字は持たない。証拠は「走りが上限 / login の文で止まった」事実と、そこから読めた戻る時刻だけ。
export type Cli = "claude" | "codex" | "gemini";
export type Billing = { kind: "contract" } | { kind: "metered"; source: string } | { kind: "not-logged-in" } | { kind: "unknown" };
export type Why = "limit" | "metered" | "unconfirmed" | "login" | "start-failed";
export type Choice =
  | { kind: "keep" }
  | { kind: "switch"; to: Cli; reason: Why }
  | { kind: "wait"; until: number; line: string }
  | { kind: "refuse"; reason: Why; line: string };

export type ChooseInput = {
  current: Cli;
  order: readonly Cli[]; // 入っている AI（優先順）。current を含んでよい
  billing: Partial<Record<Cli, Billing>>;
  failed: "limit" | "login" | null; // current が今止まった理由（見ていなければ null）
  until: number | null; // current の上限が戻る時刻（読めた時だけ）
  unusable?: readonly Cli[]; // 起こせなかった・さっき同じ理由で止まった AI
  allowed?: ReadonlySet<Cli>; // 人が「従量でもよい」と許した AI
};

// 人に勧める AI は使える物だけ。Google は 2026-06-18 に個人向けの Gemini CLI を止めた（有料の API key と Enterprise は使える）
// https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
// 今止まった AI（current）は勧めない: 替え先が無い時は current を除く。AI が 1 つも無い時だけ全部
export const installHint = (current?: Cli) => {
  const names = (["claude", "codex"] as Cli[]).filter((c) => c !== current).join(" か ");
  return `${names} を入れ${current ? "ると替われます" : "てください"}。gemini は有料の API key がある時だけ使えます`;
};
export const INSTALL_HINT = installHint();
export const GEMINI_ENDED = "gemini は Google の個人向けの提供が終わりました（2026-06-18）";
export const DEAD_GEMINI = /IneligibleTier|no longer supported for Gemini/i;

export const NAMES: Record<Cli, string> = { claude: "claude", codex: "codex", gemini: "gemini" };

// 今日は H:mm、別の日は M/D H:mm
export function formatReset(at: number, now = Date.now()): string {
  const w = new Date(at);
  const clock = `${w.getHours()}:${String(w.getMinutes()).padStart(2, "0")}`;
  return w.toDateString() === new Date(now).toDateString() ? clock : `${w.getMonth() + 1}/${w.getDate()} ${clock}`;
}

export const backWords = (until: number | null, now = Date.now()) => (until === null ? "戻る時刻は分かりません" : `${formatReset(until, now)} に戻ります`);
export const stopWords = (c: Cli, failed: "limit" | "login" | null, until: number | null, now: number) =>
  failed === "login" ? `${NAMES[c]} の login が切れています` : failed === "limit" ? `${NAMES[c]} が上限です（${backWords(until, now)}）` : `${NAMES[c]} を使えません`;

export const meteredLine = (c: Cli, source: string) => `${NAMES[c]} は従量課金（${source}）で動く設定です。お金がかかるので、あなたが許すまで替えません（お金がかかってもよければ「従量でもよい」を押してください）`;
export const loginLine = (c: Cli) => `${NAMES[c]} の login が切れています。ターミナルで ${NAMES[c]} と打って login すると、続きを頼めます`;
export const unconfirmedLine = (c: Cli | null | undefined) => (c ? `${NAMES[c]} が契約で使えるか確かめられないので、替えません。ターミナルで ${NAMES[c]} を開いて確かめてください` : `替えられる agent が見つかりません。${INSTALL_HINT}`);

export function chooseEngine(i: ChooseInput, now = Date.now()): Choice {
  const unusable = i.unusable ?? [];
  const allowed = i.allowed ?? new Set<Cli>();
  const kind = (c: Cli) => i.billing[c]?.kind ?? "unknown";
  // unknown は使える証拠ではない（上流: 確かめられない物は unconfirmable。使える物に数えない）
  const usable = (c: Cli) => !unusable.includes(c) && (kind(c) === "contract" || (kind(c) === "metered" && allowed.has(c)));
  if (i.failed === null && usable(i.current)) return { kind: "keep" };
  const others = i.order.filter((c) => c !== i.current);
  const to = others.find(usable);
  const reason: Why = i.failed ?? (unusable.includes(i.current) ? "start-failed" : "unconfirmed");
  if (to) return { kind: "switch", to, reason };
  // 替え先が 1 つも使えない。お金 → login → 確かめられない の順で、人が変えられる物を名指す（上流と同じ）
  for (const c of others) {
    const b = i.billing[c];
    if (b?.kind === "metered" && !allowed.has(c)) return { kind: "refuse", reason: "metered", line: `${stopWords(i.current, i.failed, i.until, now)}。${meteredLine(c, b.source)}` };
  }
  for (const c of others) if (kind(c) === "not-logged-in") return { kind: "refuse", reason: "login", line: `${stopWords(i.current, i.failed, i.until, now)}。${loginLine(c)}` };
  const nothing = others.length === 0;
  if (i.failed === "limit" && i.until !== null) {
    return { kind: "wait", until: i.until, line: `${stopWords(i.current, "limit", i.until, now)}。${nothing ? `替えられる agent がありません。${installHint(i.current)}。` : `${unconfirmedLine(others[0])} `}それまで待ってください` };
  }
  return { kind: "refuse", reason: i.failed ?? "unconfirmed", line: `${stopWords(i.current, i.failed, i.until, now)}。${nothing ? `替えられる agent がありません。${installHint(i.current)}` : unconfirmedLine(others[0])}` };
}

// ---- 止まり方の読み取り（走りの最後の文から）----
const LIMIT = /usage limit|hit your limit|limit reached|rate.?limit|quota (exceeded|exhausted)|exceeded your (current )?quota|resource.?exhausted|too many requests|\b429\b/i;
const LOGIN = /\/login|invalid api key|not logged in|please run .*login|authentication (required|failed)|error authenticating|ineligible ?tier|please (sign|log) ?in|not authenticated/i;

// 「resets 3pm」「resets at 3:30 PM」「reset at 15:30」「|1760000000」から戻る時刻を読む。読めなければ null
export function parseReset(text: string, now = Date.now()): number | null {
  const epoch = text.match(/limit reached\|(\d{10})/i);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = text.match(/resets?(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// 終わり方がおかしい時（exit が 0 でない・is_error）か、短い文の時だけ見る。長い答えの中の「limit」という語は止まりではない
export function judgeStop(text: string, bad: boolean, now = Date.now()): { failed: "limit" | "login"; until: number | null } | null {
  if (!bad && text.length > 300) return null;
  if (LOGIN.test(text)) return { failed: "login", until: null };
  if (LIMIT.test(text)) return { failed: "limit", until: parseReset(text, now) };
  return null;
}

// ---- 従量課金の見分け（秘密は読まない・在るかだけ）----
const METERED = new Set(["api_key", "api_key_helper", "third_party"]);
const SHOWABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export function judgeClaudeStatus(code: number | null, stdout: string): Billing {
  let s: any;
  try { s = JSON.parse(stdout); } catch { return { kind: "unknown" }; }
  const named = [s?.apiKeySource, s?.apiProvider, s?.authMethod].find((x) => typeof x === "string" && SHOWABLE.test(x));
  if ((typeof s?.authMethod === "string" && METERED.has(s.authMethod)) || (typeof s?.apiKeySource === "string" && s.apiKeySource !== "") || (typeof s?.apiProvider === "string" && s.apiProvider !== "firstParty"))
    return { kind: "metered", source: named ?? "its settings" };
  if (s?.loggedIn === true && code === 0 && typeof s?.subscriptionType === "string" && s.subscriptionType) return { kind: "contract" };
  if (s?.loggedIn === true && code === 0 && s?.authMethod === "claude.ai") return { kind: "contract" };
  if (s?.loggedIn === false) return { kind: "not-logged-in" };
  return { kind: "unknown" };
}
// gemini は status の口が無い。settings の auth 種別（oauth-personal = 契約・login 済み）と env の鍵の「在るか」だけ
export function judgeGemini(selectedType: unknown, env: Record<string, string | undefined>, hasOauth: boolean): Billing {
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return { kind: "metered", source: env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY" };
  if (selectedType === "oauth-personal") return hasOauth ? { kind: "contract" } : { kind: "not-logged-in" };
  if (typeof selectedType === "string" && /api-key|vertex/.test(selectedType)) return { kind: "metered", source: selectedType };
  return { kind: "unknown" };
}
