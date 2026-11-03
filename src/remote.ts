// スマホで操作（R1）: Mac の常駐が 127.0.0.1 に小さな HTTP / WS server を立て、cloudflared（src/tunnel.ts）が https の道を張る。
// QR = <URL>/#k=<一度きりの 32 byte>。URL を知っているだけでは入れない: 中身は全部 k から作った AES-GCM で包む（edge は暗号文しか見ない）。
// 一度きり = 表示から 90 秒・1 台・使ったら無効。許可が出るまで一覧は返さない。許可した端末の公開鍵（ECDSA）と ds は鍵束（Keychain）に置く＝鍵の file を作らない。
// 暗号の本体は extension/wire.js（スマホと同じ file）。R1 は「一覧を見せる」まで（会話の送信・承認の回答・起動は R2 以降）。
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { Chan, authBytes, b64, base, deviceId, pairCode, pairKey, rand, sessionKey, unb64 } from "../extension/wire.js";
import { create as qrCreate } from "./vendor/qrcode.js";
import { startTunnel, type TunnelResult } from "./tunnel.ts";

export type Row = { id: number; name: string; state: "turn" | "work" | "fail" | "neutral"; label: string; last?: string; stopped?: boolean; canResume?: boolean }; // stopped = 止まった担当（スマホの起動の画面に行く）・canResume = Mac で「スマホから再開してよい」を入れた担当
export type DeviceRec = { id: string; pub: { kty: string; crv: string; x: string; y: string }; ds: string; name: string; at: number };
// R2: 会話の読み・送る・承認に答える。常駐（main.ts の remoteBridge）が、人の panel と同じ op を呼んで答える
export type Msg = { id: number; mine: boolean; via: "phone" | null; name: string; text: string; at: number };
export type Appr = { id: string; ver: number; text: string; app: string; danger: boolean };
export type Conv = { name: string; state: Row["state"]; label: string; rows: Msg[]; approvals: Appr[]; more: boolean };
export type Answered = "answered" | "already" | "stale" | "mac-only";
// R3: 起動の結果。unreachable（この Mac につながらない）はスマホ側が言う（返事が来ない）。ここに来るのは Mac まで届いた結果
export type Started = "running" | "starting" | "needsLocalApproval" | "helperUnavailable" | "stale" | "gone";
export type Bridge = {
  resume(conv: number, expected: string, device: { id: string; name: string }): Promise<{ result: Started; hint?: string }>; // 許した担当の再開だけ（許していなければ needsLocalApproval）
  launch(device: { id: string; name: string }): Promise<{ result: "running" | "starting" | "helperUnavailable"; hint?: string }>; // 閉じた Bar を裏で起こす（前面・focus・clipboard を取らない）
  bar(): Promise<boolean | null>; // 画面（Bar）が開いているか。null = 入っていない・分からない
  allowed(): number[]; // スマホから再開してよい担当（root の id）
  setAllowed(id: number, on: boolean): void;
  messages(id: number, before: number | null, limit: number): Promise<Conv | null>;
  send(id: number, text: string, device: { id: string; name: string }): Promise<{ ok: boolean; hint?: string; row?: number }>;
  answer(conv: number, approval: string, allow: boolean, ver: number, device: { id: string; name: string }): Promise<Answered>; // 今回だけ（always・この頼みの間は引数に無い）
};
export type DeviceStore = { load(): Promise<DeviceRec[]>; save(d: DeviceRec[]): Promise<void> };

const OFFER_MS = 90_000; // QR の寿命 = 読むまで 90 秒。読んだ後の「許可」を待つのも 90 秒
const MAX_DEVICES = 8;
const SEND_MAX = 4000, PAGE = 20;
const RID = /^[\w-]{8,64}$/;
const RESUME_KEYS = new Set(["ev", "conv", "status", "rid"]);
const ANSWER_KEYS = new Set(["ev", "conv", "approval", "allow", "ver", "rid"]); // 答えに載せてよい欄はこれだけ（always・scope・choice は受けない）
const LAN_NOTE = "外から入れません（Wi-Fi 内だけ）";

// 許した端末は鍵束へ（file にしない）。1 行 4000 字までの `security -i` に収まる分だけ（古い順に外す）
export function keychainStore(service = "kangae-remote"): DeviceStore {
  const enc = (d: DeviceRec[]) => Buffer.from(JSON.stringify(d)).toString("base64url");
  return {
    async load() {
      const p = Bun.spawn(["security", "find-generic-password", "-s", service, "-a", "devices", "-w"], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) return []; // 無い = 空
      try { return JSON.parse(Buffer.from(out.trim(), "base64url").toString()); } catch { return []; }
    },
    async save(d) {
      let v = enc(d);
      while (v.length > 3800 && d.length > 1) v = enc((d = d.slice(1)));
      const p = Bun.spawn(["security", "-i"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" }); // 値を argv に出さない
      p.stdin.write(`add-generic-password -U -s ${service} -a devices -w ${v}\n`);
      p.stdin.end();
      if ((await p.exited) !== 0) throw new Error("keychain");
    },
  };
}
export function memoryStore(): DeviceStore {
  let d: DeviceRec[] = [];
  return { load: async () => d, save: async (x) => void (d = x) };
}

export function lanIp(): string | null {
  for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  return null;
}

function qrDataUrl(text: string): string {
  const { size, data } = qrCreate(text, { errorCorrectionLevel: "M" }).modules as { size: number; data: Uint8Array };
  const q = 4, n = size + q * 2;
  let d = "";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y * size + x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const cleanJwk = (j: any) => j && j.kty === "EC" && j.crv === "P-256" && /^[\w-]{40,50}$/.test(j.x) && /^[\w-]{40,50}$/.test(j.y) ? { kty: "EC", crv: "P-256", x: j.x as string, y: j.y as string } : null;
const cleanName = (n: unknown) => String(n ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 24) || "スマホ";

type Offer = { k: Uint8Array; exp: number; state: "open" | "claimed" | "used" | "void"; fails: number; qr: string };
type Sess = {
  ws: ServerWebSocket<Sess> | null;
  step: "new" | "chal" | "wait" | "live";
  chan: Chan | null; id: string | null; dev: DeviceRec | null; n: Uint8Array | null;
  hello: { pub: DeviceRec["pub"]; name: string; code: string } | null;
  rx: Promise<unknown>; tx: Promise<unknown>; sent: string; sentAt: number; timer: ReturnType<typeof setTimeout> | null;
  open: number | null; convSent: string; sends: number[]; // open = 今開いている会話（その会話の変化だけ押す）
};

const FILES: Record<string, [string, string]> = {
  "/": ["phone.html", "text/html; charset=utf-8"],
  "/phone.js": ["phone.js", "text/javascript; charset=utf-8"],
  "/wire.js": ["wire.js", "text/javascript; charset=utf-8"],
  "/phone-ui.js": ["phone-ui.js", "text/javascript; charset=utf-8"],
};

export function createRemote(o: {
  list: () => Promise<Row[]>;
  extDir: string;
  store: DeviceStore;
  now?: () => number;
  tunnel?: (port: number, onExit: () => void) => Promise<TunnelResult>;
  lan?: () => string | null;
  conv?: Bridge;
  qr?: (text: string) => string; // 試験: QR にする文字をそのまま受ける
  onChange?: () => void;
}) {
  const now = o.now ?? Date.now;
  const change = () => o.onChange?.();
  let devices: DeviceRec[] | null = null;
  let storeNote: string | null = null;
  const load = async () => (devices ??= await o.store.load().catch(() => []));
  type Srv = { stop(f?: boolean): unknown; port: number };
  let local: Srv | null = null; // 127.0.0.1（cloudflared が届ける先）
  let lanSrv: { ip: string; sv: Srv } | null = null; // 道が無い時だけの、同じ Wi-Fi 用の口
  let route: { kind: "tunnel" | "lan"; base: string; note: string | null; stop?: () => void } | null = null;
  let starting: Promise<void> | null = null;
  let failure: string | null = null;
  let offer: Offer | null = null;
  let pending: Sess | null = null;
  const live = new Set<Sess>();
  let tick: ReturnType<typeof setInterval> | null = null;

  const fresh = (): Sess => ({ ws: null, step: "new", chan: null, id: null, dev: null, n: null, hello: null, rx: Promise.resolve(), tx: Promise.resolve(), sent: "", sentAt: 0, timer: null, open: null, convSent: "", sends: [] });
  const hang = (s: Sess, code: number) => { if (s.timer) clearTimeout(s.timer); try { s.ws?.close(code); } catch {} };
  // 送る・受けるは 1 本ずつ（通し番号の順を守る）
  const send = (s: Sess, obj: unknown) => (s.tx = s.tx.then(async () => { if (s.chan && s.ws) s.ws.send(JSON.stringify(await s.chan.seal(obj))); }).catch(() => hang(s, 4403)));

  // 画面（Bar）が開いているか: process を見る問い合わせなので 10 秒に 1 回だけ（全部の接続で共有）
  let barAt = -Infinity, barOpen: boolean | null = null;
  async function barNow() {
    if (!o.conv || now() - barAt < 10_000) return barOpen;
    barAt = now();
    barOpen = await o.conv.bar().catch(() => null);
    return barOpen;
  }
  async function push(s: Sess, force: boolean) {
    const rows = await o.list().catch(() => [] as Row[]);
    const bar = await barNow();
    const json = JSON.stringify([rows, bar]);
    if (!force && json === s.sent && now() - s.sentAt < 10_000) return; // 変わった時だけ送る（10 秒に 1 回は生きている印）
    s.sent = json; s.sentAt = now();
    void send(s, { ev: "list", rows, bar });
  }
  async function pushConv(s: Sess, force: boolean) {
    if (s.open == null || !o.conv) return;
    const id = s.open;
    const c = await o.conv.messages(id, null, PAGE).catch(() => null);
    if (s.open !== id) return;
    if (!c) { s.open = null; s.convSent = ""; void send(s, { ev: "gone", conv: id }); return; }
    const json = JSON.stringify(c);
    if (!force && json === s.convSent) return;
    s.convSent = json;
    void send(s, { ev: "conv", conv: id, ...c });
  }
  const pushOpen = (id: number) => { for (const s of live) if (s.open === id) void pushConv(s, false); };

  // 同じ request_id の 2 度目は、もう一度やらずに同じ結果を返す（スマホは通信が切れると同じ依頼を送り直す）。成功（と、Mac に行が入った失敗）だけ覚える
  const done = new Map<string, Promise<{ final: boolean; [k: string]: unknown }>>();
  async function once(s: Sess, ev: any, kind: "sent" | "answered" | "resumed" | "launched", fn: () => Promise<{ final: boolean; [k: string]: unknown }>) {
    const rid = String(ev?.rid ?? "");
    if (!RID.test(rid)) return void send(s, { ev: "err", rid: "", kind, hint: "うまくいきませんでした。もう一度試してください" });
    const key = `${s.id}|${rid}`;
    const hit = done.get(key);
    let p = hit;
    if (!p) {
      p = fn().catch(() => ({ final: false, ok: false, hint: "うまくいきませんでした。もう一度試してください" }));
      done.set(key, p);
      if (done.size > 300) done.delete(done.keys().next().value!);
      void p.then((r) => { if (!r.final) done.delete(key); });
    }
    const { final, ...r } = await p;
    void send(s, { ev: kind, rid, ...r, ...(hit ? { again: true } : {}) });
  }

  async function doSend(s: Sess, ev: any) {
    const text = typeof ev.text === "string" ? ev.text.trim() : "";
    const id = Number(ev.conv);
    if (!s.dev && !s.id) return { final: false, ok: false, hint: "つながっていません" };
    if (!Number.isInteger(id) || !text || text.length > SEND_MAX) return { final: false, ok: false, hint: text.length > SEND_MAX ? `長すぎます（${SEND_MAX} 字まで）` : "一言を入れてください" };
    const t = now();
    s.sends = s.sends.filter((x) => t - x < 60_000);
    if (s.sends.length >= 30) return { final: false, ok: false, hint: "送りすぎです。少し待ってからもう一度" };
    s.sends.push(t);
    const r = await o.conv!.send(id, text, { id: s.id!, name: s.dev?.name ?? "スマホ" });
    pushOpen(id);
    // 成功だけ「送りました」と言える。Mac の会話に行が入ったのに agent が動けなかった時は、同じ文を送り直させない（行が 2 つになる）
    return r.ok ? { final: true, ok: true, row: r.row } : { final: r.row != null, ok: false, row: r.row, hint: r.row != null ? "Mac の会話には入りましたが、agent を動かせませんでした" : r.hint ?? "送れませんでした" };
  }

  async function doAnswer(s: Sess, ev: any) {
    // always allow・この頼みの間・選択肢の指定は受けない（今回の allow / deny だけ）。欄が 1 つでも多ければ断る
    if (Object.keys(ev).some((k) => !ANSWER_KEYS.has(k))) return { final: true, ok: false, result: "refused", hint: "「いつも許す」はスマホからは選べません（Mac だけ）" };
    const id = Number(ev.conv);
    if (!Number.isInteger(id) || typeof ev.approval !== "string" || ev.approval.length > 64 || typeof ev.allow !== "boolean" || !Number.isFinite(ev.ver)) return { final: true, ok: false, result: "refused", hint: "うまくいきませんでした。もう一度試してください" };
    const r = await o.conv!.answer(id, ev.approval, ev.allow, Number(ev.ver), { id: s.id!, name: s.dev?.name ?? "スマホ" });
    pushOpen(id);
    const hint = { answered: "", already: "もう答えてあります", stale: "承認の内容が変わりました。もう一度見てください", "mac-only": "取り返しがつかないかもしれない操作は、Mac で答えてください" }[r];
    return { final: true, ok: r === "answered", result: r, ...(hint ? { hint } : {}) };
  }

  // R3: 再開（許した担当だけ・Mac で動いたのを見てから「動いています」）と、閉じた Bar を裏で起こす
  async function doResume(s: Sess, ev: any) {
    if (Object.keys(ev).some((k) => !RESUME_KEYS.has(k))) return { final: true, ok: false, result: "refused", hint: "うまくいきませんでした。もう一度試してください" };
    const id = Number(ev.conv);
    if (!Number.isInteger(id) || typeof ev.status !== "string" || ev.status.length > 20) return { final: true, ok: false, result: "refused", hint: "うまくいきませんでした。もう一度試してください" };
    const r = await o.conv!.resume(id, ev.status, { id: s.id!, name: s.dev?.name ?? "スマホ" });
    pushOpen(id); void push(s, true);
    // 動いた / 起こし中だけが成功。それ以外は理由を返し、同じ rid の送り直しでもう一度試せる
    return { final: r.result === "running" || r.result === "starting", ok: r.result === "running" || r.result === "starting", result: r.result, ...(r.hint ? { hint: r.hint } : {}) };
  }
  async function doLaunch(s: Sess) {
    const r = await o.conv!.launch({ id: s.id!, name: s.dev?.name ?? "スマホ" });
    barAt = -Infinity;
    void push(s, true);
    return { final: r.result !== "helperUnavailable", ok: r.result !== "helperUnavailable", result: r.result, ...(r.hint ? { hint: r.hint } : {}) };
  }

  async function onLive(s: Sess, ev: any) {
    switch (ev?.ev) {
      case "list": return push(s, true);
      case "open": { // 会話を開く（以後その会話の変化を押す）。before があれば古い方の続き
        const id = Number(ev.conv);
        if (!o.conv || !Number.isInteger(id)) return void send(s, { ev: "gone", conv: ev.conv });
        if (ev.before != null) {
          const c = await o.conv.messages(id, Number(ev.before), PAGE).catch(() => null);
          return void send(s, c ? { ev: "older", conv: id, rows: c.rows, more: c.more } : { ev: "gone", conv: id });
        }
        s.open = id; s.convSent = "";
        return pushConv(s, true);
      }
      case "close": s.open = null; s.convSent = ""; return;
      case "send": return o.conv ? once(s, ev, "sent", () => doSend(s, ev)) : void 0;
      case "answer": return o.conv ? once(s, ev, "answered", () => doAnswer(s, ev)) : void 0;
      case "resume": return o.conv ? once(s, ev, "resumed", () => doResume(s, ev)) : void 0;
      case "launch": return o.conv ? once(s, ev, "launched", () => doLaunch(s)) : void 0;
    }
  }

  function ensureTick() {
    if (tick || !live.size) return;
    tick = setInterval(() => { if (!live.size && tick) { clearInterval(tick); tick = null; } for (const s of live) { void push(s, false); void pushConv(s, false); } }, 2000);
    tick.unref();
  }

  function newOffer() {
    if (offer && offer.state !== "used") offer.state = "void";
    if (pending) { hang(pending, 4410); pending = null; }
    const k = rand(32);
    offer = { k, exp: now() + OFFER_MS, state: "open", fails: 0, qr: (o.qr ?? qrDataUrl)(`${route!.base}/#k=${b64(k)}`) };
  }

  async function pair(s: Sess, m: any) {
    const f = offer;
    if (!f || f.state !== "open" || now() > f.exp) return hang(s, 4410);
    const ch = new Chan(await pairKey(f.k), "m");
    let hello: any;
    try { hello = await ch.open(m); } catch { if (++f.fails >= 5) { f.state = "void"; change(); } return hang(s, 4403); } // 5 回外したらその QR は捨てる
    if (f.state !== "open") return hang(s, 4410); // 並行して来た別の 1 台が先に読んだ
    const pub = cleanJwk(hello?.pub);
    if (hello?.ev !== "hello" || !pub) return hang(s, 4403);
    f.state = "claimed"; f.exp = now() + OFFER_MS;
    if (s.timer) clearTimeout(s.timer);
    s.step = "wait"; s.chan = ch; s.hello = { pub, name: cleanName(hello.name), code: await pairCode(pub) };
    pending = s;
    setTimeout(() => { if (pending === s) { pending = null; hang(s, 4410); change(); } }, OFFER_MS).unref();
    void send(s, { ev: "wait", code: s.hello.code });
    change();
  }

  async function auth(s: Sess, m: any) {
    const d = (await load()).find((x) => x.id === m?.id);
    if (!d) return hang(s, 4401);
    s.dev = d; s.n = rand(16); s.step = "chal";
    s.ws!.send(JSON.stringify({ t: "chal", n: b64(s.n) }));
  }
  async function sig(s: Sess, m: any) {
    const d = s.dev!;
    const np = unb64(m?.np), sg = unb64(m?.sig);
    if (np.length !== 16) return hang(s, 4403);
    const key = await crypto.subtle.importKey("jwk", d.pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sg, authBytes(d.id, s.n!, np))) || !(await load()).some((x) => x.id === d.id)) return hang(s, 4401);
    if (s.timer) clearTimeout(s.timer);
    s.chan = new Chan(await sessionKey(await base(unb64(d.ds)), s.n!, np), "m");
    s.step = "live"; s.id = d.id; live.add(s);
    void send(s, { ev: "ready" });
    void push(s, true);
    ensureTick(); change();
  }

  async function onMessage(s: Sess, raw: string | Buffer) {
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return hang(s, 4400); }
    try {
      if (s.step === "new") return m?.t === "pair" ? await pair(s, m) : m?.t === "auth" ? await auth(s, m) : hang(s, 4400);
      if (s.step === "chal") return m?.t === "sig" ? await sig(s, m) : hang(s, 4400);
      if (s.step === "live") return await onLive(s, await s.chan!.open(m)); // 開けない（鍵違い・番号違い）= 切る
      hang(s, 4400); // 許可待ちの間にスマホから来る物は無い
    } catch { hang(s, 4403); }
  }

  const FRAME = (host: string) => `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' wss://${host} ws://${host}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const handlers = {
    async fetch(req: Request, srv: any) {
      const u = new URL(req.url);
      const host = req.headers.get("host") ?? "";
      if (u.pathname === "/healthz") return new Response("kangae", { headers: { "cache-control": "no-store" } });
      if (u.pathname === "/ws") {
        const org = req.headers.get("origin"); // ブラウザは必ず付ける。別の頁（別 origin）からの WS を断る
        if (org && (() => { try { return new URL(org).host !== host; } catch { return true; } })()) return new Response("forbidden", { status: 403 });
        if (srv.pendingWebSockets >= 16) return new Response("busy", { status: 503 });
        return srv.upgrade(req, { data: fresh() }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const f = FILES[u.pathname];
      if (!f || !/^[\w.:-]+$/.test(host)) return new Response("not found", { status: 404 });
      const file = Bun.file(join(o.extDir, f[0]));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, { headers: { "content-type": f[1], "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", ...(f[0] === "phone.html" ? { "content-security-policy": FRAME(host) } : {}) } });
    },
    websocket: {
      maxPayloadLength: 64 * 1024,
      open(ws: ServerWebSocket<Sess>) {
        const s = ws.data; s.ws = ws;
        s.timer = setTimeout(() => { if (s.step === "new" || s.step === "chal") hang(s, 4408); }, 20_000); // 20 秒で名乗れない口は切る
      },
      message(ws: ServerWebSocket<Sess>, raw: string | Buffer) { const s = ws.data; s.rx = s.rx.then(() => onMessage(s, raw)).catch(() => hang(s, 4403)); },
      close(ws: ServerWebSocket<Sess>) {
        const s = ws.data;
        if (s.timer) clearTimeout(s.timer);
        live.delete(s);
        if (pending === s) { pending = null; if (offer?.state === "claimed") offer.state = "void"; }
        change();
      },
    },
  };

  const listen = (hostname: string) => Bun.serve<Sess>({ hostname, port: 0, ...(handlers as any) }) as unknown as Srv;

  async function boot() {
    route?.stop?.(); route = null; // 押し直し: 前の道は捨てて、cloudflared をもう一度試す
    local ??= listen("127.0.0.1");
    const r = await (o.tunnel ?? ((p, ex) => startTunnel(p, ex)))(local.port, () => { // cloudflared が落ちた: 道が無い・古い QR も無効
      if (route?.kind === "tunnel") { route.stop?.(); route = null; failure = "外からの道が切れました"; if (offer && offer.state !== "used") offer.state = "void"; for (const s of live) hang(s, 1001); change(); }
    });
    if (r.ok) { lanSrv?.sv.stop(true); lanSrv = null; route = { kind: "tunnel", base: r.url, note: null, stop: r.stop }; return; }
    const ip = (o.lan ?? lanIp)();
    if (!ip) { failure = `${r.why}。同じ Wi-Fi の URL も作れませんでした`; return; }
    if (lanSrv?.ip !== ip) { lanSrv?.sv.stop(true); lanSrv = { ip, sv: listen(ip) }; }
    route = { kind: "lan", base: `http://${ip}:${lanSrv.sv.port}`, note: `${LAN_NOTE}（${r.why}）` };
  }

  const status = async () => {
    const f = offer, t = now();
    const open = f?.state === "open" && t <= f.exp;
    return {
      ok: true as const,
      phase: starting ? "starting" : failure && !route ? "error" : open ? "offer" : f?.state === "claimed" && pending ? "claimed" : f?.state === "open" ? "expired" : "idle",
      hint: failure,
      route: route?.kind ?? null,
      note: route?.note ?? null,
      storeNote,
      qr: open ? f!.qr : null,
      expiresIn: open ? Math.max(0, Math.ceil((f!.exp - t) / 1000)) : 0,
      pending: pending?.hello ? { name: pending.hello.name, code: pending.hello.code } : null,
      agents: o.conv ? await (async () => { const ok = new Set(o.conv!.allowed()); return (await o.list().catch(() => [] as Row[])).map((r) => ({ id: r.id, name: r.name, allowed: ok.has(r.id) })); })() : [],
      devices: (await load()).map((d) => ({ id: d.id, name: d.name, at: d.at, online: [...live].some((s) => s.id === d.id) })),
    };
  };

  return {
    status,
    // 「スマホで操作」を押した時。server と道は 1 回だけ起こし、QR は押すたびに新しくする（前の QR は無効）
    async start() {
      if (!route || failure || route.kind === "lan") { failure = null; starting ??= boot().catch((e) => { failure = String(e?.message ?? e); }).finally(() => { starting = null; change(); }); change(); await starting; }
      else await starting;
      if (route) newOffer();
      change();
      return status();
    },
    // Mac で「このスマホを許可」を押した時だけ
    async allow() {
      const s = pending, f = offer;
      if (!s || !f || f.state !== "claimed" || now() > f.exp) return { ok: false as const, hint: "期限が切れました。もう一度 QR を出してください" };
      const { pub, name } = s.hello!;
      const rec: DeviceRec = { id: await deviceId(pub), pub, ds: b64(rand(32)), name, at: now() };
      const all = [...(await load()).filter((d) => d.id !== rec.id), rec].slice(-MAX_DEVICES);
      try { await o.store.save(all); storeNote = null; } catch { storeNote = "この Mac の鍵束に覚えられませんでした（Kangae を止めるまでは QR なしで入れます）"; }
      devices = all;
      f.state = "used"; pending = null;
      s.step = "live"; s.id = rec.id; s.dev = rec; live.add(s);
      void send(s, { ev: "paired", id: rec.id, ds: rec.ds });
      void push(s, true);
      ensureTick(); change();
      return { ok: true as const };
    },
    // R3: この担当を、スマホから再開してよいことにする / 戻す（Mac の画面だけ）
    setResume(id: number, on: boolean) { o.conv?.setAllowed(id, on); change(); return { ok: !!o.conv }; },
    // 「許可しない」「QR をやめる」（画面を離れる時も）: 使われていない QR はここで無効
    cancel() {
      if (offer && offer.state !== "used") offer.state = "void";
      if (pending) { hang(pending, 4403); pending = null; } // 4403 = スマホには「この QR は使えません」と出る
      change();
      return { ok: true as const };
    },
    // id を省くと全部。開いている接続も次の瞬間に切る
    async revoke(id?: string) {
      const keep = id ? (await load()).filter((d) => d.id !== id) : [];
      try { await o.store.save(keep); } catch {}
      devices = keep;
      for (const s of [...live]) if (!id || s.id === id) hang(s, 4401);
      change();
      return { ok: true as const };
    },
    stop() {
      route?.stop?.(); route = null;
      local?.stop(true); lanSrv?.sv.stop(true); local = lanSrv = null;
      if (tick) clearInterval(tick);
    },
  };
}
