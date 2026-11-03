// content script だけで頁の DOM を読み・書く（debugger は使わない）。
// 実験 B: exec は「実行の直前」に 文書の印(DOC)・世代・期限 を確かめ、古ければ捨てる。cfg で検査を外せる（わざと壊す用）。
const DOC = `${performance.timeOrigin}:${crypto.randomUUID()}`; // 文書ごとの印
document.documentElement.dataset.kdoc = DOC;
let gen = 0; // 人の介入で sw が上げた世代（この文書が知っている分）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (text) => {
  const q = document.getElementById('q');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(q, text);
  q.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('send').click();
};
const read = () => {
  const role = new URLSearchParams(location.search).get('role');
  return { role, doc: DOC, gen, qValue: document.getElementById('q').value, dom: [...document.querySelectorAll('#saved li')].map((l) => l.textContent),
    saved: JSON.parse(localStorage.getItem('saved:' + role) || '[]'), ev: JSON.parse(localStorage.getItem('ev:' + role) || '[]'), visibility: document.visibilityState };
};
async function exec({ grant: g, cmd, cfg, extGen }) {
  gen = Math.max(gen, extGen || 0);
  if (cmd.hold) await sleep(cmd.hold); // 命令が届いてから実行までの間（ここで人が入る）
  if (cfg.doc && g.doc !== DOC) return { status: 'rejected', why: 'doc' };
  if (cfg.gen && g.gen < gen) return { status: 'rejected', why: 'gen' };
  if (cfg.exp && Date.now() > g.exp) return { status: 'rejected', why: 'exp' };
  write(cmd.text);
  const t = Date.now();
  if (cmd.lag) await sleep(cmd.lag); // 実行したが結果が返るのが遅い
  return { status: 'executed', t, doc: DOC };
}
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m.op === 'write') { write(m.text); reply({ ok: true }); }
  else if (m.op === 'read' || m.op === 'hello') reply(read());
  else if (m.op === 'gen') { gen = Math.max(gen, m.gen); reply({}); }
  else if (m.op === 'exec') exec(m).then(reply);
  else reply({});
  return true;
});
