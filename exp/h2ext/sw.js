// H2 測定 probe（製品に入れない・**未実行**＝この session では Chrome を起こさなかった。手順は docs/verify/h2/RESULT.md §Chrome）。
// 測る事（BRIEF-h2 項目 1・2 と ChatGPT の追加 ②④）:
//   1. tab を引き出した時の tabId・元の windowId・元の index（onDetached の oldWindowId / oldPosition）と、引き出し中の新しい窓（windows.onCreated / onBoundsChanged の位置）
//   2. 落とし先で離した後 chrome.tabs.move で元の窓・元の index へ戻せるか（引き出し中は「Tabs cannot be edited right now (user may be dragging a tab)」で失敗する、と公式 docs にある＝何 ms 後から成功するか）
//   ② onDetached の時刻 t（epoch ms）を h2-probe（Swift）の down / up の t と突き合わせて、「マウスの drag」と「tab の引き出し」が同じ操作かを見る
//   ④ windows.onFocusChanged の時刻と windowId: Chrome 自身が focus を変える事があるか（Kangae が奪うのとは別物として記録する）
// 記録: 各 event を JSON 行で console.log し、chrome.storage.local の h2log（最新 500 件）にも積む。読む: chrome://extensions → h2-probe の「service worker」→ console で
//   (await chrome.storage.local.get('h2log')).h2log.map(JSON.stringify).join('\n')
// 戻す: 同じ console で  h2.giveBack()   （最後に引き出した tab を元の窓・元の index へ。成功するまで 50ms ごとに試し、失敗の文面と回数を記録）
// 自動で戻す（測定専用 profile でだけ）: await chrome.storage.local.set({ auto: true })  → onAttached / windows.onRemoved の後に giveBack を自動で起こす
const log = (o) => {
  const e = { t: Date.now(), ...o };
  console.log(JSON.stringify(e));
  chrome.storage.local.get('h2log').then(({ h2log = [] }) => chrome.storage.local.set({ h2log: [...h2log, e].slice(-500) }));
};
let last = null; // 最後に引き出された tab: { tabId, oldWindowId, oldPosition, at }

chrome.tabs.onDetached.addListener((tabId, d) => {
  last = { tabId, oldWindowId: d.oldWindowId, oldPosition: d.oldPosition, at: Date.now() };
  log({ ev: 'tabs.onDetached', tabId, oldWindowId: d.oldWindowId, oldPosition: d.oldPosition });
});
chrome.tabs.onAttached.addListener((tabId, a) => {
  log({ ev: 'tabs.onAttached', tabId, newWindowId: a.newWindowId, newPosition: a.newPosition });
  chrome.storage.local.get('auto').then(({ auto }) => auto && giveBack());
});
chrome.tabs.onMoved.addListener((tabId, m) => log({ ev: 'tabs.onMoved', tabId, windowId: m.windowId, from: m.fromIndex, to: m.toIndex }));
chrome.tabs.onActivated.addListener((a) => log({ ev: 'tabs.onActivated', tabId: a.tabId, windowId: a.windowId }));
chrome.windows.onCreated.addListener((w) => log({ ev: 'windows.onCreated', windowId: w.id, type: w.type, state: w.state, focused: w.focused, bounds: [w.left, w.top, w.width, w.height] }));
chrome.windows.onRemoved.addListener((id) => log({ ev: 'windows.onRemoved', windowId: id }));
// 引き出し中の窓の位置がマウスについてくるのを拡張が追えるか（bounds の更新が連続で来るか・終わりだけか）
chrome.windows.onBoundsChanged.addListener((w) => log({ ev: 'windows.onBoundsChanged', windowId: w.id, bounds: [w.left, w.top, w.width, w.height] }));
// ④ Chrome 自身が focus を変えるか（WINDOW_ID_NONE = -1 は「Chrome が前面でなくなった」）
chrome.windows.onFocusChanged.addListener((id) => log({ ev: 'windows.onFocusChanged', windowId: id }));

async function giveBack() {
  if (!last) return log({ ev: 'giveBack', ok: false, why: 'no-detached-tab' });
  const { tabId, oldWindowId, oldPosition } = last;
  const before = (await chrome.tabs.query({ windowId: oldWindowId }).catch(() => [])).map((t) => [t.id, t.index]);
  const started = Date.now();
  let tries = 0, lastErr = null;
  for (; Date.now() - started < 5000; ) {
    tries++;
    try {
      const t = await chrome.tabs.move(tabId, { windowId: oldWindowId, index: oldPosition });
      const after = (await chrome.tabs.query({ windowId: oldWindowId })).map((x) => [x.id, x.index]);
      return log({ ev: 'giveBack', ok: true, tabId, toWindowId: t.windowId, toIndex: t.index, wantedWindowId: oldWindowId, wantedIndex: oldPosition, tries, after_ms: Date.now() - started, since_detached_ms: Date.now() - last.at, firstError: lastErr, otherTabsBefore: before, otherTabsAfter: after });
    } catch (e) {
      lastErr = lastErr ?? String(e.message ?? e);
      await new Promise((r) => setTimeout(r, 50)); // 公式 docs の retry と同じ 50ms
    }
  }
  log({ ev: 'giveBack', ok: false, tabId, tries, error: lastErr });
}
globalThis.h2 = { giveBack, last: () => last };
log({ ev: 'h2-probe-started' });
