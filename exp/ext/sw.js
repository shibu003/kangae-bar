// sw の timer は 10 秒に丸められる実測（docs/REPORT-expA.md）ので、時計は持たず node の命令を長 poll で受けて実行するだけ
const S = 'http://localhost:8765';
const post = (p, o) => fetch(S + p, { method: 'POST', body: JSON.stringify({ t: Date.now(), ...o }) }).catch(() => {});
// 実験 B: 人の介入（agent の対象 tab が前面になる・窓を移る）で世代を上げ、その tab の文書へ即押す
const gen = {}, watch = new Set(), cfg = { gen: true, doc: true, tab: true, exp: true };
const bump = (tab, why) => { gen[tab] = (gen[tab] || 0) + 1; chrome.tabs.sendMessage(tab, { op: 'gen', gen: gen[tab] }).catch(() => {}); post('/log', { k: 'bump', tab, why, gen: gen[tab] }); };
chrome.tabs.onAttached.addListener((id) => watch.has(id) && bump(id, 'attached'));
chrome.tabs.onActivated.addListener((i) => { if (watch.has(i.tabId)) bump(i.tabId, 'activated'); post('/log', { k: 'onActivated', tab: i.tabId }); });
chrome.windows.onFocusChanged.addListener((i) => post('/log', { k: 'onFocusChanged', win: i }));
const run = {
  create: (c) => chrome.tabs.create({ windowId: c.win, url: c.url || `${S}/page.html?role=${c.role}`, active: c.active }).then((t) => ({ id: t.id, win: t.windowId })),
  win: () => chrome.windows.getAll().then((w) => w[0].id),
  update: (c) => chrome.tabs.update(c.tab, c.props).then(() => 1),
  msg: (c) => chrome.tabs.sendMessage(c.tab, c.m),
  active: (c) => chrome.tabs.query({ active: true, windowId: c.win }).then((a) => a[0].id),
  discardedList: () => chrome.tabs.query({}).then((a) => a.filter((t) => t.discarded).map((t) => t.id)),
  reload: (c) => chrome.tabs.reload(c.tab).then(() => 1),
  discard: (c) => chrome.tabs.discard(c.tab).then((t) => ({ newId: t?.id, discarded: t?.discarded, autoDiscardable: t?.autoDiscardable })),
  get: (c) => chrome.tabs.get(c.tab).then((t) => ({ discarded: t.discarded, autoDiscardable: t.autoDiscardable })),
  watch: (c) => (watch.add(c.tab), 1),
  cfg: (c) => (Object.assign(cfg, c.cfg), 1),
  gen: (c) => gen[c.tab] || 0,
  nav: (c) => chrome.tabs.update(c.tab, { url: c.url }).then(() => 1),
  remove: (c) => chrome.tabs.remove(c.tab).then(() => 1),
  moveWin: (c) => chrome.windows.create({ tabId: c.tab }).then((w) => w.id),
  // 命令 1 つずつに操作権を載せる。tab と世代は sw でも見る（文書と世代は実行の直前に content でもう一度）
  exec: async (c) => {
    if (cfg.tab && c.grant.tab !== c.tab) return { status: 'rejected', why: 'tab' };
    if (cfg.gen && c.grant.gen < (gen[c.tab] || 0)) return { status: 'rejected', why: 'gen(sw)' };
    return chrome.tabs.sendMessage(c.tab, { op: 'exec', grant: c.grant, cmd: c.cmd, cfg, extGen: gen[c.tab] || 0 });
  },
  noop: () => 0,
};
(async () => { for (;;) {
  let c;
  try { c = await (await fetch(S + '/next')).json(); } catch { continue; }
  (async () => { let r; try { r = { v: await run[c.fn](c) }; } catch (e) { r = { err: String(e) }; } await post('/res', { id: c.id, ...r }); })(); // 並行に処理（人の介入が実行中の命令に塞がれない）
} })();
