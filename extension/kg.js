// W77b: panel の部品（light DOM の customElements・docs/design-ui-modules.md）。部品は属性を描いてイベントを投げるだけ。
// port・storage・chrome を持たない（受け手の panel.js が call に繋ぐ）。文字は textContent だけ（agent の名前・頁の題が入っても HTML にならない）。
// 見た目は panel.css の token のまま（部品が色・px を持たない）。

// 承認の 3 択。文言は CEO 指定の英語（要件 14・W53fix）。choices に無い物は描かない（押せない選択肢を出さない）
// W101: kind 無し = 3 ボタン（役割 class）。kind=choice は radio＋自由記述。kind=multi はチップ＋自由記述。文字は textContent だけ
const LABEL = { always: "always allow", allow: "allow", deny: "deny" };
let pickN = 0;
export function answerLine(d) {
  const free = String(d?.free ?? "").trim();
  if (d?.kind === "choice") {
    const choice = String(d.choice ?? "").trim();
    if (choice && free) return `${choice}（ほかに: ${free}）`;
    return choice || free;
  }
  if (d?.kind === "multi") {
    const list = (Array.isArray(d.choices) ? d.choices : []).map((s) => String(s).trim()).filter(Boolean);
    const head = list.length ? `選んだ: ${list.join(", ")}` : "";
    if (head && free) return `${head}（ほかに: ${free}）`;
    return head || (free ? `ほかに: ${free}` : "");
  }
  return "";
}
function roleClass(id, danger) {
  if (danger && id === "deny") return "danger";
  if (id === "allow" && !danger) return "primary";
  return "quiet";
}
function mkBtn(c, danger) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn ${roleClass(c, danger)}`;
  b.dataset.choice = c;
  b.textContent = LABEL[c];
  return b;
}
class KgApprove extends HTMLElement {
  static observedAttributes = ["choices", "kind", "data-options", "free", "danger"];
  connectedCallback() {
    if (!this._on) {
      this._on = true;
      this.addEventListener("click", (e) => this.onClick(e));
      this.addEventListener("input", () => this.syncGo());
    }
    this.paint();
  }
  attributeChangedCallback(name) { if (this.isConnected && KgApprove.observedAttributes.includes(name)) this.paint(); } // aria-busy など観測しない属性では描き直さない
  onClick(e) {
    const kind = this.getAttribute("kind");
    if (kind === "choice" || kind === "multi") { this.onPick(e, kind); return; }
    const b = e.target.closest?.("button[data-choice]");
    if (!b || b.disabled || this._busy) return;
    this.busy(true); // W114: 押した瞬間に card の全選択肢を止める（結果を待つ間に別の選択を送らない）。戻すのは受け手（失敗なら busy(false)・成功なら card ごと消える）
    this.dispatchEvent(new CustomEvent("kg-answer", { bubbles: true, detail: { choice: b.dataset.choice } }));
  }
  // W114: 押下中。全 button / input を disabled・aria-busy="true"。戻す時は自分が止めた物だけ（元から disabled の物は disabled のまま）
  busy(on) {
    on = !!on;
    if (on === !!this._busy) return;
    this._busy = on;
    if (on) {
      this.setAttribute("aria-busy", "true");
      this._held = [...this.querySelectorAll("button"), ...this.querySelectorAll("input")].filter((n) => !n.disabled);
      for (const n of this._held) n.disabled = true;
      return;
    }
    this.toggleAttribute("aria-busy", false);
    for (const n of this._held ?? []) n.disabled = false;
    this._held = null;
    this._sent = false;
    this.syncGo();
  }
  onPick(e, kind) {
    if (this._sent) return;
    if (kind === "choice") {
      const lab = e.target.closest?.("label");
      const inp = lab && [...lab.querySelectorAll("input")].find((n) => n.type === "radio"); // NodeList に find は無い（実ブラウザで TypeError）。配列にしてから
      if (inp) {
        for (const r of this.querySelectorAll("input")) if (r.type === "radio") r.checked = r === inp;
        this.syncGo();
        return;
      }
    } else {
      const chip = e.target.closest?.("button[data-opt]");
      if (chip) {
        chip.setAttribute("aria-pressed", chip.getAttribute("aria-pressed") === "true" ? "false" : "true");
        this.syncGo();
        return;
      }
    }
    const go = e.target.closest?.("button[data-go]");
    if (!go || go.disabled) return;
    this._sent = true;
    this.busy(true); // W114: これで を含む全部（radio・chip・自由記述）を止める
    const free = this._free ? String(this._free.value ?? "") : "";
    if (kind === "choice") {
      const picked = [...this.querySelectorAll("input")].find((n) => n.type === "radio" && n.checked);
      this.dispatchEvent(new CustomEvent("kg-answer", { bubbles: true, detail: { kind: "choice", choice: picked ? picked.dataset.opt : "", free } }));
    } else {
      const choices = [...this.querySelectorAll("button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.opt);
      this.dispatchEvent(new CustomEvent("kg-answer", { bubbles: true, detail: { kind: "multi", choices, free } }));
    }
  }
  syncGo() {
    const go = this._go;
    if (!go || this._sent) return;
    const kind = this.getAttribute("kind");
    const free = this._free ? String(this._free.value ?? "").trim() : "";
    let ok = !!free;
    if (kind === "choice") ok = ok || [...this.querySelectorAll("input")].some((n) => n.type === "radio" && n.checked);
    else if (kind === "multi") ok = ok || [...this.querySelectorAll("button")].some((b) => b.getAttribute("aria-pressed") === "true");
    else return;
    go.disabled = !ok;
  }
  paint() {
    const kind = this.getAttribute("kind");
    if (kind === "choice" || kind === "multi") { this.paintPick(kind); return; }
    this.classList.add("btns");
    const danger = this.hasAttribute("danger");
    const ids = (this.getAttribute("choices") ?? "always,allow,deny").split(",").filter((c) => c in LABEL);
    for (const x of [...this.querySelectorAll("button[data-choice]")]) x.remove(); // 受け手が足した物（次から覚えない など）は残す
    this.prepend(...ids.map((c) => mkBtn(c, danger)));
  }
  paintPick(kind) {
    this._sent = false;
    this._busy = false;
    this._held = null;
    this.toggleAttribute("aria-busy", false);
    this._nm = this._nm || `k${++pickN}`;
    for (const x of [...this.querySelectorAll("label"), ...this.querySelectorAll("input"), ...this.querySelectorAll("button")]) x.remove();
    const opts = (this.getAttribute("data-options") ?? "").split("\n").filter((s) => s !== "");
    if (kind === "choice") {
      for (const text of opts) {
        const lab = document.createElement("label");
        const inp = document.createElement("input");
        inp.type = "radio";
        inp.name = this._nm;
        inp.setAttribute("name", this._nm);
        inp.dataset.opt = text;
        const span = document.createElement("span");
        span.textContent = text;
        lab.append(inp, span);
        this.append(lab);
      }
    } else {
      for (const text of opts) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn quiet";
        b.dataset.opt = text;
        b.setAttribute("aria-pressed", "false");
        b.textContent = text;
        this.append(b);
      }
    }
    this._free = null;
    if (this.hasAttribute("free")) {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = "ほかに";
      inp.setAttribute("placeholder", "ほかに");
      this._free = inp;
      this.append(inp);
    }
    const go = document.createElement("button");
    go.type = "button";
    go.className = "btn primary";
    go.dataset.go = "1";
    go.textContent = "これで";
    go.disabled = true;
    this._go = go;
    this.append(go);
    this.syncGo();
  }
}

// on/off の 1 行（設定）。DESIGN.md §6: label（14/24）と、その下に常時出す説明（12/20）・右に 36×22 の switch（hit 44）。label 全体が押せる。
// 中は label > [名前, input（checkbox・role=switch・hit 44 で透明）, track（見える物）, 説明]。押すと kg-toggle を投げ、受け手が失敗なら .on を戻す
class KgToggle extends HTMLElement {
  static observedAttributes = ["label", "hint", "on", "disabled"];
  static n = 0;
  connectedCallback() {
    if (!this._box) {
      this.style.display = "contents";
      const lab = document.createElement("label");
      this._text = document.createElement("span");
      this._text.className = "setting-label";
      this._box = document.createElement("input");
      this._box.type = "checkbox";
      this._box.setAttribute("role", "switch");
      const track = document.createElement("span");
      track.className = "switch-track";
      track.setAttribute("aria-hidden", "true");
      this._hint = document.createElement("span");
      this._hint.className = "setting-hint";
      this._hint.id = `kg-toggle-hint-${++KgToggle.n}`;
      lab.append(this._text, this._box, track, this._hint);
      this.append(lab);
      this._lab = lab;
      this._box.addEventListener("change", () => { this.toggleAttribute("on", this._box.checked); this.dispatchEvent(new CustomEvent("kg-toggle", { bubbles: true, detail: { on: this._box.checked } })); });
    }
    this.paint();
  }
  attributeChangedCallback() { if (this._box) this.paint(); }
  paint() {
    const label = this.getAttribute("label") ?? "", hint = this.getAttribute("hint") ?? "";
    this._text.textContent = label;
    this._box.setAttribute("aria-label", label);
    this._hint.textContent = hint;
    this._hint.hidden = !hint;
    if (hint) this._box.setAttribute("aria-describedby", this._hint.id); else this._box.toggleAttribute("aria-describedby", false);
    this._lab.title = hint;
    this._box.checked = this.hasAttribute("on");
    this._box.disabled = this.hasAttribute("disabled");
  }
  get on() { return this.hasAttribute("on"); }
  set on(v) { this.toggleAttribute("on", !!v); }
  set disabled(v) { this.toggleAttribute("disabled", !!v); }
  get disabled() { return this.hasAttribute("disabled"); }
}


// 固定の線画 icon（DESIGN.md §8: viewBox 20・fill=none・currentColor・stroke 1.6・round）。太さは panel.css の .ic が 14/16/20px で揃える。固定の文字列だけで、利用者の文字は入らない
export const ic = (cls, body, view = "0 0 20 20") => `<svg class="${cls}" viewBox="${view}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const SURF = {
  tab: ic("ic", '<circle cx="10" cy="10" r="7.25"/><path d="M2.75 10h14.5M10 2.75c2 2.1 3 4.5 3 7.25s-1 5.15-3 7.25c-2-2.1-3-4.5-3-7.25s1-5.15 3-7.25z"/>'),
  app: ic("ic", '<rect x="2.75" y="3.75" width="14.5" height="10" rx="2"/><path d="M7.5 17h5M10 13.75V17"/>'),
};
// W77c / W111: agent 一覧の 1 行（DESIGN.md §6 一覧 / kg-row）。<kg-row> が行の枠（hover・選択・押下の背景）で、中に兄弟の button が 2 つ: avatar = その担当の設定（kg-open-settings）／本文 button.root = 会話。button の中に button を入れない。
// 行の余白を押す = 会話（受け手が kg-row の click を聞く）。avatar と面の icon は click を行へ上げない。描くのは人が今要る物だけ: 担当名・時刻・最後の 1 文・未読の点・状態（有る時だけ 3 行目）・受け持つ面の icon（有る時だけ。押して初めて kg-peek＝縮小絵は受け手が出す・要件 37）
const put = (el, k, v) => { if (el[k] !== v) el[k] = v; };
class KgRow extends HTMLElement {
  static icons = {}; // 状態の絵（panel.js が自分の定数を渡す。信頼できる固定の svg 文字列だけ）
  connectedCallback() { this.ensure(); }
  get body() { return this.ensure().body; }
  ensure() {
    if (this._e) return this._e;
    const mk = (tag, cls) => Object.assign(document.createElement(tag), { className: cls, ...(tag === "button" ? { type: "button" } : {}) });
    const e = (this._e = { avBtn: mk("button", "av-btn"), av: mk("span", "av li"), body: mk("button", "root"), c: mk("span", "c"), text: mk("span", "root-text"), time: mk("span", "time"), last: mk("span", "pv-last"), badge: mk("span", "badge"), mark: mk("span", "mark"), surfs: mk("span", "surfs"), markOn: false });
    e.avBtn.append(e.av);
    e.c.append(e.text, e.time, e.last, e.badge);
    e.body.append(e.c);
    this.append(e.avBtn, e.body, e.surfs);
    e.avBtn.addEventListener("click", (ev) => { ev.stopPropagation(); this.dispatchEvent(new CustomEvent("kg-open-settings", { bubbles: true })); }); // W92: avatar を押す = この agent の設定（行＝会話を開く、は押された事にしない）
    e.surfs.addEventListener("click", (ev) => {
      const b = ev.target.closest?.("span[data-key]");
      if (!b) return;
      ev.stopPropagation(); // 行（会話を開く）は押された事にしない
      this.dispatchEvent(new CustomEvent("kg-peek", { bubbles: true, detail: { key: b.dataset.key } }));
    });
    return e;
  }
  // d = { name, glyph, state: [kind, text] | null, fail, last, lastHidden, time, dot, surfaces: [{ key, kind: "tab" | "app", app }] }
  set data(d) {
    const e = this.ensure();
    put(e.text, "textContent", d.name);
    put(e.av, "textContent", d.glyph);
    const label = `${d.name}の設定`;
    e.avBtn.setAttribute("aria-label", label); e.avBtn.title = label;
    if (!!d.state !== e.markOn) { e.markOn = !!d.state; if (d.state) e.c.append(e.mark); else e.mark.remove(); } // 状態が無い行は 3 行目を作らない
    if (d.state) {
      const tone = d.tone != null ? d.tone : (d.fail ? "fail" : ""); // W94: 色 class。未指定は従来の fail 印
      put(e.mark, "className", tone ? `mark ${tone}` : "mark");
      if (e.mark.dataset.k !== d.state[0]) { e.mark.innerHTML = KgRow.icons[d.state[0]] ?? ""; e.mark.append(document.createElement("span")); e.mark.dataset.k = d.state[0]; }
      put(e.mark.lastChild, "textContent", d.state[1]);
    }
    e.last.hidden = !!d.lastHidden;
    put(e.last, "textContent", d.last);
    put(e.time, "textContent", d.time);
    e.badge.hidden = !d.dot;
    const sig = JSON.stringify(d.surfaces ?? []);
    if (e.surfs._sig !== sig) { // 変わった時だけ作り直す（押している最中の icon を差し替えない）
      e.surfs._sig = sig;
      e.surfs.replaceChildren(...(d.surfaces ?? []).map((x) => { const b = document.createElement("span"); b.className = "surf"; b.dataset.key = x.key; b.setAttribute("role", "button"); b.tabIndex = 0; b.title = x.app; b.setAttribute("aria-label", String(x.app || "").trim() || (x.kind === "tab" ? "タブ" : "app")); b.innerHTML = SURF[x.kind === "tab" ? "tab" : "app"]; return b; }));
    }
    e.surfs.hidden = !(d.surfaces ?? []).length;
  }
}

// 設定の画面の中身（W113: popover の入れ物ではなくなった）。節（<details>）は既定で全部閉じ、1 つ開くと他は閉じる（1 画面に主操作 1 つ）。open は hidden の逆
class KgSettings extends HTMLElement {
  connectedCallback() {
    if (this._on) return;
    this._on = true;
    this.addEventListener("toggle", (e) => { // toggle は bubble しないので capture で受ける。節（直下の details）だけ畳む。中の 1 件を開いても節は閉じない
      const t = e.target;
      if (!t.open || (t.parentElement || t.parent) !== this) return;
      for (const d of this.children) if (d !== t && d.open) d.open = false;
    }, true);
  }
  closeAll() { for (const d of this.children) d.open = false; } // 設定の画面を開くたびに全部閉じで始める
  get open() { return !this.hidden; }
  set open(v) { this.hidden = !v; }
}

// W77d: 消える報せ（Toast = 自動で消える・Snackbar = 1 つだけ操作がつく）。画面に 1 枚だけ（新しいのが来たら置き換える）。modal は作らない（inline + toast）。
// 文字は textContent だけ・次の一手が分かる人の言葉だけを渡す（内部の語・理由の内部は渡す側が出さない）。操作を押すと kg-action {id} を投げて閉じる
// W117: mouseenter / focusin で時計を止め、mouseleave / focusout で残りから再開する。toast へ focus は移さない
class KgToast extends HTMLElement {
  connectedCallback() {
    if (this._on) return;
    this._on = true;
    this.setAttribute("role", "status");
    this.setAttribute("aria-live", "polite");
    this.setAttribute("aria-atomic", "true");
    this.hidden = true;
    this.addEventListener("click", (e) => {
      const b = e.target.closest?.("button[data-act]");
      if (!b) return;
      this.hide();
      this.dispatchEvent(new CustomEvent("kg-action", { bubbles: true, detail: { id: b.dataset.act } }));
    });
    this.addEventListener("mouseenter", () => this._pause());
    this.addEventListener("focusin", () => this._pause());
    this.addEventListener("mouseleave", () => this._resume());
    this.addEventListener("focusout", () => this._resume());
  }
  _stop() { clearTimeout(this._t); this._t = null; }
  _arm(ms) { this._left = ms; this._at = Date.now(); this._t = setTimeout(() => this.hide(), ms); }
  _pause() {
    if (this.hidden) return;
    if (!this._held && this._t != null) { this._left = Math.max(0, this._left - (Date.now() - this._at)); this._stop(); }
    this._held = (this._held || 0) + 1;
  }
  _resume() {
    if (!this._held) return;
    this._held--;
    if (this._held || this.hidden) return;
    if (this._left <= 0) { this.hide(); return; }
    this._arm(this._left);
  }
  // o = { tone: "ok" | "warn", action: { id, label }, ms }。既定の長さ: 知らせ 4 秒・失敗と操作つきは 8 秒（読み終わる前に消えない）
  show(text, o = {}) {
    this._stop();
    this._held = 0;
    const tone = o.tone === "warn" ? "warn" : "ok";
    this._tone = tone;
    this.className = `toast ${tone}`;
    const msg = document.createElement("span");
    msg.textContent = String(text);
    const kids = [msg];
    if (o.action) { const b = document.createElement("button"); b.type = "button"; b.className = "btn quiet"; b.dataset.act = o.action.id; b.textContent = o.action.label; kids.push(b); }
    this.replaceChildren(...kids);
    this.hidden = false;
    this._arm(o.ms ?? (o.action || tone === "warn" ? 8000 : 4000));
    if (this.matches(":hover") || this.matches(":focus-within")) this._pause();
  }
  // tone を渡すと、その種類が出ている時だけ閉じる（入力し直したら失敗の報せだけ消す・知らせは残す）
  hide(tone) {
    if (tone && this._tone !== tone) return;
    this._stop();
    this._left = 0;
    this._held = 0;
    this._tone = null;
    this.hidden = true;
    this.replaceChildren();
  }
}

// W91: 添付 1 つの chip。押すと kg-open（見る・開く）。受け手が種類で出し分ける（image / text = viewer・pdf / video = 人の既定の app・file = 保存）。
// 属性: view = image | text | pdf | video | file・name・meta（大きさなど 1 語）・removable・saveable。保存 / 外すは付けた時だけ描く（見なくていい物は見せない）。名前は他人が決める＝textContent だけ
// W116（DESIGN §6）: 種類を問わず同じ形 = 種類の印 16px・basename・大きさ。見える文字は basename だけ（全文は title / aria-label）。外す（送りかけだけ）は右端の別 button・hit 44px
// < > を含む名前は path と見なさない（HTML 風の文字の `</b>` を区切りと取り違えない）
export const baseName = (s) => { const t = String(s ?? ""); return /^[^<>]*[\\/]/.test(t) ? t.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : t; };
// 種類の印（固定の svg・viewBox 20・stroke 1.6 は縮尺に依らず保つ＝css の vector-effect）。W119 の形が来たらここだけ差し替える
const KIND_SVG = (d) => `<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const KIND_ICON = {
  image: KIND_SVG('<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.2"/><path d="M3.5 14l4-3.5 3 2.5 2.5-2 3.5 3"/>'),
  video: KIND_SVG('<rect x="3" y="4.5" width="14" height="11" rx="2"/><path d="M8.5 7.8v4.4l3.8-2.2z"/>'),
  doc: KIND_SVG('<path d="M5.5 2.5h6l4 4v10a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M11.5 2.5v4h4"/>'),
};
class KgChip extends HTMLElement {
  static observedAttributes = ["view", "name", "meta", "removable", "saveable"];
  connectedCallback() { this._paint(); }
  attributeChangedCallback() { if (this.isConnected) this._paint(); }
  // 縮小絵（image）。受け手が data: URL を渡す。null なら絵を出さず種類の印のまま（形は変えない＝印の場所に 16px で入る）
  setThumb(src) { this._thumb = src; this._paint(); }
  _paint() {
    const full = this.getAttribute("name") || "", view = this.getAttribute("view") || "file";
    this.className = "att-chip";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "att-file att-open";
    open.title = full || "添付";
    open.setAttribute("aria-label", full || "添付");
    const ico = document.createElement("span"); ico.className = "att-ico";
    if (view === "image" && this._thumb) { const i = document.createElement("img"); i.alt = ""; i.src = this._thumb; ico.append(i); }
    else ico.innerHTML = KIND_ICON[view] ?? KIND_ICON.doc;
    const n = document.createElement("span"); n.className = "att-name"; n.textContent = baseName(full) || "添付";
    open.append(ico, n);
    const meta = this.getAttribute("meta");
    if (meta) { const m = document.createElement("span"); m.className = "att-size"; m.textContent = meta; open.append(m); }
    open.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kg-open", { bubbles: true, detail: { view } })));
    const kids = [open];
    if (this.hasAttribute("saveable")) { const b = document.createElement("button"); b.type = "button"; b.className = "att-save"; b.textContent = "保存"; b.setAttribute("aria-label", `${full || "添付"} を保存`); b.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kg-save", { bubbles: true }))); kids.push(b); }
    if (this.hasAttribute("removable")) { const x = document.createElement("button"); x.type = "button"; x.className = "att-x"; x.title = "外す"; x.setAttribute("aria-label", "外す"); x.textContent = "×"; x.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kg-remove", { bubbles: true }))); kids.push(x); }
    this.replaceChildren(...kids);
  }
}

// W91: 添付の viewer（吹き出しの中に開く・modal は作らない）。image = 画像 1 枚・text = 最小の整形（見出し・箇条書き・code・表・段落）。
// 文書の中の link・画像の参照は辿らない（文字のまま出す）・制御文字と向きを変える文字は落とす・HTML は作らない（要素を組む）。1MB で切って「続きは保存で」
export const VIEW_TEXT_MAX = 1024 * 1024;
const clean = (t) => String(t).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (c) => (c === "\n" || c === "\t" ? c : ""));
export function mdNodes(raw) {
  const out = [], lines = clean(raw).replace(/\r\n?/g, "\n").split("\n");
  const el = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; };
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]); i++; const pre = el("pre"); pre.append(el("code", buf.join("\n"))); out.push(pre); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { out.push(el(`h${Math.min(h[1].length + 2, 6)}`, h[2])); i++; continue; }
    if (/^\s*([-*]|\d+[.)])\s+/.test(l)) { const ol = /^\s*\d/.test(l), list = el(ol ? "ol" : "ul"); for (; i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i]); i++) list.append(el("li", lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, ""))); out.push(list); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) { const t = el("table"); const head = el("tr"); for (const c of cells(l)) head.append(el("th", c)); t.append(head); for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) { const r = el("tr"); for (const c of cells(lines[i])) r.append(el("td", c)); t.append(r); } out.push(t); continue; }
    if (!l.trim()) { i++; continue; }
    const buf = []; for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*([-*]|\d+[.)])\s)/.test(lines[i]); i++) buf.push(lines[i]);
    out.push(el("p", buf.join("\n")));
  }
  return out;
}
class KgView extends HTMLElement {
  // o = { kind: "image", src, name } | { kind: "text", text, name, cut }。閉じる（×）は kg-close を投げて自分を消す
  show(o) {
    this.className = "att-view";
    // W116: 戻る（閉じる）は常に左上・見える名前は basename だけ（全文は title）。重ねる表示は作らない
    const head = document.createElement("div"); head.className = "att-view-head";
    const n = document.createElement("span"); n.className = "att-name"; n.title = o.name || ""; n.textContent = baseName(o.name || "");
    const x = document.createElement("button"); x.type = "button"; x.className = "att-x"; x.title = "閉じる"; x.setAttribute("aria-label", "閉じる"); x.textContent = "×";
    x.addEventListener("click", () => { this.dispatchEvent(new CustomEvent("kg-close", { bubbles: true })); this.remove(); });
    head.append(x, n);
    const body = document.createElement("div"); body.className = "att-view-body";
    if (o.kind === "image") { const i = document.createElement("img"); i.alt = o.name || ""; i.src = o.src; body.append(i); }
    else { body.append(...mdNodes(o.text)); if (o.cut) { const c = document.createElement("p"); c.className = "att-size"; c.textContent = "続きは「保存」で読めます"; body.append(c); } }
    this.replaceChildren(head, body);
  }
}

// DESIGN.md §6: 直径 28px の 1px 円（r=13.5）＋ 16px の chevron-left。viewBox は 20 の格子の外へ 4 広げて 28px で 1 単位 = 1px
const BACK_SVG = ic("back-svg", '<circle class="back-ring" cx="10" cy="10" r="13.5" stroke-width="1"/><path transform="translate(2 2) scale(.8)" d="M13.5 3.5L7 10l6.5 6.5"/>', "-4 -4 28 28");
// W90（CEO 10-14「常に左上にまるで囲まれた＜で前にいたpageに戻れるように。ダブルクリックで一覧に」）: ○ で囲んだ ＜。1 押し = kg-back {to:"prev"}・2 度押し = kg-back {to:"root"}。
// depth="0"（根＝一覧）では薄くして何も投げない（「常に」出すが押せない物を押させない）。画面の stack は受け手（panel.js）が持つ
class KgBack extends HTMLElement {
  static observedAttributes = ["depth"];
  connectedCallback() {
    if (!this._ring) {
      this.setAttribute("role", "button");
      if (!this.getAttribute("aria-label")) this.setAttribute("aria-label", "前の画面へ（2 度押しで一覧）");
      this.tabIndex = 0;
      this._ring = document.createElement("span"); // ○＜ は固定の SVG（円 28px・1px ＋ chevron-left 16px）。hover の面は .ring の背景
      this._ring.className = "ring";
      this._ring.innerHTML = BACK_SVG;
      this.append(this._ring);
      this.addEventListener("click", () => this.go("prev"));
      this.addEventListener("dblclick", () => this.go("root"));
      this.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.go("prev"); } });
    }
    this.paint();
  }
  attributeChangedCallback() { if (this._ring) this.paint(); }
  paint() { const root = this.getAttribute("depth") === "0"; this.setAttribute("aria-disabled", String(root)); }
  go(to) { if (this.getAttribute("depth") === "0") return; this.dispatchEvent(new CustomEvent("kg-back", { bubbles: true, detail: { to } })); }
}


customElements.define("kg-approve", KgApprove);
customElements.define("kg-back", KgBack);
customElements.define("kg-toggle", KgToggle);
customElements.define("kg-row", KgRow);
customElements.define("kg-settings", KgSettings);
customElements.define("kg-toast", KgToast);

// W92（CEO 10-14 §10.3）: agent の設定の画面（icon・名前 1 つ・どの AI・きまり・共に働く agent・消す）。人が決める物だけ・内部語なし。
// 口が在る物（名前 = kg-agent-name {name}・きまり = kg-agent-rule {text}・消す = kg-agent-remove）だけ触れる。口が無い物（icon を変える・どの AI・共に働く agent）は表示だけで「繋がるまで触れません」。
// 消すは 2 段（1 度目は「本当に消す」に変わるだけ・5 秒で戻る・modal は作らない）。文字は textContent だけ（名前に HTML / bidi が来ても字として出る）
class KgAgentSettings extends HTMLElement {
  connectedCallback() {
    if (this._e) return;
    const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? "", ...(text == null ? {} : { textContent: text }) });
    const e = (this._e = { av: el("span", "av"), name: el("input", "agent-name"), save: el("button", "btn", "名前を変える"), ai: el("p", "dim"), rule: el("textarea", "agent-rule"), tell: el("button", "btn", "伝える"), mate: el("p", "dim", "共に働く agent: 繋がるまで触れません"), del: el("button", "btn danger", "この agent を消す") });
    e.name.setAttribute("aria-label", "名前"); e.rule.setAttribute("aria-label", "いつも守らせる事"); e.rule.placeholder = "この agent にいつも守らせる事";
    for (const [b, act] of [[e.save, "name"], [e.tell, "rule"], [e.del, "remove"]]) { b.type = "button"; b.dataset.act = act; }
    this.append(e.av, e.name, e.save, el("p", "dim", "icon を変える: 繋がるまで触れません"), e.ai, e.rule, e.tell, e.mate, e.del);
    this.addEventListener("click", (ev) => {
      const b = ev.target.closest?.("button[data-act]");
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      if (act === "name") { const name = String(e.name.value ?? "").trim(); if (name) this.fire("kg-agent-name", { name }); }
      else if (act === "rule") { const text = String(e.rule.value ?? "").trim(); if (text) { this.fire("kg-agent-rule", { text }); e.rule.value = ""; } }
      else if (!this._armed) { this._armed = true; e.del.textContent = "本当に消す"; this._t = setTimeout(() => this.disarm(), 5000); }
      else { this.disarm(); this.fire("kg-agent-remove", {}); }
    });
  }
  fire(type, detail) { this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail })); }
  disarm() { clearTimeout(this._t); this._armed = false; if (this._e) this._e.del.textContent = "この agent を消す"; }
  // d = { key, glyph, name, prov }。別の agent に替わったら「本当に消す」の途中を戻す（前の agent の確認で次を消さない）
  set data(d) {
    this.connectedCallback();
    const e = this._e;
    if (this._key !== d.key) { this._key = d.key; this.disarm(); e.rule.value = ""; }
    e.av.textContent = d.glyph;
    e.name.value = d.name;
    e.ai.textContent = d.prov ? `どの AI で: ${d.prov}（繋がるまで変えられません）` : "";
    e.ai.hidden = !d.prov;
  }
}
customElements.define("kg-agent-settings", KgAgentSettings);
customElements.define("kg-chip", KgChip);
customElements.define("kg-view", KgView);

// W102: agent 同士の chat の画面側。文字は textContent だけ。roomId はイベントの detail にだけ載せ、画面の文には出さない。
const cutChars = (s, n) => Array.from(s ?? "").slice(0, n).join("");
function clock(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// 吹き出しの上の 1 行。by が空なら作らない（人の会話は header で足りる）。kg-thread と panel の相手側が共有する
export function speakerLine(by, at) {
  if (!by) return null;
  const p = document.createElement("p");
  p.className = "by";
  const name = document.createElement("span");
  name.className = "by-name";
  name.textContent = String(by);
  p.append(name);
  if (at != null && at !== "") {
    const t = document.createElement("time");
    t.textContent = clock(at);
    p.append(t);
  }
  return p;
}
function memberLine(members) {
  return (members ?? []).map((m) => {
    const name = m?.name ?? "";
    const role = cutChars(m?.role ?? "", 30);
    return role ? `${name}（${role}）` : name;
  }).filter(Boolean).join("・");
}

class KgNotice extends HTMLElement {
  static observedAttributes = ["from", "text", "room-id"];
  connectedCallback() {
    if (!this._on) {
      this._on = true;
      this.setAttribute("role", "button");
      this.tabIndex = 0;
      this._line = document.createElement("span");
      this.append(this._line);
      this.addEventListener("click", () => this.open());
      this.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.open(); } });
    }
    this.paint();
  }
  attributeChangedCallback() { if (this._line) this.paint(); }
  get from() { return this.getAttribute("from") ?? ""; }
  set from(v) { this.setAttribute("from", v ?? ""); }
  get text() { return this.getAttribute("text") ?? ""; }
  set text(v) { this.setAttribute("text", v ?? ""); }
  get roomId() { return this.getAttribute("room-id") ?? ""; }
  set roomId(v) { this.setAttribute("room-id", v ?? ""); }
  open() {
    const roomId = this.roomId;
    if (!roomId) return;
    this.dispatchEvent(new CustomEvent("kg-open-thread", { bubbles: true, detail: { roomId } }));
  }
  paint() { this._line.textContent = `message from ${this.from} ・ ${cutChars(this.text, 40)}`; }
}

class KgThread extends HTMLElement {
  connectedCallback() { this.paint(); }
  set data(d) { this._data = d; this.paint(); }
  paint() {
    const d = this._data ?? { room: { members: [] }, rows: [] };
    const head = document.createElement("p");
    head.className = "thread-members";
    head.textContent = memberLine(d.room?.members);
    const body = document.createElement("div");
    body.className = "thread-rows";
    const rows = Array.isArray(d.rows) ? d.rows : [];
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "thread-empty";
      empty.textContent = "まだやり取りはありません";
      body.append(empty);
    } else {
      for (const r of rows) {
        const box = document.createElement("div");
        box.className = "chat-row they";
        const text = document.createElement("p");
        text.className = "chat-text";
        text.textContent = r?.text ?? "";
        const who = speakerLine(`${r?.from ?? ""} → ${r?.to ?? ""}`, r?.at);
        box.append(...(who ? [who, text] : [text]));
        body.append(box);
      }
    }
    this.replaceChildren(head, body);
  }
}
customElements.define("kg-notice", KgNotice);
customElements.define("kg-thread", KgThread);

// W109: 進んでいます。既定は畳む（open を付けない）。開いた時は新しい 4 本と、残りを「ほか N 件」の 1 行。文字は textContent だけ
class KgProgress extends HTMLElement {
  static observedAttributes = ["open"];
  static icon = "";
  static tick = "";
  connectedCallback() { this.paint(); }
  get open() { return this.hasAttribute("open"); }
  set open(v) {
    const on = !!v;
    if (on === this.hasAttribute("open")) return;
    this.toggleAttribute("open", on);
  }
  set steps(v) {
    const next = Array.isArray(v) ? v.map((s) => String(s)) : [];
    const sig = JSON.stringify(next);
    if (sig === this._sig && this._fold) return;
    this._sig = sig;
    this._steps = next;
    this.paint();
  }
  attributeChangedCallback() { this.paint(); }
  paint() {
    if (!this._fold) {
      this.classList.add("card");
      const t = document.createElement("div");
      t.className = "t";
      if (KgProgress.icon) t.append(iconSpan(KgProgress.icon));
      const label = document.createElement("span");
      label.textContent = "進んでいます";
      const fold = document.createElement("button");
      fold.type = "button";
      fold.className = "r";
      fold.addEventListener("click", () => {
        this.open = !this.hasAttribute("open");
        this.dispatchEvent(new CustomEvent("kg-fold", { bubbles: true, detail: { open: this.hasAttribute("open") } }));
      });
      t.append(label, fold);
      this.append(t);
      this._fold = fold;
    }
    const on = this.hasAttribute("open");
    this._fold.textContent = on ? "たたむ" : "ひらく";
    this._fold.setAttribute("aria-expanded", String(on));
    this._list?.remove();
    this._list = null;
    if (!on) return;
    const all = this._steps ?? [];
    const shown = all.slice(-4);
    const rest = all.length - shown.length;
    const list = document.createElement("div");
    list.className = "steps";
    const lines = shown.length ? shown : ["考え中…"];
    for (const [i, x] of lines.entries()) {
      const last = i === lines.length - 1;
      const row = document.createElement("div");
      row.className = last ? "step now" : "step";
      if (last) row.append(dots());
      else if (KgProgress.tick) row.append(iconSpan(KgProgress.tick));
      const name = document.createElement("span");
      name.textContent = x;
      row.append(name);
      list.append(row);
    }
    if (rest > 0) {
      const more = document.createElement("div");
      more.className = "step";
      more.textContent = `ほか ${rest} 件`;
      list.append(more);
    }
    this._list = list;
    this.append(list);
  }
}
function iconSpan(html) { const s = document.createElement("span"); s.innerHTML = html; return s; }
function dots() { const s = document.createElement("span"); s.className = "dots"; s.append(document.createElement("i"), document.createElement("i"), document.createElement("i")); return s; }
customElements.define("kg-progress", KgProgress);
