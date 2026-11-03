// Bar の会話の画面。口は call(op, …)。tab group の判断は groups.js（planSwitch / planTitle）
import { failedRowId, firstCards, firstName, readRetry, findGroup, groupTitle, isWeb, agentColors, liveRuns, NEAR_BOTTOM, plain, planAdd, planSwitch, planTitle, peekKeys, scrollPlan } from "./groups.js";
import { answerLine, ic } from "./kg.js";
import { RULES } from "./rules.js";
import { speakerLine } from "./kg.js";

const $ = (id) => document.getElementById(id);

let port = null;
const waiting = new Map();
let composing = false;
let busy = false;
// 送るを押してから確定（返り）まで。欄は空・送るは disabled＋aria-busy で 2 度送れない（W121 / DESIGN §6 入力欄と送る・§7 押した直後）
let sending = false;
let roots = [];
let rootId = null;
Object.defineProperty(window, "kangaeRoot", { get: () => rootId }); // bar（WKWebView）が「今見ている会話」を聞く窓
let rows = [];
let nexts = []; // いちばん新しい返事の「次の一手」（押していない物）
let hasOverride = false;
let runs = [];
let runTimer = null;
let rootsGen = 0;
// 起動時に 1 回だけ取る。tabs / tabGroups / 購読の全部がこの窓だけを見る
let winId = null;
let frontWeb = false;
// rootId ごとの欄の書きかけ（メモリだけ）
const drafts = new Map();
// 「＋」「名前を変える」を押してから名前を Enter するまで: false | "new" | "rename"
let naming = false;
let creating = false;
let clearing = false;
const stopping = new Set();
// 自分で開いた tab: "<rootId> <保存 url>" → tabId（メモリだけ）
const opened = new Map();
// 送った直後で、まだ op:runs に現れない run
const sent = [];
// 2-1 の失敗: {rootId, rowId, hint, text}。次の send か根の切替で消える
let failMem = null;
let shownIds = new Set();
// 開いて見た失敗の行 id（見ていない根の「失敗」はまだ見ていない物だけ）
const seenFail = new Set();
let downTimer = null;
let approvalRows = []; // 承認待ちの card（どの会話の agent が待っているか）
let leaseRows = []; // agent に渡した面（どの会話が何を持っているか。一覧の行に出す）
const progressOpen = new Set(); // 進み具合を開いている会話。既定は畳む（open を付けない）
// 開いて見た最後の行 id（会話ごと・未読の印に使う）
const seenRows = (() => { try { return JSON.parse(localStorage.getItem("panel-seen") || "{}"); } catch { return {}; } })();
const loadJson = (key, fallback) => { try { const v = JSON.parse(localStorage.getItem(key) || ""); return v ?? fallback; } catch { return fallback; } };
const saveJson = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} };
let providers = loadJson("kangae-provider", {});
if (!providers || typeof providers !== "object" || Array.isArray(providers)) providers = {};
let findQ = "";
let listFilter = ""; // W98: "turn" の間、一覧は「あなたの番です」だけ
let approveMemo = [[], [], [], []];
let approveOpen = false; // W107: 「あと N 件」を開いたか。approveMemo で描き直しても戻さない
let starting = false;
const EMPTY_MSG = "何をしてほしいかを書いて Enter"; // session がまだ無い時（名前は一言目の頭から自動・後で変えられる）
const EMPTY_HINT = "例: 今日のメールを整理して"; // 入力欄の薄い字
const EXAMPLE = "返事を書く"; // dm-ui.html の composer と同じ文言
// タブで開かれた時（panel.html?session=<根の id>）の根。Bar の会話では null
const tabSession = (() => {
  const v = new URLSearchParams(location.search).get("session");
  return v != null && /^\d+$/.test(v) ? Number(v) : null;
})();

function connect() {
  port = kangaeConnect();
  port.onMessage.addListener((res) => {
    if (res.type === "disconnected") {
      for (const w of waiting.values()) {
        if (w.retried) {
          waiting.delete(w.msg.id);
          w.resolve({ ok: false, hint: "本体に繋がりません。アプリを開き直してから、もう一度押してください" });
        } else {
          w.retried = true; // 回数を残す理由: 同じ要求を 1 回だけ送り直す（副作用の上限・時間では決まらない）
          setTimeout(() => port?.postMessage(w.msg), 500);
        }
      }
      return;
    }
    if (res.type === "ui") {
      applyUi(res.ui);
      return;
    }
    if (res.type === "desktop") return;
    if (res.type === "leases") {
      loadLeases();
      return;
    }
    if (res.type === "opened") { toast(`${plain(res.who, 40)}が${plain(res.label, 60)}を開きました`); return; } // W78o: 聞かずに裏で開いた時の知らせ
    if (res.type === "room") { if (nav.top() === "thread" && res.roomId && res.roomId === threadRoom) void loadThread(threadRoom, false); return; } // W125: 開いている部屋に行が増えた → 読み直す（stack は積まない）
    if (res.type === "mods") {
      loadMods();
      return;
    }
    if (res.type === "drafts") { if (!$("settings").hidden) void loadOpDrafts(); return; } // W124: 歯車が開いている時だけ読み直す（閉じている間は開く時に読む）
    if (res.type === "roots") {
      reloadRoots();
      return;
    }
    if (res.type === "history") {
      // 常駐は「会話に行が増えた（bar が囲んだ画面を貼った）」と「tab の履歴が増えた」の両方で流す。
      // redraw（＝renderRoots）だけでは rows が古いままなので、会話も読み直す
      if (res.rootId === rootId) { loadChat("keep"); redraw(); }
      return;
    }
    const w = waiting.get(res.id);
    if (w) {
      waiting.delete(res.id);
      w.resolve(res);
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    for (const w of waiting.values()) resend(w);
  });
}

function resend(w) {
  if (w.retried) {
    waiting.delete(w.msg.id);
    w.resolve({ ok: false, hint: "本体に繋がりません。アプリを開き直してから、もう一度開いてください" });
    return;
  }
  w.retried = true;
  connect();
  port.postMessage(w.msg);
}

function call(op, extra = {}) {
  return new Promise((resolve) => {
    if (!port) connect();
    const msg = { id: crypto.randomUUID(), op, ...extra };
    waiting.set(msg.id, { msg, resolve, retried: false });
    port.postMessage(msg);
  });
}

function once(f) {
  if (busy) return;
  busy = true;
  // 通しは、描画が済んでも applySwitch の途中で次の操作を投げるとここに捨てられる。終わるまで待たせる印。
  document.documentElement.dataset.busy = "1";
  Promise.resolve()
    .then(f)
    .finally(() => {
      busy = false;
      delete document.documentElement.dataset.busy;
    });
}

function bindIme(el) {
  el.addEventListener("compositionstart", () => (composing = true));
  el.addEventListener("compositionend", () => (composing = false));
}

function showEmpty() {
  $("empty").hidden = false;
  $("app").hidden = true;
}

function showApp() {
  $("empty").hidden = true;
  $("app").hidden = false;
}

function saveRoot() {
  try {
    if (rootId != null && tabSession == null) localStorage.setItem("panel-root", String(rootId));
  } catch {}
}

function loadSavedRoot() {
  try {
    const n = Number(localStorage.getItem("panel-root"));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const winQuery = () => (winId != null ? { windowId: winId } : { currentWindow: true });
const mapKey = (id, url) => `${id} ${url}`;

function set(el, key, value) {
  if (el[key] !== value) el[key] = value;
}

function place(parent, els) {
  els.forEach((el, i) => {
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
  });
  while (parent.children.length > els.length) parent.lastElementChild.remove();
}

function nearBottom(ul) {
  return ul.scrollHeight - ul.scrollTop - ul.clientHeight <= NEAR_BOTTOM;
}

function liveHere() {
  return liveRuns(runs, sent);
}

function rootShowsWord(id) {
  if (id == null || id === rootId) return false;
  return liveHere().some((x) => x.nodeId === id);
}

// 見ていない根の最新の run が失敗で終わっていて、まだ開いて見ていない時だけ
function rootShowsFail(id) {
  if (id == null || id === rootId || liveHere().some((x) => x.nodeId === id)) return false;
  const row = failedRowId(runs, id);
  return row != null && !seenFail.has(row);
}

function stash() {
  if (rootId != null && !naming) drafts.set(rootId, $("send-text").value);
}

// 送る ⇄ 止めるの押せる・押せない。空（文 0 字・添付 0）は送れない / 送信中は送れない / 動いている間の「止める」は押せる
function syncSend() {
  const b = $("send-btn"), typed = $("send-text").value.trim();
  b.disabled = b.dataset.stop ? sending && !!typed : sending || (!typed && !pendAtts.length);
  b.setAttribute("aria-busy", String(sending));
}

function providerLineHidden(isNew, n) {
  return !(isNew && n >= 2);
}

function replyPlaceholder(mode, moving) {
  if (mode === "rename") return "担当名";
  if (mode) return "会話の名前";
  return moving ? "書いておく（動き終わったら送ります）" : EXAMPLE;
}

function renderField() {
  $("app").classList.toggle("new-session", naming === "new"); // 「＋」の新規画面は、直前の会話の見出しと吹き出しを見せない（取り違えの元）
  const moving = rootId != null && liveHere().some((x) => x.nodeId === rootId);
  $("send-text").placeholder = replyPlaceholder(naming, moving);
  $("provider-line").hidden = providerLineHidden(naming === "new", $("provider").querySelectorAll("option").length);
  syncSend();
}

function tabLabel(node) {
  const text = String(node.text ?? "").trim();
  let s = text;
  if (!s) {
    try { s = new URL(node.url).host; } catch { s = ""; }
  }
  return Array.from(s).slice(0, 120).join("");
}

const mk = (tag, cls) => Object.assign(document.createElement(tag), { className: cls });

// 時刻: 今日は HH:mm・昨日は「昨日」・それ以前は M/D（dm-ui の一覧）
function timeLabel(at) {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return ""; // 送りかけの行の createdAt は番兵（MAX_SAFE_INTEGER）＝時刻は出さない
  const t = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const gap = Math.round((day(t) - day(d)) / 86_400_000);
  return gap === 0 ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : gap === 1 ? "昨日" : `${d.getMonth() + 1}/${d.getDate()}`;
}

let agentColor = new Map();

// 一望の行の下の 1 行: 動いている / 承認待ちの agent には「代わる」、止めた agent には止まった事と次の一手＋「続けて」。
// 「代わる」= その会話の agent だけ止め、持っていた面は人に戻る（別の会話は続く）
function fillAgentAct(li, r) {
  const run = runs.filter((x) => x.nodeId === r.id).at(-1);
  // W5c: 画面の操作を decision model に任せた段（一望の 1 行）
  let sc = li.querySelector(":scope > .agent-screen");
  if (run?.screen?.steps) {
    if (!sc) { sc = mk("div", "agent-screen"); li.append(sc); }
    set(sc, "textContent", `画面の操作: ${run.screen.engine}（${run.screen.steps} 手・${Math.max(1, Math.round(run.screen.ms / 1000))} 秒）`);
  } else sc?.remove();
  const waiting = approvalRows.some((a) => a.owner === `s:${r.id}`);
  const kind = run?.status === "running" || waiting ? "take" : run?.status === "stopped" ? "resume" : run?.stop ? "refused" : run?.switched ? "switched" : null;
  let act = li.querySelector(":scope > .agent-act");
  if (!kind) { act?.remove(); return; }
  if (!act) {
    act = mk("div", "agent-act");
    act.dataset.ag = String(agentColor.get(r.id) ?? r.id % 6);
    act.append(mk("span", "agent-note"), mk("button", "agent-btn"));
    li.append(act);
  }
  act.dataset.ag = String(agentColor.get(r.id) ?? r.id % 6);
  act.dataset.kind = kind;
  const [note, btn] = act.children;
  const held = leaseRows.find((l) => l.owner === `s:${r.id}`);
  btn.hidden = false;
  if (kind === "switched" || kind === "refused") {
    // 止まったので替わった / 替えられなかった（理由と次の一手の 1 行）。料金で止めた時だけ「このまま続ける（料金がかかります）」
    set(note, "textContent", kind === "switched" ? `${run.switched.line}${run.switched.limits ? `。${run.switched.limits}` : ""}` : run.stop.line);
    btn.type = "button";
    btn.hidden = !(kind === "refused" && run.stop.engine);
    set(btn, "textContent", "このまま続ける（料金がかかります）");
    btn.onclick = () => once(async () => { btn.disabled = true; await call("allowMetered", { engine: run.stop.engine }); btn.disabled = false; btn.hidden = true; });
    return;
  }
  set(note, "textContent", kind === "take" ? `${waiting ? "承認を待っています。" : ""}代わると、この agent だけ止まり${held ? "、渡していた窓・tab があなたに戻ります" : "ます"}` : "止まりました。「続けて」で呼び直せます（窓や tab が要るなら、渡し直しを頼みます）");
  btn.type = "button";
  set(btn, "textContent", kind === "take" ? "代わる" : "続けて");
  btn.onclick = () => once(async () => {
    btn.disabled = true;
    await call(kind === "take" ? "handover" : "resume", { rootId: r.id });
    await refreshRuns({ scene: "keep", reload: true });
    await loadLeases();
    btn.disabled = false;
  });
}

// W38: その agent が触った folder（作業場所と、run で使った登録 cwd）を、人の選んだ app で前に開く「見る」（docs/BRIEF-w38.md）。
// 送るのは会話の番号だけ（path も app 名も panel からは渡さない＝常駐が引く）。人が押した時だけ前に出る。agent の呼びは常駐が断る
function fillAgentView(li, r) {
  const run = runs.filter((x) => x.nodeId === r.id).at(-1);
  let v = li.querySelector(":scope > .agent-view");
  if (!run?.dir) { v?.remove(); return; } // folder を持たない行には出さない
  if (!v) {
    v = mk("div", "agent-view");
    const b = mk("button", "agent-btn");
    b.type = "button";
    b.textContent = "見る";
    b.title = "この agent が触った folder を、設定の app で開きます（前に出ます）";
    v.append(mk("span", "agent-note"), b);
    li.append(v);
    b.onclick = () => once(async () => {
      b.disabled = true;
      const x = await call("openFolder", { rootId: r.id });
      toast(x.ok ? `${x.app} で開きました（${x.opened.length} folder）` : x.hint || "開けませんでした", { tone: x.ok ? "ok" : "warn" });
      b.disabled = false;
    });
  }
  v.dataset.ag = String(agentColor.get(r.id) ?? r.id % 6);
}

// W50: 人が裏の仕事を見る。その agent の直近の操作を「どの tab / 窓で・何を・どうなった」の 1 行ずつ（最大 5）。常駐が ops.jsonl から人の言葉にして返す（値は伏せたまま・
// agent の呼びは常駐が断る）。textContent で入れる（頁の題など他人の文字を HTML として読まない）。3 秒より短くは取り直さない
const opsAt = new Map();
async function fillAgentOps(li, r) {
  let v = li.querySelector(":scope > .agent-ops");
  if (!v) { v = mk("ul", "agent-ops"); v.setAttribute("aria-label", "この agent の直近の操作"); v.hidden = true; li.append(v); }
  v.dataset.ag = String(agentColor.get(r.id) ?? r.id % 6);
  if (Date.now() - (opsAt.get(r.id) ?? 0) < 3000) return;
  opsAt.set(r.id, Date.now());
  let items = [];
  try { const x = await call("opsRecent", { rootId: r.id }); if (x?.ok && Array.isArray(x.items)) items = x.items.slice(0, 5); } catch { /* 古い版が op を知らない間は出さない */ }
  v.replaceChildren(...items.map((i) => { const e = mk("li", "agent-op"); e.textContent = String(i.line ?? ""); e.title = new Date(Number(i.at) || 0).toLocaleTimeString(); return e; }));
  v.hidden = !items.length;
}

// 丸の字: 名前（agent の名前 / 会話の頭）の先頭 1 字。ほかの会話と同じになる時は、最後の語の頭 → それでも同じなら 1 から数える番号（agent A / agent B が両方「A」にならない）
// review19: 制御・書式の文字（RTL 上書き・ゼロ幅）は字に使わない
const nameOf = (r) => r.agent?.name ?? r.text;
const glyphs = (r) => {
  const w = nameOf(r).replace(/[\p{Cc}\p{Cf}]/gu, "").trim().split(/\s+/).filter(Boolean);
  return [Array.from(w[0] ?? "")[0], Array.from(w.at(-1) ?? "")[0]].map((x) => (x ?? "·").toUpperCase());
};
function avatarGlyph(r) {
  const [first, last] = glyphs(r);
  const same = (g, i) => roots.some((o) => o.id !== r.id && glyphs(o)[i] === g);
  if (!same(first, 0)) return first;
  if (!same(last, 1)) return last;
  return String(roots.findIndex((o) => o.id === r.id) + 1);
}
// 一覧の行（LINE のトーク一覧の形）: 顔・題・最後の 1 行（状態の印 + 文）・面を持っている印 / 時刻・あなたの番か未読の ●
// W74: 一覧の行の題。担当名 → 会話名 → 空なら「名前のない会話」（空の行に見えない）
const rootLabel = (r) => plain(r.agent?.name ?? r.role ?? r.text, 60).trim() || "名前のない会話";
// W102: 宛先の user 行の印。崩れていれば null（普通の文として出す）。roomId は画面の文に出さない
function relayMark(text) {
  const m = /^\[\[relay: (.+?) \| (.+?)\]\]\s*([\s\S]*)$/.exec(String(text ?? ""));
  if (!m) return null;
  const from = m[1].trim();
  const roomId = m[2].trim();
  if (!from || !roomId) return null;
  return { from, roomId, text: m[3] };
}
function spawnedParent(text) {
  const m = /^\[\[spawned: (.+?) \| (.+?)\]\]/.exec(String(text ?? ""));
  if (!m) return null;
  const parent = m[1].trim();
  const roomId = m[2].trim();
  if (!parent || !roomId) return null;
  return parent;
}
function fillRootButton(row, r) { // W77c: 行の中身は kg-row（extension/kg.js）。ここは何を見せるかを決めるだけ。W111: row = 行の枠・row.body = 会話を開く button.root（avatar は兄弟の別 button）
  const b = row.body;
  set(b, "className", r.id === rootId ? "root on" : "root");
  b.dataset.id = String(r.id);
  row.dataset.ag = String(agentColor.get(r.id) ?? r.id % 6);
  row.toggleAttribute("on", r.id === rootId);
  // dm-ui の一覧: 2 行目 = 状態の icon + 状態語（動いています / あなたの番 / 終わりました）。状態が無い時（自分が最後に話した・まだ無い）だけ最後の文
  const fail = !rootShowsWord(r.id) && rootShowsFail(r.id);
  const bad = /^[✗⛔]/.test(r.agent?.answer ?? ""); // 常駐を起こし直した後は run が無い。失敗の知らせを「終わりました」と読ませない
  const state = rowState(r);
  // W94: 色 class は三項の「あなたの番です」だけ turn、「失敗」「うまく終われませんでした」だけ fail。承認待ち・止まりました・替えられません・動いています・終わりましたは色 class なし（kind の turn/work/done は icon のまま）
  const tone = state?.[1] === "あなたの番です" ? "turn" : (state?.[1] === "失敗" || state?.[1] === "うまく終われませんでした") ? "fail" : "";
  const ans = r.agent?.answer; // 名前を持つ agent の終わりの知らせ: 答えの 1 行（未読の印は下の dot）
  const vaultHere = (approveMemo[2] ?? []).some((a) => a?.vault && a.owner === `s:${r.id}`); // W98: 金庫の card がある会話
  const raw = String(ans || r.last?.text || "").replace(/\s+/g, " ").trim();
  const circled = raw.startsWith("📎") || raw.startsWith("指した物:"); // W109: 囲んだ・指した行は 1 文に畳む（[[spawned: とは別の分岐）
  const unread = r.agent ? r.agent.unread : r.last && !r.last.mine && r.last.id > (seenRows[r.id] ?? 0);
  const dot = r.last?.turn || unread || vaultHere;
  const mine = leaseRows.filter((l) => l.owner === `s:${r.id}`); // 受け持つ面: icon の種類と app 名だけ（面の題・他人の頁の文字は出さない・W60b2）
  const spawned = spawnedParent(r.last?.text) ?? (r.last ? null : spawnedParent(r.text)); // 最初の行が立てた印のとき、一覧の最後の 1 行
  row.data = {
    name: rootLabel(r), // W60b2: 担当名（agent が付け、人が付け直せる）
    glyph: avatarGlyph(r),
    state, tone, fail: fail || bad,
    lastHidden: vaultHere ? false : !!state && (!ans || (bad && ans.startsWith("✗"))), // ✗ の文は状態の語と同じ事を言うので重ねない（⛔ は理由なので残す）。金庫は最後の 1 行を出す
    last: vaultHere ? "パスワードを入れますか" : spawned ? `${spawned} が立てました` : circled ? "画面を囲んで聞きました" : ans ? ans.replace(/\s+/g, " ").slice(0, 60) : r.last ? `${r.last.mine ? "あなた: " : ""}${r.last.text.replace(/\s+/g, " ").slice(0, 60)}` : "まだ何も話していません",
    time: timeLabel(r.last?.at ?? r.createdAt),
    dot: !!dot,
    surfaces: mine.map((l) => ({ key: l.key, kind: l.surface.app === "web" ? "tab" : "app", app: l.surface.app === "web" ? "tab" : l.surface.app })),
  };
  b.classList.toggle("you", !!dot);
  // 押した面だけ縮小絵を出す（閉じている間は絵の描画 0・要件 37）。絵は既存の peekEl（押すとその面が前に出る）
  const li = row.parentElement;
  const open = mine.find((l) => rowPeek.has(l.key));
  const have = li?.querySelector(":scope > .row-peek");
  if (li && !open && have) have.remove();
  else if (li && open && have?.dataset.key !== open.key) { have?.remove(); const box = el("div", "row-peek"); box.dataset.key = open.key; box.append(peekEl(open.key)); li.append(box); }
}

function rowState(r) {
  const fail = !rootShowsWord(r.id) && rootShowsFail(r.id);
  const latest = runs.filter((x) => x.nodeId === r.id).at(-1);
  const waiting = approvalRows.some((a) => a.owner === `s:${r.id}`);
  const bad = /^[✗⛔]/.test(r.agent?.answer ?? "");
  return waiting ? ["turn", "承認待ち"] : latest?.status === "stopped" ? ["turn", "止まりました"] : latest?.stop ? ["turn", "替えられません"] : rootShowsWord(r.id) ? ["work", "動いています"] : fail ? ["turn", "失敗"] : bad ? ["turn", "うまく終われませんでした"] : r.last?.turn ? ["turn", "あなたの番です"] : r.last && !r.last.mine ? ["done", "終わりました"] : null;
}

function markSeen() {
  const last = rows.filter((x) => x.id > 0).at(-1);
  if (rootId != null && roots.find((r) => r.id === rootId)?.agent?.unread) call("agentRead", { rootId }); // 開いた = 既読
  if (rootId == null || !last || seenRows[rootId] === last.id) return;
  seenRows[rootId] = last.id;
  try { localStorage.setItem("panel-seen", JSON.stringify(seenRows)); } catch {}
}

const HISTORY_MAX = 10;

// その session で開いた頁（新しい順）。押すと、窓にあれば前面・無ければ新しい tab（session の group に入る）
function renderHistory(box, visits) {
  const c = (box._c ??= { head: null, empty: null, items: [] });
  if (!c.head) {
    c.head = document.createElement("p");
    c.head.className = "attached-note";
    c.head.textContent = "履歴";
  }
  const els = [c.head];
  if (!visits.length) {
    if (!c.empty) {
      c.empty = document.createElement("p");
      c.empty.className = "attached-empty";
      c.empty.textContent = "まだ履歴はありません。この会話で開いた頁がここに並びます";
    }
    els.push(c.empty);
  }
  visits.forEach((v, i) => {
    let b = c.items[i];
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.className = "visit";
      b.onclick = () => once(() => openVisit(b.dataset.url));
      c.items[i] = b;
    }
    const label = tabLabel(v);
    set(b, "textContent", label);
    set(b, "title", `${label}\n${v.url}`);
    set(b.dataset, "url", v.url);
    els.push(b);
  });
  place(box, els);
}

async function openVisit(url) {
  if (rootId == null || !url) return;
  const { windowTabs } = await windowState();
  const hit = windowTabs.find((t) => (t.url || t.pendingUrl) === url);
  if (hit) await chrome.tabs.update(hit.id, { active: true });
  else {
    const tab = await chrome.tabs.create({ url, active: true, ...(winId != null ? { windowId: winId } : {}) });
    if (tab?.id != null) await groupTabs([tab.id]);
  }
  await renderRoots();
}

function titleDisabled(url, saved, state) {
  if (!state) return true;
  const mid = opened.get(mapKey(rootId, url));
  const mapTab = mid != null && state.windowTabs.some((t) => t.id === mid) ? mid : null;
  return planTitle({
    rootId,
    url,
    savedUrls: saved.map((t) => t.url),
    windowTabs: state.windowTabs,
    groups: state.groups,
    mapTab,
    mapValues: [...opened.values()],
  }).disabled;
}

function renderAttached(box, saved, state) {
  const c = (box._c ??= { titles: [], empty: null, note: null });
  const els = [];
  saved.slice(0, 3).forEach((tab, i) => {
    let b = c.titles[i];
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.className = "tab-title";
      b.onclick = () => once(() => openTitle(b.dataset.url));
      c.titles[i] = b;
    }
    const label = tabLabel(tab);
    set(b, "textContent", label);
    set(b, "title", label);
    set(b.dataset, "url", tab.url);
    set(b, "disabled", titleDisabled(tab.url, saved, state));
    els.push(b);
  });
  if (!saved.length) {
    if (!c.empty) {
      c.empty = document.createElement("p");
      c.empty.className = "attached-empty";
      c.empty.textContent = "付いた tab はありません";
    }
    els.push(c.empty);
  }
  if (state && !state.frontWeb) {
    if (!c.note) {
      c.note = document.createElement("p");
      c.note.className = "attached-note";
      c.note.textContent = "付けるには、ふつうのページ（http / https）の tab を前に出してください";
    }
    els.push(c.note);
  }
  place(box, els);
}

function findShown(count) { return count >= 7; }

function paintList() {
  const find = $("find-text");
  if (find) {
    const show = findShown(roots.length);
    find.hidden = !show;
    if (!show) { find.value = ""; findQ = ""; }
  }
  const ul = $("roots");
  const have = new Map([...ul.querySelectorAll(":scope > li")].map((li) => [li.dataset.id, li]));
  const keep = new Set();
  const seq = [];
  agentColor = agentColors(roots.map((r) => r.id));
  const ordered = [...roots].sort((a, b) => (b.last?.at ?? b.createdAt) - (a.last?.at ?? a.createdAt));
  const q = findQ.trim().toLowerCase();
  const turnOnly = listFilter === "turn"; // W98: 右上の印が 2 件以上の時は「あなたの番です」だけ
  const yourTurn = (r) => rowState(r)?.[1] === "あなたの番です";
  const match = (r) => (!turnOnly || yourTurn(r)) && (!q || [rootLabel(r), plain(r.text, 80)].some((t) => t.toLowerCase().includes(q)));
  const n = ordered.filter((r) => yourTurn(r) && (!q || [rootLabel(r), plain(r.text, 80)].some((t) => t.toLowerCase().includes(q)))).length;
  paintTurnLine(n);
  for (const r of ordered) {
    if (!match(r)) continue;
    const key = String(r.id);
    keep.add(key);
    let li = have.get(key);
    if (!li) {
      li = document.createElement("li");
      li.dataset.id = key;
      const row = document.createElement("kg-row");
      row.onclick = () => once(async () => { await selectRoot(r.id); closeList(); }); // W111: 本文と行の余白 = 会話（avatar と面の icon は click を上げない）
      row.addEventListener("kg-peek", (e) => { const k = e.detail.key; if (rowPeek.has(k)) { rowPeek.delete(k); delete peekCache[k]; } else rowPeek.add(k); peekLast[k] = 0; paintList(); peekTick(); });
      li.append(row);
      li.addEventListener("dragover", (e) => dropOver(e, r.id, false)); // H1: 行に落とすと、会話を開かずにその担当へ渡す
      li.addEventListener("dragleave", dropLeave);
      li.addEventListener("drop", (e) => dropDo(e, r.id, false));
    }
    fillRootButton(li.querySelector(":scope > kg-row"), r);
    fillAgentAct(li, r);
    fillAgentView(li, r);
    void fillAgentOps(li, r);
    seq.push(li);
  }
  for (const [key, li] of have) if (!keep.has(key)) li.remove();
  $("roots-empty").hidden = seq.length > 0 || !!q || listFilter === "turn"; // W74: 一覧が 0 件の時は空白でなく一言。絞っている間は上の 1 行
  seq.forEach((li, i) => { if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] ?? null); });
}

async function renderRoots() {
  const gen = ++rootsGen;
  let saved = [];
  let state = null;
  let visits = [];
  if (rootId != null) {
    saved = await savedTabsOf(rootId);
    const h = await call("history", { rootId, limit: HISTORY_MAX });
    visits = h.ok ? h.visits : [];
  }
  try { state = await windowState(); } catch { state = null; }
  if (gen !== rootsGen) return;
  $("add-tab").disabled = rootId == null || !state || !state.frontWeb;
  $("tab-to-desktop").disabled = !state || !state.frontWeb;
  $("desk-reason").hidden = !!state?.frontWeb;
  if (tabSession != null) document.title = roots.find((r) => r.id === rootId)?.text || "Kangae";
  paintList();
  // 付いた tab と履歴は、選んだ会話の「…」の中（一覧には出さない）
  const here = rootId != null && roots.some((r) => r.id === rootId);
  renderAttached($("attached"), here ? saved : [], here ? state : null);
  renderHistory($("history"), here ? visits : []);
}

const isBot = (r) => r.text.startsWith("🤖") || !!r.cards?.length;
const humanAfter = (list, i) => list.slice(i + 1).find((r) => !r.text.startsWith("🤖"));
const ICON = {
  turn: ic("ic", '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.2" fill="currentColor" stroke="none"/>'),
  tick: ic("ic ic-1", '<path d="M4.5 10.5l3.5 3.5 7.5-8"/>'),
  done: ic("ic", '<circle cx="10" cy="10" r="7.5"/><path d="M6.3 10.5l2.5 2.5 5-5.5"/>'),
  work: ic("ic", '<path d="M10 3a7 7 0 1 1-7 7"/>'),
  stop: ic("ic", '<rect x="6" y="6" width="8" height="8" rx="2" fill="currentColor" stroke="none"/>'),
  send: ic("ic", '<path d="M10 16V4.5M5 9.5l5-5 5 5"/>'),
};
customElements.get("kg-row").icons = ICON; // 状態の絵（固定の svg）を部品に渡す
const el = (tag, cls, html) => { const x = mk(tag, cls); if (html != null) x.innerHTML = html; return x; };
const txt = (tag, cls, text) => { const x = mk(tag, cls); x.textContent = text; return x; };
// W77b: 承認の 3 択（always allow / allow / deny・CEO 指定の英語）は kg-approve（extension/kg.js）。選んだ id（always / allow / deny）が来る
// W101: kind が choice / multi の時は人の言葉にして sendChat（3 ボタンの id はそのまま answer へ）
// W114（DESIGN.md §6 承認card・§7 押した直後）: 押した瞬間に k が全選択肢を止めている（k.busy(true)）。ここは結果を待ち、成功なら操作部を消して中立の toast・失敗なら全部戻して既存の error 文を toast（同じ card で押し直せる）
const onAnswer = (answer, k) => async (e) => {
  const d = e.detail || {};
  if (d.kind === "choice" || d.kind === "multi") {
    const text = answerLine(d);
    if (!text || busy || rootId == null) { k.busy(false); return; }
    const id = rootId;
    once(async () => { try { await sendChat(id, text); } finally { k.busy(false); } });
    return;
  }
  let r;
  try { r = await answer(d.choice); } catch { r = { ok: false }; }
  if (r && r.ok === false) { k.busy(false); showErr(null, r.hint || undefined); return; }
  k.remove();
  syncSendQuiet();
  if (d.choice === "allow" || d.choice === "deny") toast(d.choice); // always は押した先の既存 toast（全 agent に効く旨）が結果
};
const approveEl = (answer) => { const k = document.createElement("kg-approve"); k.addEventListener("kg-answer", onAnswer(answer, k)); return k; };
// W114: 未処理の承認（答えを待つ kg-approve・人の手を待つ認証 card・「あと N 件」＝畳まれた別の承認）が #approve に在る間だけ、送るを quiet（primary を 2 つ塗らない）
const syncSendQuiet = () => $("send-btn").classList.toggle("quiet", !!$("approve").querySelector("kg-approve, .auth-card, .more-cards"));

// card 1 枚。ask / handoff = 答えを押せる（live の時だけ）・done = 結果。押した後は answer があれば 1 行の receipt に替わる
function cardEl(c, { live, answer }) {
  if (answer != null && c.kind !== "done") {
    const said = answer.text.trim();
    const r = el("div", "receipt", ICON.tick);
    r.append((c.kind === "choice" || c.kind === "multi" ? !!said : c.options.includes(said)) ? `「${said}」と答えました` : "答えずに次へ進みました");
    return r;
  }
  const box = el("div", "card");
  const t = el("div", "t", c.kind === "done" ? ICON.done : ICON.turn);
  t.append(`${c.kind === "done" ? "終わりました" : "あなたの番です"} — ${c.title}`);
  box.append(t);
  if (c.kind === "done" && c.detail) {
    const f = el("div", "file");
    f.append(txt("span", "k", "物"), txt("span", "n", c.detail));
    box.append(f);
  } else if (c.kind === "handoff") box.append(txt("div", "m", c.detail ? `どこで: ${c.detail}（人だけがする操作です）` : "人だけがする操作です"), txt("div", "m", "終わったら「やりました」を押してください（やらない時は「やめる」）。人の代わりには入力しません"));
  if (live && (c.kind === "choice" || c.kind === "multi")) {
    const k = document.createElement("kg-approve");
    k.setAttribute("kind", c.kind);
    k.setAttribute("data-options", (c.options || []).join("\n"));
    if (c.kind === "choice" || c.free) k.setAttribute("free", ""); // W127: choice は常に自由記述の口（常駐の card に free は無い）
    k.addEventListener("kg-answer", onAnswer(() => {}, k));
    box.append(k);
    return box;
  }
  if (live && c.options.length) {
    const btns = mk("div", "btns");
    c.options.forEach((o, i) => {
      const b = txt("button", i === 0 ? "btn p" : "btn", o);
      b.type = "button";
      b.onclick = () => {
        if (busy || rootId == null) return;
        const id = rootId;
        once(() => sendChat(id, o));
      };
      btns.append(b);
    });
    box.append(btns);
  }
  return box;
}

// W112: 話し手の鍵。同じ鍵が続く間は、先頭の 1 行だけが顔と名前を持つ（相手 = row.by か「🤖 名前:」の名前・自分 = "me"・memo / notice / 立てた知らせは連続に数えない）
const botName = (t) => /^🤖\s*([^:：]+)[:：]/.exec(t)?.[1]?.trim() ?? "";
function speakerKey(row) {
  const t = row.text;
  if (t.startsWith("🤖")) return `🤖${row.by ?? botName(t)}`;
  return t.startsWith("📋") || relayMark(t) || spawnedParent(t) ? "" : "me";
}
const sameSpeaker = (list, i) => i > 0 && speakerKey(list[i]) !== "" && speakerKey(list[i - 1]) === speakerKey(list[i]);

// 行・印・止める・失敗の行は key（行 id）で突き合わせ、変わった所だけ触る。#rows の子は作り直さない
function renderChat(scene = "keep") {
  const ul = $("rows");
  const near = nearBottom(ul);
  const prev = ul.scrollTop;
  const list = [...rows].sort((a, b) => (a.createdAt - b.createdAt) || (a.id - b.id));
  const mem = failMem && failMem.rootId === rootId ? failMem : null;
  if (mem && mem.text != null && !list.some((r) => r.id === mem.rowId)) {
    list.push({ id: mem.rowId, text: mem.text, createdAt: Number.MAX_SAFE_INTEGER });
  }
  if (scene === "keep" && list.some((r) => !shownIds.has(r.id) && r.text.startsWith("🤖"))) scene = "reply";
  if (scene === "open") shownIds = new Set();
  const live = liveHere().filter((x) => x.nodeId === rootId);
  const failId = failedRowId(runs, rootId);
  if (failId != null) seenFail.add(failId);
  const have = new Map([...ul.children].map((li) => [li.dataset.id, li]));
  const lis = [];
  const turn = turnCard(list, live.length > 0);
  const need = needOf(list, live.length > 0);
  for (const [i, row] of list.entries()) {
    let li = have.get(String(row.id));
    if (!li) {
      li = document.createElement("li");
      li.className = row.text.startsWith("🤖") ? "chat-row they" : row.text.startsWith("📋") ? "chat-row memo" : "chat-row me"; // 自分は右の吹き出し・相手は地の文
      li.dataset.id = String(row.id);
      li._e = {};
    }
    const e = li._e;
    const relay = relayMark(row.text);
    if (relay) {
      li.className = "chat-row notice";
      if (!e.notice) e.notice = document.createElement("kg-notice");
      e.notice.from = relay.from;
      e.notice.text = relay.text;
      e.notice.roomId = relay.roomId;
      place(li, [e.notice]);
      lis.push(li);
      continue;
    }
    if (li.className.includes("notice")) li.className = row.text.startsWith("🤖") ? "chat-row they" : row.text.startsWith("📋") ? "chat-row memo" : "chat-row me";
    const cont = sameSpeaker(list, i); // 前の行と同じ話し手 = 名前と顔は出さず、間は 8
    li.classList.toggle("same", cont);
    const spawnedHere = spawnedParent(row.text);
    if (li.classList.contains("they") && !e.av) {
      e.av = document.createElement("span");
      e.av.className = "av sm";
      e.av.textContent = /^🤖\s*([^:：]+)/.exec(row.text)?.[1]?.trim().charAt(0) || "·";
    }
    if (!e.p) {
      e.p = document.createElement("p");
      e.p.className = "chat-text";
    }
    // 相手の名前は上の 1 行と顔が持つ。返事の markdown の記号は読みにくいので外す
    set(e.p, "textContent", row.text.startsWith("🤖") ? row.text.replace(/^🤖\s*[^:：]+[:：]\s*/, "").replace(/\*\*/g, "").replace(/^#+\s*/gm, "") : spawnedHere ? `${spawnedHere} が立てました` : row.text);
    e.p.hidden = !e.p.textContent; // 返事が印だけの時は、空の行を出さない
    const els = [e.p];
    if (e.av && !cont) {
      // 相手の行の上に「顔 + 名前」を 1 つ。by の行（W102）が名前を持つ時は二重に出さない
      e.who ??= Object.assign(document.createElement("div"), { className: "who-line" });
      const nm = row.by ? "" : botName(row.text);
      if (nm) set((e.nm ??= Object.assign(document.createElement("span"), { className: "who-name" })), "textContent", nm);
      place(e.who, nm ? [e.av, e.nm] : [e.av]);
      els.unshift(e.who);
    }
    if (row.by && row.text.startsWith("🤖") && !cont) {
      if (!e.byLine || e.byLine.dataset.by !== String(row.by)) {
        e.byLine = speakerLine(String(row.by));
        if (e.byLine) e.byLine.dataset.by = String(row.by);
      }
      if (e.byLine) els.unshift(e.byLine);
    }
    // W127: 候補が choice 2〜5 / multi 2〜8 の外なら card にしない（常駐が既に弾く・古い常駐の時の守り）
    const cards = (row.cards ?? []).filter((c) => c.kind !== "choice" && c.kind !== "multi" || (c.options?.length ?? 0) >= 2 && c.options.length <= (c.kind === "choice" ? 5 : 8));
    if (cards.length) {
      const answer = humanAfter(list, i);
      const first = answer || live.length ? -1 : cards.findIndex((c) => c.kind !== "done");
      const sig = JSON.stringify([cards, first, answer?.text ?? null]);
      if (e.cardSig !== sig) {
        e.cardSig = sig;
        e.cardEls = cards.map((c, k) => cardEl(c, { live: k === first, answer }));
      }
      els.push(...e.cardEls);
    }
    if (row.atts?.length) {
      const asig = JSON.stringify([rootId, row.atts]);
      if (e.attSig !== asig) {
        e.attSig = asig;
        e.attEl = document.createElement("div");
        e.attEl.className = "att-row";
        e.attEl.append(...row.atts.map((a) => attEl(a)));
      }
      els.push(e.attEl);
    }
    const run = live.find((x) => x.rowId === row.id);
    if (run) {
      if (!e.mark) {
        e.mark = document.createElement("span");
        e.mark.className = "mark";
        e.mark.textContent = "動いている";
      }
      if (!e.stop) {
        e.stop = document.createElement("button");
        e.stop.type = "button";
        e.stop.className = "stop";
        e.stop.textContent = "止める";
        e.stop.onclick = () => stopOne(li._runId);
      }
      li._runId = run.id;
      els.push(e.mark, e.stop);
    }
    const hint = mem && mem.rowId === row.id ? mem.hint : null;
    if (!need && (hint != null || (!run && failId === row.id))) {
      if (!e.fail) {
        e.fail = document.createElement("div");
        e.fail.className = "fail-line";
        e.fail.word = document.createElement("span");
        e.fail.word.className = "mark fail";
        e.fail.word.textContent = "失敗";
        e.fail.hint = document.createElement("span");
        e.fail.hint.className = "fail-hint";
      }
      set(e.fail.hint, "textContent", hint || "もう一度送ると、続きから頼めます");
      place(e.fail, [e.fail.word, e.fail.hint]);
      els.push(e.fail);
    }
    const when = li.classList.contains("memo") ? "" : timeLabel(row.createdAt); // 時刻は吹き出しの外・話し手側の端（css）
    if (when) {
      e.time ??= document.createElement("time");
      set(e.time, "textContent", when);
      els.push(e.time);
    }
    place(li, els);
    lis.push(li);
  }
  for (const [id, li] of have) {
    if (!lis.includes(li)) li.remove();
  }
  place(ul, lis);
  shownIds = new Set(list.map((r) => r.id));
  const lastRow = list.at(-1);
  const lastLi = lis.at(-1);
  // 進み具合・次の一手・上の 1 行で #rows の高さが変わるので、末尾の位置はそれらを描いた後で決める
  renderNext(lastRow, turn);
  renderProgress(live[0]);
  renderNeed(need);
  renderHead(list, live, failId, turn, need);
  const how = scrollPlan({
    scene,
    near,
    lastIsBot: !!lastRow && lastRow.text.startsWith("🤖"),
    lastHeight: lastLi ? lastLi.offsetHeight : 0,
    viewHeight: ul.clientHeight,
  });
  if (how === "end") ul.scrollTop = ul.scrollHeight;
  else if (how === "last-top" && lastLi) ul.scrollTop += lastLi.getBoundingClientRect().top - ul.getBoundingClientRect().top;
  else ul.scrollTop = prev;
}

// 最後が返事で、答えを待つ card（ask / handoff）が付いていて、まだ人が何も返していない時だけ
function turnCard(list, working) {
  if (working) return null;
  const i = list.findLastIndex((r) => r.text.startsWith("🤖") && r.cards?.some((c) => c.kind !== "done"));
  if (i < 0 || humanAfter(list, i)) return null;
  return { card: list[i].cards.find((c) => c.kind !== "done"), row: list[i] };
}

// 足りない物（agent が居ない・login が切れた・同時に動ける数）。送った時の失敗か、止まった run が持つ
function needOf(list, working) {
  if (working) return null;
  if (failMem?.rootId === rootId && failMem.need) return failMem.need;
  const run = runs.filter((x) => x.nodeId === rootId).at(-1);
  return run?.status === "failed" && run.need ? run.need : null;
}

// 進み具合の card（1 枚・畳める）。agent が動いている間だけ。終わると返事の行に替わる
function stepText(l) {
  const tool = /^🔧\s*(\S+)/.exec(l);
  return tool ? `${tool[1]} を使っています` : l.replace(/^(?:🤖|⏳|■|✗|⏱)\s*/u, "");
}
function renderProgress(working) {
  const box = $("progress");
  if (!working) {
    box.hidden = true;
    box._sig = "";
    return;
  }
  const log = working.log ?? [];
  const steps = log.slice(log.findLastIndex((l) => l.startsWith("👤")) + 1).map(stepText); // いまの頼みの分だけ（前の返事の行は出さない）。本数の上限は kg-progress
  const sig = JSON.stringify([rootId, steps]);
  box.hidden = false;
  let card = box._p;
  if (!card || (card.parentElement ?? card.parent) !== box) {
    card = box._p = document.createElement("kg-progress");
    const prog = customElements.get?.("kg-progress");
    if (prog) { prog.icon = ICON.work; prog.tick = ICON.tick; }
    card.addEventListener("kg-fold", () => {
      const id = rootId;
      if (card.hasAttribute("open")) progressOpen.add(id); else progressOpen.delete(id);
    });
    box.replaceChildren(card);
  }
  card.steps = steps;
  card.open = progressOpen.has(rootId); // 既定は畳む。open は人が開いた会話だけ
  if (box._sig === sig) return;
  box._sig = sig;
}

// 足りない物の 1 枚（次の一手つき）。「もう一度送る」は直前の自分の一言をそのまま送り直す
function renderNeed(need) {
  const box = $("need");
  if (!need) {
    box.hidden = true;
    box._sig = "";
    return;
  }
  box.hidden = false;
  const sig = JSON.stringify(need);
  if (box._sig === sig) return;
  box._sig = sig;
  const card = mk("div", "card");
  const t = el("div", "t", ICON.turn);
  t.append(`あなたの番です — ${need.what}`);
  const btn = txt("button", "btn p", "もう一度送る");
  btn.type = "button";
  btn.onclick = () => {
    const text = failMem?.rootId === rootId && failMem.text != null ? failMem.text : [...rows].reverse().find((r) => !r.text.startsWith("🤖") && r.id > 0)?.text;
    if (busy || rootId == null || !text) return;
    const id = rootId;
    once(() => sendChat(id, text));
  };
  const btns = mk("div", "btns");
  btns.append(btn);
  card.append(t, ...need.how.split("\n").map((l) => txt("div", "m", l)), btns);
  box.replaceChildren(card);
}

// 上の 1 行: 相手の名前と「いま何をしているか」。相手は 1 人に決め打ちせず、この会話の最新の run / 返事から引く
function renderHead(list, live, failId, turn, need) {
  renderField();
  if (naming === "new") { set($("hd-name"), "textContent", "新しい会話"); set($("hd-av"), "textContent", "＋"); set($("hd-st"), "textContent", EMPTY_MSG); return; }
  const lastRun = runs.filter((x) => x.nodeId === rootId).at(-1);
  const lastBot = [...list].reverse().find((r) => r.text.startsWith("🤖"));
  const name = roots.find((r) => r.id === rootId)?.agent?.name || lastRun?.role || lastRun?.cli || (lastBot && /^🤖\s*([^:：]+)/.exec(lastBot.text)?.[1]?.trim()) || "agent";
  const working = live[0];
  const failed = !working && (failId != null || failMem?.rootId === rootId || /^[✗⛔]/.test(roots.find((r) => r.id === rootId)?.agent?.answer ?? "")); // 常駐を起こし直した後（run が無い）でも、失敗の知らせを「終わりました」にしない
  const lastRow = list.at(-1);
  const [state, rest] = working
    ? ["進んでいます", working.log?.at(-1)?.replace(/^[^\s]+\s/, "") ?? ""]
    : need
      ? ["あなたの番です", need.what]
      : turn
        ? ["あなたの番です", turn.card.title]
        : failed
      ? ["あなたの番です", "失敗です。下の欄からもう一度"]
      : lastRow?.text.startsWith("🤖")
        ? ["終わりました", "続きは下の欄から"]
        : ["あなたの番です", "下の欄に書いてください"];
  set($("hd-name"), "textContent", plain(name, 60));
  { const cur = roots.find((r) => r.id === rootId); set($("hd-av"), "textContent", cur ? avatarGlyph(cur) : name.charAt(0)); } // 一覧の丸と同じ字
  const st = $("hd-st");
  const b = st.querySelector("b") ?? st.appendChild(document.createElement("b"));
  const sp = st.querySelector("span") ?? st.appendChild(document.createElement("span"));
  set(b, "textContent", state);
  set(sp, "textContent", rest ? `— ${rest}` : "");
  // 送る ⇄ 止めるは同じ位置（欄の右の丸）
  const btn = $("send-btn");
  btn.dataset.stop = working ? working.id : "";
  btn.setAttribute("aria-label", working ? "止める" : "送る");
  btn.title = btn.getAttribute("aria-label");
  btn.innerHTML = working ? ICON.stop : ICON.send;
  syncSend();
}

// 返事の下の「次の一手」。押すとその文がそのまま次の一言になる。3 つ出なかった時も、次に何をするかを 1 行出す
function renderNext(lastRow, turn) {
  const box = $("next");
  const working = liveHere().some((x) => x.nodeId === rootId);
  const shown = !working && !turn && lastRow && lastRow.text.startsWith("🤖") ? nexts.slice(0, 3) : [];
  const els = shown.map((n) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "next-btn";
    b.textContent = n.text;
    b.onclick = () => {
      if (busy || rootId == null) return;
      const id = rootId;
      nexts = [];
      renderNext(null, null);
      once(() => sendChat(id, n.text, n.id));
    };
    return b;
  });
  if (!els.length && !working && !turn && lastRow?.text.startsWith("🤖") && !failMem) {
    const p = document.createElement("p");
    p.className = "next-hint";
    p.textContent = "次の一手は出ませんでした。続きを下の欄に書いてください";
    els.push(p);
  }
  box.hidden = els.length === 0;
  box.replaceChildren(...els);
}

// 初めての 1 枚（bar の常駐だけが /first を持つ。拡張の中では取れないので何も出さない）
// 「この AI のきまり」: 1 押しで開く。行は rules.js（守っている所と 1 対 1・test/w13.test.ts）
function rulesCard() {
  const d = mk("details", "card rules");
  d.append(txt("summary", "t", "この agent のきまり（できる事・しない事・止め方）"));
  const ul = mk("ul", "m");
  ul.append(...RULES.map((r) => txt("li", "", r.text)));
  d.append(ul);
  return d;
}
function renderFirst(needs) {
  const box = $("first");
  box.hidden = false;
  box.replaceChildren(...firstCards(needs).map((n) => {
    const card = mk("div", "card");
    const t = el("div", "t", ICON.turn);
    t.append(n.title);
    card.append(t, txt("div", "m", n.how));
    if (n.button) {
      const done = txt("div", "m", "");
      const btn = txt("button", "btn p", n.button);
      btn.type = "button";
      btn.onclick = async () => {
        btn.disabled = true;
        const r = await call("extPlace");
        btn.disabled = false;
        if (!r.ok) { done.textContent = `置けませんでした（${r.hint ?? "原因不明"}）`; return; }
        done.textContent = "置きました。次の 3 つを Chrome でしてください";
        const ol = document.createElement("ol");
        for (const step of [
          "chrome://extensions を開き、右上の「デベロッパー モード」をオンにする",
          "「パッケージ化されていない拡張機能を読み込む」を押す",
          "Finder で開いた「extension」フォルダを選ぶ",
        ]) {
          const li = document.createElement("li");
          li.textContent = step;
          ol.append(li);
        }
        done.append(ol, txt("p", "first-note", "macOS が『Downloads フォルダへのアクセス』を聞いたら『許可』を押してください（Kangae が添付を保存するために使います）"));
      };
      const btns = mk("div", "btns");
      btns.append(btn);
      card.append(btns, done);
    }
    return card;
  }), rulesCard());
}
const sleepMs = (ms) => new Promise((f) => setTimeout(f, ms));
// 読めなかった時の 1 行と「もう一度」。空（読めて 0 件）とは別の文にする
function readFailCard(what, reason, again) {
  const btn = txt("button", "btn p", "もう一度");
  btn.type = "button";
  btn.onclick = again;
  const card = mk("div", "card");
  card.append(txt("div", "t", `${what}を読めませんでした（${reason}）`), btn);
  return card;
}
// 常駐の op を締切の中で読み直す。読めたら結果、読めなかったら box に理由と「もう一度」を出して null
async function readOp(box, what, again, op, extra) {
  const r = await readRetry(async () => { const x = await call(op, extra); return x.ok ? x : { ok: false, reason: x.hint || "本体から返事がありません" }; }, { sleep: sleepMs, onWait: () => { box.hidden = false; box.replaceChildren(txt("div", "m", `${what}を読み直しています…`)); } });
  if (r.ok) return r;
  box.hidden = false;
  box.replaceChildren(readFailCard(what, r.reason, again));
  return null;
}
// 拡張の案内が出ている間は 3 秒ごとに静かに読み直し、案内の中身が変わった（繋がった・置かれた）時だけ描き直す
function watchFirst(token, shown) {
  const sig = (n) => JSON.stringify(n.map((x) => x.what));
  if (!shown.some((n) => n.kind === "extension")) return;
  setTimeout(async () => {
    try {
      const x = await fetch(`/first?token=${token}`);
      if (x.ok) {
        const now = await x.json();
        if (sig(now) !== sig(shown)) return (renderFirst(now), watchFirst(token, now));
      }
    } catch {}
    watchFirst(token, shown);
  }, 3000);
}
async function loadFirst() {
  const box = $("first");
  const wait = () => { box.hidden = false; box.replaceChildren(txt("div", "m", "準備しています…")); };
  wait();
  const token = document.querySelector('meta[name="kangae-token"]')?.content;
  const r = await readRetry(async () => {
    if (!token) return { ok: false, final: true, reason: "Kangae Bar を開き直してください" };
    try {
      const x = await fetch(`/first?token=${token}`);
      return x.ok ? { ok: true, needs: await x.json() } : { ok: false, reason: `本体の返事が ${x.status} でした` };
    } catch (e) {
      return { ok: false, reason: `本体に繋がりません（${e?.message || "原因不明"}）` };
    }
  }, { sleep: sleepMs, onWait: wait });
  if (r.ok) { renderFirst(r.needs); return watchFirst(token, r.needs); }
  box.replaceChildren(readFailCard("最初の案内", r.reason, loadFirst));
}
loadFirst();

async function loadChat(scene) {
  if (rootId == null) {
    rows = [];
    nexts = [];
    renderChat(scene);
    return;
  }
  void loadPend();
  const r = await call("chat", { rootId });
  rows = r.ok ? r.rows ?? [] : [];
  nexts = r.ok ? r.next ?? [] : [];
  markSeen();
  renderChat(scene);
}

async function selectRoot(id) {
  const same = id === rootId;
  const wasNaming = naming;
  stash();
  naming = false;
  if (!same) {
    failMem = null;
    $("desktop-note").hidden = true;
  }
  rootId = id;
  saveRoot();
  if (!same || wasNaming) $("send-text").value = drafts.get(id) ?? "";
  renderField();
  if (same && wasNaming) $("send-text").focus();
  await loadChat(same ? "keep" : "open");
  await renderRoots();
  if (same) {
    const { groups } = await windowState();
    if (!findGroup(groups, id)) await applySwitch();
  } else {
    await applySwitch();
  }
  await renderRoots();
}

async function savedTabsOf(id) {
  const t = await call("tree", { rootId: id });
  if (!t.ok) return [];
  return (t.nodes ?? []).filter((n) => n.kind === "tab" && n.parentId === id && n.url).sort((a, b) => a.id - b.id);
}

async function savedUrlsOf(id) {
  return (await savedTabsOf(id)).map((n) => n.url);
}

async function windowState() {
  const [windowTabs, groups, front] = await Promise.all([
    chrome.tabs.query(winQuery()),
    chrome.tabGroups.query(winQuery()),
    chrome.tabs.query({ active: true, ...winQuery() }),
  ]);
  frontWeb = !!(front[0] && isWeb(front[0]));
  return { windowTabs, groups, frontWeb };
}

async function groupTabs(tabIds) {
  const ids = tabIds.filter((id) => id != null);
  if (!ids.length || rootId == null) return;
  const groups = await chrome.tabGroups.query(winQuery());
  const g = findGroup(groups, rootId);
  if (g) {
    await chrome.tabs.group({ tabIds: ids, groupId: g.id });
    return;
  }
  const gid = await chrome.tabs.group({ tabIds: ids, ...(winId != null ? { createProperties: { windowId: winId } } : {}) });
  const root = roots.find((x) => x.id === rootId);
  await chrome.tabGroups.update(gid, { title: groupTitle(root ?? { text: "", id: rootId }) });
}

async function applySwitch() {
  if (rootId == null) return;
  const { windowTabs, groups } = await windowState();
  const plan = planSwitch({
    rootId,
    savedUrls: await savedUrlsOf(rootId),
    windowTabs,
    groups,
  });
  if (plan.activate != null) await chrome.tabs.update(plan.activate, { active: true });
  if (plan.group?.length) {
    if (plan.expand != null) {
      await chrome.tabs.group({ tabIds: plan.group, groupId: plan.expand });
    } else {
      const gid = await chrome.tabs.group({ tabIds: plan.group, ...(winId != null ? { createProperties: { windowId: winId } } : {}) });
      const root = roots.find((x) => x.id === rootId);
      await chrome.tabGroups.update(gid, { title: groupTitle(root ?? { text: "", id: rootId }) });
    }
  }
  const openedNow = [];
  for (const item of plan.open ?? []) {
    if (!item || typeof item.url !== "string" || !item.url) continue;
    const tab = await chrome.tabs.create({ url: item.url, active: !!item.active, ...(winId != null ? { windowId: winId } : {}) });
    if (tab?.id != null) {
      openedNow.push(tab.id);
      opened.set(mapKey(rootId, item.url), tab.id);
    }
  }
  if (openedNow.length) await groupTabs(openedNow);
  for (const gid of plan.collapse ?? []) await chrome.tabGroups.update(gid, { collapsed: true });
  if (plan.expand != null) await chrome.tabGroups.update(plan.expand, { collapsed: false });
}

async function openTitle(url) {
  if (rootId == null || !url) return;
  const key = mapKey(rootId, url);
  let mapTab = null;
  const mid = opened.get(key);
  if (mid != null) {
    try {
      const t = await chrome.tabs.get(mid);
      if (t && (winId == null || t.windowId === winId)) mapTab = t.id;
    } catch {}
    if (mapTab == null) opened.delete(key);
  }
  const { windowTabs, groups } = await windowState();
  const plan = planTitle({
    rootId,
    url,
    savedUrls: await savedUrlsOf(rootId),
    windowTabs,
    groups,
    mapTab,
    mapValues: [...opened.values()],
  });
  if (plan.disabled) return;
  if (plan.activate != null) {
    await chrome.tabs.update(plan.activate, { active: true });
  } else if (plan.open && typeof plan.open.url === "string" && plan.open.url) {
    const tab = await chrome.tabs.create({ url: plan.open.url, active: !!plan.open.active, ...(winId != null ? { windowId: winId } : {}) });
    if (tab?.id != null) {
      await groupTabs([tab.id]);
      opened.set(key, tab.id);
    }
  }
  await renderRoots();
}

async function addCurrentTab() {
  if (rootId == null) return;
  const [tab] = await chrome.tabs.query({ active: true, ...winQuery() });
  if (!tab || !isWeb(tab)) return;
  const url = tab.url || tab.pendingUrl || "";
  await call("addTabs", { nodeId: rootId, tabs: [{ title: tab.title ?? "", url }] });
  const groups = await chrome.tabGroups.query(winQuery());
  const root = roots.find((x) => x.id === rootId);
  const plan = planAdd({ rootId, rootText: root?.text ?? "", tab, groups });
  if (plan.tabId != null) {
    if (plan.groupId != null) {
      await chrome.tabs.group({ tabIds: [plan.tabId], groupId: plan.groupId });
    } else if (plan.newTitle) {
      const gid = await chrome.tabs.group({ tabIds: [plan.tabId], ...(winId != null ? { createProperties: { windowId: winId } } : {}) });
      await chrome.tabGroups.update(gid, { title: plan.newTitle });
    }
  }
  await renderRoots();
}

// first = session が無い画面の一言目: 名前は頭の 30 字から自動で付け、その一言をそのまま送る（名前を先に聞かない）
// review/W12-7: 断られた理由は欄の下に出す（title＝hover だけだと、Enter を押して何も起きないように見える）。次に打てば消える
// W77d: 失敗・知らせは kg-toast に 1 枚だけ（入力欄の下の赤い 1 行は無くした）。msg が "" の時は失敗の報せだけ閉じる。第 1 引数は呼び出し側の形をそのまま（使わない）
const toast = (text, o) => $("toast").show(text, o);
const showErr = (_field, msg) => (msg === "" ? $("toast").hide("warn") : toast(msg || "うまくいきませんでした。もう一度試してください", { tone: "warn" }));
for (const id of ["empty-text", "send-text"]) $(id).addEventListener("input", () => showErr($(id), ""));
async function createSession(text, first = false) {
  text = text.trim();
  if (!text || creating) return;
  creating = true;
  try {
    const rememberProvider = naming === "new";
    const chosen = $("provider").value;
    const r = await call("add", { text: first ? firstName(text) : text });
    if (!r.ok || !r.node) {
      showErr($("app").hidden ? $("empty-text") : $("send-text"), r.hint);
      return;
    }
    roots = [r.node, ...roots.filter((x) => x.id !== r.node.id)];
    rootId = r.node.id;
    saveRoot();
    if (rememberProvider) { providers[String(r.node.id)] = chosen; saveJson("kangae-provider", providers); }
    naming = false;
    failMem = null;
    for (const f of [$("empty-text"), $("send-text")]) {
      showErr(f, "");
      f.value = "";
    }
    renderField();
    rows = [];
    showApp();
    await renderRoots();
    renderChat("open");
    if (first) await sendChat(r.node.id, text);
    else await refreshRuns({ scene: "keep" });
    $("send-text").focus();
  } finally {
    creating = false;
  }
}

// 名前は group の題にも入っている（·#番号 で見つける）。この窓の group の題を今の名前に合わせる
async function syncGroupTitles() {
  let groups = [];
  try { groups = await chrome.tabGroups.query(winQuery()); } catch { return; }
  for (const r of roots) {
    const g = findGroup(groups, r.id);
    if (g && g.title !== groupTitle(r)) await chrome.tabGroups.update(g.id, { title: groupTitle(r) }).catch(() => {});
  }
}

// agent に渡した窓の一覧（誰が持っているか）。常駐が起き直した後の「要再確認」もここで押す
// W8e 覗き窓: 渡した面の縮小絵。人が押した面（W79: 一覧の行の icon・「拡げる」）と認証 card の面だけ、panel が見えている間 1 面ずつ（常駐の peek-lite が変わった時しか撮らない）。絵を押した時だけその面が前に出る
const peekCache = {}; // lease の key → { img } か { hint }
const rowPeek = new Set(); // 一覧の行の icon を押して縮小絵を出している面の key（押した時だけ・閉じている間は絵の描画 0）
const peekOpen = new Set(); // 一望の中で拡げている行の key（前面は変えない）
let authKeys = []; // 認証 card が出ている面の key（card の小さい絵だけは出る時に撮る）
const peekLast = {}; // key → 最後に撮った時刻
window.__peekLog = []; // 撮った回数の原文（試験が読む）: { key, big, t }
let peekBusy = false;
// 間隔: 拡げている間 2 秒・閉じたら 4 秒・見えていない時は撮らない（src/peek.ts の peekEvery と同じ値）
async function peekTick() {
  const want = peekKeys(leaseRows ?? [], { rows: rowPeek, open: peekOpen, auth: authKeys }); // W79: 人が押した面と認証 card の面だけ。他は撮りに行かない（定期の撮影 0）
  if (peekBusy || document.visibilityState !== "visible" || !want.length) return;
  peekBusy = true;
  try {
    for (const l of leaseRows.filter((x) => want.includes(x.key))) {
      const big = peekOpen.has(l.key);
      if (Date.now() - (peekLast[l.key] ?? 0) < (big ? 2000 : 4000) - 100) continue;
      peekLast[l.key] = Date.now();
      window.__peekLog.push({ key: l.key, big, t: Date.now() });
      const x = await call("peek", { key: l.key, visible: document.visibilityState === "visible", big });
      peekCache[l.key] = x.ok ? { img: x.img } : { hint: x.hint };
      document.querySelectorAll(".lease, .auth-card, .row-peek").forEach((r) => r.dataset.key === l.key && r.querySelector(".peek")?.replaceWith(peekEl(l.key)));
    }
  } finally { peekBusy = false; }
}
function peekEl(key) {
  const c = peekCache[key];
  if (!c) return Object.assign(el("span", "peek"), { hidden: true });
  if (c.hint) return Object.assign(el("span", "peek hint"), { textContent: c.hint });
  const big = peekOpen.has(key);
  const i = Object.assign(el("img", big ? "peek big" : "peek"), { src: c.img, title: "押すと、この窓が前に出ます", alt: "この窓の今の絵" });
  i.onclick = async () => { const x = await call("peekFront", { key }); if (!x.ok) { peekCache[key] = { hint: x.hint }; i.replaceWith(peekEl(key)); } else loadLeases(); }; // W76b: 前に出した後、認証 card を「人が操作中」に描き直す
  return i;
}
// 「拡げる / 閉じる」: 一望の中で絵を大きくする（前に出さない）。閉じたら元の行・撮る間隔も 4 秒へ
function peekToggle(key, btn) {
  const open = !peekOpen.has(key);
  open ? peekOpen.add(key) : peekOpen.delete(key);
  if (!open) delete peekCache[key]; // 閉じたら古い絵を残さない（icon だけに戻る）
  peekLast[key] = 0; // 拡げた / 閉じた直後に 1 枚撮り直す
  btn.textContent = open ? "閉じる" : "拡げる";
  btn.closest(".lease")?.classList.toggle("expanded", open);
  peekTick();
}
setInterval(peekTick, 1000);
// W11c: 取り戻した後の 3 つの状態（図 §54）。履歴を順に並べて「何が起きたか」を残す（送った物が無ければ「結果を確認中」は出ない）
const RECOV = { stopping: "agent を止めています", reclaimed: "止めました（この窓・tab はあなたに戻りました）", verifying: "やりかけの操作を確かめています", confirmed: "確かめました（送った操作の結果が分かりました）", unknown: "確かめられませんでした", prevented: "agent の操作を実行前に止めました（何も送っていません）" };
function recoveryRow(c) {
  const row = el("div", "lease recov");
  row.dataset.key = c.key;
  row.dataset.phase = c.phase;
  const t = (at) => new Date(at).toLocaleTimeString("ja-JP", { hour12: false });
  const np = c.steps.filter((x) => x.phase === "prevented").length; // W11c-3: 実行の直前に止めた件数（人が取り戻した後に届きかけた操作）
  row.dataset.prevented = String(np);
  row.append(Object.assign(el("span", ""), { textContent: `${c.app}${c.title ? ` / ${c.title}` : ""} — ${RECOV[c.phase]}${np ? `（実行前に止めた操作 ${np} 件・その操作は実行されていません）` : ""}${c.sent ? `（止める直前に agent が送っていた操作が ${c.sent} 件あります${c.phase === "unknown" ? "。実行されたかもしれません。画面を見て確かめてください" : c.phase === "confirmed" ? "" : "。結果を待っています"}）` : ""}　${c.steps.map((x) => `${RECOV[x.phase]} ${t(x.at)}`).join(" → ")}` }));
  return row;
}
async function loadLeases() {
  loadMods();
  loadCmds();
  const box = $("leases");
  const r = await readOp(box, "agent に渡している窓・tab の一覧", loadLeases, "leaseList");
  if (!r) { // 読めない間は、渡している物が有るか分からない。止めたい時に止める button が無いのが一番悪いので停止の button は押せる形で出す
    showStopAll(true);
    return;
  }
  leaseRows = r.leases;
  authKeys = (r.auth ?? []).map((c) => c.key);
  peekTick();
  approvalRows = r.approvals ?? [];
  renderApprove(r.approvals ?? [], r.leases, r.carries ?? [], r.routineCards ?? [], r.auth ?? []);
  syncSendQuiet();
  if (!$("app").hidden) renderRoots();
  const recs = r.recoveries ?? [];
  if (!r.leases.length && !recs.length) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  box.replaceChildren(...recs.map(recoveryRow), ...r.leases.map((l) => {
    const row = document.createElement("div");
    row.className = "lease";
    row.dataset.key = l.key;
    const who = roots.find((x) => `s:${x.id}` === l.owner)?.text ?? l.owner;
    const label = document.createElement("span");
    label.textContent = `🔒 ${l.surface.app}${l.surface.title ? ` / ${l.surface.title}` : ""} — ${who} の agent が持っています${l.confirmed ? "" : "（アプリが再起動しました。右の「再確認」を押すまで agent は動けません）"}${l.hold ? (l.waitSince ? "　⏳ 待っています: あなたがこの画面から離れたら始めます（まだ何も変えていません）" : "　⏳ あなたがこの画面から離れたら始めます") : ""}`;
    const take = document.createElement("button");
    take.type = "button";
    take.textContent = "代わる"; // 行の「代わる」と同じ 1 つの言葉・同じ働き（その会話の agent だけ止まり、面は人に戻る）。帯は誰が何を持っているかの表示
    take.onclick = async () => { take.disabled = true; await call("handover", { rootId: Number(l.owner.slice(2)) }); await refreshRuns({ scene: "keep", reload: true }); };
    row.append(peekEl(l.key), label);
    const grow = document.createElement("button");
    grow.type = "button";
    grow.className = "peek-grow";
    grow.textContent = peekOpen.has(l.key) ? "閉じる" : "拡げる";
    grow.onclick = () => peekToggle(l.key, grow);
    row.classList.toggle("expanded", peekOpen.has(l.key));
    row.append(grow);
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "1 手戻す";
    back.onclick = async () => { back.disabled = true; const x = await call("undoLast", { rootId: Number(l.owner.slice(2)) }); toast(x.ok ? x.text : x.hint ?? "戻せませんでした", { tone: x.ok ? "ok" : "warn" }); await loadLeases(); };
    row.append(back);
    if (!l.confirmed) {
      const again = document.createElement("button");
      again.type = "button";
      again.textContent = "再確認";
      again.onclick = async () => { const x = await call("leaseReconfirm", { key: l.key }); if (!x.ok) label.textContent = x.hint; };
      row.append(again);
    }
    row.append(take);
    // 操作権の 6 行（W11a・型 capOf が作る。panel は判定しない）。行を開くと、この面で agent ができる事 / できない事が読める
    if (l.rights) {
      const det = document.createElement("details");
      det.className = "rights";
      det.append(Object.assign(document.createElement("summary"), { textContent: "できる事・できない事" }), ...l.rights.rows.map(([k, v]) => { const li = document.createElement("div"); li.append(Object.assign(document.createElement("b"), { textContent: k }), Object.assign(document.createElement("span"), { textContent: v })); return li; }));
      det.append(modePick(l.surface.app, l.key));
      row.classList.add("has-rights");
      row.append(det);
    }
    return row;
  }));
}

// 「これからも許す」の口（W11a-3）。既定は「この窓だけ」（key 付き）。「<app> の全部の窓」は人が checkbox を入れた時だけ key 無しで送る（W11a-2 の app 単位）
function modePick(app, key) {
  const box = mk("div", "mode-pick");
  const cb = Object.assign(document.createElement("input"), { type: "checkbox" });
  const lab = mk("label", "");
  lab.append(cb, ` ${app} の全部の窓`);
  const note = txt("div", "hint", "");
  note.hidden = true;
  cb.onchange = () => { note.hidden = !cb.checked; note.textContent = cb.checked ? `${app} の他の窓にも同じ許しが効きます` : ""; };
  const go = txt("button", "btn", "これからはこの窓だけ許す");
  go.type = "button";
  cb.addEventListener("change", () => { go.textContent = cb.checked ? `これからは ${app} の全部の窓に許す` : "これからはこの窓だけ許す"; });
  go.onclick = async () => { go.disabled = true; await call("leaseMode", { app, mode: "allow", ...(cb.checked ? {} : { key }) }); go.disabled = false; };
  box.append(go, lab, note);
  return box;
}

// 承認の card（門が止めた「壊しうる操作」を何を・どこに・1 行で）と、全停止の 1 押し。承認は押された 1 件だけ実行・断るは 0 件
// W8g-4: 金庫（Bitwarden）からパスワードを入れる card。checkbox は既定 off・on にして「入れる」を押した時だけ承諾（off のまま押したら断りと同じ）
function vaultCard(a) {
  const c = el("div", "card approval carry vault");
  c.dataset.id = a.id;
  c.append(el("div", "t", ICON.turn));
  c.firstChild.append(`agent が ${a.host} のログイン画面に来ました。金庫（Bitwarden）からパスワードを入れますか（値は agent には見せません）`);
  const hl = mk("label", "hint hist");
  const hb = mk("input", "");
  hb.type = "checkbox";
  const keep = (window.vaultOn ??= new Set()); // card は作り直されるので、on の印は id で持つ
  hb.checked = keep.has(a.id);
  hb.onchange = () => (hb.checked ? keep.add(a.id) : keep.delete(a.id));
  hl.append(hb, `金庫から ${a.host} のパスワードを入れる（チェックを入れて「入れる」を押した時だけ・項目が 1 件だけ合う時だけ入ります。送信は押しません）`);
  c.append(hl);
  c.append(approveEl(async (choice) => {
    if (choice === "deny") return call("carryAnswer", { id: a.id, yes: false, vault: false });
    if (choice === "always") { hb.checked = true; keep.add(a.id); toast(`always allow: これからは全部の agent に効きます（${a.host}）`); } // W90（CEO 10-14「always allow を選ぶと全ての agent に always allow される」）
    return call("carryAnswer", { id: a.id, yes: true, vault: choice === "always" ? true : hb.checked });
  }));
  return c;
}

// card に出す「どこで」: tab の面は app 名が内部の "web" なので「tab」と言う
const cardPlace = (a) => `${a.app === "web" ? "tab" : a.app}${a.title ? ` / ${a.title}` : ""}`;
// W76a: 認証で人の手が要る時の card（種類と host だけ・面の題は出さない）。agent が触っている面の小さい絵（peek-lite・新しくは撮らない）を載せる。絵を押すと面が前に出る（人の操作）
function authCardEl(c) {
  const box = el("div", "card approval auth-card");
  box.dataset.id = c.id; box.dataset.key = c.key;
  box.append(Object.assign(el("div", "t", ICON.turn), { textContent: `認証が要ります — ${c.reason}` }));
  // 絵を押すと、その面が前に出て、そこから先は人の操作（agent は止まったまま）。済んだら押す
  box.append(Object.assign(el("div", "m"), { textContent: c.fronted ? `${c.host} の画面を前に出しました。認証だけ済ませて、下の「済んだ」を押してください（agent は止まっています）` : `${c.host} で、人にしかできない確認が出ています。agent は止まっています。下の絵を押すと、その画面が前に出ます` }));
  box.append(peekEl(c.key));
  const btns = mk("div", "btns");
  for (const o of c.options) {
    const b = txt("button", o.id === "done" ? "btn p" : "btn", o.id === "done" && c.fronted ? "済んだ（agent に続きを頼む）" : o.label);
    b.type = "button";
    b.onclick = async () => {
      b.disabled = true;
      const r = await call("authAnswer", { authId: c.id, choice: o.id });
      if (!r.ok) { b.disabled = false; showErr($("send-text"), r.hint); return; }
      if (r.pick) { // 登録: 金庫に項目が複数ある時は、人が名前で選ぶ（値は見せない・id の参照だけを結ぶ）
        const list = mk("div", "btns");
        list.append(Object.assign(el("div", "m"), { textContent: "どの項目に結びますか" }));
        for (const it of r.pick) {
          const pb = txt("button", "btn", it.name || "（名前なし）");
          pb.type = "button";
          pb.onclick = async () => { pb.disabled = true; const x = await call("authAnswer", { authId: c.id, choice: "register", itemId: it.id }); if (!x.ok) { pb.disabled = false; showErr($("send-text"), x.hint); } else loadLeases(); };
          list.append(pb);
        }
        btns.replaceWith(list);
        return;
      }
      loadLeases();
    };
    btns.append(b);
  }
  box.append(btns);
  return box;
}
function renderApprove(approvals, leases, carries = [], routineCards = [], auth = []) {
  approveMemo = [approvals, leases, carries, routineCards, auth];
  const shownCarries = carries; // W98: 金庫の card も常に出す（鍵 icon は無い）
  const box = $("approve");
  box.hidden = !approvals.length && !leases.length && !shownCarries.length && !routineCards.length && !auth.length;
  const queue = [
    ...auth.map(authCardEl),
    ...leases.filter((l) => l.turnAllow).map((l) => Object.assign(el("div", "hint turn-allow"), { textContent: `この頼みの間、${l.surface.app}${l.surface.title ? ` / ${l.surface.title}` : ""} への書き込みを許しています（頼みが終わると消えます）` })),
    ...approvals.map((a) => {
      const c = el("div", "card approval");
      c.dataset.id = a.id;
      c.append(el("div", "t", ICON.turn));
      c.firstChild.append(a.tool === "open_app" && !a.app ? `agent が ${a.what}（まだ窓を持っていない会話の頼みです）` : a.tool === "run_cmd" || a.tool === "open_app" || a.tool === "launch_app" ? `agent が ${a.what}（${cardPlace(a)} の頼みの中で）` : a.open && !a.app ? `agent が新しい tab で ${a.open} を開きます（まだ何も開いていない会話の頼みです）` : a.open ? `agent が新しい tab で ${a.open} を開きます（${cardPlace(a)} の頼みの中で）` : !a.app ? `agent が ${a.what}` : a.unsure ? `agent が ${cardPlace(a)} で「${a.what}」をしようとしています` : a.danger ? `agent が ${cardPlace(a)} で ${a.what}ところです` : `agent が ${cardPlace(a)} に「${a.what}」をしようとしています`);
      { const who = roots.length >= 2 ? roots.find((x) => `s:${x.id}` === a.owner) : null; if (who) c.append(Object.assign(el("div", "m"), { textContent: `「${plain(who.agent?.name ?? who.text)}」の agent の頼みです` })) /* review19: HTML として描かない */; } // 会話が 2 つ以上の時: どの agent が待っているかを card に（承認は全部の会話で見える・名前が無いと A と B を取り違える）
      if (a.danger) { c.classList.add("danger"); if (!a.open && !["open_app", "run_cmd", "launch_app", "api_tab", "op_read", "op_write", "api_anything"].includes(a.tool)) c.append(el("div", "m", a.unsure ? "押す先が分からないので聞きます" : "取り返しがつかないかもしれません。押す前に確かめてください")); } // open_tab・open_app・tab を借りる・op は note だけ（押す操作ではないので「押す前に」は出さない）
      if (a.note) c.append(Object.assign(el("div", "hint"), { textContent: a.note })); // review19: note に URL・path・argv が入る＝HTML として描かない
      c.append(approveEl(async (choice) => {
        if (choice === "always" && a.app) { await call("leaseMode", { app: a.app, mode: "allow" }); toast(`always allow: これからは全部の agent に効きます（${a.app}）`); } // W90: leaseMode は app 単位で agent を持たない＝全 agent に効く事を人に 1 行
        return call("approvalAnswer", { id: a.id, yes: choice !== "deny", scope: "once" });
      }));
      if (!a.danger) c.append(modePick(a.app, a.key)); // 取り返しがつかない物は毎回聞く（これからも許す、は出さない）
      return c;
    }),
    // W8g: ログインを運ぶ card。domain ごとの cookie の名前と件数だけ（値は常駐にも来ていない）。既定の選択は無い
    ...shownCarries.map((a) => {
      if (a.vault) return vaultCard(a);
      const c = el("div", "card approval carry");
      c.dataset.id = a.id;
      c.append(el("div", "t", ICON.turn));
      c.firstChild.append(`agent が ${a.host} のログインを、見えないブラウザに運ぼうとしています（この頼みの間だけ・値は見せません）`);
      for (const g of a.groups) c.append(Object.assign(el("div", `hint${g.remembered ? " prev" : ""}`), { textContent: `${g.remembered ? "● 前回も運びました  " : ""}${g.domain}: ログイン情報 ${g.count} 件（名前だけ: ${g.names.join("、")}）` }));
      for (const s of a.skipped) c.append(Object.assign(el("div", "hint thin"), { textContent: `運ばない物: ${s.domain} — ${s.reason}` }));
      // 履歴は cookie と別の承諾。既定 off・on にして「運ぶ」を押した click の中でだけ、ブラウザに履歴の許可を求める
      const hl = mk("label", "hint hist");
      const hb = mk("input", "");
      hb.type = "checkbox";
      const keep = (window.histOn ??= new Set()); // card は作り直されるので、on の印は id で持つ
      hb.checked = keep.has(a.id);
      hb.onchange = () => (hb.checked ? keep.add(a.id) : keep.delete(a.id));
      hl.append(hb, `この site の履歴も渡す（直近 ${a.history?.limit ?? 20} 件・題と URL だけ。URL の ? 以降と # は渡しません）`);
      c.append(hl);
      const btns = approveEl(async (choice) => {
        const yes = choice !== "deny";
        let history = false;
        if (yes && hb.checked) history = await chrome.permissions.request({ permissions: ["history"] }).catch(() => false);
        const r = await call("carryAnswer", { id: a.id, yes, history });
        if (history && !r?.ok) await chrome.permissions.remove({ permissions: ["history"] }).catch(() => {}); // 承諾の待ちが先に終わっていたら許可を残さない
        return r;
      });
      if (a.remember) {
        const f = txt("button", "btn", "次から覚えない");
        f.type = "button";
        f.title = "前回運んだ site の名前を消し、今回も覚えません（運ぶかどうかは別に選べます）";
        f.onclick = async () => { f.disabled = true; await call("carryForget", { id: a.id }); };
        btns.append(f);
      } else c.append(Object.assign(el("div", "hint"), { textContent: "この頼みでは、運んだ site を次回に覚えません" }));
      c.append(btns);
      return c;
    }),
    // W8fix: agent が自分で足した routine は、人が押すまで鳴らない（答えが無ければ断ると同じ）
    ...routineCards.map((a) => {
      const c = el("div", "card approval routine");
      c.dataset.id = a.id;
      c.append(el("div", "t", ICON.turn));
      c.firstChild.append(`agent「${a.agent}」が予約しようとしています: ${a.label}${a.task ? ` — ${a.task}` : ""}`);
      if (a.internal) c.append(Object.assign(el("div", "hint"), { textContent: "この機械の中・社内のアドレスの頁です。承諾すると、この Mac がその頁を読みに行きます。心当たりが無ければ deny を押してください" }));
      c.append(approveEl((choice) => call("routineAnswer", { id: a.id, yes: choice !== "deny" })));
      return c;
    }),
  ];
  // W107: 先頭の card だけ。turn-allow の hint は数えない。2 枚以上は末尾に「あと N 件」（押すと全部・もう一度で畳む）
  const isCard = (n) => String(n.className ?? "").split(/\s+/).includes("card");
  const nCard = queue.filter(isCard).length;
  const showAll = approveOpen || nCard < 2;
  let seen = false;
  const visible = [];
  for (const n of queue) {
    if (isCard(n)) {
      if (showAll || !seen) visible.push(n);
      seen = true;
    } else if (showAll || !seen) visible.push(n);
  }
  if (nCard >= 2) {
    const more = txt("button", "more-cards", `あと ${nCard - 1} 件`);
    more.type = "button";
    more.onclick = () => { approveOpen = !approveOpen; renderApprove(...approveMemo); };
    visible.push(more);
  }
  box.replaceChildren(...visible);
  // W14: 「全部止める」は bar を開いた一番上（どの画面でも見える）。渡している物がある時だけ。押すと常駐の stopAll → 下の取り戻しの行が 停止要求中 → 回収済み → 結果を確認中 と進む
  showStopAll(!!(leases.length || approvals.length || shownCarries.length || routineCards.length));
}
function showStopAll(show) {
  const sa = $("stop-all");
  sa.hidden = !show;
  sa.disabled = false;
  sa.onclick = async () => { sa.disabled = true; try { await call("stopAll"); } finally { sa.disabled = false; await loadLeases(); } }; // 常駐が答えなくても押せないまま残さない
}

// 画面の操作を誰に任せるか（W5c）。既定 claude。d1 / jev にする時は、窓の文字が外の会社へ送られる事を選ぶ場で見せる
async function loadScreenEngine(pick) {
  const box = $("screen-engine");
  const r = await readOp(box, "画面の操作の設定", () => loadScreenEngine(pick), "screenEngine", pick ? { engine: pick } : {});
  if (!r) return;
  const sel = mk("select", "screen-sel");
  sel.setAttribute("aria-label", "画面の操作");
  for (const [v, n] of [["claude", "画面の操作: claude（既定）"], ["d1", "画面の操作: d1（速い）"], ["jev", "画面の操作: Jev（速い）"]]) sel.append(Object.assign(mk("option", ""), { value: v, textContent: n, selected: v === r.engine }));
  sel.onchange = () => loadScreenEngine(sel.value);
  box.replaceChildren(sel, txt("div", "why", r.sends || "理解と生成も、画面の操作も claude が行います（窓の中身は外の会社へ送られません）"));
}
loadScreenEngine();

// mod（W6a）。前面の app は bar が window.kangaeFront(app, pid) で教える（見るだけ・前面は奪わない）。札 = 前面の app 用で、許可が on の mod
let front = { app: "", pid: 0 };
window.kangaeFront = (app, pid) => { front = { app: String(app || ""), pid: Number(pid) || 0 }; loadMods(); };
// W17b: AI に走らせてよい command の一覧（読むだけ。登録・外すは人のターミナルの cmd-add / cmd-rm だけ＝この欄に AI の文が入る道を作らない）
// W97: 1 件は details。summary は名前（手順は on/off の kg-toggle も）。中身は開いた時だけ。0 件の節は hidden
function paintLearnedEmpty() {
  $("learned-empty").hidden = !($("cmds").hidden && $("mods").hidden && $("op-drafts").hidden);
}
async function loadCmds() {
  const box = $("cmds");
  const r = await readOp(box, "登録した物の一覧", loadCmds, "cmdList");
  if (!r) { paintLearnedEmpty(); return; }
  if (!r.items.length) { box.hidden = true; box.replaceChildren(); paintLearnedEmpty(); return; }
  box.hidden = false;
  box.replaceChildren(...r.items.map((c) => {
    const det = mk("details", "cmd" + (c.ok ? "" : " bad"));
    const sum = mk("summary", "cmd-name");
    sum.textContent = c.name + (c.app ? "（app）" : "");
    det.append(sum, txt("div", "m", `場所: ${c.cwd}`), txt("div", "m", `実行する行: ${c.line}`), txt("div", "m", `ネットワーク: ${c.network ? "あり" : "なし"}${c.reads && c.reads.length ? `・読みを許す所: ${c.reads.join(" / ")}` : ""}`), txt("div", "m", `登録した日: ${new Date(c.at).toISOString().slice(0, 10)}`));
    if (!c.ok) det.append(txt("div", "m", "登録が書き換えられているので動かしません。外して、登録し直してください"));
    det.append(txt("div", "m", `外すには: ~/.kangae/bin/kangae cmd-rm ${c.name}`));
    return det;
  }));
  paintLearnedEmpty();
}
async function loadMods() {
  const box = $("mods");
  const r = await readOp(box, "覚えた手順の一覧", loadMods, "mods", { app: front.app, rootId });
  if (!r) { paintLearnedEmpty(); return; }
  const tags = r.mods.filter((m) => m.ok && m.on && m.front);
  const rows = r.mods.map((m) => {
    const det = mk("details", "mod" + (m.ok ? "" : " bad"));
    det.dataset.key = m.key;
    const sum = mk("summary", "");
    sum.append(txt("span", "nm", m.ok ? m.label : m.name));
    if (m.ok) {
      const sw = document.createElement("kg-toggle");
      if (m.on) sw.setAttribute("on", "");
      sw.setAttribute("label", m.on ? "on" : "off");
      sw.addEventListener("click", (e) => e.stopPropagation()); // summary の開閉にしない
      sw.addEventListener("kg-toggle", async (e) => {
        sw.disabled = true;
        try {
          const x = await call("modOn", { key: m.key, yes: !!e.detail.on });
          if (!x?.ok) { sw.on = !e.detail.on; toast(x?.hint ?? "変えられませんでした", { tone: "warn" }); }
          else loadMods();
        } finally { sw.disabled = false; }
      });
      sum.append(sw);
    }
    det.append(sum);
    if (!m.ok) { det.append(txt("div", "why", `読めません: ${m.error}`)); return det; }
    det.append(txt("span", `perm ${m.permission}`, m.permission === "read" ? "読むだけ" : "書く"));
    det.append(txt("div", "why origin", `作った人: ${m.origin}${m.seen > 1 ? `・${m.seen} 回` : ""}`));
    if (m.runs) det.append(txt("div", "why", `${m.on ? "この手順は" : "on にすると"} ${m.runs} を起こします`));
    return det;
  });
  box.hidden = !rows.length && !r.offer;
  box.replaceChildren(...rows);
  if (r.offer) { // 成功した手順（2〜8 手）を覚えるか（押すまで何も書かない・書いても off）
    const o = mk("div", "mod-offer");
    const yes = txt("button", "btn mod-make", "手順として覚える");
    const no = txt("button", "btn mod-no", "しない");
    yes.type = no.type = "button";
    yes.onclick = async () => { yes.disabled = no.disabled = true; const x = await call("distillMake", { rootId }); toast(x.ok ? "覚えた手順の下書きを作りました（まだ許していません）" : x.hint ?? "作れませんでした", { tone: x.ok ? "ok" : "warn" }); loadMods(); };
    no.onclick = async () => { await call("distillNo", { rootId }); };
    o.append(txt("span", "", `この手順を覚えますか（${r.offer.app}・${r.offer.steps} 手）`), yes, no);
    box.prepend(o);
  }
  if (tags.length) {
    const t = mk("div", "mod-tags");
    for (const m of tags) {
      const b = txt("button", "btn mod-tag", `🧩 ${m.label}`);
      b.type = "button";
      b.dataset.key = m.key;
      b.onclick = async () => {
        b.disabled = true;
        const x = await call("modRun", { key: m.key, rootId, pid: front.pid, app: front.app, title: "" });
        if (!x.ok) toast(x.hint ?? "動かせませんでした", { tone: "warn" });
        b.disabled = false;
        if (x.ok) { await refreshRuns({ scene: "keep", reload: true }); loadLeases(); }
        loadMods();
      };
      t.append(b);
    }
    box.prepend(t);
  }
  paintLearnedEmpty();
}

async function reloadRoots() {
  const listed = await call("roots");
  if (!listed.ok) return;
  roots = listed.roots ?? [];
  loadLeases();
  if ($("app").hidden && roots.length && !starting && !$("empty-text").value) return start(); // 「session がまだ無い」の画面に、外から session が出来た（囲んだ画面）
  await syncGroupTitles();
  if (!$("app").hidden) await renderRoots();
}

async function sendChat(id, text, nextId) {
  failMem = null;
  // 常駐が返すまで数秒かかる事があるので、送った一言は先に会話へ出す（読み直しで本物の行に替わる）
  rows.push({ id: -Date.now(), text, createdAt: Number.MAX_SAFE_INTEGER });
  nexts = [];
  renderChat("send");
  const r = await call("send", { rootId: id, text, ...(nextId != null ? { nodeId: nextId } : {}) });
  if (r.ok && r.ui) applyUi(r.ui);
  if (r.ok && r.runId && r.row) sent.push({ runId: r.runId, nodeId: id, rowId: r.row.id, at: Date.now() });
  if (!r.ok) {
    failMem = { rootId: id, rowId: r.row ? r.row.id : -Date.now(), hint: typeof r.hint === "string" ? r.hint : "", text: r.row ? null : text, need: r.need ?? null };
  }
  await refreshRuns({ scene: r.ok ? "send" : "fail", reload: true });
  return r;
}

async function stopOne(runId) {
  if (!runId || stopping.has(runId)) return;
  stopping.add(runId);
  try {
    await call("stopRun", { runId });
    await refreshRuns({ scene: "keep", reload: true });
  } finally {
    stopping.delete(runId);
  }
}

function arm() {
  clearTimeout(runTimer);
  if (!liveHere().length) return;
  runTimer = setTimeout(() => { refreshRuns({ scene: "keep", reload: true }); }, 2000);
}

async function refreshRuns({ scene = "keep", reload = false } = {}) {
  clearTimeout(runTimer);
  const listed = await call("roots");
  if (listed.ok) roots = listed.roots ?? roots; // 一覧の「最後の 1 行・時刻・あなたの番」を新しくする
  if (roots.length) {
    const r = await call("runs", { nodeIds: roots.map((x) => x.id) });
    if (r.ok) runs = r.runs ?? [];
  }
  // 会話は runs の「後」に読む。逆順だと、読んだ後・runs の前に速い run が終わった時、会話は返事なし・runs は「終わった」の組になり、
  // arm() は動いている run が無いので二度と読み直さず、返事が出ない（dm.e2e D3 の不安定の根・本線でも再現）。返事は run が idle になる前に保存されるので、runs が終わりなら会話に返事が在る
  if (reload && rootId != null) {
    const c = await call("chat", { rootId });
    if (c.ok) { rows = c.rows ?? []; nexts = c.next ?? []; markSeen(); }
  }
  // view に現れたら覚えは要らない。30 秒たっても現れない run は常駐が忘れたとみなして捨てる
  for (let i = sent.length - 1; i >= 0; i--) {
    if (runs.some((x) => x.id === sent[i].runId) || Date.now() - sent[i].at > 30_000) sent.splice(i, 1);
  }
  await renderRoots();
  renderChat(scene);
  arm();
}

function redraw() {
  if (rootId != null && !$("app").hidden) renderRoots();
}

function applyUi(ui) {
  hasOverride = !!ui?.hasOverride;
  renderClearUi();
}

function renderClearUi() {
  const el = $("clear-ui");
  const hide = !hasOverride;
  if (el.hidden === hide) return;
  const ul = $("rows");
  const near = nearBottom(ul);
  el.hidden = hide;
  if (scrollPlan({ scene: "toggle", near, lastIsBot: false, lastHeight: 0, viewHeight: 0 }) === "end") ul.scrollTop = ul.scrollHeight;
}

$("empty-form").onsubmit = (e) => {
  e.preventDefault();
  if (composing || e.isComposing) return;
  createSession($("empty-text").value, true);
};
async function loadProviders() {
  const sel = $("provider");
  const keep = sel.value;
  let found = [];
  try {
    const r = await call("providers");
    if (r && r.ok && Array.isArray(r.providers)) found = r.providers.filter((p) => p && p.id && p.id !== "gemini");
  } catch {}
  const group = document.createElement("optgroup");
  group.label = "この Mac に入っている物";
  for (const p of found) group.append(new Option(p.label || p.id, p.id));
  const local = document.createElement("optgroup");
  local.label = "この Mac の中だけで動く";
  local.append(new Option("この Mac", "local"));
  sel.replaceChildren(group, local);
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  renderField();
}
function startNew() {
  void loadProviders();
  closeList();
  if (naming === "new") return;
  stash();
  naming = "new";
  const f = $("send-text");
  f.value = "";
  renderField();
  f.focus();
}
$("plus").onclick = () => startNew();
// W60b2: 担当名（表示名）。空で送ると担当名は消える。agent 名は同じ値を既存の op でもう 1 回送る（空は 1 字必須で拒否されるので、その失敗だけは担当名の消去を止めない）
$("rename").onclick = () => {
  closeList();
  if (rootId == null || naming === "rename") return;
  stash();
  naming = "rename";
  const f = $("send-text");
  const cur = roots.find((r) => r.id === rootId);
  f.value = cur?.agent?.name || cur?.role || "";
  renderField();
  f.focus();
  f.select();
};
async function renameShown(text) {
  text = text.trim();
  if (creating || rootId == null) return;
  creating = true;
  try {
    const agent = await call("agentName", { rootId, name: text });
    if (text && !agent.ok) { showErr($("send-text"), agent.hint); return; }
    const role = await call("role", { rootId, role: text });
    if (!role.ok) { showErr($("send-text"), role.hint); return; }
    naming = false;
    const f = $("send-text");
    showErr(f, "");
    f.value = drafts.get(rootId) ?? "";
    renderField();
    await reloadRoots();
    f.focus();
  } finally {
    creating = false;
  }
}
// IME で変換を確定する Enter は送らない（WebKit は compositionend の後に keydown が来るので keyCode 229 も見る）
// 幅に関係なく 一覧 ⇄ 会話 の 2 画面。左上の ☰ で agent の一覧へ、行を押すと会話へ
function closeMore() {
  $("more").hidden = true;
  $("hd-more").setAttribute("aria-expanded", "false");
}
// R1: 一覧の頭の「…」→「スマホで操作」（会話の「…」と同じ: 別の窓にせず頭の下に 1 行出る）
function closeListMenu() {
  $("list-menu").hidden = true;
  $("list-more").setAttribute("aria-expanded", "false");
}
$("list-more").onclick = () => {
  const open = $("list-menu").hidden;
  $("list-menu").hidden = !open;
  $("list-more").setAttribute("aria-expanded", String(open));
};
$("open-remote").onclick = () => { closeListMenu(); nav.show("remote"); };
document.addEventListener("click", (e) => {
  const t = e.target;
  if ($("list-menu").hidden || (t && ($("list-menu").contains(t) || $("list-more").contains(t)))) return;
  closeListMenu();
});
$("hd-more").onclick = () => {
  const open = $("more").hidden;
  $("more").hidden = !open;
  $("hd-more").setAttribute("aria-expanded", String(open));
};
// W94: Esc は開いている「…」の popover、無ければ設定の画面を 1 つ閉じる（W113）。外側 click は「…」だけ。何も開いていなければ何もしない。IME 中は触らない。nav は直接触らない
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.isComposing || composing || e.keyCode === 229) return;
  if (!$("more").hidden) closeMore();
  else if (!$("list-menu").hidden) closeListMenu();
  else if (!$("settings").hidden || !$("remote").hidden) hidePanes(); // 設定・スマホで操作の画面も Esc で 1 つ戻る（hidePanes が #settings を隠して stack を settle する）
});
document.addEventListener("click", (e) => {
  const box = $("more"), btn = $("hd-more"), t = e.target;
  if (box.hidden || (t && (t === box || t === btn || box.contains(t) || btn.contains(t)))) return;
  closeMore();
});
$("add-line").append(Object.assign(txt("button", "", "押す操作の一覧"), { type: "button", onclick: () => { // W108: 別頁へ行かず、panel の中の画面。○＜ の 1 押しで一覧
  closeMore();
  $("press").dataset.root = rootId == null ? "" : String(rootId);
  nav.stack = ["list"];
  nav.show("press");
} }));
// W90（CEO 10-14「常に左上にまるで囲まれた＜で前にいたpageに戻れるように。ダブルクリックで一覧に」）: 画面は 1 本の stack（根 = 一覧）。
// 画面 = list（一覧）/ chat（会話）/ press（押す操作）/ thread（読むだけの会話）/ accounts・plugins・phone（一覧の中の頁）/ settings（歯車）。○＜（kg-back）の 1 押し = 1 つ前・2 度押し = 根。
// 既存の closeList / openPane / hidePanes / 歯車 がそれぞれ stack に書くので、呼ぶ側は今までどおり
const nav = {
  stack: ["list"],
  top() { return this.stack[this.stack.length - 1]; },
  push(s) { if (this.top() !== s) this.stack.push(s); this.paint(); },
  settle() { while (this.stack.length > 1 && this.top() !== "chat") this.stack.pop(); this.paint(); }, // 一覧の中の頁を閉じた → 一覧へ戻った事にする（chat の上の履歴は残す）
  root() { this.stack = ["list"]; this.show("list"); },
  back() {
    if (this.stack.length <= 1) { if (!$("app").classList.contains("list-open")) this.show("list"); else this.paint(); return; } // 根より手前は無い。会話から始まった時だけ一覧へ
    this.stack.pop();
    this.show(this.top());
  },
  show(s) {
    const onThread = s === "thread";
    $("thread").hidden = !onThread;
    $("chat").hidden = onThread;
    if (onThread) { $("app").classList.remove("list-open"); this.paint(); return; }
    if (s === "chat") { closeList(); return; }
    $("app").classList.add("list-open");
    if (s === "list") hidePanes();
    else openPane(s);
    this.paint();
  },
  paint() { const d = String(Math.max(0, this.stack.length - 1)); $("list-back").setAttribute("depth", d); $("press-back").setAttribute("depth", d); $("settings-back").setAttribute("depth", d); $("remote-back").setAttribute("depth", d); $("hd-list").setAttribute("depth", this.stack.length > 1 || !$("app").classList.contains("list-open") ? "1" : "0"); $("thread-back").setAttribute("depth", d); },
};
function closeList() {
  closeMore();
  $("app").classList.remove("list-open");
  if (nav.top() !== "chat") nav.stack.push("chat");
  nav.paint();
}
let threadRoom = null; // いま開いている thread の部屋（room の broadcast で読み直す相手）
async function loadThread(roomId, first) {
  const res = await call("roomLog", { roomId });
  if (nav.top() !== "thread" || threadRoom !== roomId) return;
  if (!res || res.ok !== true) { if (first) { toast("まだ使えません"); nav.back(); } return; } // 読み直しの失敗は今の画面を残す
  $("thread-log").data = { room: res.room ?? { members: [] }, rows: Array.isArray(res.rows) ? res.rows : [] };
}
async function openThread(roomId) {
  if (!roomId) return;
  threadRoom = roomId;
  nav.push("thread");
  nav.show("thread");
  await loadThread(roomId, true);
}
for (const id of ["hd-list", "list-back", "press-back", "settings-back", "thread-back"]) $(id).addEventListener("kg-back", (e) => (e.detail.to === "root" ? nav.root() : nav.back()));
$("remote-back").addEventListener("kg-back", (e) => (e.detail.to === "root" ? nav.root() : nav.back())); // R1
$("rows").addEventListener("kg-open-thread", (e) => openThread(e.detail && e.detail.roomId));
$("send-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (composing || e.isComposing || e.keyCode === 229)) e.preventDefault();
});
$("send-text").addEventListener("input", syncSend);
$("send-form").onsubmit = (e) => {
  e.preventDefault();
  if (composing || e.isComposing) return;
  const stopId = $("send-btn").dataset.stop;
  if (stopId && !$("send-text").value.trim()) { stopOne(stopId); return; }
  const i = $("send-text");
  if (naming) {
    (naming === "rename" ? renameShown : createSession)(i.value);
    return;
  }
  if (busy) return;
  const text = i.value.trim();
  if ((!text && !pendAtts.length) || rootId == null) return;
  const id = rootId, typed = i.value, withAtt = pendAtts.length;
  i.value = "";
  drafts.delete(id);
  pendAtts = [];
  sending = true; // 同じイベントの中で空欄・disabled・aria-busy（paintChips が syncSend を呼ぶ）
  paintChips();
  once(async () => {
    try {
      const r = await sendChat(id, text || (withAtt ? "📎 添付" : ""));
      if (!r.ok) { // 失敗: 打った文を欄に戻す（同じ会話で欄が空のまま。書き直し済み・別の会話なら draft へ）。消さない
        if (rootId === id && !i.value) i.value = typed;
        else drafts.set(id, drafts.get(id) || typed);
        showErr(i, r.hint);
      }
    } finally {
      sending = false;
      syncSend();
    }
  });
};
$("clear-ui").onclick = async () => {
  if (clearing) return;
  clearing = true;
  try {
    const r = await call("clearUi");
    if (r.ok) applyUi(r.ui);
  } finally {
    clearing = false;
  }
};
$("add-tab").onclick = () => once(() => addCurrentTab());
$("open-tab").hidden = tabSession != null;
$("open-tab").onclick = () => {
  if (rootId != null) chrome.tabs.create({ url: chrome.runtime.getURL(`panel.html?session=${rootId}`) });
};
const putOnDesk = (extra) =>
  once(async () => {
    const note = $("desktop-note");
    const res = await call("desktopPlace", extra);
    note.textContent = !res.ok ? res.hint || "置けませんでした" : res.already ? "もうデスクトップにある" : `デスクトップに置いた: ${res.name}`;
    note.hidden = false;
  });
const needSession = () => {
  $("desktop-note").textContent = "会話を選んでください";
  $("desktop-note").hidden = false;
};
$("to-desktop").onclick = () => (rootId == null ? needSession() : putOnDesk({ kind: "session", rootId }));
$("term-to-desktop").onclick = () => (rootId == null ? needSession() : putOnDesk({ kind: "terminal", rootId }));
$("tab-to-desktop").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, ...winQuery() });
  if (!tab || !isWeb(tab)) return;
  putOnDesk({ kind: "tab", url: tab.url || tab.pendingUrl || "", title: tab.title ?? "", icon: tab.favIconUrl || undefined });
};
chrome.tabs.onActivated.addListener((info) => {
  if (winId == null || info.windowId === winId) redraw();
});
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (!(info.url || info.status || info.pendingUrl)) return;
  if (winId == null || tab.windowId === winId) redraw();
});
bindIme($("empty-text"));
bindIme($("send-text"));

// W112: 入力欄（DESIGN.md §6 入力欄と送る）。textarea は中身に合わせて伸びる（48〜144px は css の min / max・超えたら中で scroll）・Enter で送る・Shift+Enter は改行。
// 変換中の Enter は上の keydown が止める。値を書き換える側（送った後の空・書きかけの戻し・失敗で戻す）が多いので、value の書き込みで高さを合わせる
{
  const box = $("send-text");
  const form = $("send-form");
  const fit = () => {
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  };
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  Object.defineProperty(box, "value", { get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); fit(); } });
  box.addEventListener("input", fit);
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || composing || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    form.requestSubmit();
  });
  // toast は欄の上 --toast-gap（css）。欄の上端の高さ（窓の下から）を渡す。欄の無い画面（一覧）は 0px に戻す＝下 --toast-bottom
  const lift = () => {
    const r = form.getBoundingClientRect();
    document.documentElement.style.setProperty("--composer-top", r.height ? `${window.innerHeight - r.top}px` : "0px");
  };
  const follow = () => { fit(); lift(); };
  if (typeof ResizeObserver === "function") new ResizeObserver(follow).observe(form);
  window.addEventListener("resize", follow);
}

// 本体につながらない間: 欄は使えず、つながるまで 5 秒おきに自動で試す（アプリを開き直すとつながる）
function showDown() {
  showEmpty();
  $("empty-msg").textContent = "本体につながりません。アプリを開き直すと、数秒で自動でつながります";
  $("down").hidden = false;
  const i = $("empty-text");
  i.disabled = true;
  i.placeholder = "失敗";
  i.title = "失敗";
  clearTimeout(downTimer);
  downTimer = setTimeout(start, 5000);
}

async function start() {
  if (starting) return;
  starting = true;
  clearTimeout(downTimer);
  try {
    if (winId == null) {
      try {
        winId = (await chrome.windows.getCurrent()).id ?? null;
      } catch {}
      if (winId == null) {
        try {
          winId = (await chrome.windows.getLastFocused()).id ?? null;
        } catch {}
      }
    }
    const dead = setTimeout(showDown, 60_000);
    const res = await call("status");
    clearTimeout(dead);
    if (!res.ok) {
      showDown();
      return;
    }
    $("down").hidden = true;
    const listed = await call("roots");
    roots = listed.ok ? listed.roots ?? [] : [];
    const ui = await call("ui");
    if (ui.ok) applyUi(ui.ui);
    loadLeases(); // 誰が何の面を持っているか（一覧の行に出す）
    if (!roots.length) {
      showEmpty();
      $("empty-msg").textContent = EMPTY_MSG;
      const i = $("empty-text");
      i.disabled = false;
      i.title = "";
      i.placeholder = EMPTY_HINT;
      i.focus();
      return;
    }
    if (window.__kangaeList === "turn") listFilter = "turn";
    if (listFilter === "turn") { // W98: 会話を開いて既読にせず、一覧だけ出す
      showApp();
      const rr = await call("runs", { nodeIds: roots.map((x) => x.id) });
      if (rr.ok) runs = rr.runs ?? [];
      nav.root();
      await renderRoots();
      arm();
      return;
    }
    const saved = roots.some((r) => r.id === tabSession) ? tabSession : loadSavedRoot();
    rootId = roots.some((r) => r.id === saved) ? saved : roots[0].id;
    saveRoot();
    renderField();
    showApp();
    // W74: 開いたら会話が前面（一覧は ☰ で開く）
    const chat = await call("chat", { rootId });
    rows = chat.ok ? chat.rows ?? [] : [];
    nexts = chat.ok ? chat.next ?? [] : [];
    markSeen();
    const rr = await call("runs", { nodeIds: roots.map((x) => x.id) });
    if (rr.ok) runs = rr.runs ?? [];
    await renderRoots();
    renderClearUi();
    renderChat("open");
    arm();
    $("send-text").focus();
  } finally {
    starting = false;
  }
}

function listChrome(show) {
  $("list-hd").hidden = !show;
  $("session-tools").hidden = !show;
}
function hidePanes() {
  $("agent-set").hidden = true;
  $("press").hidden = true;
  $("remote").hidden = true;
  globalThis.unmountRemote?.(); // R1: 画面を離れたら、使われていない QR は無効
  listChrome(true);
  $("roots").hidden = false;
  $("settings").hidden = true;
  nav.settle(); // W90: 一覧の中の頁を閉じた＝一覧に居る
}
function openPane(name) {
  $("agent-set").hidden = name !== "agent";
  $("press").hidden = name !== "press";
  $("settings").hidden = name !== "settings";
  $("remote").hidden = name !== "remote";
  if (name !== "remote") globalThis.unmountRemote?.();
  listChrome(name !== "press" && name !== "settings"); // 押す操作・設定は自分の ○＜ を持つ。一覧の頭は重ねない
  if (name === "remote") listChrome(false); // R1: スマホで操作も自分の ○＜ を持つ
  $("roots").hidden = true;
  nav.push(name); // W90: 一覧の中の頁 = stack の 1 段（○＜ で一覧へ）
  if (name === "agent") paintAgentSet();
  if (name === "press") globalThis.mountPress($("press")); // 開くたびに一覧を読み直す
  if (name === "remote") globalThis.mountRemote($("remote")); // R1: 開く = QR を出す
  if (name === "settings") { $("user-pop").closeAll(); void loadViewer(); void loadCursor(); void loadNamedOnly(); void loadAppShotOff(); void loadOpenAllow(); void loadRemembered(); void loadOpDrafts(); } // 開くたびに今の値を読み直す
}
// W92: agent の設定（一覧の行の icon / 会話 header の icon を押す）。口は既存の rename / agentName / instruct / remove だけ
let agentSetId = null;
function openAgentSet(id) { agentSetId = id; openPane("agent"); }
function paintAgentSet() {
  const r = roots.find((x) => x.id === agentSetId);
  if (!r) { nav.back(); return; }
  $("agent-settings").data = { key: r.id, glyph: avatarGlyph(r), name: r.agent?.name ?? rootLabel(r), prov: providers[String(r.id)] };
}
const agentSet = $("agent-settings");
agentSet.addEventListener("kg-agent-name", async (e) => {
  const id = agentSetId, r = roots.find((x) => x.id === id);
  if (!r) return;
  const x = r.agent ? await call("agentName", { rootId: id, name: e.detail.name }) : await call("rename", { rootId: id, text: e.detail.name });
  if (!x.ok) { toast(x.hint ?? "名前を変えられませんでした", { tone: "warn" }); return; }
  await reloadRoots();
  paintAgentSet();
  toast("名前を変えました");
});
agentSet.addEventListener("kg-agent-rule", async (e) => {
  const id = agentSetId, run = runs.filter((x) => x.nodeId === id).at(-1);
  const x = run ? await call("instruct", { runId: run.id, text: e.detail.text }) : await call("workspace", { nodeId: id, agent: true, text: e.detail.text });
  toast(x.ok ? "伝えました" : x.hint ?? "伝えられませんでした", { tone: x.ok ? "ok" : "warn" });
});
agentSet.addEventListener("kg-agent-remove", async () => {
  const id = agentSetId;
  for (const l of leaseRows.filter((x) => x.owner === `s:${id}`)) await call("leaseTakeback", { key: l.key }); // 持っている面は先に人へ戻す
  for (const run of runs.filter((x) => x.nodeId === id && x.status === "running")) await call("stopRun", { runId: run.id });
  const x = await call("remove", { nodeId: id });
  if (!x.ok) { toast(x.hint ?? "消せませんでした", { tone: "warn" }); return; }
  agentSetId = null;
  await reloadRoots();
  if (rootId === id) { rootId = roots[0]?.id ?? null; saveRoot(); await renderRoots(); } // 見ていた会話を消したら残りの先頭へ（stale な id を持たない）
  nav.root();
  toast("消しました");
});
$("hd-av").addEventListener("click", () => { if (rootId != null && naming === false) openAgentSet(rootId); });
$("roots").addEventListener("kg-open-settings", (e) => { const li = e.target.closest?.("li"); if (li) openAgentSet(Number(li.dataset.id)); });
// W75a: 「＋」/ drop で選んだ file の中身を 512KB ずつ常駐へ送る（会話の att/ に 0600・agent は Read だけ）。載った物は chip になる。断られたら理由を欄の下に出す
const ATT_CHUNK = 512 * 1024;
const b64Of = (buf) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
async function uploadFile(f) {
  const upId = crypto.randomUUID();
  const n = Math.max(1, Math.ceil(f.size / ATT_CHUNK));
  for (let i = 0; i < n; i++) {
    const b64 = b64Of(await f.slice(i * ATT_CHUNK, (i + 1) * ATT_CHUNK).arrayBuffer());
    const r = await call("attachChunk", { rootId, upId, seq: i, last: i === n - 1, name: f.name, b64 });
    if (!r.ok) return r;
    if (r.done) return r;
  }
  return { ok: false, hint: "添付が終わりませんでした" };
}
// W75b: 載せた物は欄の文字でなく chip（画像は縮小・file は名前と大きさ・×で消す）。送ると吹き出しに載る。agent→人の添付（W75c）も同じ部品で吹き出しに出す
const VIEW_TEXT_MAX = 1024 * 1024; // viewer に流す text の上限（kg.js と同じ・attachRead の 1MB の壁の中）
let pendAtts = [];
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const thumbs = new Map();
async function attThumb(id, w) {
  const k = `${rootId}:${id}:${w}`;
  if (!thumbs.has(k)) thumbs.set(k, call("attachThumb", { rootId, attId: id, w }).then((r) => (r.ok ? `data:image/jpeg;base64,${r.jpeg}` : null)));
  return thumbs.get(k);
}
// 添付 1 つの見た目。image / file / link。文字は textContent だけ（名前・題は他人が決める）。link は押すと人の Chrome の新しい tab（人の操作）
function attEl(a, { onRemove } = {}) {
  let box;
  if (a.kind === "link") {
    box = document.createElement("a");
    box.className = "att-link";
    box.href = a.url; box.target = "_blank"; box.rel = "noopener noreferrer";
    // 人が押した時だけ人の Chrome の新しい tab（noopener）。拡張の外（Bar の窓）では常駐が既定の browser で開く。http(s) だけ
    box.onclick = (e) => {
      if (!/^https?:\/\//.test(a.url)) { e.preventDefault(); return; }
      e.preventDefault();
      if (globalThis.chrome?.tabs?.create) chrome.tabs.create({ url: a.url, active: true });
      else call("openLink", { url: a.url });
    };
    box.append(txt("span", "att-origin", a.origin), txt("span", "att-name", a.title || ""));
  } else {
    // W91: 種類を問わず kg-chip。押すと見る（image / text = 吹き出しの中の viewer・pdf / video = 人の既定の app・それ以外 = 保存）。modal は作らない
    const chip = document.createElement("kg-chip");
    const view = a.view ?? (a.kind === "image" ? "image" : "file"), rid = rootId;
    chip.setAttribute("view", view); chip.setAttribute("name", a.name); chip.setAttribute("meta", fmtSize(a.size));
    if (onRemove) chip.setAttribute("removable", ""); else chip.setAttribute("saveable", "");
    if (view === "image") attThumb(a.id, 240).then((u) => { if (u && rootId === rid) chip.setThumb(u); });
    chip.addEventListener("kg-open", async () => {
      const shown = chip.parentElement?.querySelector("kg-view");
      if (shown) { shown.remove(); return; } // もう一度押すと閉じる
      const host = chip.parentElement; if (!host) return;
      if (view === "image") { const u = await attThumb(a.id, 720); if (u && rootId === rid) { const v = document.createElement("kg-view"); host.append(v); v.show({ kind: "image", src: u, name: a.name }); } else toast("絵を出せませんでした。保存してください", { tone: "warn" }); }
      else if (view === "text") {
        const parts = []; let cut = false;
        for (let seq = 0; ; seq++) {
          const r = await call("attachRead", { rootId: rid, attId: a.id, seq });
          if (!r.ok) { toast(r.hint ?? "読めませんでした", { tone: "warn" }); return; }
          parts.push(Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0)));
          if (r.last) break;
          if (seq * ATT_CHUNK + ATT_CHUNK >= VIEW_TEXT_MAX) { cut = true; break; }
        }
        if (rootId !== rid) return;
        const v = document.createElement("kg-view"); host.append(v);
        v.show({ kind: "text", name: a.name, text: new TextDecoder("utf-8").decode(await new Blob(parts).arrayBuffer()), cut });
      } else if (view === "pdf" || view === "video") { const r = await call("attachOpen", { rootId: rid, attId: a.id }); toast(r.ok ? "既定のアプリで開きました" : r.hint ?? "開けませんでした", { tone: r.ok ? "ok" : "warn" }); }
      else saveAtt(a, chip);
    });
    chip.addEventListener("kg-save", () => saveAtt(a, chip));
    if (onRemove) chip.addEventListener("kg-remove", onRemove);
    const item = document.createElement("span"); // chip と、開いた viewer を同じ行に（viewer は 1 行を使う）
    item.className = "att-item";
    item.append(chip);
    return item;
  }
  return box;
}
// W75d: 受け取った file / 画像を人の Downloads へ（512KB ずつ読んで Blob にし、download 属性で保存）。送り主が決めた名前は拡張子を種類から付け直す
async function saveAtt(a, btn) {
  const rid = rootId, parts = [];
  let ext = "bin";
  btn.disabled = true; // chip（kg-chip）でも button でも
  try {
    for (let seq = 0; ; seq++) {
      const r = await call("attachRead", { rootId: rid, attId: a.id, seq });
      if (!r.ok) { showErr($("send-text"), r.hint ?? "保存できませんでした"); return; }
      parts.push(Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0)));
      ext = r.ext;
      if (r.last) break;
    }
    const url = URL.createObjectURL(new Blob(parts));
    const x = document.createElement("a");
    x.href = url; x.download = `${a.name || "file"}.${ext}`;
    document.body.append(x); x.click(); x.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } finally { btn.disabled = false; }
}
function paintChips() {
  const box = $("att-chips");
  box.replaceChildren(...pendAtts.map((a) => attEl(a, { onRemove: async () => { const r = await call("attachRemove", { rootId, attId: a.id }); if (r.ok) { pendAtts = pendAtts.filter((x) => x.id !== a.id); paintChips(); } else showErr($("send-text"), r.hint); } })));
  box.hidden = !pendAtts.length;
  syncSend();
}
async function loadPend() {
  if (rootId == null) { pendAtts = []; paintChips(); return; }
  const rid = rootId, r = await call("attachList", { rootId });
  if (rid !== rootId) return;
  pendAtts = r.ok ? r.items ?? [] : [];
  paintChips();
}
async function addFiles(files) {
  const list = [...files].filter((f) => f && f.name);
  if (!list.length) return;
  if (rootId == null) { showErr($("send-text"), "会話を開いてから載せてください"); return; }
  const rid = rootId;
  for (const f of list) {
    const r = await uploadFile(f);
    if (r.ok && r.att && rid === rootId) { pendAtts.push(r.att); paintChips(); }
    else if (!r.ok) showErr($("send-text"), `${f.name}: ${r.hint ?? "載せられませんでした"}`);
  }
}
$("user-btn").onclick = () => nav.show("settings"); // W113: popover でなく独立した全面の画面。stack の 1 段（openPane が push・○＜ の 1 押しで一覧）
// W38: 「見る」で開く app。候補は常駐が /Applications を読むだけで作る（app は起こさない）・人だけが選ぶ・既定 Finder。常駐が古くて op を知らない間は Finder だけ
async function loadViewer() {
  const sel = $("viewer-app");
  const r = await call("editors");
  const list = r.ok && Array.isArray(r.editors) && r.editors.length ? r.editors : ["Finder"];
  const cur = r.ok && list.includes(r.current) ? r.current : "Finder";
  sel.replaceChildren(...list.map((n) => { const o = document.createElement("option"); o.value = n; o.textContent = n; o.selected = n === cur; return o; }));
  sel.disabled = !r.ok;
}
$("viewer-app").onchange = async () => { const x = await call("viewer", { app: $("viewer-app").value }); if (!x.ok) await loadViewer(); }; // once() を通さない（busy の間に選ぶと保存されず表示だけ変わる）
// W39c: agent のカーソルを見せる（既定 off・人だけが切り替える）
// W78p: 覚えた許し（host / app の名前と口の種類だけ・値は出さない）。［戻す］はその 1 件だけ聞くに戻す
function paintRemembered(items) {
  $("remembered-empty").hidden = items.length > 0;
  $("remembered-list").replaceChildren(...items.map((it) => {
    const li = document.createElement("li");
    const t = document.createElement("span"); t.textContent = plain(it.label, 80);
    const b = document.createElement("button"); b.type = "button"; b.textContent = "戻す";
    b.onclick = async () => { b.disabled = true; const x = await call("forget", { id: it.id }); if (x.ok) { paintRemembered(x.items ?? []); void loadOpenAllow(); } else { b.disabled = false; toast(x.hint ?? "戻せませんでした", { tone: "warn" }); } };
    li.append(t, b);
    return li;
  }));
}
async function loadRemembered() { const r = await call("remembered"); if (r.ok) paintRemembered(r.items ?? []); }
// W124（DESIGN.md §6 設定・ボタン4種）: agent が残した操作の下書き。案が在る行だけ［案を使って操作にする］（primary・script の中身は出さない）・［捨てる］は 2 段（4 秒で戻る・modal 無し）。
// 常駐が古くて draftList を知らない間（ok でない）は小見出しごと出さない（readOp の失敗 card は使わない）
function paintOpDraft(d) {
  const row = mk("div", "draft"), acts = mk("div", "draft-acts");
  row.dataset.id = String(d.id);
  row.append(txt("div", "draft-op", plain(d.op, 80)), txt("div", "why", plain(d.why, 160)));
  if (d.suggestion) {
    row.append(txt("div", "why", `案: ${plain(d.suggestion.what, 120)}（${d.suggestion.permission === "read" ? "読むだけ" : "書く"}）`));
    const use = txt("button", "btn primary", "案を使って操作にする");
    use.type = "button";
    use.addEventListener("click", async () => {
      use.disabled = true; // 押した瞬間に止める（二重送信なし）
      const x = await call("draftPromote", { draftId: d.id, useSuggestion: true });
      if (x.ok) { toast("操作にしました", { tone: "ok" }); void loadOpDrafts(); } else { use.disabled = false; toast(x.hint ?? "操作にできませんでした", { tone: "warn" }); }
    });
    acts.append(use);
  }
  const drop = txt("button", "btn quiet", "捨てる");
  drop.type = "button";
  let armed = null;
  const disarm = () => { armed = null; drop.className = "btn quiet"; drop.textContent = "捨てる"; };
  drop.addEventListener("click", async () => {
    if (armed == null) { armed = setTimeout(disarm, 4000); drop.className = "btn danger"; drop.textContent = "本当に捨てる"; return; }
    clearTimeout(armed); armed = null;
    drop.disabled = true;
    const x = await call("draftDrop", { draftId: d.id });
    if (x.ok) void loadOpDrafts(); else { drop.disabled = false; disarm(); toast(x.hint ?? "捨てられませんでした", { tone: "warn" }); }
  });
  acts.append(drop);
  row.append(acts);
  return row;
}
async function loadOpDrafts() {
  const r = await call("draftList");
  const list = r.ok && Array.isArray(r.drafts) ? r.drafts : [];
  $("op-drafts").hidden = !list.length;
  $("op-drafts").replaceChildren(...(list.length ? [txt("h3", "draft-h", "下書き"), ...list.map(paintOpDraft)] : []));
  paintLearnedEmpty();
}
async function loadOpenAllow() { const r = await call("openMode"); $("open-allow").on = !!(r.ok && r.on); $("open-allow").disabled = !r.ok; }
$("open-allow").addEventListener("kg-toggle", async (e) => { const x = await call("openMode", { on: e.detail.on }); if (!x.ok) await loadOpenAllow(); });
async function loadNamedOnly() { const r = await call("namedOnly"); $("named-only").on = !!(r.ok && r.on); $("named-only").disabled = !r.ok; }
$("named-only").addEventListener("kg-toggle", async (e) => { const x = await call("namedOnly", { on: e.detail.on }); if (!x.ok) await loadNamedOnly(); });
async function loadAppShotOff() { const r = await call("appShotOff"); $("app-shot-off").on = !!(r.ok && r.on); $("app-shot-off").disabled = !r.ok; } // W125: 既定 off・人だけ。古い常駐（ok:false）は触れない
$("app-shot-off").addEventListener("kg-toggle", async (e) => { const x = await call("appShotOff", { on: e.detail.on }); if (!x.ok) { await loadAppShotOff(); toast(x.hint ?? "切り替えられませんでした", { tone: "warn" }); } });
async function loadCursor() { const r = await call("cursorOverlay"); $("cursor-overlay").on = !!(r.ok && r.on); $("cursor-overlay").disabled = !r.ok; }
$("cursor-overlay").addEventListener("kg-toggle", async (e) => { const x = await call("cursorOverlay", { on: e.detail.on }); if (!x.ok) await loadCursor(); });
$("find-text").addEventListener("input", () => { findQ = $("find-text").value; paintList(); });
$("attach").onclick = () => $("attach-file").click();
$("attach-file").onchange = () => { addFiles($("attach-file").files || []); $("attach-file").value = ""; };
// W95: 落とした URL。http(s) だけ返す。javascript: / file: / data: や空は ""（呼び出し側は何も呼ばない）
function droppedHttpUrl(raw) {
  const line = String(raw ?? "").split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#")) ?? "";
  if (!/^https?:\/\//i.test(line)) return "";
  let u = null;
  try { u = new URL(line); } catch { u = null; }
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return "";
  return u.href;
}
// file が在れば file（添付が優先）。ただし 1 つだけの .app は app（名前は drop の時にだけ読める＝dragover の間は file）。text/uri-list だけなら url
function dropKind(dt) {
  const names = [...(dt?.files || [])].map((f) => f.name);
  const file = [...(dt?.items || [])].some((x) => x.kind === "file") || names.length > 0;
  if (file) return names.length === 1 && /\.app$/i.test(names[0]) ? "app" : "file";
  if ([...(dt?.types || [])].includes("text/uri-list")) return "url";
  return "";
}
function assigneeName(id = rootId) {
  const r = roots.find((x) => x.id === id);
  if (r) return rootLabel(r);
  const n = id === rootId ? $("hd-name").textContent.trim() : "";
  return n || "担当";
}
// H1: 同じ URL の tab が 2 つ以上ある時だけ、渡す前に 1 回「どの tab か」を聞く（kg-approve の choice・題を並べる）。やめる / 次の drop は null
let pickEnd = null;
function pickTab(tabs, who) {
  pickEnd?.(null);
  return new Promise((resolve) => {
    const box = $("drop-pick");
    const byOpt = new Map(tabs.map((t, i) => [`${i + 1}. ${plain(t.title || "（題なし）", 60)}`, t]));
    const done = (t) => { pickEnd = null; box.hidden = true; box.replaceChildren(); resolve(t); };
    pickEnd = done;
    const k = document.createElement("kg-approve");
    k.setAttribute("kind", "choice");
    k.setAttribute("data-options", [...byOpt.keys()].join("\n"));
    k.addEventListener("kg-answer", (e) => done(byOpt.get(e.detail.choice) ?? null));
    const no = txt("button", "btn quiet", "やめる");
    no.type = "button";
    no.onclick = () => done(null);
    box.replaceChildren(txt("div", "t", `どの tab を ${who} に渡しますか`), k, no);
    box.hidden = false;
  });
}
const gaveToast = (r, who) => toast(r.ok ? `${who} に渡しました` : String(r.hint || "渡せませんでした").slice(0, 200), r.ok ? undefined : { tone: "warn" });
// 同じ URL の tab を探して渡す（id = 渡す先の担当。会話の drop と一覧の行の drop が共用する 1 本）。無ければ裏で開いてから渡す。拡張の外（Bar）は常駐が拡張に聞く
async function giveDroppedUrl(url, id = rootId) {
  if (id == null) { toast("会話を開いてから落としてください"); return; }
  const who = assigneeName(id);
  try {
    let found = [], tab = null;
    if (globalThis.chrome?.tabs) {
      const q = url.split("#")[0];
      found = (await chrome.tabs.query({})).filter((t) => t && t.id != null && String(t.url ?? "").split("#")[0] === q);
      if (!found.length) tab = await chrome.tabs.create({ url, active: false, ...(winId != null ? { windowId: winId } : {}) });
    } else {
      const r = await call("urlTabs", { url });
      if (!r.ok) { toast(String(r.hint || "Chrome の Kangae を開いてください").slice(0, 200), { tone: "warn" }); return; }
      found = r.tabs;
    }
    tab = tab ?? (found.length > 1 ? await pickTab(found, who) : found[0]);
    if (!tab) return;
    if (tab.id == null) { toast("渡せませんでした", { tone: "warn" }); return; }
    gaveToast(await call("leaseGive", { rootId: id, tabId: tab.id, title: tab.title }), who);
  } catch {
    toast("渡せませんでした", { tone: "warn" });
  }
}
// H1: Finder の .app（名前だけ届く）。常駐が card 無しで裏で起こして、その窓を渡す
async function giveDroppedApp(file, id = rootId) {
  if (id == null) { toast("会話を開いてから落としてください"); return; }
  const name = file.name.replace(/\.app$/i, "");
  toast(`${name} を起こしています`);
  gaveToast(await call("dropApp", { rootId: id, name }), assigneeName(id));
}
// 会話の画面全体（今の担当）と一覧の agent の行（その担当）の drop は、この 3 本を共用する。dragover の間は .app かどうか読めないので、行の帯は file でも「渡します」
function dropOver(e, id, inChat) {
  const kind = dropKind(e.dataTransfer);
  if (!kind) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = kind === "file" ? "copy" : "link";
  const box = e.currentTarget;
  box.classList.add("dropping");
  let band = box.querySelector(":scope > .drop-band");
  if (!band) { band = document.createElement("div"); band.className = "drop-band"; box.append(band); }
  band.textContent = inChat && kind === "file" ? `添付します（.app は ${assigneeName(id)} に渡します）` : `ここに落とすと ${assigneeName(id)} に渡します`;
}
function dropLeave(e) {
  if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
  e.currentTarget.classList.remove("dropping");
  e.currentTarget.querySelector(":scope > .drop-band")?.remove();
}
function dropDo(e, id, inChat) {
  const dt = e.dataTransfer;
  const kind = dropKind(dt);
  e.currentTarget.classList.remove("dropping");
  e.currentTarget.querySelector(":scope > .drop-band")?.remove();
  if (!kind) return; // 人の操作だけ: agent は panel の DOM に触れず、常駐の urlTabs / dropApp は HUMAN_OPS（agent の口は断られる）
  e.preventDefault();
  if (kind === "file") { if (inChat) addFiles(dt.files || []); else toast("file は会話の画面に落としてください（一覧の行に渡せるのは tab と app です）"); return; }
  if (kind === "app") { void giveDroppedApp(dt.files[0], id); return; }
  const url = droppedHttpUrl(dt.getData("text/uri-list"));
  if (!url) return;
  void giveDroppedUrl(url, id);
}
$("chat").addEventListener("dragover", (e) => dropOver(e, rootId, true));
$("chat").addEventListener("dragleave", dropLeave);
$("chat").addEventListener("drop", (e) => dropDo(e, rootId, true));

// W90（CEO 10-14「文を選択すると自動で copy され下の方に小さく copy! と出るように」）: 選んだ文を clipboard に入れて toast「copy!」。
// 入力欄（input / textarea）の中の選択は人が編集中なので触らない。同じ文を続けて選んでも 2 度入れない。execCommand は人の操作（mouseup / keyup）の中だから通る（W74d の編集 menu の ⌘C とは独立・両方効く）
let copied = "";
function copySel() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return;
  const text = String(window.getSelection() || "").trim();
  if (!text || text === copied) return;
  let ok = false;
  try { ok = !!document.execCommand("copy"); } catch {}
  if (ok) { copied = text; toast("copy!", { ms: 1100 }); return; }
  navigator.clipboard?.writeText(text).then(() => { copied = text; toast("copy!", { ms: 1100 }); }, () => {});
}
document.addEventListener("mouseup", () => setTimeout(copySel, 0));
document.addEventListener("keyup", (e) => { if (e.key === "Shift" || e.shiftKey) setTimeout(copySel, 0); });
document.addEventListener("selectionchange", () => { if (!String(window.getSelection() || "").trim()) copied = ""; });

function paintTurnLine(n) {
  let line = $("turn-line");
  if (listFilter !== "turn") { if (line) line.hidden = true; return; }
  if (!line) {
    line = document.createElement("button");
    line.type = "button";
    line.id = "turn-line";
    line.onclick = () => { listFilter = ""; window.__kangaeList = ""; paintList(); };
    $("roots").before(line);
  }
  line.hidden = false;
  line.textContent = `あなたの番です（${n}）・すべて見る`;
}
window.kangaeOpenList = (mode) => {
  listFilter = mode === "turn" ? "turn" : "";
  window.__kangaeList = listFilter === "turn" ? "turn" : "";
  if (listFilter === "turn" && !$("app").hidden) nav.root();
  paintList();
};
if (window.__kangaeList === "turn") listFilter = "turn";
// W104: menu「設定を開く」。一覧に戻してから、歯車と同じ開き方（W113: nav の画面）。未読込の印は起動が 1 回終わってから開く。
window.kangaeOpenSettings = () => {
  nav.root();
  $("user-btn").onclick();
};
if (window.__kangaeSettings) {
  const openSettings = window.kangaeOpenSettings;
  const kick = start;
  start = async (...args) => {
    const busy = starting;
    const r = await kick.apply(this, args);
    if (!busy && window.__kangaeSettings) {
      window.__kangaeSettings = 0;
      openSettings();
    }
    return r;
  };
}
$("retry").onclick = start;
start();
if (new URLSearchParams(location.search).has("remote")) { // 新しいタブの「…」→「スマホで操作」: 一覧が出てから、同じ画面を開く
  const t0 = Date.now(), t = setInterval(() => { if (!$("app").hidden || Date.now() - t0 > 20_000) { clearInterval(t); if (!$("app").hidden) $("open-remote").onclick(); } }, 200);
}
