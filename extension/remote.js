// スマホで操作の画面（R1）。panel の #remote に描く（押す操作の press.js と同じ作り: 自分の口を 1 本持つ）。
// 文字は textContent だけ。QR は常駐が作った画像（data:）をそのまま <img> に出す。画面を離れると、まだ使われていない QR は無効にする。
// 口は call("remote", { action })。内部の語（鍵・token・port・tunnel）は画面に出さない。
(() => {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const btn = (text, cls, onclick, disabled) => { const b = el("button", `btn ${cls}`.trim(), text); b.type = "button"; b.onclick = onclick; b.disabled = !!disabled; return b; };

  let port = null, root = null, st = null, note = "", busy = null, gen = 0, left = 0, tick = null, poll = null;
  const waiting = new Map();
  function connect() {
    port = kangaeConnect();
    port.onMessage.addListener((res) => {
      if (res?.type === "remote") { if (root) void refresh(); return; } // 常駐の「変わりました」
      const w = res && waiting.get(res.id);
      if (w) { waiting.delete(res.id); w(res); }
    });
    port.onDisconnect.addListener(() => { port = null; for (const [id, w] of waiting) { waiting.delete(id); w({ ok: false, hint: "本体に繋がりません。アプリを開き直してから、もう一度押してください" }); } }); // 押す依頼は送り直さない（二重に押さない）
  }
  const call = (action, extra = {}) => new Promise((resolve) => {
    if (!port) connect();
    const msg = { id: crypto.randomUUID(), op: "remote", action, ...extra };
    waiting.set(msg.id, resolve);
    port.postMessage(msg);
  });

  async function refresh() {
    const my = gen;
    const r = await call("status");
    if (my !== gen || !root || busy) return;
    st = r.ok ? r : { phase: "error", hint: r.hint, devices: [] };
    paint();
  }
  // 押した瞬間に busy（二重に押せない）→ 結果を待つ → 常駐の今を読み直す
  async function act(action, extra) {
    if (busy) return;
    const my = gen;
    busy = action; note = ""; paint();
    const r = await call(action, extra);
    busy = null;
    if (my !== gen || !root) return;
    if (!r.ok) note = r.hint || "うまくいきませんでした。もう一度試してください";
    if (r.ok && r.phase) st = r;
    else { const s = await call("status"); if (my !== gen || !root) return; st = s.ok ? s : { phase: "error", hint: s.hint, devices: [] }; }
    paint();
  }

  function qrBlock(s) {
    const box = el("div", "remote-qr");
    const img = el("img"); img.src = s.qr; img.alt = "スマホのカメラで読む QR"; img.width = 248; img.height = 248;
    const left_ = el("p", "remote-left"); left_.id = "remote-left"; left_.textContent = `あと ${left} 秒で無効になります`;
    box.append(img, left_, btn("新しい QR", "quiet", () => act("start"), !!busy));
    return box;
  }

  function paint() {
    const body = root?.querySelector("#remote-body");
    if (!body) return;
    const s = st ?? { phase: "starting", devices: [] };
    const phase = busy === "start" ? "starting" : s.phase;
    left = s.expiresIn ?? 0;
    const kids = [];
    if (phase === "starting") kids.push(el("p", "remote-line", "外から入る道を作っています…（数十秒かかることがあります）"));
    else if (phase === "offer") {
      kids.push(el("p", "remote-line", s.route === "tunnel" ? "QR をスマホのカメラで読んでください。外出先（モバイル回線）からも、この Mac の担当 agent を見られます。" : "QR をスマホのカメラで読んでください。"));
      if (s.note) kids.push(el("p", "remote-warn", s.note));
      kids.push(qrBlock(s));
    } else if (phase === "claimed" && s.pending) {
      const c = el("div", "remote-card");
      c.append(el("h2", "", "スマホが QR を読みました"), el("p", "remote-code", s.pending.code), el("p", "remote-line", `「${s.pending.name}」の画面にも同じ数字が出ていれば、許可してください。読んだ覚えがなければ「許可しない」を押してください。`));
      const row = el("div", "remote-btns");
      row.append(btn("このスマホを許可", "primary", () => act("allow"), !!busy), btn("許可しない", "quiet", () => act("cancel"), !!busy));
      c.append(row);
      kids.push(c);
    } else if (phase === "error") {
      kids.push(el("p", "remote-warn", s.hint || "つなげませんでした"), btn("もう一度つなぐ", "primary", () => act("start"), !!busy));
    } else {
      kids.push(el("p", "remote-line", phase === "expired" ? "QR の期限が切れました（90 秒）。" : "新しいスマホをつなぐ時は、QR を出してください。"), btn("QR を出す", "primary", () => act("start"), !!busy));
      if (s.note) kids.push(el("p", "remote-warn", s.note));
    }
    if (note) kids.push(el("p", "remote-warn", note));
    if (s.storeNote) kids.push(el("p", "remote-warn", s.storeNote));
    if (s.devices?.length) {
      const sec = el("section", "remote-devs");
      sec.append(el("h2", "remote-label", "接続済みのスマホ"));
      for (const d of s.devices) {
        const row = el("div", "remote-dev");
        const who = el("div", "remote-who");
        who.append(el("div", "remote-name", d.name), el("div", "remote-state", d.online ? "つながっています" : "今はつながっていません"));
        row.append(who, btn("接続を解除", "quiet", () => act("revoke", { id: d.id }), !!busy));
        sec.append(row);
      }
      if (s.devices.length > 1) sec.append(btn("すべての接続を解除", "quiet", () => act("revoke"), !!busy));
      kids.push(sec);
    }
    if (s.agents?.length) { // R3: 止まった担当をスマホから再開してよいか（担当ごと・既定は入れていない）
      const sec = el("section", "remote-devs");
      sec.append(el("h2", "remote-label", "スマホから再開してよい担当"), el("p", "remote-hint", "止まった担当を、スマホの「再開する」で動かせます。入れていない担当は Mac で再開してください。"));
      for (const a of s.agents) {
        const row = el("label", "remote-dev remote-opt"), box = el("input"), name = el("span", "remote-name", a.name);
        box.type = "checkbox"; box.checked = !!a.allowed; box.setAttribute("role", "switch"); box.disabled = !!busy;
        box.onchange = () => act("resumeAllow", { rootId: a.id, on: box.checked });
        row.append(name, box);
        sec.append(row);
      }
      kids.push(sec);
    }
    kids.push(el("p", "remote-foot", "Mac が寝ている間や、Kangae が止まっている間は、スマホからつながりません。"));
    body.replaceChildren(...kids);
  }

  globalThis.mountRemote = (r) => {
    root = r; gen++; st = null; note = ""; busy = null;
    paint();
    void act("start"); // 押した = QR を出す（cloudflared が道を作る間は「作っています」）
    clearInterval(tick); clearInterval(poll);
    tick = setInterval(() => { // 残り秒（画面の目安。有効かどうかは常駐の時計が決める）
      if (st?.phase !== "offer" || busy) return;
      left = Math.max(0, left - 1);
      const p = root?.querySelector("#remote-left");
      if (p) p.textContent = `あと ${left} 秒で無効になります`;
      if (left === 0) void refresh();
    }, 1000);
    poll = setInterval(() => void refresh(), 3000);
  };
  globalThis.unmountRemote = () => {
    if (!root) return;
    root = null; gen++; busy = null;
    clearInterval(tick); clearInterval(poll);
    void call("cancel"); // 画面を離れたら、まだ使われていない QR は無効
  };
})();
