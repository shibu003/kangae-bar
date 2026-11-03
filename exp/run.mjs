// 使い方: node run.mjs [break=steal|wrongtab] [dur=60]   → /private/tmp/claude-501/expA-<name>.json に生データ・標準出力に数字
// 時計は全部ここ（sw の timer は 10 秒に丸められる）。sw は命令を実行するだけ。
import { spawn, execSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os';
import { serve } from './server.mjs';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('='))); const DUR = +(args.dur || 60); const name = args.break || 'clean';
const logs = [], front = [], procs = [];
const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = `${os.homedir()}/Library/Application Support/Kangae/Chromium.app/Contents/MacOS/Chromium`;
const prof = fs.mkdtempSync('/private/tmp/claude-501/expA-prof-');
const { srv, rpc } = serve((l) => logs.push(l));
const chrome = spawn(app, [`--user-data-dir=${prof}`, `--load-extension=${process.cwd()}/ext`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const win = await rpc({ fn: 'win' });
const mk = async (role, active) => (await rpc({ fn: 'create', win, role, active })).id;
const T0 = await mk('T0', true); await sleep(1500);
const T1 = await mk('T1', false), T2 = await mk('T2', false), T3 = await mk('T3', false);
await rpc({ fn: 'update', tab: T1, props: { autoDiscardable: false } }); // A-4: T1 だけ捨てない
await sleep(2500); await rpc({ fn: 'update', tab: T0, props: { active: true } });
const ids = { T0, T1, T2, T3 }; const m = (id, m) => rpc({ fn: 'msg', tab: id, m });
await sleep(1500);
const activeSamples = []; let discardedSeen = new Set();
const startT = Date.now(); logs.push({ k: 'start', t: startT });
const typer = spawn('/private/tmp/claude-501/typez', [String(DUR)], { stdio: 'inherit' });
const tick = setInterval(async () => {
  front.push(sh(`osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js'`));
  const rows = sh('ps -axo pid=,ppid=,%cpu=,rss=').split('\n').map((r) => r.trim().split(/\s+/).map(Number));
  const kids = new Set([chrome.pid]); let grew = true;
  while (grew) { grew = false; for (const [p, pp] of rows) if (kids.has(pp) && !kids.has(p)) { kids.add(p); grew = true; } }
  const mine = rows.filter((r) => kids.has(r[0]));
  procs.push({ n: mine.length, cpu: mine.reduce((a, r) => a + r[2], 0), rssMB: mine.reduce((a, r) => a + r[3], 0) / 1024 });
  try { activeSamples.push(await rpc({ fn: 'active', win })); (await rpc({ fn: 'discardedList' })).forEach((d) => discardedSeen.add(d)); } catch {}
}, 1000);
const agent = async (who, tab) => {
  for (let i = 0; Date.now() - startT < DUR * 1000; i++) {
    let target = tab;
    if (args.break === 'wrongtab' && who === 'B' && i === 5) target = T1;
    if (args.break === 'steal' && who === 'A' && i === 5) await rpc({ fn: 'update', tab: T1, props: { active: true } });
    try { await m(target, { op: 'write', text: `agent${who}#${i}` }); await m(target, { op: 'read' }); } catch (e) { logs.push({ k: 'err', who, e: String(e) }); }
    await sleep(900);
  }
};
await Promise.all([agent('A', T1), agent('B', T2)]);
clearInterval(tick);
const shot = `/private/tmp/claude-501/expA-${name}.png`; sh(`screencapture -x ${shot}`);
const out = {}; for (const [r, id] of Object.entries(ids)) out[r] = await m(id, { op: 'read' });
const natural = [...discardedSeen];
await rpc({ fn: 'reload', tab: T1 }); await sleep(2500); const reloadT1 = await m(T1, { op: 'read' });
const disc = {}; for (const [r, id] of Object.entries(ids)) if (r !== 'T0') disc[r] = await rpc({ fn: 'discard', tab: id }).catch((e) => String(e));
chrome.kill(); srv.close(); typer.kill();
fs.writeFileSync(`/private/tmp/claude-501/expA-${name}.json`, JSON.stringify({ logs, front, procs, out, disc, activeSamples, natural }, null, 1));
const act = (k) => logs.filter((l) => l.k === k && l.t >= startT);
const zIn = (r) => ((out[r].qValue || '').match(/z/g) || []).length + out[r].saved.filter((s) => /z/.test(s.text)).length;
const foreign = (r, p) => out[r].saved.filter((s) => !s.text.startsWith(p)).length;
const cnt = (r) => Object.entries(out[r].ev.reduce((a, e) => ((a[`${e.type}:${e.trusted}`] = (a[`${e.type}:${e.trusted}`] || 0) + 1), a), {}));
console.log(JSON.stringify({
  run: name, 前面を奪った回数_Chromium以外が前面の標本数: front.filter((f) => !/Chromium/i.test(f)).length, front標本数: front.length, front_names: [...new Set(front)],
  onActivated回数: act('onActivated').length, onFocusChanged回数: act('onFocusChanged').length,
  active標本中T0以外: activeSamples.filter((a) => a !== T0).length, active標本数: activeSamples.length,
  人のz_T0: zIn('T0'), 人のz_T1: zIn('T1'), 人のz_T2: zIn('T2'), 人のz_T3: zIn('T3'), T0_qValue: out.T0.qValue,
  対象外書き込み: foreign('T1', 'agentA') + foreign('T2', 'agentB') + out.T3.saved.length + out.T0.saved.length,
  A書込数: out.T1.saved.length, B書込数: out.T2.saved.length, A_DOM行: out.T1.dom.length, reload後T1保存: reloadT1.saved.length,
  isTrusted: { T0: cnt('T0'), T1: cnt('T1'), T2: cnt('T2') }, visibility: { T1: out.T1.visibility, T2: out.T2.visibility },
  自然に捨てられたtab: natural, 明示discard後: disc,
  CPU_peak: Math.max(...procs.map((p) => p.cpu)).toFixed(1), CPU_avg: (procs.reduce((a, p) => a + p.cpu, 0) / procs.length).toFixed(1), mem_peak_MB: Math.max(...procs.map((p) => p.rssMB)).toFixed(0), proc_n: Math.max(...procs.map((p) => p.n)),
  errs: logs.filter((l) => l.k === 'err').map((l) => l.e),
}, null, 1));
process.exit(0);
