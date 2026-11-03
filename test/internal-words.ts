// 人に出る文に出してはいけない内部の語（W53 の承認 card・W77e の panel の文言が同じ表を使う）。初期値は docs/design-ui-inventory.md §5。
// 「面」は単独では 0（surface の意）。「画面」「前面」「場面」などの普通の語は数えない。agent・tab・always allow / allow / deny は製品の語として残す
export const INTERNAL = new RegExp([
  "lease", "token", "\\bgen\\b", "origin", "surface", "\\bop\\b", "0600", "cookie", "操作権", "世代", "一望", "api の call", "再生", "click / type_text", "\\bweb\\b",
  "(?<![画場表帳方側地反書全前後正裏上下一])面(?![倒白])",
  "session", "\\bmods?\\b", "出所", "command", "\\bcwd\\b", "plugin", "\\bMCP\\b", "skill", "project", "engine", "provider", "\\bport\\b",
  "\\btasks?\\b", "\\bsearch\\b", "connect with", "Detected on", "\\blocal\\b",
  "password", "side panel", "許可は off",
].join("|"), "i");

// CEO 原文の画面の形。禁止語の表に掛ける前に、この句だけ除く（句の外に残った語は今までどおり赤）
export const VISIBLE_OK = ["message from"];
export function mentionsInternal(text: string): boolean {
  const stripped = VISIBLE_OK.reduce((s, w) => s.split(w).join(" "), text);
  return INTERNAL.test(stripped);
}
