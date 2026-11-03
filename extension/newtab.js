const $ = (id) => document.getElementById(id);

let port = null;
const waiting = new Map(); // id → { msg, resolve, retried }

function paint(ui) {
  const h1 = document.querySelector("h1");
  if (!ui?.hasOverride) {
    h1.textContent = "Kangae";
    h1.style.color = "";
    return;
  }
  if ("color" in ui) h1.style.color = ui.color ?? "";
  if ("text" in ui) h1.textContent = ui.text ?? "Kangae";
}

function connect() {
  port = kangaeConnect();
  port.onMessage.addListener((res) => {
    if (res.type === "disconnected") {
      for (const w of waiting.values()) {
        if (w.retried) { waiting.delete(w.msg.id); w.resolve({ ok: false }); }
        else { w.retried = true; /* 回数を残す理由: 同じ要求を 1 回だけ送り直す（副作用の上限・時間では決まらない） */ setTimeout(() => port?.postMessage(w.msg), 500); }
      }
      return;
    }
    if (res.type === "ui") { paint(res.ui); return; }
    if (res.type === "desktop") { drawDesk(); return; }
    if (res.type === "pty") { ptyIn(res); return; }
    const w = waiting.get(res.id);
    if (w) { waiting.delete(res.id); w.resolve(res); }
  });
  port.onDisconnect.addListener(() => { port = null; });
}

function call(op, extra = {}) {
  return new Promise((resolve) => {
    if (!port) connect();
    const msg = { id: crypto.randomUUID(), op, ...extra };
    waiting.set(msg.id, { msg, resolve, retried: false });
    port.postMessage(msg);
  });
}

// 「…」→「スマホで操作」: Bar と同じ画面（panel.html の #remote）を tab で開く
$("more").addEventListener("click", () => { const open = $("menu").hidden; $("menu").hidden = !open; $("more").setAttribute("aria-expanded", String(open)); });
$("phone").addEventListener("click", () => { $("menu").hidden = true; chrome.tabs.create({ url: chrome.runtime.getURL("panel.html?remote=1") }); });
// click の中で open。await すると gesture が切れる
$("open").addEventListener("click", () => {
  chrome.windows.getCurrent((w) => chrome.sidePanel.open({ windowId: w.id }));
});

const CARD_W = 140;
const MARK = { terminal: "⌘" };
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 札を押した時の行き先。窓に同じ url の tab があれば前面に、無ければ新しい tab
async function openOrFocus(url) {
  const t = (await chrome.tabs.query({})).find((x) => x.url === url);
  if (t) {
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  } else chrome.tabs.create({ url });
}

const outsideUrl = (c) => (c.kind === "session" ? chrome.runtime.getURL(`panel.html?session=${c.rootId}`) : c.url);

// 札を押した時: 窓を開く（開いていれば前へ）。terminal はまだ作業場所を Terminal で開く
let zTop = 10;
const wins = new Map(); // key → 窓の要素
function press(c) {
  const el = wins.get(c.key);
  if (el) { el.style.zIndex = ++zTop; return; }
  const n = wins.size;
  return call("desktopWindow", { key: c.key, win: { x: 40 + n * 28, y: 24 + n * 28, w: 520, h: 420, open: true } });
}

// terminal の窓: xterm の画面と、常駐の PTY（ptyId）を結ぶ。出力が ptyOpen の返事より先に来る事があるので、開いている最中だけ溜める
const ptyTerms = new Map(); // ptyId → xterm
const ptyEarly = new Map(); // ptyId → 先に届いた出力
let ptyOpening = 0;
function ptyIn(m) {
  const t = ptyTerms.get(m.ptyId);
  if (!t) { if (ptyOpening > 0 && m.data) ptyEarly.set(m.ptyId, (ptyEarly.get(m.ptyId) ?? "") + m.data); return; }
  if (m.data) t.write(m.data);
  if (m.exit) t.write("\r\n\x1b[2m[shell が終わりました。窓を閉じて開き直すと新しい shell]\x1b[0m\r\n");
}
addEventListener("pagehide", () => { for (const id of ptyTerms.keys()) call("ptyClose", { ptyId: id }); });

function mountTerminal(c, host) {
  const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "Menlo, Monaco, monospace", scrollback: 5000 });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  let ptyId = null, dead = false;
  const sizeNow = () => { try { fit.fit(); } catch {} };
  sizeNow();
  ptyOpening++;
  call("ptyOpen", { rootId: c.rootId, cols: term.cols, rows: term.rows }).then((r) => {
    ptyOpening--;
    if (!r.ok) { term.write(`\x1b[31m${r.hint ?? "ターミナルを開けませんでした"}\x1b[0m`); return; }
    if (dead) { call("ptyClose", { ptyId: r.ptyId }); return; }
    ptyId = r.ptyId;
    ptyTerms.set(ptyId, term);
    const early = ptyEarly.get(ptyId);
    ptyEarly.delete(ptyId);
    if (early) term.write(early);
    call("ptyResize", { ptyId, cols: term.cols, rows: term.rows });
  });
  term.onData((data) => { if (ptyId !== null) call("ptyWrite", { ptyId, data }); });
  term.onResize(({ cols, rows }) => { if (ptyId !== null) call("ptyResize", { ptyId, cols, rows }); });
  new ResizeObserver(sizeNow).observe(host);
  return () => {
    dead = true;
    if (ptyId !== null) { ptyTerms.delete(ptyId); call("ptyClose", { ptyId }); }
    term.dispose();
  };
}

function fitWin(el, w) {
  const desk = $("desk");
  el.style.left = `${Math.min(Math.max(0, w.x), Math.max(0, desk.clientWidth - 80))}px`;
  el.style.top = `${Math.min(Math.max(0, w.y), Math.max(0, desk.clientHeight - 32))}px`;
  el.style.width = `${w.w}px`;
  el.style.height = `${w.h}px`;
}

function makeWin(c) {
  const el = document.createElement("div");
  el.className = "win";
  el.dataset.key = c.key;
  const bar = document.createElement("div");
  bar.className = "win-bar";
  const title = document.createElement("span");
  title.className = "win-title";
  title.textContent = c.name;
  const pop = document.createElement("button");
  pop.type = "button";
  pop.className = "win-pop";
  pop.textContent = c.kind === "terminal" ? "Terminal で開く" : "タブで開く";
  pop.onclick = () => (c.kind === "terminal" ? call("workspace", { nodeId: c.rootId, agent: false }) : openOrFocus(outsideUrl(c)));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "win-close";
  close.textContent = "×";
  close.title = "窓を閉じる（札は残る）";
  close.onclick = () => call("desktopWindow", { key: c.key, win: { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, open: false } });
  bar.append(title, pop, close);
  const body = document.createElement("div");
  body.className = "win-body";
  if (c.kind === "terminal") {
    const host = document.createElement("div");
    host.className = "term";
    body.append(host);
    el._mount = () => { el._dispose = mountTerminal(c, host); };
  } else {
    const f = document.createElement("iframe");
    f.src = outsideUrl(c);
    f.title = c.name;
    body.append(f);
  }
  const grip = document.createElement("div");
  grip.className = "win-grip";
  el.append(bar, body, grip);
  const save = () => call("desktopWindow", { key: c.key, win: { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, open: true } });
  const track = (handle, onMove) => (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    const desk = $("desk");
    desk.classList.add("busy");
    el.dataset.busy = "1";
    handle.setPointerCapture(e.pointerId);
    const from = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    handle.onpointermove = (m) => onMove(from, m.clientX - from.x, m.clientY - from.y);
    handle.onpointerup = () => {
      handle.onpointermove = handle.onpointerup = null;
      desk.classList.remove("busy");
      delete el.dataset.busy;
      save();
    };
  };
  bar.onpointerdown = track(bar, (f0, dx, dy) => {
    const desk = $("desk");
    el.style.left = `${Math.min(Math.max(0, f0.l + dx), Math.max(0, desk.clientWidth - 80))}px`;
    el.style.top = `${Math.min(Math.max(0, f0.t + dy), Math.max(0, desk.clientHeight - 32))}px`;
  });
  grip.onpointerdown = track(grip, (f0, dx, dy) => {
    el.style.width = `${Math.max(240, f0.w + dx)}px`;
    el.style.height = `${Math.max(160, f0.h + dy)}px`;
  });
  el.addEventListener("pointerdown", () => { el.style.zIndex = ++zTop; }, true);
  el.style.zIndex = ++zTop;
  return el;
}

// desktop.json の窓（開いている物）と画面の窓を合わせる。開いたままの窓の iframe は作り直さない
function syncWins() {
  const desk = $("desk");
  const open = new Map(cards.filter((c) => c.win?.open).map((c) => [c.key, c]));
  for (const [key, el] of wins) if (!open.has(key)) { el._dispose?.(); el.remove(); wins.delete(key); }
  for (const [key, c] of open) {
    let el = wins.get(key);
    if (!el) {
      el = makeWin(c);
      wins.set(key, el);
      desk.append(el);
    }
    el.querySelector(".win-title").textContent = c.name;
    if (!el.dataset.busy) fitWin(el, c.win);
    if (el._mount) { el._mount(); el._mount = null; }
  }
}

function place(el, c) {
  const desk = $("desk");
  el.style.left = `${c.x * Math.max(0, desk.clientWidth - CARD_W)}px`;
  el.style.top = `${c.y * Math.max(0, desk.clientHeight - el.offsetHeight)}px`;
}

function makeCard(c) {
  const el = document.createElement("div");
  el.className = `card ${c.kind}`;
  el.dataset.key = c.key;
  el.title = c.kind === "tab" ? `${c.name}\n${c.url}` : c.name;
  if (c.icon) {
    const img = document.createElement("img");
    img.src = c.icon;
    img.alt = "";
    img.onerror = () => img.remove();
    el.append(img);
  } else if (MARK[c.kind]) {
    const m = document.createElement("span");
    m.className = "mark";
    m.textContent = MARK[c.kind];
    el.append(m);
  }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = c.name;
  const x = document.createElement("button");
  x.className = "x";
  x.type = "button";
  x.textContent = "×";
  x.title = "デスクトップから外す";
  x.onclick = (e) => { e.stopPropagation(); call("desktopRemove", { key: c.key }); };
  el.append(name, x);
  el.onpointerdown = (e) => {
    if (e.target === x || e.button !== 0) return;
    const desk = $("desk");
    const dx = e.clientX - el.offsetLeft, dy = e.clientY - el.offsetTop;
    let moved = false, to = { x: c.x, y: c.y };
    el.setPointerCapture(e.pointerId);
    el.onpointermove = (m) => {
      if (!moved && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 4) return;
      moved = true;
      el.classList.add("dragging");
      const left = Math.min(Math.max(0, m.clientX - dx), desk.clientWidth - CARD_W);
      const top = Math.min(Math.max(0, m.clientY - dy), desk.clientHeight - el.offsetHeight);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      to = { x: clamp01(left / Math.max(1, desk.clientWidth - CARD_W)), y: clamp01(top / Math.max(1, desk.clientHeight - el.offsetHeight)) };
    };
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
      el.classList.remove("dragging");
      if (moved) { c.x = to.x; c.y = to.y; call("desktopMove", { key: c.key, ...to }); } else press(c);
    };
  };
  return el;
}

let cards = [];
async function drawDesk() {
  const r = await call("desktopList");
  if (!r.ok) return;
  cards = r.cards;
  const desk = $("desk");
  desk.querySelectorAll(".card").forEach((n) => n.remove());
  $("desk-empty").hidden = cards.length > 0;
  for (const c of cards) {
    const el = makeCard(c);
    desk.append(el);
    place(el, c);
  }
  syncWins();
  document.body.dataset.desk = String(cards.length);
}
addEventListener("resize", () => { cards.forEach((c) => { const w = wins.get(c.key); if (w && c.win) fitWin(w, c.win); }); cards.forEach((c) => { const el = document.querySelector(`.card[data-key="${CSS.escape(c.key)}"]`); if (el) place(el, c); }); });

connect();
drawDesk();
call("ui").then((r) => { if (r.ok) paint(r.ui); document.body.dataset.painted = "1"; });
