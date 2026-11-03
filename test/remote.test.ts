// R1: スマホで操作。本物の server に、スマホと同じ extension/wire.js で話す偽のスマホをつなぐ（cloudflared は使わない・LAN の道 = 127.0.0.1）
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Chan, authBytes, b64, base, deviceId, pairKey, rand, sessionKey, unb64 } from "../extension/wire.js";
import { createRemote, memoryStore, type Bridge, type Row } from "../src/remote.ts";
import type { BarProbe } from "../src/launchbar.ts";

const extDir = join(import.meta.dir, "../extension");
let clock = 1_000_000;
let rows: Row[] = [{ id: 1, name: "調べ物", state: "turn", label: "あなたの番です" }];
let lastQr = "";
const store = memoryStore();
const remote = createRemote({
  list: async () => rows, extDir, store, now: () => clock, lan: () => "127.0.0.1", qr: (t) => (lastQr = t),
  tunnel: async () => ({ ok: false, why: "cloudflared が入っていません" }),
});
afterAll(() => remote.stop());

const parse = () => { const u = new URL(lastQr.replace("/#", "/?")); return { base: u.origin, k: unb64(u.searchParams.get("k")!) }; };

// 偽のスマホ: 1 本の ws。frames = 来た物（暗号文）を順に溜める・closed = 切れた code
function phone(baseUrl: string) {
  const ws = new WebSocket(baseUrl.replace("http", "ws") + "/ws");
  const q: any[] = [];
  const waits: ((m: any) => void)[] = [];
  let closed: number | null = null;
  const closing: ((c: number) => void)[] = [];
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); const w = waits.shift(); w ? w(m) : q.push(m); };
  ws.onclose = (e) => { closed = e.code; closing.splice(0).forEach((f) => f(e.code)); };
  return {
    ws,
    opened: new Promise<void>((r) => (ws.onopen = () => r())),
    next: () => new Promise<any>((r) => (q.length ? r(q.shift()) : waits.push(r))),
    closed: () => new Promise<number>((r) => (closed !== null ? r(closed) : closing.push(r))),
    send: (o: unknown) => ws.send(JSON.stringify(o)),
    queued: () => q.length,
  };
}
const newKeys = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const j = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const pub = { kty: j.kty!, crv: j.crv!, x: j.x!, y: j.y! };
  return { pair, pub, id: await deviceId(pub) };
};
async function pairUp(name = "iPhone") {
  const { base: b, k } = parse();
  const dev = await newKeys();
  const p = phone(b);
  await p.opened;
  const ch = new Chan(await pairKey(k), "p");
  p.send({ t: "pair", ...(await ch.seal({ ev: "hello", pub: dev.pub, name })) });
  return { p, ch, dev };
}

test("道が無い時は LAN に落ちて、外から入れないと言う・QR は新しく出る", async () => {
  const s = await remote.start();
  expect(s.phase).toBe("offer");
  expect(s.route).toBe("lan");
  expect(s.note).toContain("外から入れません（Wi-Fi 内だけ）");
  expect(lastQr).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#k=[\w-]{43}$/);
});

test("phone page は暗号の file だけを配り、secret を含まず、他の path は無い", async () => {
  const { base: b } = parse();
  const html = await fetch(b + "/");
  expect(html.headers.get("referrer-policy")).toBe("no-referrer");
  expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(html.headers.get("cache-control")).toBe("no-store");
  expect(await (await fetch(b + "/wire.js")).text()).toContain("AES-GCM");
  expect((await fetch(b + "/phone.js")).status).toBe(200);
  expect((await fetch(b + "/phone-ui.js")).status).toBe(200);
  for (const path of ["/panel", "/src/remote.ts", "/phone.html", "/../package.json"]) expect((await fetch(b + path)).status).toBe(404);
});

test("許可するまで一覧は返らない・許可すると paired と一覧が暗号で届く", async () => {
  const { p, ch, dev } = await pairUp();
  const wait = await ch.open(await p.next());
  expect(wait.ev).toBe("wait");
  expect(wait.code).toMatch(/^\d{4}$/);
  const st = await remote.status();
  expect(st.phase).toBe("claimed");
  expect(st.pending).toEqual({ name: "iPhone", code: wait.code });
  expect(st.qr).toBeNull(); // 読まれた QR は画面から消える
  await Bun.sleep(100);
  // 許可の前に一覧を欲しがっても何も返らない（許可待ちの口からの送信は切る）
  p.send({ ...(await ch.seal({ ev: "list" })) });
  expect(await p.closed()).toBe(4400);
  expect((await remote.status()).devices).toEqual([]);
  void dev;
});

test("もう一度 QR を出して、許可 → paired + 一覧。同じ QR の 2 台目・再利用は断る", async () => {
  await remote.start();
  const a = await pairUp("iPhone");
  expect((await a.ch.open(await a.p.next())).ev).toBe("wait");
  const b = await pairUp("Android"); // 同じ QR を別の端末が読んだ
  expect(await b.p.closed()).toBe(4410);
  expect(await remote.allow()).toEqual({ ok: true });
  const paired = await a.ch.open(await a.p.next());
  expect(paired).toMatchObject({ ev: "paired", id: a.dev.id });
  expect(unb64(paired.ds).length).toBe(32);
  const list = await a.ch.open(await a.p.next());
  expect(list).toEqual({ ev: "list", rows, bar: null });
  expect((await remote.status()).devices.map((d) => [d.name, d.online])).toEqual([["iPhone", true]]);
  const c = await pairUp(); // 使い終わった QR
  expect(await c.p.closed()).toBe(4410);
  a.p.ws.close();
});

test("2 回目以降は QR なし: 署名と ds で入る・一覧が変わると押される・解除で切れる", async () => {
  // 許可の時に渡った ds は store に在る。スマホの身元（秘密鍵つき）を作って、その公開鍵で store を差し替え、別の常駐（r2）で入る
  const rec = (await store.load())[0]!;
  const dev = await newKeys();
  const st2 = memoryStore();
  await st2.save([{ ...rec, id: dev.id, pub: dev.pub }]);
  let qr2 = "";
  const r2 = createRemote({ list: async () => rows, extDir, store: st2, now: () => clock, lan: () => "127.0.0.1", qr: (t) => (qr2 = t), tunnel: async () => ({ ok: false, why: "x" }) });
  await r2.start();
  const b = new URL(qr2.replace("/#", "/?")).origin;
  const p = phone(b);
  await p.opened;
  p.send({ t: "auth", id: dev.id });
  const chal = await p.next();
  const n = unb64(chal.n), np = rand(16);
  const sg = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, dev.pair.privateKey, authBytes(dev.id, n, np)));
  const ch = new Chan(await sessionKey(await base(unb64(rec.ds)), n, np), "p");
  p.send({ t: "sig", np: b64(np), sig: b64(sg) });
  expect((await ch.open(await p.next())).ev).toBe("ready");
  expect((await ch.open(await p.next())).rows).toEqual(rows);
  rows = [{ id: 1, name: "調べ物", state: "work", label: "動いています" }];
  expect((await ch.open(await p.next())).rows[0].state).toBe("work"); // tick（2 秒）で変化が届く
  // 署名が違う（別の端末が id だけ名乗る）なら入れない
  const evil = await newKeys(), bad = phone(b);
  await bad.opened;
  bad.send({ t: "auth", id: dev.id });
  const n2 = unb64((await bad.next()).n), np2 = rand(16);
  bad.send({ t: "sig", np: b64(np2), sig: b64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, evil.pair.privateKey, authBytes(dev.id, n2, np2)))) });
  expect(await bad.closed()).toBe(4401);
  await r2.revoke(dev.id);
  expect(await p.closed()).toBe(4401); // 解除 = 開いている接続も切る
  const again = phone(b);
  await again.opened;
  again.send({ t: "auth", id: dev.id });
  expect(await again.closed()).toBe(4401);
  r2.stop();
}, 15_000);

test("同時に 2 台が同じ QR を読んでも、先に復号できた 1 台だけが進む", async () => {
  await remote.start();
  const { base: b, k } = parse();
  const mk = async (name: string) => { const dev = await newKeys(), p = phone(b); await p.opened; return { p, dev, ch: new Chan(await pairKey(k), "p"), name }; };
  const [x, y] = await Promise.all([mk("a"), mk("b")]);
  await Promise.all([x, y].map(async (t) => t.p.send({ t: "pair", ...(await t.ch.seal({ ev: "hello", pub: t.dev.pub, name: t.name })) })));
  const res = await Promise.all([x, y].map((t) => Promise.race([t.p.next().then(() => "wait"), t.p.closed().then((c) => c)])));
  expect(res.filter((r) => r === "wait").length).toBe(1);
  expect(res.filter((r) => r === 4410).length).toBe(1);
  remote.cancel();
});

test("鍵が違う・5 回外したら QR は捨てる・期限切れは断る", async () => {
  await remote.start();
  const { base: b } = parse();
  for (let i = 0; i < 5; i++) {
    const p = phone(b); await p.opened;
    const ch = new Chan(await pairKey(rand(32)), "p"); // 別の k
    const dev = await newKeys();
    p.send({ t: "pair", ...(await ch.seal({ ev: "hello", pub: dev.pub, name: "x" })) });
    expect(await p.closed()).toBe(4403);
  }
  const good = await pairUp(); // 5 回外した後は、正しい k でも読めない
  expect(await good.p.closed()).toBe(4410);
  expect((await remote.status()).phase).toBe("idle");
  await remote.start();
  clock += 91_000; // 90 秒たった
  expect((await remote.status()).phase).toBe("expired");
  const late = await pairUp();
  expect(await late.p.closed()).toBe(4410);
});

test("Mac でやめた QR・出し直す前の QR は断る・許可の取り消しで 2 度目の許可は出来ない", async () => {
  await remote.start();
  const old = parse();
  remote.cancel();
  const dev = await newKeys();
  let p = phone(old.base); await p.opened;
  p.send({ t: "pair", ...(await new Chan(await pairKey(old.k), "p").seal({ ev: "hello", pub: dev.pub, name: "x" })) });
  expect(await p.closed()).toBe(4410);
  await remote.start();
  const first = parse();
  await remote.start(); // 出し直し
  const p2 = phone(first.base); await p2.opened;
  p2.send({ t: "pair", ...(await new Chan(await pairKey(first.k), "p").seal({ ev: "hello", pub: dev.pub, name: "x" })) });
  expect(await p2.closed()).toBe(4403); // 出し直した後の QR に、前の k では開けない
  expect(await remote.allow()).toMatchObject({ ok: false }); // 読まれていない QR は許可できない
});

test("不正な Origin の WS は断る", async () => {
  const { base: b } = parse();
  const r = await fetch(b + "/ws", { headers: { origin: "https://evil.example", upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "x3JJHMbDL1EzLkh9GBhXDw==", "sec-websocket-version": "13" } });
  expect(r.status).toBe(403);
});

// ---- 常駐の口（op remote）: 人だけが押せる・一覧の元（remoteRows）は名前と状態だけ ----
import { mktmp } from "./tmp.ts";
import { makeHandler, remoteBridge, remoteRows } from "../src/main.ts";
import { openStore } from "../src/store.ts";

function daemonish() {
  const r = createRemote({ list: async () => [], extDir, store: memoryStore(), now: () => clock, lan: () => "127.0.0.1", qr: (t) => (lastQr = t), tunnel: async () => ({ ok: false, why: "x" }) });
  const h = makeHandler(openStore(":memory:"), async () => [], undefined,
    { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [], spawn: (() => { throw new Error("no spawn"); }) as any, browserUrl: async () => null },
    { uiHome: mktmp("kangae-ui"), modsRoot: mktmp("mods"), remote: r }) as (m: any, owner?: unknown) => Promise<any>;
  return { r, h };
}

test("op remote: 人（owner {}）は QR を出して許可できる・agent の CLI（write を持つ口）は全部断る", async () => {
  const { r, h } = daemonish();
  const cli = { write: () => 0 };
  for (const action of ["start", "allow", "status", "revoke", "cancel"]) expect(await h({ op: "remote", action }, cli)).toMatchObject({ ok: false, code: "bad" });
  expect(await h({ op: "remote", action: "start", owner: "s:1" }, {})).toMatchObject({ ok: false, code: "bad" }); // owner つきの人の口も不可
  const st = await h({ op: "remote", action: "start" }, {});
  expect(st).toMatchObject({ ok: true, phase: "offer", route: "lan" });
  expect(typeof st.qr).toBe("string");
  expect((await h({ op: "remote", action: "allow" }, {})).ok).toBe(false); // まだ誰も読んでいない QR は許可できない
  expect(await h({ op: "remote", action: "cancel" }, {})).toEqual({ ok: true });
  r.stop();
});

test("remoteRows: 名前・状態の語・最後の 1 文だけ（秘密に見える文と 2 行目以降は渡さない）", async () => {
  const { r, h } = daemonish();
  const a = await h({ op: "add", text: "メールを整理して\n秘密の本文 sk-ABCDEF" });
  expect(a.ok).toBe(true);
  const rows = await remoteRows(h as any);
  expect(rows).toEqual([{ id: a.node.id, name: "メールを整理して", state: "neutral", label: "まだ何も話していません", last: "", stopped: false, canResume: false }]);
  expect(JSON.stringify(rows)).not.toContain("sk-ABCDEF");
  r.stop();
});

// ---- R2: 送る・答える（冪等・always を受けない） ----
const stub = (over: Partial<Bridge>): Bridge => ({ messages: async () => null, send: async () => ({ ok: true }), answer: async () => "answered", resume: async () => ({ result: "gone" }), launch: async () => ({ result: "running" }), bar: async () => null, allowed: () => [], setAllowed: () => {}, ...over });
async function connected(bridge: Bridge, list: () => Promise<Row[]> = async () => rows) {
  let qr = "";
  const r = createRemote({ list, extDir, store: memoryStore(), now: () => clock, lan: () => "127.0.0.1", qr: (t) => (qr = t), tunnel: async () => ({ ok: false, why: "x" }), conv: bridge });
  await r.start();
  const u = new URL(qr.replace("/#", "/?"));
  const dev = await newKeys(), p = phone(u.origin);
  await p.opened;
  const ch = new Chan(await pairKey(unb64(u.searchParams.get("k")!)), "p");
  p.send({ t: "pair", ...(await ch.seal({ ev: "hello", pub: dev.pub, name: "iPhone" })) });
  await ch.open(await p.next()); // wait
  await r.allow();
  await ch.open(await p.next()); // paired
  await ch.open(await p.next()); // list
  const say = async (o: unknown) => p.send(await ch.seal(o));
  const hear = async () => { for (;;) { const m = await ch.open(await p.next()); if (m.ev !== "list" && m.ev !== "conv") return m; } }; // 一覧・会話の push は読み飛ばして、依頼の返事だけ返す
  const quiet = async (ms = 150) => { await Bun.sleep(ms); return p.queued() === 0; }; // 何も来ていない（待ち受けは作らない＝次の frame を横取りしない）
  return { r, p, say, hear, quiet, dev };
}
const sleep = (ms: number) => Bun.sleep(ms);

test("R2 冪等: 同じ request_id の送りは 1 回しか実行しない・結果が返るまで「送りました」を出さない・失敗は送り直せる", async () => {
  let calls = 0, gate!: () => void;
  const open = new Promise<void>((r) => (gate = r));
  let fail = true;
  const bridge = stub({
    send: async (_id, _text, _dev) => { calls++; if (fail && calls === 1) return { ok: false, hint: "つながりません" }; await open; return { ok: true, row: 40 + calls }; },
  });
  const t = await connected(bridge);
  // 失敗（Mac に行が入っていない）は覚えない: 同じ request_id で送り直すともう一度実行され、成功できる
  await t.say({ ev: "send", conv: 1, text: "一回目", rid: "rid-fail-0001" });
  expect(await t.hear()).toMatchObject({ ev: "sent", rid: "rid-fail-0001", ok: false, hint: "つながりません" });
  fail = false;
  // 成功: Mac（bridge）が返すまでスマホには何も返らない（押した瞬間に「送りました」と出さない）
  await t.say({ ev: "send", conv: 1, text: "二回目", rid: "rid-fail-0001" });
  await t.say({ ev: "send", conv: 1, text: "二回目", rid: "rid-fail-0001" }); // 通信が切れて送り直した = 実行中の同じ依頼
  expect(await t.quiet()).toBe(true);
  gate();
  const a = await t.hear(), b = await t.hear();
  expect(a).toMatchObject({ ev: "sent", ok: true, row: 42 });
  expect(b).toMatchObject({ ev: "sent", ok: true, row: 42, again: true });
  expect(calls).toBe(2); // 失敗の 1 回 + 成功の 1 回（送り直しの 2 通目は実行しない）
  await t.say({ ev: "send", conv: 1, text: "二回目", rid: "rid-fail-0001" }); // 後から届いた 3 通目も同じ結果
  expect(await t.hear()).toMatchObject({ ev: "sent", ok: true, row: 42, again: true });
  expect(calls).toBe(2);
  // 別の request_id は別の送り
  await t.say({ ev: "send", conv: 1, text: "三回目", rid: "rid-other-002" });
  expect(await t.hear()).toMatchObject({ ev: "sent", ok: true, row: 43 });
  expect(calls).toBe(3);
  t.r.stop();
}, 15_000);

test("R2 always を受けない: 答えは今回の allow / deny だけ・always / この頼みの間 / 選択肢の指定は断り、Mac の承認は触らない", async () => {
  const seen: unknown[][] = [];
  const bridge = stub({ answer: async (...a) => { seen.push(a.slice(0, 4)); return "answered"; } });
  const t = await connected(bridge);
  const base = { ev: "answer", conv: 1, approval: "a1", ver: 5 };
  const bad: [string, Record<string, unknown>][] = [
    ["always の欄", { allow: true, always: true }],
    ["scope の欄（この頼みの間）", { allow: true, scope: "turn" }],
    ["choice の欄", { allow: true, choice: "always" }],
    ["allow が文字（always）", { allow: "always" }],
    ["allow が無い", {}],
  ];
  for (const [i, [why, extra]] of bad.entries()) {
    await t.say({ ...base, ...extra, rid: `rid-bad-000${i}` });
    const r = await t.hear();
    expect(r, why).toMatchObject({ ev: "answered", ok: false, result: "refused" });
  }
  expect(seen).toEqual([]); // 1 つも Mac の承認に届いていない
  // 欄が揃った「今回だけ」は通り、bridge には conv / approval / allow / ver だけが渡る
  await t.say({ ...base, allow: false, rid: "rid-good-0001" });
  expect(await t.hear()).toMatchObject({ ev: "answered", ok: true, result: "answered" });
  expect(seen).toEqual([[1, "a1", false, 5]]);
  t.r.stop();
}, 15_000);

// ---- R3: 再開（許した担当だけ・冪等）と Kangae を裏で開く ----
function agentish() {
  const procs: { kill: () => void }[] = [];
  const spawn = () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>, done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
    const exited = new Promise<number>((r) => (done = r));
    const p = { stdout, exited, kill: () => { try { ctrl.close(); } catch {} done(143); } };
    procs.push(p);
    return p;
  };
  const home = mktmp("kangae-ui"), opens: string[] = [];
  let barUp = false;
  const probe: BarProbe = { app: "/x/Kangae Bar.app", running: () => barUp, open: (a) => { opens.push(a); barUp = true; return true; } };
  const store = openStore(":memory:");
  const h = makeHandler(store, async () => [], undefined,
    { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn: spawn as any, browserUrl: async () => null },
    { uiHome: home, modsRoot: mktmp("mods") }) as (m: any, owner?: unknown) => Promise<any>;
  return { h, store, home, procs, opens, bridge: remoteBridge(store, () => h as any, home, probe), probe };
}
// 動いている担当を 1 つ作って止める（= スマホの一覧で「止まりました」の行）
async function stoppedAgent(a: ReturnType<typeof agentish>) {
  const id = (await a.h({ op: "add", text: "調べ物" })).node.id;
  expect((await a.h({ op: "send", rootId: id, text: "始めて" })).ok).toBe(true);
  const run = (await a.h({ op: "runs", nodeIds: [id] })).runs[0];
  await a.h({ op: "stopRun", runId: run.id });
  expect((await a.h({ op: "runs", nodeIds: [id] })).runs[0].status).toBe("stopped");
  return id as number;
}

test("R3 許していない担当は再開しない: Mac で許すまで needsLocalApproval・agent は 1 つも起きない。許すと Mac で動いたのを見てから running", async () => {
  const a = agentish();
  const id = await stoppedAgent(a);
  expect(a.procs.length).toBe(1); // 最初の 1 回だけ
  const rowsNow = () => remoteRows(a.h as any, a.bridge.allowed());
  const t = await connected(a.bridge, rowsNow);
  expect((await rowsNow())[0]).toMatchObject({ id, stopped: true, canResume: false });
  await t.say({ ev: "resume", conv: id, status: "stopped", rid: "rid-resume-001" });
  expect(await t.hear()).toMatchObject({ ev: "resumed", ok: false, result: "needsLocalApproval" });
  expect(a.procs.length).toBe(1); // 許していないので何も起こしていない
  expect((await a.h({ op: "runs", nodeIds: [id] })).runs[0].status).toBe("stopped");
  // 欄に余計な物（shell・path・コマンド）を足しても受けない
  await t.say({ ev: "resume", conv: id, status: "stopped", rid: "rid-resume-002", cmd: "rm -rf /" });
  expect(await t.hear()).toMatchObject({ ev: "resumed", ok: false, result: "refused" });
  expect(a.procs.length).toBe(1);
  // Mac で許す（人の画面だけが書く）→ 同じ担当が再開できる
  expect(t.r.setResume(id, true)).toEqual({ ok: true });
  await t.say({ ev: "resume", conv: id, status: "stopped", rid: "rid-resume-003" });
  expect(await t.hear()).toMatchObject({ ev: "resumed", ok: true, result: "running" });
  expect(a.procs.length).toBe(2);
  expect((await a.h({ op: "runs", nodeIds: [id] })).runs[0].status).toBe("running");
  // 許していない別の担当は、許した担当があっても再開されない
  const other = await stoppedAgent(a);
  await t.say({ ev: "resume", conv: other, status: "stopped", rid: "rid-resume-004" });
  expect(await t.hear()).toMatchObject({ ok: false, result: "needsLocalApproval" });
  expect(a.procs.length).toBe(3); // other を止めた分の最初の 1 回だけ（再開では増えていない）
  t.r.stop();
}, 20_000);

test("R3 冪等: 同じ request_id の再開は 1 回だけ・別の request_id でも動いている担当は二重に起こさない・Kangae を開くも 1 回", async () => {
  const a = agentish();
  const id = await stoppedAgent(a);
  a.bridge.setAllowed(id, true);
  const t = await connected(a.bridge, () => remoteRows(a.h as any, a.bridge.allowed()));
  await t.say({ ev: "resume", conv: id, status: "stopped", rid: "rid-idem-0001" });
  await t.say({ ev: "resume", conv: id, status: "stopped", rid: "rid-idem-0001" }); // 通信が切れて送り直した
  const x = await t.hear(), y = await t.hear();
  expect(x).toMatchObject({ ok: true, result: "running" });
  expect(y).toMatchObject({ ok: true, result: "running", again: true });
  expect(a.procs.length).toBe(2); // 最初の 1 回 + 再開の 1 回だけ
  await t.say({ ev: "resume", conv: id, status: "stopped", rid: "rid-idem-0002" }); // 別の request_id: もう動いている
  expect(await t.hear()).toMatchObject({ ok: true, result: "running" });
  expect(a.procs.length).toBe(2);
  // Kangae の画面を裏で開く: 同じ request_id は 1 回しか open しない（前面を取らない `open -g` の引数は固定）
  await t.say({ ev: "launch", rid: "rid-launch-001" });
  await t.say({ ev: "launch", rid: "rid-launch-001" });
  expect(await t.hear()).toMatchObject({ ev: "launched", ok: true, result: "running" });
  expect(await t.hear()).toMatchObject({ ev: "launched", again: true });
  expect(a.opens).toEqual(["/x/Kangae Bar.app"]);
  t.r.stop();
}, 20_000);
