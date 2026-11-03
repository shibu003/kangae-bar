// スマホの画面: QR の # の後ろから鍵を取り、すぐ履歴から消す。Mac の「許可」を待って、担当の一覧（R1）→ 会話を読む・送る・承認に今回だけ答える（R2）→ 止まった担当の再開・Kangae を開く（R3）。
// R4: 触る所だけ。頭の題・見出し・説明は無い。状態は点と色、結果はボタンの無効化と toast 1 行。画面の部品と文字は phone-ui.js。
// 「送りました」を言う代わりに、Mac から結果が返った時だけ欄を空にする。通信が切れたら同じ request_id で送り直す（Mac は 2 度目を実行しない）。
import { Chan, authBytes, b64, base, deviceId, pairKey, rand, sessionKey, unb64 } from "./wire.js";
import { STR, apprView, avColor, bubbleView, el, glyph, rowView, stClass } from "./phone-ui.js";

const hash = location.hash; // 読んだら即消す（履歴・共有・スクショに鍵を残さない）。await より前
history.replaceState(null, "", location.pathname + location.search);

const $ = (id) => document.getElementById(id);
const text = (id, v) => { $(id).textContent = v ?? ""; };

// ---- この端末の身元（署名鍵は取り出せない形で IndexedDB へ）。使えない時は覚えない（次は QR が要る） ----
const idb = () => new Promise((res, rej) => { const r = indexedDB.open("kangae-remote", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const kv = async (mode, fn) => { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction("kv", mode); const out = fn(t.objectStore("kv")); t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error); }); };
const loadDev = () => kv("readonly", (s) => s.get("dev")).catch(() => null);
const saveDev = (d) => kv("readwrite", (s) => s.put(d, "dev")).catch(() => {});
const dropDev = () => kv("readwrite", (s) => s.delete("dev")).catch(() => {});

const deviceName = () => (/iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android" : "スマホ");

// ---- 画面 ----
let toastTimer = null;
const toast = (msg) => { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4000); };

let cur = null; // 開いている会話の id
let conv = null; // 最後に Mac から来た { name, state, label, rows, approvals, more }
let lastRows = [];
let barOpen = null; // Kangae の画面（Bar）が開いているか。false の時だけ「Kangae を開く」を出す

function showList() { cur = null; conv = null; $("convView").hidden = true; $("listView").hidden = false; }
// 状態の 1 行（QR・つながらない など）。一覧は隠す。許可待ちだけ数字を大きく
function showState(kind, extra) {
  showList();
  $("state").hidden = false;
  text("msg", kind === "waiting" ? STR.macSame : STR.state[kind] ?? "");
  $("code").hidden = kind !== "waiting";
  text("code", extra ?? "");
  $("act").hidden = kind !== "lost";
  text("act", STR.retry);
  $("list").replaceChildren();
  $("empty").hidden = $("baropen").hidden = true;
}
function render(rows) {
  lastRows = rows;
  $("state").hidden = true;
  $("empty").hidden = rows.length > 0;
  text("empty", rows.length ? "" : STR.empty);
  $("list").replaceChildren(...rows.map((r) => rowView(document, r, { onOpen: (x) => openConv(x.id), onResume: resumeRow })));
  const bar = $("baropen");
  bar.hidden = barOpen !== false;
  text("baropen", STR.openBar);
}

// ---- 会話（R2） ----
const note = (msg) => text("note", msg);
function openConv(id) {
  cur = id; conv = null;
  const r = lastRows.find((x) => x.id === id);
  paintHead(r);
  $("msgs").replaceChildren(); $("appr").replaceChildren(); $("in").value = ""; note(""); sync();
  $("cline").hidden = up;
  text("cline", STR.unreach);
  $("listView").hidden = true; $("convView").hidden = false;
  history.pushState({ conv: id }, "");
  tell({ ev: "open", conv: id });
}
function paintHead(c) {
  text("cname", c?.name ?? ""); text("cav", glyph(c?.name)); $("cav").style.background = avColor(cur);
  $("cdot").className = `cdot ${stClass(c?.state)}`; $("cdot").setAttribute("aria-label", c?.label ?? ""); $("cdot").title = c?.label ?? "";
}
function closeConv() { if (cur != null) tell({ ev: "close" }); showList(); render(lastRows); }
const goBack = () => (history.state?.conv != null ? history.back() : closeConv());
$("back").onclick = goBack;
addEventListener("popstate", () => { if (cur != null) closeConv(); });

function paintConv(c, keepScroll) {
  const box = $("msgs"), near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  paintHead(c);
  const kids = [];
  if (c.more) { const b = el(document, "button", "more", STR.older); b.type = "button"; b.onclick = () => { b.disabled = true; tell({ ev: "open", conv: cur, before: c.rows[0]?.id }); }; kids.push(b); }
  for (const m of c.rows) kids.push(bubbleView(document, m));
  box.replaceChildren(...kids);
  if (!keepScroll || near) box.scrollTop = box.scrollHeight;
  $("appr").replaceChildren(...c.approvals.map((a) => apprView(document, a, { onAnswer: answer })));
}

// 送る・答える・再開 = request_id つきの依頼。Mac から結果が返るまで成功とは言わない。返らない・切れた時は同じ request_id で送り直す（Mac は 2 度目を実行しない）
const outbox = new Map(); // rid → { msg, done, keep, timer }
const rid = () => b64(rand(12));
function request(msg, done, { id = rid(), keep = false } = {}) {
  const e = outbox.get(id) ?? { msg: { ...msg, rid: id }, timer: null };
  e.done = done; e.keep = keep; outbox.set(id, e);
  fire(id);
  return id;
}
function fire(id) {
  const e = outbox.get(id);
  if (!e) return;
  clearTimeout(e.timer);
  e.timer = setTimeout(() => { // 結果が返らない = まだ分からない。送りと再開は残して（つなぎ直したら同じ request_id で送り直す）・答えは捨てる（遅れて逆の答えが実行されないように）
    if (!e.keep) outbox.delete(id);
    e.done({ ok: false, unknown: true });
  }, 15_000);
  tell(e.msg);
}
function settle(r) {
  const e = outbox.get(r.rid);
  if (!e) return;
  clearTimeout(e.timer);
  outbox.delete(r.rid);
  e.done(r);
}

let busy = false; // 送っている最中（二重に押せない）
let attempt = null; // { rid, text, conv }: 結果が返っていない・失敗した送り。同じ文の送り直しは同じ request_id
function sync() { $("send").disabled = busy || !$("in").value.trim(); $("send").setAttribute("aria-busy", String(busy)); }
$("in").addEventListener("input", () => { $("in").style.height = "auto"; $("in").style.height = `${Math.min(144, $("in").scrollHeight)}px`; sync(); });
$("in").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && matchMedia("(pointer: fine)").matches) { e.preventDefault(); $("form").requestSubmit(); } });
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("in").value.trim();
  if (busy || cur == null || !t) return;
  if (!attempt || attempt.text !== t || attempt.conv !== cur) attempt = { rid: undefined, text: t, conv: cur };
  const a = attempt;
  busy = true; note(""); sync(); // 「送っています」は文にせず、ボタンの無効化で見せる
  a.rid = request({ ev: "send", conv: a.conv, text: a.text }, (r) => {
    busy = false;
    if (r.ok || r.row != null) { // Mac から結果が返り、会話に入った時だけ欄を空にする
      if (attempt === a) attempt = null;
      if ($("in").value.trim() === a.text) { $("in").value = ""; $("in").style.height = "auto"; }
      note(r.ok ? "" : r.hint ?? STR.sendFail);
    } else note(r.unknown ? STR.sendFail : r.hint || STR.sendFail); // 文は欄に残る・もう一度押すと同じ request_id
    sync();
  }, { id: a.rid, keep: true });
});
function answer(a, allow, undo) {
  request({ ev: "answer", conv: cur, approval: a.id, allow, ver: a.ver }, (r) => {
    if (r.ok) return; // card は Mac の push で消える（文は出さない）
    undo();
    toast(r.unknown ? STR.unreach : r.hint || STR.fail);
  });
}

// ---- 一覧の上の操作（R3）: 止まった担当の「再開」・閉じた Kangae を「開く」。結果は一覧の点と色が変わる / ボタンが戻る / toast 1 行 ----
function resumeRow(r, b) {
  if (!up) return toast(STR.unreach);
  b.disabled = true; b.setAttribute("aria-busy", "true");
  request({ ev: "resume", conv: r.id, status: "stopped" }, (x) => {
    b.removeAttribute("aria-busy");
    if (x.ok) return; // running / starting: 一覧が work に変わると「再開」は消える
    b.disabled = false;
    toast(x.unknown ? STR.unreach : x.hint || STR.fail);
  }, { keep: true });
}
$("baropen").onclick = () => {
  if (!up) return toast(STR.unreach);
  const b = $("baropen");
  b.disabled = true; b.setAttribute("aria-busy", "true");
  request({ ev: "launch" }, (x) => {
    b.removeAttribute("aria-busy"); b.disabled = false;
    if (x.unknown) return toast(STR.unreach);
    if (!x.ok) toast(x.hint || STR.fail);
  }, { keep: true });
};

// ---- つなぐ ----
let sock = null, ch = null, tx = Promise.resolve(), lastRx = 0, retry = 0, retryTimer = null, up = false;
const wsUrl = () => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
// 暗号化して送る（通し番号の順を守るため 1 本ずつ）。つながっていなければ何もしない（request は outbox から送り直される）
function tell(obj) {
  const s = sock, c = ch;
  if (!up || !s || !c) return false;
  tx = tx.then(async () => s.send(JSON.stringify(await c.seal(obj)))).catch(() => s.close());
  return true;
}
function resume() { // つながった（または繋ぎ直した）: 開いていた会話を読み直し、答えが返っていない依頼を送り直す
  if (cur != null) tell({ ev: "open", conv: cur });
  for (const id of [...outbox.keys()]) fire(id);
}

// k があれば初回（QR）、無ければ覚えた身元で 2 回目以降
function connect(dev, k) {
  clearTimeout(retryTimer);
  sock?.close();
  if (cur == null) showState("connecting");
  const s = (sock = new WebSocket(wsUrl()));
  let mine = null, rx = Promise.resolve();
  ch = null; up = false; tx = Promise.resolve();
  s.onopen = async () => {
    try {
      if (k) {
        mine = new Chan(await pairKey(k), "p");
        s.send(JSON.stringify({ t: "pair", ...(await mine.seal({ ev: "hello", pub: dev.pub, name: deviceName() })) }));
        k.fill(0);
      } else s.send(JSON.stringify({ t: "auth", id: dev.id }));
    } catch { s.close(); }
  };
  s.onmessage = (e) => (rx = rx.then(async () => {
    if (s !== sock) return;
    const m = JSON.parse(e.data);
    if (m.t === "chal") { // 2 回目以降: 署名で本人を示し、接続ごとの鍵を作る
      const n = unb64(m.n), np = rand(16);
      const sg = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, dev.pair.privateKey, authBytes(dev.id, n, np)));
      mine = new Chan(await sessionKey(dev.ds, n, np), "p");
      return s.send(JSON.stringify({ t: "sig", np: b64(np), sig: b64(sg) }));
    }
    const ev = await mine.open(m);
    lastRx = Date.now();
    if (ev.ev === "wait") return showState("waiting", ev.code);
    if (ev.ev === "paired") { // Mac が許可した: 2 回目以降の合言葉を取り込む（取り出せない形で）
      if (ev.id !== dev.id) return s.close();
      dev.ds = await base(unb64(ev.ds));
      await saveDev({ id: dev.id, pair: dev.pair, ds: dev.ds });
      return;
    }
    if (ev.ev === "ready") return;
    if (ev.ev === "list") {
      const first = !up;
      ch = mine; up = true; retry = 0;
      lastRows = ev.rows ?? [];
      barOpen = ev.bar ?? null;
      if (cur == null) render(lastRows); else { $("cline").hidden = true; paintHead(lastRows.find((x) => x.id === cur) ?? conv); }
      if (first) resume();
      return;
    }
    if (ev.ev === "conv" && ev.conv === cur) { conv = ev; paintConv(ev, true); return; }
    if (ev.ev === "older" && ev.conv === cur && conv) { conv = { ...conv, rows: [...ev.rows, ...conv.rows], more: ev.more }; paintConv(conv, false); return; }
    if (ev.ev === "gone" && ev.conv === cur) { closeConv(); return; }
    if (ev.ev === "sent" || ev.ev === "answered" || ev.ev === "resumed" || ev.ev === "launched") return settle(ev);
    if (ev.ev === "err") return toast(ev.hint || STR.fail);
  }).catch(() => s.close()));
  s.onclose = (e) => {
    if (s !== sock) return;
    sock = null; ch = null; up = false;
    if (e.code === 4410 || (k && !dev.ds && e.code !== 1006)) return showState(e.code === 4410 ? "expired" : "refused");
    if (e.code === 4401) { void dropDev(); return showState("revoked"); }
    if (cur == null) showState("lost"); else { text("cline", STR.unreach); $("cline").hidden = false; }
    if (dev.ds) retryTimer = setTimeout(() => connect(dev), Math.min(30_000, 3000 * 2 ** retry++)); // 許可済みなら自動で繋ぎ直す: 3 → 6 → 12 → 24 → 30 秒
  };
  return dev;
}

async function main() {
  if (!globalThis.crypto?.subtle) return showState("noCrypto");
  const m = /^#k=([\w-]{43})$/.exec(hash);
  if (m) { // 初回（または読み直し）: 新しい署名鍵を作る
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const j = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const pub = { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
    const dev = { id: await deviceId(pub), pair, pub, ds: null };
    connect(dev, unb64(m[1]));
    return;
  }
  const dev = await loadDev();
  if (!dev) return showState("scan");
  connect(dev);
}

$("act").onclick = async () => { const dev = await loadDev(); if (dev) connect(dev); else showState("scan"); };
document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && !sock) { const dev = await loadDev(); if (dev) connect(dev); } });
setInterval(() => { if (sock && up && Date.now() - lastRx > 35_000) sock.close(); }, 5000); // Mac から 35 秒何も来ない = 道が切れた
void main();
