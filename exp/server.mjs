import http from 'node:http'; import fs from 'node:fs';
// /next = sw が命令を長 poll で取る・/res = 結果・/log = event の記録
export function serve(onLog) {
  const waiting = []; const cmds = []; const pending = new Map(); let id = 0;
  const pump = () => { while (waiting.length && cmds.length) waiting.shift().end(JSON.stringify(cmds.shift())); };
  const srv = http.createServer((req, res) => { if (process.env.DBG) console.error(req.method, req.url);
    if (req.url === '/next') { waiting.push(res); pump(); setTimeout(() => { const i = waiting.indexOf(res); if (i >= 0) { waiting.splice(i, 1); res.end('{"fn":"noop"}'); } }, 8000); return; }
    if (req.url === '/log' || req.url === '/res') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const o = JSON.parse(b); if (req.url === '/log') onLog(o); else pending.get(o.id)?.(o); res.end('ok'); }); return; }
    if (req.url.startsWith('/page.html')) { res.setHeader('content-type', 'text/html'); return res.end(fs.readFileSync(new URL('./page.html', import.meta.url))); }
    res.statusCode = 404; res.end();
  }).listen(8765);
  const rpc = (cmd) => new Promise((ok, ng) => { const i = ++id; const to = setTimeout(() => ng(new Error('rpc timeout ' + JSON.stringify(cmd))), 45000); pending.set(i, (r) => { clearTimeout(to); r.err ? ng(new Error(r.err)) : ok(r.v); }); cmds.push({ ...cmd, id: i }); pump(); });
  return { srv, rpc };
}
