import { pickDiscard, fromExtensionPage, humanTouch } from "./tabs.js";
import { keep, webRun } from "./web.js";

const HOST = "app.kangae_sora.host";
let native = null;
const ports = new Set();
const owner = new Map(); // 送った id → 返す先の port

function ensureNative() {
  if (native) return native;
  stopped = false;
  native = chrome.runtime.connectNative(HOST);
  native.postMessage({ op: "webHello", id: "w:hello" }); // 常駐へ「web の依頼を受けられる」と知らせる（繋がる前の依頼は常駐が待つ）
  native.onMessage.addListener((res) => {
    // web の面: 常駐からの腕の依頼は sw が自分で実行して返す。web の返事への ack（id が w: で始まる）は誰にも配らない
    if (res.type === "web") {
      webRun(res.tool, res.args).catch((e) => ({ error: true, text: `拡張の中で失敗しました: ${e?.message ?? e}` })).then((r) => native?.postMessage({ op: "webResult", id: `w:${res.id}`, callId: res.id, ...r }));
      return;
    }
    if (res.type === "stopped") { stopped = true; setAlarm(1); return; }
    if (res.id === "w:hello") { // 常駐が応えた。ok が偽 = 断られた（決まりの外の browser・別の profile…）: 拡張の icon に ! と理由 1 行を出す（繋がったら消す）
      backoff = 500; if (stopped) { stopped = false; setAlarm(0.5); }
      chrome.action.setBadgeText({ text: res.ok === false ? "!" : "" });
      chrome.action.setTitle({ title: res.ok === false ? `Kangae: ${res.hint ?? "本体に断られました"}。いつもの Google Chrome の、いつもの profile で読み込み直してください` : "Kangae" });
      return;
    }
    if (typeof res.id === "string" && res.id.startsWith("w:")) return;
    // id 無し type:ui / desktop / roots / history / room / pty は全 port へ（NTP と panel の両方に配る）
    if (!res.id && (res.type === "ui" || res.type === "desktop" || res.type === "roots" || res.type === "history" || res.type === "room" || res.type === "pty")) {
      for (const p of ports) p.postMessage(res);
      return;
    }
    const p = owner.get(res.id);
    owner.delete(res.id);
    (p ?? [...ports].at(-1))?.postMessage(res);
  });
  native.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? "";
    native = null;
    for (const p of ports) p.postMessage({ type: "disconnected", reason });
    retry();
  });
  return native;
}

// 常駐が落ちた・起こし直された後、人が何も触らなくても繋ぎ直す。速い道 = setTimeout の backoff（sw が起きている間・0.5 → 30 秒）、
// 眠っても起きる道 = chrome.alarms（30 秒周期・MV3 の最短）。繋がっている間は ensureNative が何もしない。
// backoff を戻すのは「常駐から最初の返事（webHello の ack）が来た時」だけ（connectNative は常駐に繋がらなくても同期では成功するので、成功で戻すと 6.5 秒ごとに永久に起こす）。
// relay が「人が全部終わるで止めた」と知らせた（type:"stopped"）時は黙る: タイマーを張らず、alarm も 1 分に落とす。panel / 新しいタブが開けば onConnect が即繋ぎ直す
let backoff = 500;
let stopped = false;
function retry() {
  if (stopped) return;
  setTimeout(() => { try { ensureNative(); } catch { retry(); } }, backoff);
  backoff = Math.min(backoff * 2, 30000);
}
const setAlarm = (min) => chrome.alarms.create("reconnect", { periodInMinutes: min });
chrome.alarms.get("reconnect").then((a) => a || setAlarm(0.5));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "reconnect") try { ensureNative(); } catch {} });

// 端末の窓を開いた port が閉じたら（タブを閉じた・落ちた）、その窓の shell を止めさせる
let portSeq = 0;
chrome.runtime.onConnect.addListener((port) => {
  if (!fromExtensionPage(port.sender, chrome.runtime.id)) { port.disconnect(); return; } // 頁の script・別 frame・他の拡張からは常駐の口（操作権・端末）へ繋がせない
  ports.add(port);
  const from = ++portSeq;
  let ptyOpened = false;
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (ptyOpened) try { ensureNative().postMessage({ op: "ptyDrop", from }); } catch {}
  });
  port.onMessage.addListener((msg) => {
    if (msg.op === "ptyOpen") { msg.from = from; ptyOpened = true; }
    if (msg.id) owner.set(msg.id, port);
    try {
      ensureNative().postMessage(msg);
    } catch (e) {
      port.postMessage({ type: "disconnected", reason: String(e) });
    }
  });
  ensureNative();
});

// 常駐から web の腕の依頼が届くよう、panel が開いていなくても常駐へ繋いでおく
try { ensureNative(); } catch {}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// tab を開きすぎても重くならない: 生きている tab は 8 まで。超えたら古い物の中身を捨てる（tab は残る）
const LIVE_TABS = 8;
async function trim() {
  for (const id of pickDiscard(await chrome.tabs.query({}), LIVE_TABS, keep())) chrome.tabs.discard(id).catch(() => {}); // agent に渡した tab・agent が開いた tab は捨てない（捨てると文書が変わり面が切れる）
}
chrome.tabs.onActivated.addListener(trim);
chrome.tabs.onCreated.addListener(() => setTimeout(trim, 1000));
chrome.tabs.onUpdated.addListener((_id, info) => info.status === "complete" && trim());

// 起動直後は、拡張が読み込まれる前に最初の tab が開き、標準の新しいタブのまま残る。見つけたら自分の画面に替える
const STOCK_NTP = /^chrome:\/\/(newtab|new-tab-page)\/?$/;
// 自分の newtab.html も一瞬 chrome://newtab に見えるので、題名で見分ける。開き直すのは chrome://newtab
// （今度は自分の画面になり、focus も入力欄に来る）。1 つの tab に 1 回だけ
const claimed = new Set();
const claim = (t) => {
  if (claimed.has(t.id) || t.status !== "complete" || t.title === "Kangae" || !STOCK_NTP.test(t.url ?? "")) return;
  claimed.add(t.id);
  chrome.tabs.update(t.id, { url: "chrome://newtab/" }).catch(() => {});
};
const claimAll = () => chrome.tabs.query({}).then((ts) => ts.forEach(claim));
chrome.tabs.onUpdated.addListener((_id, info, t) => (info.url || info.status) && claim(t));

// 読み終わった http(s) が ·#数 の tab group に居れば、その session の履歴を常駐へ送る（返事は待たない）
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status !== "complete" || tab.groupId == null || tab.groupId < 0 || !/^https?:/.test(tab.url || "")) return;
  chrome.tabGroups.get(tab.groupId).then((g) => {
    const m = /·#(\d+)$/.exec(g?.title || "");
    if (!m) return;
    try { ensureNative().postMessage({ op: "visit", rootId: Number(m[1]), url: tab.url, title: tab.title || "" }); } catch {}
  }).catch(() => {});
});
chrome.runtime.onStartup.addListener(claimAll);
// 版が変わった直後の起動では sw が登録し直され、その間の「読み込み終わり」を取りこぼす事がある。起きてから数回見直す
for (const ms of [0, 3000, 10000]) setTimeout(claimAll, ms);

// 人が agent に渡した tab に触った（前面にした・窓を移した・中で入力した）事を常駐へ知らせる。どの tab かの判断は常駐の束縛表（stateless）
const touched = (tabId, input) => { try { ensureNative().postMessage({ op: "webEvent", id: `w:${crypto.randomUUID()}`, tabId, ...(input ? { input: true } : {}) }); } catch {} };
// W11d: 人の今（窓が前面の browser で選択中の tab・browser が前面でなければ null）を常駐へ。どの tab かだけ・頁の中身は読まない
const seenTab = async () => { try { const w = await chrome.windows.getLastFocused({ populate: true }); const t = w.focused ? w.tabs?.find((x) => x.active)?.id : null; ensureNative().postMessage({ op: "webSeen", id: `w:${crypto.randomUUID()}`, tab: t ?? null }); } catch {} };
chrome.tabs.onActivated.addListener((i) => { touched(i.tabId); seenTab(); });
chrome.windows.onFocusChanged.addListener(() => seenTab());
chrome.tabs.onAttached.addListener((id) => touched(id));
chrome.tabs.onDetached.addListener((id) => touched(id));
chrome.runtime.onMessage.addListener((m, sender) => { if (m?.op === "human" && humanTouch(sender)) touched(sender.tab.id, true); });

// 移動が起きた事（開始の時刻・種類）を常駐へ。agent が起こした移動か人が起こした移動かの判定は常駐の門がやる（操作の時刻と突き合わせる）
const navStart = new Map();
chrome.webNavigation.onBeforeNavigate.addListener((d) => { if (d.frameId === 0) navStart.set(d.tabId, Date.now()); });
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  const startedAt = navStart.get(d.tabId) ?? Date.now();
  navStart.delete(d.tabId);
  try { ensureNative().postMessage({ op: "webEvent", id: `w:${crypto.randomUUID()}`, tabId: d.tabId, nav: { startedAt, committedAt: Date.now(), type: d.transitionType, quals: d.transitionQualifiers ?? [] } }); } catch {}
});
