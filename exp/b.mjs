// 実験 B: 操作権（面・文書・世代・持ち主・期限）。使い方: node b.mjs → /private/tmp/claude-501/expB.json と標準出力に数字
// 時計は全部ここ。人の介入の代役は chrome.tabs.update(active) / reload（agent は tab を前面にしないので、対象 tab の onActivated = 人）。
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os';
import { serve } from './server.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = `${os.homedir()}/Library/Application Support/Kangae/Chromium.app/Contents/MacOS/Chromium`;
const prof = fs.mkdtempSync('/private/tmp/claude-501/expB-prof-');
const logs = []; const { srv, rpc } = serve((l) => logs.push(l));
const chrome = spawn(app, [`--user-data-dir=${prof}`, `--load-extension=${process.cwd()}/ext`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let win = await rpc({ fn: 'win' });
const L = 'http://localhost:8765/page.html?role=', O = 'http://127.0.0.1:8765/page.html?role=';
const msg = (tab, m) => rpc({ fn: 'msg', tab, m });
const hello = async (tab) => { for (let i = 0; i < 40; i++) { try { return await msg(tab, { op: 'hello' }); } catch { await sleep(300); } } throw new Error('no hello ' + tab); };
const mk = async (role, url, active = false) => { const id = (await rpc({ fn: 'create', win, role, url, active })).id; await hello(id); return id; };
const ALL = { gen: true, doc: true, tab: true, exp: true };
const setCfg = (c = {}) => rpc({ fn: 'cfg', cfg: { ...ALL, ...c } });
const issue = async (tab, gen = 0, exp = Date.now() + 60000) => ({ tab, doc: (await hello(tab)).doc, gen, owner: 'agent', exp });
const exec = (tab, grant, cmd) => rpc({ fn: 'exec', tab, grant, cmd }).catch((e) => ({ status: 'unknown', err: String(e).slice(0, 90) }));
const bumps = (tab) => logs.filter((l) => l.k === 'bump' && l.tab === tab);
const T0 = await mk('T0', L + 'T0', true); await sleep(500);
const human = async (tab) => { const t = Date.now(); await rpc({ fn: 'update', tab, props: { active: true } }); return t; }; // 人が tab を前面にした
const back = () => rpc({ fn: 'update', tab: T0, props: { active: true } });
const R = { b1: [], b2: [], b3: [] };

// ---------- B-1: 3 つの時点で人が取り戻す ----------
// variant: purge=常駐が待ち行列を捨てる / extGen=拡張が世代を見る
const variants = { clean: { purge: true, gen: true }, 拡張だけ: { purge: false, gen: true }, 拡張の世代検査なし: { purge: false, gen: false } };
const typer = spawn('/private/tmp/claude-501/typez', ['150'], { stdio: 'inherit' });
async function b1(timing, vname) {
  const v = variants[vname]; const role = `B1-${timing}-${vname}`; await setCfg({ gen: v.gen });
  const tab = await mk(role, L + role); await rpc({ fn: 'watch', tab }); await back(); await sleep(1500);
  const g = await issue(tab, 0); const res = []; let nodeStop = null, tH = null, tabNow = tab;
  const send = async (i, extra = {}) => { const r = await exec(tab, g, { text: `${role}#${i}`, ...extra }); res.push({ i, ...r, tRes: Date.now() }); return r; };
  if (timing === '待ち行列') {
    const q = [...Array(10).keys()]; setTimeout(async () => { tH = await human(tab); }, 800);
    for (const i of q) {
      if (v.purge && bumps(tab).length && !nodeStop) nodeStop = Date.now();
      if (nodeStop) { res.push({ i, status: 'purged' }); continue; }
      await send(i); await sleep(250);
    }
  } else if (timing === '実行直前') {
    const ps = [0, 1, 2].map((i) => send(i, { hold: 1500 })); await sleep(600); tH = await human(tab); await Promise.all(ps); // 届いたが実行まで 1.5 秒の間に人が入る
    if (v.purge) nodeStop = Date.now();
  } else if (timing === '結果前') {
    const p = send(0, { lag: 1500 }); await sleep(600); tH = await human(tab); await p; // 実行済みで結果が返るのが遅い
    if (v.purge) nodeStop = Date.now();
  } else { // 結果前(再読み込み): 実行後に人が reload → 結果は返らない → 読み直して確定
    const p = send(0, { lag: 1500 }); await sleep(600); tH = Date.now(); await rpc({ fn: 'reload', tab }); await p;
    await hello(tab); const saved = (await msg(tab, { op: 'read' })).saved; res.forEach((r) => r.status === 'unknown' && (r.resolved = saved.some((s) => s.text === `${role}#${r.i}`) ? '実行済み' : '未実行'));
  }
  await sleep(800);
  const st = await msg(tab, { op: 'read' }); const bT = bumps(tab)[0]?.t ?? null; const cut = bT ?? tH;
  const agentSaved = st.saved.filter((s) => s.text.startsWith(role));
  const klass = (r) => (r.status === 'executed' ? (r.t < cut ? '実行済み(介入前)' : '失効後に実行') : r.status === 'rejected' || r.status === 'purged' ? '未実行' : `結果不明→${r.resolved}`);
  const after = agentSaved.filter((s) => s.t >= cut).length; // 頁の保存時刻が正本
  const keyBefore = st.ev.filter((e) => e.type === 'keydown' && e.trusted && e.t < tH).length;
  const o = { timing, variant: vname, 命令数: res.length, 失効後に実行された数: tH ? after : 0, 分類: res.reduce((a, r) => ((a[klass(r)] = (a[klass(r)] || 0) + 1), a), {}), 拒否理由: [...new Set(res.map((r) => r.why).filter(Boolean))],
    介入から拡張が世代を上げるまでms: bT && tH ? bT - tH : null, 介入から常駐が止めるまでms: nodeStop && tH ? nodeStop - tH : null, 頁の保存数: agentSaved.length, 介入前にagent対象へ入った人のkeydown: keyBefore };
  R.b1.push(o); console.log(JSON.stringify(o)); await back();
}
for (const t of ['待ち行列', '実行直前', '結果前', '結果前(再読み込み)']) for (const vn of Object.keys(variants)) await b1(t, vn);
typer.kill();
// 人の入力（z）の行き先を全体で数える
const zT0 = (await msg(T0, { op: 'read' })).qValue.length;
R.人のz_T0の入力欄 = zT0;

// ---------- B-2: 文書が入れ替わる ----------
const v2 = { 'all-on': {}, 'doc-off': { doc: false }, 'gen-off': { gen: false }, 'doc+tab-off': { doc: false, tab: false }, 'all-off': { doc: false, gen: false, tab: false } };
async function b2(sc, vname) {
  const role = `B2-${sc}-${vname}`; await setCfg(v2[vname]);
  let tab = await mk(role, L + role); await rpc({ fn: 'watch', tab }); await back(); await sleep(800);
  const g = await issue(tab, 0); const pre = await exec(tab, g, { text: 'pre' }); const oldDoc = g.doc; let target = tab; const oldId = tab;
  if (sc === '再読み込み') { await rpc({ fn: 'reload', tab }); }
  else if (sc === '別site') { await rpc({ fn: 'nav', tab, url: O + role }); }
  else if (sc === '閉じて開き直し') { await rpc({ fn: 'remove', tab }); target = await mk(role, L + role); await rpc({ fn: 'watch', tab: target }); }
  else if (sc === '別の窓へ') { const w2 = await rpc({ fn: 'moveWin', tab }); await sleep(800); win = win; void w2; }
  else if (sc === 'discard') { const d = await rpc({ fn: 'discard', tab }); target = d.newId; await rpc({ fn: 'update', tab: target, props: { active: true } }); }
  const now = await hello(target);
  const r = await exec(target, g, { text: 'stale' });
  await sleep(500); const st = await msg(target, { op: 'read' });
  const o = { sc, variant: vname, 事前の命令: pre.status, tabId同じか: target === oldId, 文書の印が変わったか: now.doc !== oldDoc, 古い操作権の結果: r.status + (r.why ? `(${r.why})` : ''), 新文書に効いた: st.saved.some((s) => s.text === 'stale') };
  R.b2.push(o); console.log(JSON.stringify(o));
  // 後始末: 窓を移した tab は元の窓へ戻せないので閉じる
  await rpc({ fn: 'remove', tab: target }).catch(() => {}); await back().catch(() => {});
}
for (const sc of ['再読み込み', '別site', '閉じて開き直し', '別の窓へ', 'discard']) for (const vn of Object.keys(v2)) await b2(sc, vn);

// ---------- B-3: 再開 ----------
async function b3(vname, naive) {
  const role = `B3-${vname}`; await setCfg(vname === 'gen-off' ? { gen: false } : {});
  const tab = await mk(role, L + role); await rpc({ fn: 'watch', tab }); await back(); await sleep(800);
  const plan = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']; const g0 = await issue(tab, 0);
  for (const p of plan.slice(0, 2)) await exec(tab, g0, { text: p });
  await human(tab); await sleep(300);
  for (const p of ['p3', 'p4']) await msg(tab, { op: 'write', text: p }); // 人が自分で p3 p4 を足した（grant なし）
  await sleep(300);
  let replay = [], issued = null, done = [];
  if (naive) { for (const p of plan.slice(2)) replay.push((await exec(tab, g0, { text: p })).status); } // 古い手順をそのまま再生
  else {
    for (const p of plan.slice(2)) replay.push((await exec(tab, g0, { text: p })).status); // 古い操作権で再生を試みる → 全部捨てられるはず
    const h = await hello(tab); const have = new Set(h.saved.map((s) => s.text)); const rest = plan.filter((p) => !have.has(p)); // 読み直して残りだけ
    issued = await issue(tab, h.gen); for (const p of rest) done.push(p + ':' + (await exec(tab, issued, { text: p })).status);
  }
  await sleep(500); const st = await msg(tab, { op: 'read' }); const texts = st.saved.map((s) => s.text);
  const dup = texts.length - new Set(texts).size;
  const o = { variant: vname, 手順: naive ? '古い手順をそのまま再生' : '読み直して残りだけ', 古い操作権での再生: replay, 新しい操作権: issued && { gen: issued.gen, 旧gen: g0.gen, 同じ文書: issued.doc === g0.doc }, 読み直し後に実行した分: done, 最終: texts, 二重処理: dup };
  R.b3.push(o); console.log(JSON.stringify(o)); await back();
}
await b3('all-on', false); await b3('gen-off', true);
// 期限
await setCfg(); { const tab = await mk('B3-exp', L + 'B3-exp'); const ge = await issue(tab, 0, Date.now() - 1); const r1 = await exec(tab, ge, { text: 'x' }); await setCfg({ exp: false }); const r2 = await exec(tab, ge, { text: 'y' }); R.期限 = { 検査あり: r1.status + '(' + (r1.why || '') + ')', 検査なし: r2.status }; console.log(JSON.stringify(R.期限)); }
fs.writeFileSync('/private/tmp/claude-501/expB.json', JSON.stringify({ R, logs }, null, 1));
chrome.kill(); srv.close(); process.exit(0);
