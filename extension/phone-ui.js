// スマホの画面の部品（R4）: 文字と DOM の組み立てだけ。document を引数で受ける＝試験が偽の document で中身（残した文・消した文）を見られる。
// 方針（CEO 10-15）: 見てわかる物は文字にしない。残す文は「つながらない時の 1 行」と「承認の中身・2 つのボタン」など、安全や次の一手に要る物だけ。
// 文字は textContent だけ（Mac から来た名前・本文を HTML にしない）。

export const STR = {
  unreach: "この Mac につながりません。Mac が起きているか確かめてください", // 消さない（つながらない時の 1 行）
  retry: "もう一度つなぐ",
  yes: "許す（今回だけ）", // 消さない（承認の 2 つ。always は出さない）
  no: "断る",
  danger: "取り返しがつかないかもしれない操作です。Mac で答えてください", // 消さない（Mac でしか答えられない理由）
  resume: "再開",
  openBar: "Kangae を開く",
  empty: "まだ担当がいません",
  older: "前の会話を読む",
  sendFail: "送れませんでした。もう一度",
  fail: "うまくいきませんでした。もう一度試してください",
  macSame: "Mac の数字と同じなら許可", // 初回の許可待ち（別の端末が先に読んだ時に気付ける 4 桁の照合。消さない）
  // 状態の 1 行（見出しと説明に分けない）
  state: {
    noCrypto: "この接続では使えません（https が要ります）",
    scan: "Mac の QR を読んでください",
    connecting: "つないでいます",
    expired: "QR の期限が切れました。Mac で新しい QR を出してください",
    refused: "この QR は使えません。Mac で新しい QR を出してください",
    revoked: "この Mac に登録されていません。QR を読み直してください",
    lost: "この Mac につながりません。Mac が起きているか確かめてください",
  },
};

export const el = (doc, tag, cls, text) => {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
};
const btn = (doc, cls, text, onclick) => { const b = el(doc, "button", cls, text); b.type = "button"; if (onclick) b.onclick = onclick; return b; };

export const glyph = (name) => [...String(name ?? "")][0] ?? "·";
export const avColor = (id) => `var(--ag${Math.abs(Number(id) || 0) % 6})`;
export const stClass = (s) => (["turn", "work", "fail"].includes(s) ? s : "neutral");

// 一覧の 1 行: avatar・名前・状態（点 + 語）・最後の 1 文。止まった担当には行の上に「再開」（兄弟の button = button の中に button を入れない）
export function rowView(doc, r, { onOpen, onResume }) {
  const li = el(doc, "li", "item"), row = btn(doc, "row", "", () => onOpen(r)), av = el(doc, "span", "av", glyph(r.name)), body = el(doc, "span", "body");
  const top = el(doc, "span", "top"), name = el(doc, "span", "name", r.name), st = el(doc, "span", `st ${stClass(r.state)}`);
  st.append(el(doc, "i", "dot"), r.label);
  top.append(name, st);
  body.append(top);
  if (r.last) body.append(el(doc, "span", "last", r.last));
  row.setAttribute("aria-label", `${r.name}、${r.label}${r.last ? `。${r.last}` : ""}`);
  av.style.background = avColor(r.id);
  row.append(av, body);
  li.append(row);
  if (r.stopped) li.append(btn(doc, "go", STR.resume, (e) => onResume(r, e.currentTarget ?? e.target)));
  return li;
}

// 承認 card: 中身（何を許すか）と 2 つのボタンだけ。always・この頼みの間は出さない。取り返しがつかない物はボタンを出さず、Mac で答える理由の 1 行
export function apprView(doc, a, { onAnswer }) {
  const c = el(doc, "section", "appr");
  c.append(el(doc, "h3", "", a.text));
  if (a.app) c.append(el(doc, "p", "app", a.app));
  if (a.danger) { c.append(el(doc, "p", "dg", STR.danger)); return c; }
  const row = el(doc, "div", "btns"), yes = btn(doc, "btn", STR.yes), no = btn(doc, "btn quiet", STR.no);
  const go = (allow) => { yes.disabled = no.disabled = true; c.setAttribute("aria-busy", "true"); onAnswer(a, allow, () => { yes.disabled = no.disabled = false; c.removeAttribute("aria-busy"); }); };
  yes.onclick = () => go(true); no.onclick = () => go(false);
  row.append(yes, no);
  c.append(row);
  return c;
}

export function bubbleView(doc, m) {
  const w = el(doc, "div", `msg${m.mine ? " mine" : ""}`);
  w.append(el(doc, "div", "bub", m.text));
  return w;
}
