// スマホ ⇄ Mac の暗号（WebCrypto だけ）。phone.js（スマホのブラウザ）と src/remote.ts（常駐・Bun）が同じ物を読む＝両側で違う実装にならない。
// 鍵: QR の k（一度きり）→ HKDF → 最初の 1 本の AES-GCM 鍵。2 回目以降は、許可の時に渡す ds → HKDF（接続ごとの nonce つき）。
// 頁の JS が鍵の値を読み戻せないよう、取り込む鍵は extractable=false。

const te = new TextEncoder(), td = new TextDecoder();

export const b64 = (u) => { let s = ""; for (const c of u) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
export const unb64 = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
export const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
export const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

export const base = (raw) => crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
const derive = (b, salt, info) => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode(info) }, b, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
export const pairKey = async (k) => derive(await base(k), te.encode("kangae-r1"), "pair"); // k = QR の 32 byte
export const sessionKey = (dsBase, n, np) => derive(dsBase, cat(n, np), "session"); // dsBase = base(ds)

// 端末の識別と、Mac の画面とスマホの画面に出す 4 桁（QR を写真で撮った別の端末が先に読んだ時、人が気付ける）
const sha = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s)));
export const deviceId = async (jwk) => b64(await sha(`${jwk.x}.${jwk.y}`)).slice(0, 22);
export const pairCode = async (jwk) => { const h = await sha(`code:${jwk.x}.${jwk.y}`); return String(((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0).slice(-4).padStart(4, "0"); };
export const authBytes = (id, n, np) => cat(te.encode(`kangae-r1/auth:${id}:`), n, np); // スマホが署名する物（接続ごとに n・np が変わる＝使い回せない）

// 向きと通し番号つきの 1 本の道。AAD に向き（m = Mac が送る / p = スマホが送る）と番号を入れる＝反射・再生・順序の入れ替えは復号できない。
// 送る側は seal を 1 本ずつ（並べて呼ばない）。受ける側は open を 1 本ずつ。
export class Chan {
  constructor(key, me) { this.key = key; this.me = me; this.out = 0; this.in = 0; }
  async seal(obj) {
    const q = this.out++, iv = rand(12);
    const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(`${this.me}${q}`) }, this.key, te.encode(JSON.stringify(obj)));
    return { i: b64(iv), q, c: b64(new Uint8Array(c)) };
  }
  async open(f) {
    if (!f || f.q !== this.in || typeof f.i !== "string" || typeof f.c !== "string") throw new Error("frame");
    const peer = this.me === "m" ? "p" : "m";
    const p = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(f.i), additionalData: te.encode(`${peer}${f.q}`) }, this.key, unb64(f.c));
    this.in++;
    return JSON.parse(td.decode(p));
  }
}
