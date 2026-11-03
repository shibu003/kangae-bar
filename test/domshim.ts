// 最小の DOM の代役（本物のブラウザ・ポインタに触れない・W77b/c の kg-* の属性→描画とイベントだけを測る）。実機の見た目は別（要 operator）
export class El {
  tagName: string; children: any[] = []; parent: El | null = null; attrs = new Map<string, string>(); dataset: Record<string, string> = {}; style: Record<string, string> = {};
  className = ""; _text = ""; innerHTML = ""; hidden = false; tabIndex = 0; listeners = new Map<string, { f: (e: any) => void; capture: boolean }[]>(); connected = false;
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  get classList() { const o = this; const has = (c: string) => o.className.split(" ").includes(c); return { add: (c: string) => { if (!has(c)) o.className = `${o.className} ${c}`.trim(); }, contains: has, toggle: (c: string, on = !has(c)) => { if (on) { if (!has(c)) o.className = `${o.className} ${c}`.trim(); } else o.className = o.className.split(" ").filter((x) => x && x !== c).join(" "); return on; } }; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children.at(-1) ?? null; }
  get isConnected() { return this.connected; }
  setAttribute(k: string, v: string) { const had = this.attrs.get(k); this.attrs.set(k, String(v)); if (had !== String(v)) (this as any).attributeChangedCallback?.(k); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string) { return this.attrs.has(k); }
  toggleAttribute(k: string, on: boolean) { if (on && !this.attrs.has(k)) this.setAttribute(k, ""); else if (!on && this.attrs.has(k)) { this.attrs.delete(k); (this as any).attributeChangedCallback?.(k); } }
  append(...n: El[]) { for (const x of n) { x.parent = this; this.children.push(x); x.connect(this.connected); } }
  prepend(...n: El[]) { for (const x of n) { x.parent = this; x.connect(this.connected); } this.children.unshift(...n); }
  replaceChildren(...n: El[]) { this.children = []; this.append(...n); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  connect(on: boolean) { this.connected = on; if (on) (this as any).connectedCallback?.(); for (const c of this.children) c.connect(on); }
  matches(sel: string) { const m = /^(\w+)(?:\[data-(\w+)\])?$/.exec(sel); return !!m && this.tagName === m[1]!.toUpperCase() && (!m[2] || m[2] in this.dataset); }
  closest(sel: string): El | null { return this.matches(sel) ? this : this.parent?.closest(sel) ?? null; }
  querySelectorAll(sel: string): El[] { return this.children.flatMap((c) => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]); }
  addEventListener(t: string, f: (e: any) => void, capture = false) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), { f, capture }]); }
  dispatchEvent(e: any) {
    e.target ??= this; e.stopped = false;
    const up: El[] = []; for (let n: El | null = this.parent; n; n = n.parent) up.unshift(n);
    for (const n of up) for (const l of n.listeners.get(e.type) ?? []) if (l.capture) l.f(e); // 捕まえる段（根 → 手前）
    for (let n: El | null = this; n && !e.stopped; n = e.bubbles ? n.parent : null) for (const l of n.listeners.get(e.type) ?? []) if (!l.capture || n === this) l.f(e);
    return true;
  }
  click() { if (!(this as any).disabled) this.dispatchEvent({ type: "click", bubbles: true, target: this, stopPropagation() { this.stopped = true; } }); }
}
export class Plain extends El { type = ""; title = ""; checked = false; disabled = false; open = false; } // 本物の button / input / label / details（部品の element は自前の setter を持つ）
const registry = new Map<string, any>();
const g = globalThis as any;
export async function installDom() {
  g.HTMLElement = El;
  g.CustomEvent = class { type: string; bubbles: boolean; detail: unknown; target: unknown; constructor(t: string, o: any = {}) { this.type = t; this.bubbles = !!o.bubbles; this.detail = o.detail; } };
  g.document = { createElement: (t: string) => { const C = registry.get(t); return C ? new C() : new Plain(t); } };
  g.customElements = { define: (n: string, C: any) => registry.set(n, C) };
  await import(`../extension/kg.js?${Math.random()}`);
}
export const mount = (tag: string, attrs: Record<string, string> = {}) => { const e = g.document.createElement(tag) as El; for (const [k, v] of Object.entries(attrs)) e.attrs.set(k, v); const root = new El("div"); root.connected = true; root.append(e); return e; };
