// 実験 C の常駐。使い方: SRC=memory|session|file|both STATE=<file> bun daemon.mjs
// 拡張とは WebSocket（/ws）、agent とは HTTP（POST /api）。世代の写しを STATE（file）に持ち、復帰時の floor として拡張に渡す。
import fs from 'node:fs';
const SRC = process.env.SRC || 'file', STATE = process.env.STATE;
const useFile = SRC === 'file' || SRC === 'both';
let st = { gen: {} }; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(st));
const merge = (g) => { for (const [t, n] of Object.entries(g || {})) st.gen[t] = Math.max(st.gen[t] ?? -1, n); save(); };
const page = fs.readFileSync(new URL('./page.html', import.meta.url));
let ext = null, holdUntil = 0, id = 0; const pending = new Map(); const logs = [];
const ask = (cmd) => new Promise((ok) => {
  if (!ext) return ok({ err: 'no-ext' });
  const i = ++id; const to = setTimeout(() => { pending.delete(i); ok({ err: 'timeout' }); }, cmd.timeout || 6000);
  pending.set(i, (r) => { clearTimeout(to); ok(r); }); ext.send(JSON.stringify({ ...cmd, id: i }));
});
Bun.serve({
  port: 8765,
  async fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === '/ws') return Date.now() < holdUntil ? new Response('hold', { status: 503 }) :  srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
    if (u.pathname === '/page.html') return new Response(page, { headers: { 'content-type': 'text/html' } });
    if (u.pathname === '/state') return Response.json({ st, logs });
    if (u.pathname === '/dropws') { holdUntil = Date.now() + +(u.searchParams.get('hold') || 0); ext?.close(); return new Response('ok'); }
    if (u.pathname === '/api') {
      const cmd = await req.json();
      // 復帰（reconfirm）には file の floor を載せる（SRC が file / both の時だけ）
      if (cmd.fn === 'reconfirm' && useFile) cmd.floor = st.gen[cmd.tab] ?? null;
      return Response.json(await ask(cmd));
    }
    return new Response('', { status: 404 });
  },
  websocket: {
    open(ws) { ext = ws; logs.push({ k: 'ws-open', t: Date.now() }); },
    close(ws) { if (ext === ws) ext = null; logs.push({ k: 'ws-close', t: Date.now() }); },
    message(_ws, raw) {
      const m = JSON.parse(raw);
      if (m.k === 'ping') return;
      if (m.k === 'gen') merge({ [m.tab]: m.gen });
      else if (m.k === 'hello') merge(m.gen); // 繋ぎ直しで拡張の世代を取り込む（切れていた間の介入）
      else if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      logs.push({ ...m, t: m.t || Date.now() });
    },
  },
});
