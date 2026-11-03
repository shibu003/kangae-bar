import { loadavg } from "node:os";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pollUntil } from "../src/wait.ts";
// 拡張の service worker を CDP で探す（uc-web・web-w2f・web-lease が共有）。
// 締切（全体・Date.now() 基準）と 1 回ごとの時間切れ（fetch = AbortSignal.timeout・WS の eval = timer）を持つ。
// 2026-10-08 w8a-2: 240 回 ×（fetch + eval + 500ms）が 1 回ごとの切れ無しで 2896 秒かかり、JOB の列を止めた。
// 見つからない時は「理由 1 行」で投げる（debug port が開いたか・見えた target の種類・拡張の頁が居るか）。
export const evalIn = (wsUrl: string, expr: string, ms = 15_000): Promise<any> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`CDP eval が ${ms}ms で返らない`)); }, ms);
    const done = (f: () => void) => { clearTimeout(t); try { ws.close(); } catch {} f(); };
    ws.onerror = () => done(() => reject(new Error("CDP WS 接続失敗")));
    // W80（H9）: 繋いだ直後の sw は「debugger 待ち」で script が走っておらず chrome が undefined（probe 実測: typeof chrome = "undefined" の後に
    // Inspector.workerScriptLoaded が来る）。上流 puppeteer-core/src/cdp/TargetManager.ts:375（worker の target）も attach した target に runIfWaitingForDebugger を送る。
    // 返事は id で拾う（event を先に受けて値 undefined で返していた）。待っていない target には何もしない命令
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 0, method: "Runtime.runIfWaitingForDebugger" }));
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    };
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) done(() => resolve(m.result?.result?.value)); };
  });

// 拡張を CDP で入れる（Chrome 154 は --load-extension が効かない事がある: docs/REPORT-w3c.md:9）。
// 公式: Extensions.loadUnpacked（https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json の Extensions domain）。
// 要る起動引数 = --enable-unsafe-extension-debugging（試験の隔離 profile のみ）。上流: puppeteer-core/src/cdp/Browser.ts:501 installExtension が同じ呼び出し。
// 入った時は拡張 id、入らなかった時は「入っていない: 原文」で投げる。
export const installExtension = (port: number, path: string, ms = 4_000): Promise<string> =>
  fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(ms) }).then((r) => r.json() as Promise<any>).then(
    (v) =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`拡張が入っていない: loadUnpacked が ${ms}ms で返らない`)); }, ms);
        const done = (f: () => void) => { clearTimeout(t); try { ws.close(); } catch {} f(); };
        ws.onerror = () => done(() => reject(new Error("拡張が入っていない: browser の WS 接続失敗")));
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path } }));
        ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id !== 1) return; done(() => (m.result?.id ? resolve(m.result.id) : reject(new Error(`拡張が入っていない: ${JSON.stringify(m.error ?? m).slice(0, 200)}`)))); };
      }),
  );

export type FindSwOpts = {
  port: number;
  extensionDir?: string; // 渡すと、sw を探す前に installExtension で入れ直す（入るまで毎回やり直す。入れ直す前に居た sw は掴まない。失敗の原文は最後の理由に出る）
  deadlineMs?: number; // 全体の締切
  callMs?: number; // 1 回（fetch・eval）の時間切れ
  nudgeUrl?: string; // sw は idle 30 秒で止まり、止まると /json/list から消える。この頁を開いて起こす（http の頁。webNavigation が sw を起こす）
};

export async function findSw(o: FindSwOpts): Promise<{ webSocketDebuggerUrl: string; url: string }> {
  const { port, deadlineMs = 120_000, callMs = 4_000 } = o;
  const t0 = Date.now();
  const get = async (p: string, init?: RequestInit) => (await fetch(`http://127.0.0.1:${port}${p}`, { ...init, signal: AbortSignal.timeout(callMs) })).json() as Promise<any>;
  let seen = "debug port 未応答", nudged = 0, tries = 0, installed = "", installErr = "";
  const before = new Set<string>(); // 入れ直す前に居た sw の id（入れ直しで消えていく側）
  const found = await pollUntil(async () => {
    tries++;
    try {
      const list: any[] = await get("/json/list");
      seen = `target ${list.length} 件 [${[...new Set(list.map((t) => t.type + (t.url.startsWith("chrome-extension://") ? "(ext)" : "")))].join(",")}]`;
      const sws = list.filter((t) => t.type === "service_worker" && t.url.includes("sw.js") && !before.has(t.id));
      // W80: --load-extension で起きた sw は一覧に出るが chrome.tabs が真にならない（実測 43 回・576 秒）。loadUnpacked で入れ直すと新しい sw が出て、
      // 古い方は eval が返らないまま 20 秒ほど一覧に残る（同じ url の sw が 2 つ並ぶ）。だから必ず入れ直し、入れ直す前に居た id は掴まない。
      // ponytail: 古い sw が「一覧を見た後・loadUnpacked の前」に一覧へ出る隙は塞いでいない（下の 2 つ並びの検査が受ける）
      if (o.extensionDir && !installed) {
        for (const t of list) if (t.type === "service_worker") before.add(t.id);
        installed = await installExtension(port, o.extensionDir, callMs).catch((e) => { installErr = (e as Error).message; return ""; });
        return null;
      }
      const c = sws[0];
      if (sws.filter((t) => t.url === c?.url).length > 1) { seen += `・同じ sw が ${sws.length} 個（入れ直しの途中）`; return null; }
      if (c &&(await evalIn(c.webSocketDebuggerUrl, "typeof chrome !== 'undefined' && !!chrome.tabs", callMs).catch(() => false)) === true) return c as { webSocketDebuggerUrl: string; url: string };
      if (!c && o.nudgeUrl && Date.now() - t0 > (nudged + 1) * 10_000) {
        nudged++;
        const nt = await get(`/json/new?${encodeURI(o.nudgeUrl)}`, { method: "PUT" }).catch(() => null);
        await Bun.sleep(1500);
        if (nt?.id) await get(`/json/close/${nt.id}`).catch(() => {});
      }
    } catch (e) { if (!seen.startsWith("target")) seen = `debug port 未応答（${(e as Error).name}）`; }
    return null;
  }, deadlineMs, 500);
  if (found) return found;
  throw new Error(`拡張の service worker が見つかりません（${Math.round((Date.now() - t0) / 1000)} 秒・${tries} 回・${seen}・起こし ${nudged} 回${o.extensionDir ? (installed ? `・拡張 ${installed} は入った（sw が止まっている）` : `・${installErr || "拡張が入っていない"}`) : ""}）`);
}

// W80: 掴んだ sw に WS を 1 本張り続けて eval する（w3c.e2e.ts:109 と同じ形）。DevTools が繋がっている間は Chrome が sw を idle で止めない。
// sw の console と未捕捉の例外は log へ（eval が返らない時に sw の中で何が起きていたかを原文で残す）。WS が閉じたら待っている eval は全部その理由で落ちる
export async function swSession(wsUrl: string, log: (s: string) => void, ms = 15_000) {
  const ws = new WebSocket(wsUrl);
  let id = 0, dead = "";
  const pend = new Map<number, (m: any) => void>();
  const die = (why: string) => { dead ||= why; for (const f of pend.values()) f({ error: { message: why } }); pend.clear(); };
  ws.onclose = () => die("sw の WS が閉じた（sw が止まった・入れ替わった）");
  ws.onerror = () => die("sw の WS error");
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.method === "Runtime.consoleAPICalled") log(`console.${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description).join(" ").slice(0, 300)}`);
    else if (m.method === "Runtime.exceptionThrown") log(`例外: ${String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 400)}`);
    else if (m.id != null) { pend.get(m.id)?.(m); pend.delete(m.id); }
  };
  await timed("sw の WS 接続", ms, (fail) => new Promise<void>((r) => { ws.onopen = () => r(); ws.addEventListener("close", () => fail(dead || "閉じた")); }));
  const send = (method: string, params: object = {}, t = ms) =>
    timed(`sw の ${method}`, t, (fail) => new Promise<any>((res) => { if (dead) return fail(dead); const i = ++id; pend.set(i, (m) => (m.error ? fail(m.error.message) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); }));
  await send("Runtime.runIfWaitingForDebugger");
  await send("Runtime.enable");
  return {
    ev: async (expr: string, t = ms) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, t); if (r?.exceptionDetails) throw new Error(`sw の eval が投げた: ${String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300)}`); return r?.result?.value; },
    close: () => { try { ws.close(); } catch {} },
  };
}

// ---- holes-6: dm.e2e の「手」ごとの時間切れ（2026-10-08 w7a-8a-2: 7.0s の後 11 分以上止まり、runner を 45 分止めた）----
// どの手も「<手> が <秒> 返らない」の 1 行で投げる。close / error で返事が来なくなる手も同じ 1 行（理由を足す）。
export const timed = <T>(name: string, ms: number, start: (fail: (why: string) => void) => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name} が ${ms / 1000} 秒返らない`)), ms);
    start((why) => { clearTimeout(t); reject(new Error(`${name} が返らない: ${why}`)); }).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

// daemon の unix socket に 1 行送って、同じ id の返事を 1 つ受ける。接続失敗（ENOENT = socket が無い）・途中で閉じた は原文で投げる。
export const sockCall = (sock: string, m: Record<string, unknown>, ms = 20_000): Promise<any> =>
  timed(`sockCall(${String(m.op)})`, ms, (fail) =>
    new Promise((resolve) => {
      const id = crypto.randomUUID();
      let buf = "", got = false;
      const gone = (why: string) => { if (!got) fail(why); };
      Bun.connect({
        unix: sock,
        socket: {
          data(s, c) { buf += new TextDecoder().decode(c); for (const l of buf.split("\n")) { try { const j = JSON.parse(l); if (j.id === id) { got = true; resolve(j); s.end(); } } catch {} } },
          close() { gone("返事の前に socket が閉じた（daemon が落ちた）"); },
          error(_s, e) { gone(`socket error ${(e as Error).message}`); },
        },
      }).then((s) => s.write(JSON.stringify({ id, ...m }) + "\n"), (e) => fail(`接続できない ${(e as any).code ?? ""} ${(e as Error).message}${existsSync(sock) ? "" : "（socket の file が無い）"}`));
    }));

// ---- holes-17: 試験の Chrome の最初の navigate が 60 秒超（メモリの逼迫・swap 3.5GB/4GB・何も無い頁でも 3 回とも）----
// Chrome ごと（debug port ごと）に最初の 1 回だけ、about:blank で開いた頁を data: の頁へ navigate して renderer を起こす（温め・締切は warmMs の実の時間）。
// 温めの後の navigate は短く（navMs）。閉じた頁は捨てず idle に返し、次の cdpOpen が同じ頁を使い回す（新しい tab を何度も開かない・同時に要る時だけ増える）。
// 鍵は port + その Chrome の browser id（/json/version）。Chrome を同じ port で起こし直した時に、前の Chrome の「温めた」「idle の頁」を引き継がない（review7）
const warmed = new Set<string>();
const idle = new Map<string, any[]>();
export const swapNow = (): string => { try { return new TextDecoder().decode(Bun.spawnSync(["sysctl", "-n", "vm.swapusage"]).stdout).trim() || "取れない"; } catch { return "取れない"; } };

// headless Chrome の頁を 1 枚開いて CDP で操る。open / send / ev のどれも ms で切れる。ws が閉じたら待っている send は全部その理由で落ちる。
export async function cdpOpen(port: number, url: string, opt: { shots?: string; callMs?: number; warmMs?: number; navMs?: number; graceMs?: number; resendMs?: number } = {}) {
  const callMs = opt.callMs ?? 20_000;
  let t: any, last = "", key = String(port);
  for (let i = 0; i < 60 && !t; i++) {
    try {
      const get = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${p}`, { ...init, signal: AbortSignal.timeout(4_000) });
      key = `${port}:${String(((await (await get("/json/version")).json()) as any)?.webSocketDebuggerUrl ?? "").split("/").pop()}`;
      const pool = idle.get(key) ?? [];
      if (pool.length) { const live = await (await get("/json/list")).json() as any[]; t = pool.find((x) => live.some((l) => l.id === x.id)); idle.set(key, pool.filter((x) => x !== t)); }
      t ??= await (await get(`/json/new?about:blank`, { method: "PUT" })).json(); // url で直に開くと、呼ぶ側の Page.navigate（同じ url）と navigate が二重になる（holes-14）。空で開き、url へは下で 1 回だけ
    } catch (e) { last = (e as Error).message; await Bun.sleep(250); }
  }
  if (!t) throw new Error(`cdpOpen が頁を開けない（debug port ${port}・最後の理由 ${last}）`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let dead = "";
  const pending = new Map<number, (v: any) => void>();
  const die = (why: string) => { dead = why; for (const f of pending.values()) f({ error: { message: why } }); pending.clear(); };
  ws.onclose = () => die("ws が閉じた（Chrome が落ちた）");
  ws.onerror = () => die("ws error");
  await timed("cdpOpen の ws 接続", callMs, (fail) => new Promise<void>((r) => { ws.onopen = () => r(); ws.addEventListener("close", () => fail("ws が閉じた")); }));
  let id = 0;
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m); pending.delete(m.id); };
  const rawSend = (method: string, params: object = {}, ms = callMs) =>
    timed(`CDP ${method}`, ms, (fail) => new Promise<any>((res) => { if (dead) return fail(dead); const i = ++id; pending.set(i, (m) => (m.error?.message === dead && dead ? fail(dead) : res(m))); ws.send(JSON.stringify({ id: i, method, params })); }));
  // Page.navigate は頁の commit まで返らない。混雑（load 300 超）では 20 秒を超えうるので 60 秒まで待ち、それでも返らなければ target の今の状態を原文で足す（混雑の遅れか、Chrome が受けない状態かの切り分け用・2026-10-08 dm.e2e）
  const navMs = () => (warmed.has(key) ? opt.navMs ?? 30_000 : Math.max(callMs, 60_000));
  // holes-19: 頁は読み込まれている（/json/list の title=warm）のに Page.navigate の返事だけ届かない事がある（holes17-1）。
  // 返事を待つ傍ら /json/list で target の url を見て、graceMs 過ぎても返事が無く url が行き先に着いていれば返事なしで進む
  // （graceMs は、使い回した頁が元から同じ url に居る時に commit 前に抜けないための待ち）。
  const targetNow = () => fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4_000) }).then((r) => r.json() as Promise<any[]>).then((l) => l.find((x) => x.id === t.id));
  const dec = (x: string) => { try { return decodeURIComponent(x); } catch { return x; } };
  const sameUrl = (a: string, b: string) => { try { return new URL(a).href === new URL(b).href; } catch { return a === b; } };
  // data: の url は Chrome が表記（エンコード）を変えて返しうる → デコードして比べる。温めの頁は title=warm が見えたら着いた
  const arrived = (now: any, u: string) => sameUrl(String(now.url), u) || (u.startsWith("data:") && String(now.url).startsWith("data:") && (dec(String(now.url)) === dec(u) || (/<title>warm<\/title>/.test(dec(u)) && now.title === "warm")));
  // holes-19c: 返事が来ないだけでなく、移動そのものが起きない事がある（温めの後の本番の url で target が warm のまま 30 秒）。
  // resendMs 過ぎても target の url が navigate 前のままなら Page.navigate を 1 回だけ送り直す（試験の client だけ・製品の act には入れない）。
  // 送り直しても resendMs 動かなければ「頁の移動が始まらない」の 1 行で落ちる。送った回数と、どちらの送信で着いたかを log に。
  const rawNavigate = (u: string, ms: number): Promise<any> => {
    let over = false, sent = 1, resolveExtra: (v: any) => void = () => {};
    const extra = new Promise<any>((r) => { resolveExtra = r; });
    const reply = rawSend("Page.navigate", { url: u }, ms).finally(() => { over = true; });
    const state = (async () => {
      const t0 = Date.now(), resendMs = opt.resendMs ?? 5_000;
      const before = String((await targetNow().catch(() => null))?.url ?? "");
      let resentAt = 0;
      while (!over && Date.now() - t0 < ms) {
        await Bun.sleep(250);
        if (over || Date.now() - t0 < (opt.graceMs ?? 3_000)) continue;
        const now = await targetNow().catch(() => null);
        if (now && arrived(now, u)) { if (sent > 1) console.log(`[cdp] Page.navigate ${sent} 回目の送信で着いた（${u.slice(0, 60)}）`); return { result: { noReply: `Page.navigate の返事が来ない（頁は ${String(now.title).slice(0, 40)} まで読めている）` } }; }
        if (now && String(now.url) === before) {
          if (!resentAt && Date.now() - t0 >= resendMs) {
            resentAt = Date.now(); sent = 2;
            console.log(`[cdp] ${resendMs}ms 過ぎても target は ${before.slice(0, 60)} のまま → Page.navigate を送り直す（1 回だけ・${u.slice(0, 60)}）`);
            rawSend("Page.navigate", { url: u }, Math.max(1_000, ms - (Date.now() - t0))).then(resolveExtra, () => {});
          } else if (resentAt && Date.now() - resentAt >= resendMs) {
            throw new Error(`頁の移動が始まらない（target は ${before.slice(0, 60)} のまま・Page.navigate を 2 回送った・swap ${swapNow()}）`);
          }
        }
      }
      return new Promise<never>(() => {}); // 負けた側は待たせたまま捨てる（reply の時間切れが先に落とす）
    })();
    reply.catch(() => {});
    state.catch(() => {});
    return Promise.race([reply, extra, state]);
  };
  const send = async (method: string, params: object = {}, ms = method === "Page.navigate" ? navMs() : callMs) => {
    try { return method === "Page.navigate" ? await rawNavigate((params as any).url, ms) : await rawSend(method, params, ms); } catch (e) {
      if (method !== "Page.navigate" || !/返らない/.test((e as Error).message)) throw e;
      const now = await targetNow().catch((x) => `target 状態を取れない: ${(x as Error).message}`);
      throw new Error(`${(e as Error).message}（target の今: ${typeof now === "string" ? now : now ? `type=${now.type} url=${String(now.url).slice(0, 80)} title=${String(now.title).slice(0, 40)}` : "target が一覧に居ない"}・load ${loadavg()[0]!.toFixed(0)}）`);
    }
  };
  await send("Page.enable");
  if (!warmed.has(key)) {
    const warmMs = opt.warmMs ?? 180_000, t0 = Date.now();
    try { await rawNavigate("data:text/html,<title>warm</title>", warmMs); } catch (e) {
      if (!/返らない/.test((e as Error).message)) throw e;
      throw new Error(`Chrome の新しい頁の process が ${Math.round((Date.now() - t0) / 1000)} 秒起きない（メモリの逼迫の疑い: swap ${swapNow()}・load ${loadavg()[0]!.toFixed(0)}）`);
    }
    warmed.add(key);
  }
  if (url !== "about:blank") await send("Page.navigate", { url });
  await send("Emulation.setDeviceMetricsOverride", { width: 460, height: 780, deviceScaleFactor: 2, mobile: false });
  const ev = async (expr: string, ms = callMs) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, ms)).result?.result?.value;
  const shot = async (name: string, clip?: object) => {
    const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}) });
    if (opt.shots) writeFileSync(join(opt.shots, `${name}.png`), Buffer.from(r.result.data, "base64"));
    return r.result.data as string;
  };
  return { send, ev, shot, close: () => { try { ws.close(); } catch {} if (!(idle.get(key) ?? []).includes(t)) idle.set(key, [...(idle.get(key) ?? []), t]); }, id: t.id as string };
}
