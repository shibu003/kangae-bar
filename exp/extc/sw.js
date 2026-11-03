// 実験 C の拡張。世代は gen[tab]。落ちた後は known が空＝「分からない」＝既定は拒否。復帰（reconfirm）で floor より上に上げて初めて通す。
// cfg は拡張の中の cfg.json（c.mjs が run ごとに書く・落ちても再インストールしても残る・わざと壊す旗）: src=memory|session|file|both / unknown=deny|allow / noFloorOk
const S = 'localhost:8765';
let cfg = { src: 'file', unknown: 'deny', noFloorOk: false }, gen = {}, known = {}, ws = null;
const keep = () => cfg.src === 'session' || cfg.src === 'both';
const ready = (async () => {
  cfg = { ...cfg, ...(await fetch(chrome.runtime.getURL('cfg.json')).then((r) => r.json()).catch(() => ({}))) };
  if (keep()) gen = (await chrome.storage.session.get('gen')).gen || {};
  const n = ((await chrome.storage.session.get('boot')).boot || 0) + 1; chrome.storage.session.set({ boot: n }); // 起動回数（session が reload で消える実測用）
})();
const out = (o) => ws?.readyState === 1 && ws.send(JSON.stringify({ t: Date.now(), ...o }));
const setGen = (tab, n) => { gen[tab] = n; if (keep()) chrome.storage.session.set({ gen }); out({ k: 'gen', tab, gen: n }); };
const bump = (tab, why) => { setGen(tab, (gen[tab] ?? 0) + 1); chrome.tabs.sendMessage(tab, { op: 'gen', gen: gen[tab] }).catch(() => {}); out({ k: 'bump', tab, why, gen: gen[tab] }); };
const watch = new Set();
chrome.tabs.onAttached.addListener(async (id) => { await ready; watch.has(id) && bump(id, 'attached'); });
chrome.tabs.onActivated.addListener(async (i) => { await ready; watch.has(i.tabId) && bump(i.tabId, 'activated'); });
const run = {
  win: () => chrome.windows.getAll().then((w) => w[0].id),
  create: (c) => chrome.tabs.create({ windowId: c.win, url: c.url, active: c.active }).then((t) => { setGen(t.id, 0); known[t.id] = true; return { id: t.id }; }), // 自分で作った面は世代 0 から
  update: (c) => chrome.tabs.update(c.tab, c.props).then(() => 1),
  msg: (c) => chrome.tabs.sendMessage(c.tab, c.m),
  watch: (c) => (watch.add(c.tab), 1),
  later: (c) => (setTimeout(() => { chrome.storage.session.set({ later: Date.now() }); chrome.tabs.update(c.tab, { active: true }); for (const x of c.write || []) chrome.tabs.sendMessage(c.tab, { op: 'write', text: x }); }, c.ms), 1), // 人の代役を sw の中で時限に動かす（WebSocket が切れている間も動く）
  boot: async () => ({ boot: (await chrome.storage.session.get('boot')).boot ?? null, later: (await chrome.storage.session.get('later')).later ?? null, gen, known }), // session が残っているか
  // 復帰: 対象（面と文書）を読み直し、世代を floor より上げて、その面だけ「分かった」にする。floor が無ければ拒否（noFloorOk の時だけ 0 から）
  reconfirm: async (c) => {
    const ask = () => chrome.tabs.sendMessage(c.tab, { op: 'hello' }).catch(() => null);
    let h = await ask();
    if (!h) { await chrome.scripting.executeScript({ target: { tabId: c.tab }, files: ['content.js'] }).catch(() => {}); h = await ask(); } // reload で content script は孤児になる→入れ直す
    if (!h) return { err: 'no-target' };
    const base = Math.max(gen[c.tab] ?? -1, c.floor ?? -1);
    if (base < 0 && !cfg.noFloorOk) return { err: 'no-floor' };
    setGen(c.tab, base < 0 ? 0 : base + 1); known[c.tab] = true;
    chrome.tabs.sendMessage(c.tab, { op: 'gen', gen: gen[c.tab] }).catch(() => {});
    return { doc: h.doc, gen: gen[c.tab], saved: h.saved };
  },
  exec: async (c) => {
    if (c.grant.tab !== c.tab) return { status: 'rejected', why: 'tab' };
    if (!known[c.tab] && cfg.unknown !== 'allow') return { status: 'rejected', why: 'unknown' };
    if (c.grant.gen < (gen[c.tab] ?? 0)) return { status: 'rejected', why: 'gen(sw)' };
    return chrome.tabs.sendMessage(c.tab, { op: 'exec', grant: c.grant, cmd: c.cmd, cfg: { doc: true, gen: true, exp: true }, extGen: gen[c.tab] ?? 0 });
  },
};
async function connect() {
  await ready;
  chrome.tabs.query({ url: ['http://localhost:8765/*', 'http://127.0.0.1:8765/*'] }).then((a) => a.forEach((x) => chrome.scripting.executeScript({ target: { tabId: x.id }, files: ['content.js'] }).catch(() => {}))); // 起動時に既存の面へ入れ直す
  ws = new WebSocket('ws://' + S + '/ws');
  ws.onopen = () => { known = {}; out({ k: 'hello', gen }); }; // 繋ぎ直したら「分からない」に戻す（再確認するまで動かない）
  ws.onmessage = async (e) => { const c = JSON.parse(e.data); let r; try { r = { v: await run[c.fn](c) }; } catch (x) { r = { err: String(x) }; } out({ id: c.id, ...r }); };
  ws.onclose = () => setTimeout(connect, 300);
  ws.onerror = () => ws.close();
}
chrome.runtime.onInstalled.addListener(() => {}); chrome.runtime.onStartup.addListener(() => {}); // 入れ直した拡張の sw を起こす event（listener が無いと誰も起こさず常駐に戻らない＝実測: runtime.reload() の後 40 秒待っても戻らなかった）
connect();
setInterval(() => out({ k: 'ping' }), 20000); // WebSocket の往来で sw を生かしておく
