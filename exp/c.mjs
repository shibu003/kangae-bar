// 実験 C: 落ちても勝手に続けない。使い方: node c.mjs all | node c.mjs <src> <crash> [variant]
//   src=memory|session|file|both（世代をどこに残すか）/ crash=C-1a(sw を止める)|C-1b(拡張を入れ直す)|C-2|C-3|C-4 / variant=clean|R1|R2
//   R1=memory だけ + 床が無くても復帰を通す / R2=世代が分からない面を通す（わざと壊す）
// agent はこの process（落とさない）。常駐は bun の子 process（daemon.mjs）、拡張は exp/extc。結果は標準出力と /private/tmp/claude-501/expC.json
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = `${os.homedir()}/Library/Application Support/Kangae/Chromium.app/Contents/MacOS/Chromium`;
const D = 'http://localhost:8765', ROOT = new URL('.', import.meta.url).pathname;
const api = (cmd) => fetch(D + '/api', { method: 'POST', body: JSON.stringify(cmd), signal: AbortSignal.timeout(9000) }).then((r) => r.json()).catch((e) => ({ err: 'daemon-down:' + (e.cause?.code || e.name) }));
const ok = (r) => (r.err ? Promise.reject(new Error(JSON.stringify(r))) : r.v);
const rpc = (cmd) => api(cmd).then(ok);

async function run({ src, crash, variant = 'clean' }) {
  const state = `/private/tmp/claude-501/expC-state-${process.pid}.json`; fs.rmSync(state, { force: true });
  const prof = fs.mkdtempSync('/private/tmp/claude-501/expC-prof-');
  let daemon; const up = async () => { daemon = spawn('bun', [ROOT + 'daemon.mjs'], { env: { ...process.env, SRC: src, STATE: state }, stdio: 'ignore' }); for (let i = 0; i < 50; i++) { if ((await fetch(D + '/state').catch(() => null))?.ok) return; await sleep(100); } throw new Error('daemon no up'); };
  const down = async () => { daemon.kill('SIGKILL'); await new Promise((r) => daemon.once('exit', r)); };
  const extUp = async (ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const r = await api({ fn: 'win' }); if (!r.err) return r.v; await sleep(300); } throw new Error('ext no up'); };
  await up();
  const extDir = fs.mkdtempSync('/private/tmp/claude-501/expC-ext-'); fs.cpSync(ROOT + 'extc', extDir, { recursive: true }); // run ごとの写し（cfg.json はここに書く）
  fs.writeFileSync(extDir + '/cfg.json', JSON.stringify({ src, unknown: variant === 'R2' ? 'allow' : 'deny', noFloorOk: variant === 'R1' }));
  const chrome = spawn(app, [`--user-data-dir=${prof}`, `--load-extension=${extDir}`, '--remote-debugging-port=9333', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let cws, cid = 0; const cp = new Map(); // CDP: sw を止める / 拡張を入れ直す（人が chrome://extensions で reload するのと同じ側）
  const cdp = async (method, params = {}, sessionId) => {
    if (!cws) { for (let i = 0; i < 60 && !cws; i++) { try { const v = await (await fetch('http://127.0.0.1:9333/json/version')).json(); const w = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r, j) => { w.onopen = r; w.onerror = j; }); w.onmessage = (e) => { const m = JSON.parse(e.data); cp.get(m.id)?.(m); }; cws = w; } catch { await sleep(300); } } }
    return new Promise((r) => { const i = ++cid; cp.set(i, r); cws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  };
  const extId = async () => (await cdp('Extensions.getExtensions')).result.extensions.find((e) => e.path === extDir).id;
  const swStop = async () => { const pg = (await cdp('Target.getTargets')).result.targetInfos.find((t) => t.type === 'page'); const s = (await cdp('Target.attachToTarget', { targetId: pg.targetId, flatten: true })).result.sessionId; await cdp('ServiceWorker.enable', {}, s); await cdp('ServiceWorker.stopAllWorkers', {}, s); const n = (await cdp('Target.createTarget', { url: 'about:blank' })).result.targetId; await sleep(300); await cdp('Target.closeTarget', { targetId: n }); }; // 止めて、人が新しい tab を開く＝sw が起きる event
  const extReinstall = async () => { const id = await extId(); await cdp('Extensions.uninstall', { id }); await sleep(300); await cdp('Extensions.loadUnpacked', { path: extDir }); };
  const o = { src, crash, variant };
  try {
    const win = await extUp();
    const L = 'http://localhost:8765/page.html?role=';
    const hello = async (tab) => { for (let i = 0; i < 40; i++) { const r = await api({ fn: 'msg', tab, m: { op: 'hello' } }); if (!r.err) return r.v; await sleep(300); } throw new Error('no hello ' + tab); };
    const mk = async (role, active) => { const id = (await rpc({ fn: 'create', win, role, url: L + role, active })).id; await hello(id); return id; };
    const T0 = await mk('T0', true), T = await mk('T', false), T2 = await mk('T2', false); await rpc({ fn: 'watch', tab: T }); await sleep(800);
    const grant = async (tab) => ({ tab, doc: (await hello(tab)).doc, gen: (await rpc({ fn: 'boot' })).gen[tab], owner: 'agent', exp: Date.now() + 120000 });
    const exec = (g, text) => api({ fn: 'exec', tab: g.tab, grant: g, cmd: { text } }).then((r) => (r.err ? { status: 'err', why: r.err } : r.v?.status ? r.v : { status: 'err', why: JSON.stringify(r).slice(0, 80) }));
    const G = await grant(T), G2 = await grant(T2);
    const plan = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    for (const p of plan.slice(0, 2)) await exec(G, p); await exec(G2, 'q1');
    o.事前の実行 = (await rpc({ fn: 'msg', tab: T, m: { op: 'read' } })).saved.length;
    // 人が介入（T を前面に・p3 p4 を自分で足す）→ G は失効。C-2 だけは WebSocket が切れている間に起きる
    const tCut = Date.now(); let tDrop = 0;
    if (crash === 'C-2') { await rpc({ fn: 'later', tab: T, ms: 1200, write: ['H:p3', 'H:p4'] }); tDrop = Date.now(); await fetch(D + '/dropws?hold=4000'); }
    else { await rpc({ fn: 'update', tab: T, props: { active: true } }); for (const x of ['H:p3', 'H:p4']) await rpc({ fn: 'msg', tab: T, m: { op: 'write', text: x } }); await sleep(500); } // 人が T を前面にして p3 p4 を自分で足す
    const stale = []; const send = async (g, text, when) => { const r = await exec(g, text); stale.push({ when, text, status: r.status, why: r.why }); };
    if (crash !== 'C-2') await send(G, 'S0:p5', '失効後・落ちる前'); // 世代が効いているかの確認（rejected になるはず）
    o.sessionの残り前 = (await api({ fn: 'boot' })).v ?? null;
    if (crash !== 'C-2' && stale[0].status !== 'rejected') throw new Error('前提が崩れた: 落ちる前に失効していない ' + JSON.stringify(stale[0]));
    // ---- 落とす ----
    const tCrash = Date.now();
    if (crash === 'C-1a') { await swStop(); await sleep(1000); }
    else if (crash === 'C-1b') { await extReinstall(); await sleep(1500); }
    else if (crash === 'C-2') { await sleep(300); await send(G, 'S0:p5', '切れている間'); await sleep(4300); }
    else if (crash === 'C-3') { await down(); await send(G, 'S0:p5', '常駐が居ない間'); await up(); }
    else { await extReinstall(); await down(); await send(G, 'S0:p5', '常駐も拡張も居ない間'); await sleep(1200); await up(); }
    await extUp(); await sleep(1000);
    o.sessionの残り後 = (await api({ fn: 'boot' })).v ?? null;
    if (crash === 'C-2') o.介入が切断中に起きたか = o.sessionの残り後.later > tDrop && o.sessionの残り後.later < tDrop + 4000;
    // ---- 復帰直後（再確認の前）に古い操作権を送る ----
    await send(G, 'S1:p5', '復帰直後(再確認前)'); await send(G, 'S1:p3', '復帰直後(再確認前)'); await send(G2, 'S1:q2', '復帰直後(再確認前)');
    // ---- 復帰: 対象（面と文書）を読み直し、世代を上げて、新しい操作権 ----
    const fixe = (r) => (r.v?.err ? { err: r.v.err } : r); const rc = fixe(await api({ fn: 'reconfirm', tab: T })); const rc2 = fixe(await api({ fn: 'reconfirm', tab: T2 })); const tRe = Date.now();
    o.復帰 = { T: rc.err || { gen: rc.v.gen }, T2: rc2.err || { gen: rc2.v.gen } }; // err = 拒否（床が無い＝分からない）
    await send(G, 'S2:p5', '再確認の後'); await send(G, 'S2:p3', '再確認の後'); await send(G2, 'S2:q2', '再確認の後');
    const done = [];
    if (!rc.err) { // 読み直した頁に在る物を除いて、残りだけ新しい操作権で
      const have = new Set(rc.v.saved.map((s) => s.text.replace(/^H:/, ''))); const g = { tab: T, doc: rc.v.doc, gen: rc.v.gen, owner: 'agent', exp: Date.now() + 60000 };
      for (const p of plan.filter((x) => !have.has(x))) done.push(p + ':' + (await exec(g, p)).status);
    }
    if (!rc2.err) done.push('q2:' + (await exec({ tab: T2, doc: rc2.v.doc, gen: rc2.v.gen, owner: 'agent', exp: Date.now() + 60000 }, 'q2')).status);
    await sleep(500);
    const pg = async (tab) => (await rpc({ fn: 'msg', tab, m: { op: 'read' } })).saved; const sT = await pg(T), sT2 = await pg(T2);
    const norm = (s) => s.text.replace(/^(S\d|H):/, '');
    const dupOf = (a) => a.length - new Set(a.map(norm)).size;
    o.失効後に実行された数 = [...sT, ...sT2].filter((s) => /^S/.test(s.text)).length; // 頁の保存で数える（返信ではなく）
    o.再確認前に動いた数 = [...sT, ...sT2].filter((s) => s.t > tCrash && s.t < tRe && !/^H:/.test(s.text)).length;
    o.古い操作権の送信 = stale.map((s) => `${s.when}/${s.text}=${s.status}${s.why ? '(' + s.why + ')' : ''}`);
    o.復帰後に実行した分 = done; o.最終T = sT.map((s) => s.text); o.最終T2 = sT2.map((s) => s.text); o.二重処理 = dupOf(sT) + dupOf(sT2);
    o.所要_介入から復帰までms = tRe - tCut;
  } catch (e) { o.error = String(e).slice(0, 200); }
  chrome.kill('SIGKILL'); await down().catch(() => {}); fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(extDir, { recursive: true, force: true });
  console.log(JSON.stringify(o)); return o;
}

const [a, b, c] = process.argv.slice(2); const R = [];
if (a === 'all') {
  for (const crash of ['C-1a', 'C-1b', 'C-2', 'C-3', 'C-4']) for (const src of ['memory', 'session', 'file', 'both']) R.push(await run({ src, crash }));
  for (const variant of ['R1', 'R2']) for (const crash of ['C-1a', 'C-1b', 'C-2', 'C-3', 'C-4']) R.push(await run({ src: 'memory', crash, variant }));
} else if (a === 'redo') { for (const [src, crash, variant] of [['memory', 'C-1a'], ['memory', 'C-1b'], ['session', 'C-1b'], ['session', 'C-3'], ['memory', 'C-4'], ['session', 'C-4'], ['memory', 'C-1a', 'R2'], ['memory', 'C-1b', 'R2'], ['memory', 'C-4', 'R2']]) R.push(await run({ src, crash, variant })); }
else R.push(await run({ src: a, crash: b, variant: c }));
fs.writeFileSync('/private/tmp/claude-501/expC.json', JSON.stringify(R, null, 1)); process.exit(0);
