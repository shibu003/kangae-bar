import { renderFrom } from "./tabs.js";
import { gateHook } from "./gate.js";

// 見張りを入れている tab。遷移（読み込み直し）で MAIN world の差し替えは消えるので、遷移の確定時と操作の前に張り直す（W8b-2 review4）。
// MV3 の sw は idle で眠り memory が空になる → 一覧は chrome.storage.session（ブラウザを閉じるまで残り・disk に書かない）に置き、起きた時に読んで張り直す（W8b-2 fix2・図 §47）
// https://developer.chrome.com/docs/extensions/reference/api/storage#property-session
const gated = new Set();
const floors = new Map(); // tabId → 取り戻された世代の下限（W11c-3）。これより古い gen の act は実行の直前に断る
const KEY = "kangaeGated";
const save = () => chrome.storage.session.set({ [KEY]: [...gated] }).catch(() => {});
let restored = null; // sw が起きて 1 回だけ読む。読めない（storage が使えない）時は null に戻して次に読み直す
const restore = () => (restored ??= chrome.storage.session.get(KEY).then((o) => { for (const id of o?.[KEY] ?? []) gated.add(id); }).catch(() => { restored = null; }));
// 張れたら true。張れなかった tab は、張れるまで書き換えを断る（本物の passkey の dialog を CEO の前に出さない）
const arm = (tabId) => chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: gateHook, args: [true] }).then((r) => r[0]?.result === "on", () => false);
// W16b: agent が開いた tab（面になる前の間も含む）。tab を開きすぎた時の discard（sw の trim）から外す
const opened = new Set();
export const keep = () => new Set([...gated, ...opened]);
export const OPEN_MS = 15_000;
const loaded = (id, ms) => new Promise((res) => {
  let t;
  const done = (v) => { clearTimeout(t); chrome.tabs.onUpdated.removeListener?.(on); res(v); };
  const on = (x, info) => { if (x === id && info.status === "complete") done(true); };
  chrome.tabs.onUpdated.addListener(on);
  t = setTimeout(() => done(false), ms);
  chrome.tabs.get(id).then((x) => x?.status === "complete" && done(true), () => done(false)); // listener を張る前に終わっていた
});
export const NAMED = ["fill", "press_button", "select_option"]; // W42b: 名前つき操作（tab 面）。要素は token ではなく画面上の名前で指す
const WRITES = new Set([...NAMED, "vault_fill", "click", "double_click", "right_click", "drag", "type_text", "set_value", "press_key", "hotkey"]);
if (typeof chrome !== "undefined" && chrome.webNavigation) {
  chrome.webNavigation.onCommitted.addListener(async (d) => { if (d.frameId !== 0) return; await restore(); if (gated.has(d.tabId)) void arm(d.tabId); });
  chrome.tabs.onRemoved.addListener(async (tabId) => { opened.delete(tabId); await restore(); if (gated.delete(tabId)) void save(); });
  void restore().then(() => Promise.all([...gated].map(arm))); // 眠りから起きたら、渡している tab へすぐ張り直す
}
// web の面の腕。tab に差し込んで DOM を読み・書く（chrome.scripting・debugger は使わない＝黄色い帯が出ない）。
// page() は tab の中（isolated world）で動く 1 つの関数で、自分で完結している（外の変数を使えない）。
// 文書の印 K.doc は文書ごとに 1 つ（再読み込み・別 site で変わる）。実行の直前に、渡された docId と合うか毎回見る。
function page(tool, a) {
  const K = (globalThis.__kangae ??= { doc: `${performance.timeOrigin}:${crypto.randomUUID()}`, els: new Map(), n: 0, seen: 0 });
  if (tool === "tab_state") return { docId: K.doc };
  // 人の入力（isTrusted）だけを知らせ・時刻を持つ（W60a: 書く直前の確認が使う）。agent の操作は untrusted なので数えない。tab_info だけでなく全部の操作で入れる（新しい文書の最初の操作が書き込みでも持てる）
  if (!K.listening && tool !== "tab_state") {
    K.listening = true;
    for (const t of ["keydown", "mousedown", "wheel"]) addEventListener(t, (e) => { if (e.isTrusted) { const first = Date.now() - K.seen > 300; K.seen = Date.now(); if (first) chrome.runtime.sendMessage({ op: "human" }).catch(() => {}); } }, true);
  }
  if (tool === "tab_info") {
    return { docId: K.doc, title: document.title, url: location.href };
  }
  if (a.docId !== K.doc) return { error: true, text: "tab の文書が変わりました" };
  // W60a: 書く直前の最後の 1 手。この頁にいま focus があり、人の最後の入力（isTrusted の key / mousedown / wheel）が 1.5 秒以内なら、送らない（同じ JS の 1 手の中で見て書くので、見てから書くまでに人が入る隙が無い）
  if (a.guard === true && ["click", "double_click", "right_click", "drag", "type_text", "set_value", "press_key", "hotkey"].includes(tool) && document.hasFocus() && Date.now() - K.seen < 1500) return { error: true, text: "人が今この tab を操作しています（何も送っていません）", data: { human: true } };
  const el = () => { const e = K.els.get(a.element_token); return e?.isConnected ? e : null; };
  const stale = { error: true, text: "その要素はもうありません。get_window_state を読み直してください" };
  const roleOf = (e) => e.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: e.type === "checkbox" || e.type === "radio" ? e.type : "textbox", TEXTAREA: "textbox", SELECT: "select", H1: "heading", H2: "heading", H3: "heading", LI: "listitem", P: "text" }[e.tagName] ?? "element");
  if (tool === "get_window_state") {
    K.els.clear();
    const max = Math.min(Number(a.max_elements) || 300, 1000);
    // 人にしかできない確認の印（図 §47）。曖昧なら付ける側（門が止める）。invisible の reCAPTCHA（size=invisible）の badge は人に見せる物ではないので除く
    const gateOf = (e) => {
      if (e.matches("input,textarea") && /(^|\s)one-time-code(\s|$)/i.test(e.getAttribute("autocomplete") || "")) return "otp";
      if (e.tagName === "IFRAME") { const u = e.src || ""; return /recaptcha.*size=invisible/i.test(u) ? "" : /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|captcha/i.test(u) ? "captcha" : ""; }
      return e.matches(".g-recaptcha,.h-captcha,.cf-turnstile") ? "captcha" : "";
    };
    const all = [...document.querySelectorAll("a[href],button,input,textarea,select,[role],[contenteditable],[tabindex],h1,h2,h3,label,li,p,iframe,.g-recaptcha,.h-captcha,.cf-turnstile")];
    const keep = all.filter((e) => e.getClientRects().length && !(e.matches("li,p,label") && e.querySelector("a,button,input,textarea,select")) && (e.tagName !== "IFRAME" || gateOf(e)));
    const elements = keep.slice(0, max).map((e) => {
      const token = `d${++K.n}`;
      K.els.set(token, e);
      const value = "value" in e ? String(e.value) : e.isContentEditable ? e.textContent : "";
      const label = (e.getAttribute("aria-label") || e.innerText || e.placeholder || e.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
      return { element_token: token, role: roleOf(e), label, value, gate: gateOf(e), secure: e.matches("input[type=password]") };
    });
    return { data: { snapshot_id: K.doc.split(":")[1].slice(0, 8), elements, truncated: keep.length > max } };
  }
  if (tool === "click") { const e = el(); if (!e) return stale; e.click(); return { text: "clicked" }; }
  // 合成 event（untrusted）。窓も tab も前に出さず、ページの handler にだけ届く。native の menu は出ない
  const at = (e) => { const r = e.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };
  const mouse = (e, type, o = {}) => e.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, ...at(e), ...o }));
  if (tool === "double_click") {
    const e = el(); if (!e) return stale;
    for (const n of [1, 2]) { mouse(e, "mousedown", { detail: n }); mouse(e, "mouseup", { detail: n }); mouse(e, "click", { detail: n }); }
    mouse(e, "dblclick", { detail: 2 });
    return { text: "double_clicked" };
  }
  if (tool === "right_click") {
    const e = el(); if (!e) return stale;
    mouse(e, "mousedown", { button: 2, buttons: 2 }); mouse(e, "mouseup", { button: 2 }); mouse(e, "contextmenu", { button: 2, buttons: 2 });
    return { text: "right_clicked（ページの contextmenu handler に送りました。browser の menu は出ません）" };
  }
  if (tool === "drag") {
    const from = el(), to = K.els.get(a.to_element_token);
    if (!a.element_token || !a.to_element_token) return { error: true, text: "web の drag は element_token（掴む物）と to_element_token（落とす先）で指してください" };
    if (!from || !to?.isConnected) return stale;
    const dt = new DataTransfer();
    const dnd = (e, type) => e.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, dataTransfer: dt, ...at(e) }));
    // W54: 本物のポインタを使わない drag。経路を 8 点に刻み、各点の下の要素へ pointermove / mousemove（頁が経路で値を決める slider・並べ替え・描画用）。draggable なら HTML5 の drag and drop も（dragover も経路の点ごと）。
    // 全部 untrusted なので、isTrusted を見て人の操作だけ受ける頁には効かない（docs/verify/w54/RESULT.md の (B)）。効かない時は「効かなかった」と agent が確かめられる（読み直し）
    const pe = (e, type, o = {}) => e.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 1, pointerType: "mouse", isPrimary: true, ...at(e), ...o }));
    const p0 = at(from), p1 = at(to), N = 8, under = (i) => { const x = p0.clientX + ((p1.clientX - p0.clientX) * i) / N, y = p0.clientY + ((p1.clientY - p0.clientY) * i) / N; return [document.elementFromPoint(x, y) ?? to, { clientX: x, clientY: y }]; };
    const native = !!from.closest("[draggable=true]");
    pe(from, "pointerdown", { buttons: 1 }); mouse(from, "mousedown", { buttons: 1 });
    if (native) { dnd(from, "dragstart"); dnd(to, "dragenter"); }
    for (let i = 1; i <= N; i++) { const [t, xy] = under(i); if (native) dnd(t, "dragover"); else { pe(t, "pointermove", { buttons: 1, ...xy }); mouse(t, "mousemove", { buttons: 1, ...xy }); } }
    if (native) { dnd(to, "drop"); dnd(from, "dragend"); } else pe(to, "pointerup");
    mouse(to, "mouseup");
    return { text: "dragged" };
  }
  if (tool === "hotkey") {
    const keys = Array.isArray(a.keys) ? a.keys.map((k) => String(k).toLowerCase()) : [];
    const mods = { cmd: "metaKey", command: "metaKey", shift: "shiftKey", option: "altKey", alt: "altKey", ctrl: "ctrlKey", control: "ctrlKey" };
    const init = {};
    for (const k of keys.slice(0, -1)) { if (!mods[k]) return { error: true, text: `hotkey は修飾キー（cmd / shift / option / ctrl）を先に、最後に 1 つだけ key を書いてください（${k} は修飾キーではありません）` }; init[mods[k]] = true; }
    const last = keys.at(-1);
    if (!last || mods[last]) return { error: true, text: "hotkey は最後に修飾キーでない key を 1 つ書いてください（例: [\"cmd\", \"k\"]）" };
    const key = { return: "Enter", tab: "Tab", escape: "Escape", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", delete: "Backspace" }[last] ?? last;
    const e = document.activeElement ?? document.body;
    for (const t of ["keydown", "keyup"]) e.dispatchEvent(new KeyboardEvent(t, { key, bubbles: true, cancelable: true, composed: true, ...init }));
    return { text: "ページの key handler に送りました。選択・コピー・貼り付けなど browser 自身の既定の動作は起きません" };
  }
  if (tool === "type_text" || tool === "set_value") {
    let e = a.element_token ? el() : document.activeElement;
    // W45: Google Docs のように、入力を受ける編集面（contenteditable）が同 origin の iframe の中にある頁。focus は iframe にあるので、その中で今 focus のある編集面へ入れる（別 origin の iframe は触れない）
    if (!a.element_token && e?.tagName === "IFRAME") { try { const t = e.contentDocument?.activeElement; if (t?.isContentEditable) e = t; } catch { /* 別 origin */ } }
    if (!e || e === document.body) return a.element_token ? stale : { error: true, text: "入れる先の要素を element_token で指してください" };
    e.focus();
    const text = String(tool === "set_value" ? a.value ?? "" : a.text ?? "");
    if (e.isContentEditable) {
      if (tool === "set_value") e.ownerDocument.execCommand("selectAll");
      e.ownerDocument.execCommand("insertText", false, text);
    } else if ("value" in e) {
      const proto = e.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : e.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(e, tool === "set_value" ? text : e.value + text);
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
    } else return { error: true, text: "その要素には入れられません" };
    return { text: "ok" };
  }
  if (tool === "press_key") {
    const e = (a.element_token ? el() : document.activeElement) ?? document.body;
    const key = { return: "Enter", tab: "Tab", escape: "Escape", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", delete: "Backspace" }[String(a.key)];
    if (!key) return { error: true, text: "web で使える key: return, tab, escape, space, up, down, left, right, delete（文字は type_text）" };
    for (const t of ["keydown", "keyup"]) e.dispatchEvent(new KeyboardEvent(t, { key, bubbles: true, cancelable: true }));
    if (key === "Enter") { if (e.form && e.tagName === "INPUT") e.form.requestSubmit(); else if (e.matches("button,a[href]")) e.click(); }
    return { text: "ok" };
  }
  if (tool === "scroll") {
    const d = String(a.direction ?? "down");
    const step = (Number(a.amount) || 3) * (innerHeight / 3);
    scrollBy({ top: d === "down" ? step : d === "up" ? -step : 0, left: d === "right" ? step : d === "left" ? -step : 0 });
    return { text: "ok" };
  }
  return { error: true, text: `web の tab では ${tool} は使えません（使える: get_window_state, click, double_click, right_click, drag, type_text, set_value, press_key, hotkey, scroll）` };
}

// W42b（docs/design-no-fallback.md S4）: tab の名前つき DOM 操作。欄・ボタンを「見える名前」で指し、1 つに決まらなければ何もしない（推測しない）。
// tab の中で動く 1 つの関数で自分で完結している。値は返さない・password 欄と one-time-code 欄には入れない（金庫の注入と人の確認だけ）
export function namedOp(tool, a) {
  const K = globalThis.__kangae;
  if (!K || a.docId !== K.doc) return { error: true, text: "tab の文書が変わりました。get_window_state で読み直してください" };
  if (a.guard === true && tool !== "button_names" && document.hasFocus() && Date.now() - K.seen < 1500) return { error: true, text: "人が今この tab を操作しています（何も送っていません）", data: { human: true } }; // W60a: page() と同じ（書く直前の最後の 1 手）
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const text = (e) => String(e.innerText ?? e.textContent ?? "");
  const fieldName = (e) => norm(e.getAttribute("aria-label") || [...(e.labels ?? [])].map(text).join(" ") || e.getAttribute("placeholder") || e.getAttribute("name") || e.getAttribute("title") || e.id);
  // review26: 見える文字を先に（aria-label は頁が自由に付けられ、見える文字と違えば「次へ」の名前で「削除」を押させられる）。aria-label は見える文字が無い（アイコンだけの）時だけ
  // W60d: ボタンの名前は「見える文字」「aria-label」「title」の全部（どれでも 1 つに決まれば指せる）。aria-label は頁が自由に付けられる（見える文字と違えば「次へ」の名前で「削除」を押させられる）ので、
  // 門（lease）が押す前に button_names で全部の名前を受け取って危険語を見る・押す時は expect で「見た名前と同じ要素か」を確かめる
  const btnNames = (e) => [...new Set([e.tagName === "INPUT" ? e.value : text(e), e.getAttribute("aria-label"), e.getAttribute("title")].map((x) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))];
  const isBtn = (e) => e.tagName === "BUTTON" || e.getAttribute("role") === "button" || (e.tagName === "INPUT" && /^(submit|button|reset)$/.test(e.type));
  // review29: range / color を入れる（snapshot の role は textbox なので、名前つき操作だけの設定の時に click / set_value を断られて、fill も見つけられない行き止まりになっていた。slider の set_value は W54 の DRAG_HINT が勧める道）
  const isText = (e) => e.tagName === "TEXTAREA" || e.isContentEditable === true || (e.tagName === "INPUT" && /^(text|search|email|url|tel|number|date|datetime-local|month|week|time|range|color|)$/.test(e.type ?? ""));
  const btn = tool === "press_button" || tool === "button_names"; // button_names = 押さずにそのボタンの名前を全部返す（W60d・門が押す前に危険語を見る。古い拡張は知らない tool として何もしない＝押さない）
  const want = norm(btn ? a.name : a.field);
  if (!want) return { error: true, text: btn ? "name（ボタンの見える名前）を渡してください" : "field（欄の見える名前）を渡してください" };
  const pick = btn ? isBtn : tool === "select_option" ? (e) => e.tagName === "SELECT" : (e) => !isBtn(e) && e.tagName !== "SELECT" && isText(e);
  const nameOf = btn ? (e) => btnNames(e)[0] ?? "" : fieldName;
  const all = [...document.querySelectorAll("input,textarea,select,button,[role=button],[contenteditable]")].filter((e) => e.getClientRects().length && pick(e));
  const hits = all.filter((e) => (btn ? btnNames(e).map(norm) : [nameOf(e)]).includes(want));
  if (hits.length === 0) return { error: true, text: `「${want}」という名前の${btn ? "ボタン" : "欄"}は見つかりません。見える名前: ${[...new Set(all.map(nameOf).filter(Boolean))].slice(0, 8).join(" / ") || "なし"}` };
  if (hits.length > 1) return { error: true, text: `「${want}」は ${hits.length} 個あって 1 つに決まりません（何も変えていません）。get_window_state の element_token で指してください` };
  const e = hits[0];
  if (e.disabled || e.readOnly) return { error: true, text: "その要素は今は使えません（無効か読み取り専用）" };
  if (btn) {
    const names = btnNames(e);
    if (tool === "button_names") return { text: "resolved", data: { op: tool, names, matched: 1 } };
    if (Array.isArray(a.expect) && a.expect.join("\n") !== names.join("\n")) return { error: true, text: "ボタンの名前が、確かめた時から変わっています（何も押していません）。もう一度頼んでください" };
    e.click(); return { text: `「${want}」を押しました`, data: { op: tool, matched: 1 } }; }
  if (/one-time-code/i.test(e.getAttribute("autocomplete") || "")) return { error: true, text: "確認コードの欄は人にしか入れられません（何も変えていません）" };
  const v = String(a.value ?? a.option ?? "");
  const fire = (t) => e.dispatchEvent(new Event(t, { bubbles: true }));
  if (tool === "select_option") {
    const o = [...e.options].filter((x) => norm(x.text) === norm(v) || x.value === v);
    if (o.length !== 1) return { error: true, text: `選択肢「${v}」は ${o.length} 個で 1 つに決まりません。見える選択肢: ${[...e.options].map((x) => x.text).slice(0, 8).join(" / ")}` };
    e.value = o[0].value; fire("input"); fire("change");
    return { text: `「${want}」で「${o[0].text}」を選びました`, data: { op: tool, matched: 1 } };
  }
  e.focus();
  if (e.isContentEditable) { document.execCommand("selectAll"); document.execCommand("insertText", false, v); }
  else { const P = e.tagName === "TEXTAREA" ? globalThis.HTMLTextAreaElement : globalThis.HTMLInputElement; const set = P && Object.getOwnPropertyDescriptor(P.prototype, "value")?.set; if (set) set.call(e, v); else e.value = v; fire("input"); fire("change"); }
  return { text: `「${want}」に入れました（${[...v].length} 字）`, data: { op: tool, matched: 1 } };
}

// W8g-4b: 金庫の password を、渡している tab の password 欄へ（値は agent を通らない）。tab の中（isolated world）で動く 1 つの関数。
// host は「いまの頁」で数え直す（確認と注入の間に頁が動いても別 site には入らない）。value が null なら欄の数だけ返す（承諾の前の下見）。値は返さない
function fillPassword(host, value) {
  if (location.protocol !== "https:" || location.hostname.toLowerCase() !== host) return { n: -1 };
  const v = [...document.querySelectorAll("input[type=password]")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.disabled && !e.readOnly; });
  if (v.length !== 1 || value == null) return { n: v.length };
  try {
    const e = v[0];
    e.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, value);
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    return { n: 1, filled: e.value.length };
  } catch { return { n: -2 }; } // 例外を頁の外へ投げない（引数が error に載る形を作らない）
  finally { value = null; }
}
// W76c: 認証コード（TOTP）の欄。見える input のうち autocomplete=one-time-code か、名前・label・placeholder が認証コードらしい物がちょうど 1 つの時だけ（password と同じ約束: 数だけ返す・値は返さない）
function fillOtp(host, value) {
  if (location.protocol !== "https:" || location.hostname.toLowerCase() !== host) return { n: -1 };
  const RE = /otp|totp|one.?time|verification|auth.?code|security.?code|認証|確認コード|ワンタイム/i;
  const v = [...document.querySelectorAll("input")].filter((e) => {
    if (["password", "hidden", "checkbox", "radio", "submit", "button", "file", "image"].includes(e.type) || e.disabled || e.readOnly) return false;
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    return /one-time-code/.test(e.autocomplete || "") || RE.test([e.name, e.id, e.getAttribute("aria-label"), e.placeholder].join(" "));
  });
  if (v.length !== 1 || value == null) return { n: v.length };
  try {
    const e = v[0];
    e.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, value);
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    return { n: 1, filled: e.value.length };
  } catch { return { n: -2 }; } finally { value = null; }
}
// 例外の文に値が載らない（args が message / stack に入る形が来ても、値を伏せてから返す・log にも出さない）
async function vaultFill(a) {
  const host = String(a.host ?? "").toLowerCase();
  const value = typeof a.value === "string" && a.value ? a.value : null;
  const tab = await chrome.tabs.get(a.tabId).catch(() => null);
  let u = null; try { u = new URL(tab?.url ?? ""); } catch {}
  if (!host || u?.protocol !== "https:" || u.hostname.toLowerCase() !== host) return { error: true, text: "その tab の site が違う（または https でない）ので、何も入れていません" };
  let r;
  try { r = (await chrome.scripting.executeScript({ target: { tabId: a.tabId }, func: a.kind === "otp" ? fillOtp : fillPassword, args: [host, value] }))[0]?.result; }
  catch (e) { return { error: true, text: `入れられませんでした: ${String(e?.message ?? e).split(value ?? "\0").join("＊＊＊").slice(0, 120)}` }; }
  if (r?.n !== 1) return { error: true, text: r?.n === -1 ? "頁が別の site に移ったので、何も入れていません" : r?.n === -2 ? "頁の中で入れられませんでした" : `${a.kind === "otp" ? "認証コード" : "password"} の欄が ${r?.n ?? 0} 個で、1 個に決まりません。何も入れていません` };
  return value ? (r.filled ? { text: "filled", data: { filled: r.filled } } : { error: true, text: "欄に入りませんでした" }) : { text: "probe", data: { n: 1 } };
}

// api_fetch（W35c）: api-anything の request を、その site を開いている tab の中で fetch する。cookie（HttpOnly も）は Chrome が付け、常駐にも file にも来ない。site の tab が無ければ断る
async function apiFetch(a) {
  let u;
  try { u = new URL(String(a.url)); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { return { error: true, text: "http(s) の URL だけです" }; }
  // W46-B: tab は常駐が「その会話に貸した tab」から選んで渡す（拡張は origin が合うかだけ確かめる・勝手に他の tab を探さない）
  const tab = await chrome.tabs.get(Number(a.tabId)).catch(() => null);
  let to = ""; try { to = new URL(String(tab?.url)).origin; } catch {}
  if (!tab || to !== u.origin) return { error: true, text: `貸された tab が無い、または ${u.origin} の tab ではありません` };
  if (!["GET", "HEAD"].includes(String(a.method ?? "GET").toUpperCase())) return { error: true, text: "api の call は読むだけです（GET / HEAD）" };
  const run = async (url, init, max) => { // tab の中で走る（この関数は tab に写されるので、外の名前を使わない）
    try {
      const r = await fetch(url, { ...init, credentials: "include", redirect: "follow", cache: "no-store" });
      if (new URL(r.url).origin !== new URL(url).origin) return { fail: `別の site（${new URL(r.url).origin}）へ移されました。login が切れているかもしれません` };
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length > max) return { fail: "返事が大きすぎます" };
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return { status: r.status, url: r.url, headers: [...r.headers], body: btoa(s) };
    } catch (e) { return { fail: String(e?.message ?? e) }; }
  };
  let r;
  const init = { method: String(a.method ?? "GET"), headers: a.headers ?? {}, ...(typeof a.body === "string" ? { body: a.body } : {}) };
  try { r = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: run, args: [u.href, init, 4_000_000] }))[0]?.result; }
  catch (e) { return { error: true, text: `tab の中で取れませんでした: ${String(e?.message ?? e).slice(0, 120)}` }; }
  if (!r || r.fail) return { error: true, text: `取れませんでした: ${r?.fail ?? "tab が答えません"}` };
  return { data: r };
}

// ---- 画面に何も増やさずに別の頁を読む 2 つの道（図 §34）----
// fetch_url: 人の cookie を乗せて取るだけ（描画しない・窓も tab も作らない）。JS で描かれる値は入らない
async function fetchUrl(url) {
  let r;
  try { r = await fetch(url, { credentials: "include", cache: "no-store" }); } catch (e) { return { error: true, text: `取得できませんでした: ${e.message}` }; }
  if (new URL(r.url).origin !== new URL(url).origin) return { error: true, text: `別の site（${new URL(r.url).origin}）へ移されたので、中身は返しません。login が切れているかもしれません` };
  const type = r.headers.get("content-type") ?? "";
  let body = await r.text();
  if (/html/i.test(type)) body = body.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  return { text: `HTTP ${r.status} ${r.url}（描画していません。JS で描かれる値は入りません。入っていない時は render_url）\n${body.slice(0, 20_000)}`, error: !r.ok };
}
// render_url: offscreen 文書の iframe で描いて、見える文字を読む。窓も tab も作らない。既存の embed-rules（X-Frame-Options / CSP を剥がす）が効く
const rendered = new Map(); // 印 → 待っている resolve
const live = new Map(); // origin → 描いている数（0 になったら content script の登録を外す）
chrome.runtime.onMessage.addListener((m, sender) => { const w = m?.op === "rendered" ? rendered.get(m.id) : null; if (w && renderFrom(sender, w.origin)) w.res(m); }); // 描いている頁の枠の中（tab を持たない）から来た返事だけ。tab の頁・他の site の枠からは受けない
// 準備（offscreen 文書の作成・content script の登録・片づけ）は 1 本ずつ。同時に 2 本来ると、2 本目が「文書は無い」を見て作成に失敗し（握りつぶされる）、
// 文書も登録も整う前に描画を頼んで 6 秒待ちで落ちる（W3c M6・再起動後に 2/3 で赤）。準備を直列にして、整ってから頼む
let setup = Promise.resolve();
const serial = (f) => (setup = setup.then(f, f));
const registered = new Set(); // 登録済みの origin
async function renderUrl(url) {
  const id = `kangae-render:${crypto.randomUUID()}`, origin = new URL(url).origin;
  live.set(origin, (live.get(origin) ?? 0) + 1);
  try {
    await serial(async () => {
      if (!(await chrome.offscreen.hasDocument())) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["IFRAME_SCRIPTING"], justification: "agent が頼んだ頁を画面に出さずに描いて読む" });
      if (!registered.has(origin)) { await chrome.scripting.registerContentScripts([{ id: `kangae-frame:${origin}`, matches: [`${origin}/*`], js: ["frame.js"], allFrames: true, runAt: "document_idle" }]); registered.add(origin); }
    });
    const done = new Promise((res) => rendered.set(id, { res, origin }));
    chrome.runtime.sendMessage({ op: "renderLoad", id, url }).catch(() => {});
    const r = await Promise.race([done, new Promise((res) => setTimeout(() => res(null), 6000))]);
    if (!r) return { error: true, text: "描き終わりませんでした（頁が重いか、枠の中に入れない頁です）。fetch_url も試してください" };
    if (new URL(r.url).origin !== origin) return { error: true, text: `別の site（${new URL(r.url).origin}）へ移ったので、中身は返しません。login が切れているかもしれません` };
    return { text: `描画した頁 ${r.url}（題: ${r.title}）\n${r.text}` };
  } catch (e) {
    return { error: true, text: `描画の準備ができませんでした: ${e.message ?? e}` };
  } finally {
    rendered.delete(id);
    chrome.runtime.sendMessage({ op: "renderDrop", id }).catch(() => {});
    const n = (live.get(origin) ?? 1) - 1;
    if (n > 0) live.set(origin, n);
    else live.delete(origin);
    await serial(async () => { // 片づけも準備と同じ列で・列に入った時点で数え直す（待つ間に新しい描画が来ていたら外さない）
      if (!live.has(origin) && registered.delete(origin)) await chrome.scripting.unregisterContentScripts({ ids: [`kangae-frame:${origin}`] }).catch(() => {});
      if (!live.size) await chrome.offscreen.closeDocument().catch(() => {});
    });
  }
}

// sw から呼ぶ。返す形は { text, error, data }（常駐の Driver と同じ）
// W8e-5 / review11: 頁の要約。文字数だけだと「同じ長さの文字の入れ替わり」「打った入力欄の中身」が変わっても撮り直されない → 本文と入力欄の中身を頁の中で hash にして、hash だけ返す
// （本文・値は返さない。password 欄は長さだけ）。tab の中で動く 1 つの関数
function tabSig() {
  let h = 5381;
  const mix = (t) => { for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; };
  const body = document.body?.innerText ?? "";
  mix(body);
  for (const e of document.querySelectorAll("input,textarea,select")) mix(e.type === "password" ? `p${e.value.length}` : e.type === "checkbox" || e.type === "radio" ? String(e.checked) : String(e.value ?? ""));
  return `${location.href}|${document.title}|${document.getElementsByTagName("*").length}|${Math.round(scrollY)}|${body.length}|${h}`;
}

export async function webRun(tool, a) {
  // W8g: 人のログインを運ぶ。cookie_names = 名前と場所だけ（承諾の card 用）/ cookie_get = 値つき（承諾の後に常駐が 1 回だけ頼む）。取るのはその URL に送られる cookie だけ
  if (tool === "cookie_names" || tool === "cookie_get") {
    try {
      const u = new URL(String(a.url));
      if (!/^https?:$/.test(u.protocol)) return { error: true, text: "http(s) の URL だけです" };
      const all = await chrome.cookies.getAll({ url: u.href, partitionKey: {} });
      return { data: { cookies: tool === "cookie_get" ? all : all.map(({ name, domain, path, partitionKey }) => ({ name, domain, path, ...(partitionKey ? { partitionKey: { topLevelSite: partitionKey.topLevelSite ?? "" } } : {}) })) } };
    } catch (e) { return { error: true, text: `cookie を取れませんでした: ${e?.message ?? e}` }; }
  }
  // W8g-3: 履歴（人が card の checkbox を on にして許可した時だけ常駐が頼む）。権限が無ければ取らない。host の分だけ・題と URL だけ（query と # は常駐側でも落とす）
  if (tool === "history_get") {
    try {
      if (!(await chrome.permissions.contains({ permissions: ["history"] }))) return { error: true, text: "履歴の許可がありません" };
      const host = String(a.host ?? "").toLowerCase();
      if (!host) return { error: true, text: "host がありません" };
      const hits = await chrome.history.search({ text: host, maxResults: 500, startTime: 0 });
      return { data: { items: hits.map(({ url, title }) => ({ url, title })).slice(0, 500) } };
    } catch (e) { return { error: true, text: `履歴を取れませんでした: ${e?.message ?? e}` }; }
  }
  if (tool === "history_revoke") {
    try { await chrome.permissions.remove({ permissions: ["history"] }); return { text: "removed" }; }
    catch (e) { return { error: true, text: `履歴の許可を外せませんでした: ${e?.message ?? e}` }; }
  }
  if (tool === "api_fetch") return apiFetch(a);
  if (tool === "fetch_url") return fetchUrl(String(a.url));
  if (tool === "render_url") return renderUrl(String(a.url));
  // bar で指した browser の窓 → その窓の今見ている tab。窓の題は「tab の題 - app 名」なので、各窓の active tab の題で引く
  // W46-B: site を開いている tab を 1 つ探す（題と url と文書の印だけ・貸すかは常駐が人に聞く）
  if (tool === "tab_find") {
    let o; try { o = new URL(String(a.origin)).origin; } catch { return { error: true, text: "origin が読めません" }; }
    const tabs = await chrome.tabs.query({ url: `${o}/*` });
    const t = tabs.find((x) => x.active) ?? tabs[0];
    if (!t) return { data: null };
    let r; try { r = (await chrome.scripting.executeScript({ target: { tabId: t.id }, func: page, args: ["tab_info", {}] }))[0]?.result; } catch { return { data: null }; }
    return r?.docId ? { data: { tabId: t.id, docId: r.docId, title: t.title, url: t.url } } : { data: null };
  }
  if (tool === "tab_by_title") {
    const t = String(a.title ?? "");
    const hit = (await chrome.tabs.query({ active: true })).filter((x) => x.title && (t === x.title || t.startsWith(`${x.title} - `)));
    return { data: { tabIds: hit.map((x) => x.id) } };
  }
  // H1: 落とされた URL（# より前）と同じ tab。match pattern を通さず文字列で比べる（port・* を含む URL でも他の tab に当たらない）
  if (tool === "tabs_by_url") {
    const q = String(a.url ?? "").split("#")[0];
    return { data: { tabs: q ? (await chrome.tabs.query({})).filter((x) => x.id != null && String(x.url ?? "").split("#")[0] === q).map((x) => ({ id: x.id, title: x.title })) : [] } };
  }
  // W8e: 一望の覗き窓。tab_shot = いま見えている tab だけ小さな JPEG（裏の tab は撮れない＝理由つきで絵なし・debugger は使わない）。
  // tab_front = 人が絵を押した時だけ常駐が頼む（tab を前に・その窓を前面に）
  // W8e-5: 頁の要約（url・題・要素数・scroll・文字数）。値は返さない（常駐が hash にして前回と比べ、変わった時だけ tab_shot を頼む）。読めない頁は sig 無し＝毎回撮る
  if (tool === "tab_sig") {
    try {
      const r = (await chrome.scripting.executeScript({ target: { tabId: a.tabId }, func: tabSig }))[0]?.result;
      return { data: { sig: r ?? null } };
    } catch { return { data: { sig: null } }; }
  }
  if (tool === "tab_shot" || tool === "tab_front") {
    const t = await chrome.tabs.get(a.tabId).catch(() => null);
    if (!t) return { error: true, text: "その tab はもうありません" };
    if (tool === "tab_front") { await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); return { text: "fronted" }; }
    if (!t.active) return { error: true, text: "その tab は今見えていません（裏の tab は撮れません）" };
    try { // 撮ってすぐ幅 240 に縮める（native messaging は 1MB まで・数秒ごとに運ぶので小さく。拡げた時は a.w=720）
      const url = await chrome.tabs.captureVisibleTab(t.windowId, { format: "jpeg", quality: 40 });
      if (!(await chrome.tabs.get(t.id).catch(() => null))?.active) return { error: true, text: "撮る間に別の tab が前に出たので、絵は返しません" }; // 窓の見えている tab は渡した tab だけ
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      const w = Math.min(Number(a.w) || 240, 1280), h = Math.max(1, Math.round((bmp.height * w) / bmp.width)), c = new OffscreenCanvas(w, h);
      c.getContext("2d").drawImage(bmp, 0, 0, w, h);
      const buf = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: w > 240 ? 0.6 : 0.5 })).arrayBuffer());
      let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { data: { jpeg: btoa(bin) } };
    } catch (e) { return { error: true, text: `撮れませんでした: ${e?.message ?? e}` }; }
  }
  // W16b: agent が人の許しの後に開く新しい tab。裏で（active:false＝前面の窓も今見ている tab も替えない）開き、読み込みが終わるのを待って文書の印を返す（常駐がその会話の面にする）。
  // 開く browser は常駐が選ぶ（今の面の tab を持つ口）。url の検査は常駐の門（openUrlOf）が正本・ここは http(s) だけをもう一度見る
  if (tool === "open_tab") {
    let u;
    try { u = new URL(String(a.url)); } catch { return { error: true, text: "URL が読めません" }; }
    if (!/^https?:$/.test(u.protocol)) return { error: true, text: "http(s) の URL だけです" };
    const near = a.near != null ? await chrome.tabs.get(a.near).catch(() => null) : null;
    let t;
    try { t = await chrome.tabs.create({ url: u.href, active: false, ...(near ? { windowId: near.windowId } : {}) }); } catch (e) { return { error: true, text: `tab を開けませんでした: ${e?.message ?? e}` }; }
    opened.add(t.id); // 渡す前に中身を捨てられない（trim）
    if (!(await loaded(t.id, OPEN_MS))) return { error: true, text: "読み込みが終わりませんでした", data: { tabId: t.id } };
    let r;
    try { r = (await chrome.scripting.executeScript({ target: { tabId: t.id }, func: page, args: ["tab_info", {}] }))[0]?.result; } catch (e) { return { error: true, text: String(e?.message ?? e), data: { tabId: t.id } }; }
    return r?.docId ? { data: { tabId: t.id, docId: r.docId, title: r.title, url: r.url } } : { error: true, text: r?.text ?? "文書の印を読めませんでした", data: { tabId: t.id } };
  }
  const tabId = a.tabId;
  await restore();
  if (tool === "gate_off") { if (a.minGen != null) floors.set(tabId, Math.max(floors.get(tabId) ?? 0, a.minGen)); gated.delete(tabId); await save(); } // tab が無くても一覧から確実に消す
  if (!(await chrome.tabs.get(tabId).catch(() => null))) return tool === "tab_state" ? { data: { exists: false } } : { error: true, text: "その tab はもうありません" };
  if (tool === "gate_on" || tool === "gate_off") {
    if (tool === "gate_on") { gated.add(tabId); await save(); }
    try { return { text: (await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: gateHook, args: [tool === "gate_on"] }))[0]?.result ?? "" }; }
    catch (e) { return { error: true, text: String(e.message ?? e) }; }
  }
  if (gated.has(tabId) && !(await arm(tabId)) && WRITES.has(tool)) return { error: true, text: "WebAuthn の見張りを張り直せないので、書き換えは断りました（読む操作は通ります）" }; // 眠り・遷移で消えた見張りを張り直す（idempotent）。張れない間は書かない
  if (a.gen != null && a.gen < (floors.get(tabId) ?? 0)) return { error: true, text: "操作権は取り戻されました。止まってください（何も送っていません）" }; // 実行の直前（W11c-3）
  if (tool === "vault_fill") return vaultFill(a);
  let r;
  try { r = (await chrome.scripting.executeScript({ target: { tabId }, func: NAMED.includes(tool) || tool === "button_names" ? namedOp : page, args: [tool, a] }))[0]?.result; } catch (e) { r = { error: true, text: String(e.message ?? e) }; }
  if (tool === "tab_state") return { data: { exists: true, docId: r?.docId } };
  if (tool === "tab_info") return r?.docId ? { data: { ...r, here: await chrome.tabs.get(tabId).then(async (t) => !!t.active && !!(await chrome.windows.get(t.windowId)).focused).catch(() => false) } } : { data: null, error: true, text: r?.text ?? "文書の印を読めませんでした（頁が読み込み中・または拡張がその site に触れません）" };
  // 見張りが WebAuthn の呼び出しを断っていたら、どの操作の返事にも gate を載せる（読む前に起きた物も門が止める）
  const gate = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.documentElement.getAttribute("data-kangae-gate") || "" }).then((x) => x[0]?.result || "").catch(() => "");
  return { text: r?.text ?? "", error: !!r?.error, data: gate ? { ...(r?.data ?? {}), gate } : r?.data ?? null };
}
