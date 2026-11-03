// W8g: 人の Chrome のログイン状態（cookie）を、値を見せずに、頼んだ site の分だけ agent 専用の headless Chrome へ運ぶ（図 §45）。
// 取るのは拡張（chrome.cookies.getAll({url}) = その URL に送られる cookie だけ）。常駐は値を memory だけで持ち、頼みごとの browser context に入れたら捨てる。
// 上流: Cua Teleport（FSL・コードは持ち込まない）から承諾の形と「既定は最小」の語彙だけ。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Driver } from "./lease.ts";
import { pollUntil } from "./wait.ts";

export type Cookie = {
  name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean;
  sameSite?: string; expirationDate?: number; session?: boolean; hostOnly?: boolean;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor?: boolean };
};
export type Listing = { domain: string; names: string[]; count: number; remembered: boolean };
export type Unmovable = { domain: string; reason: string };
export type CarryCard = { id: string; owner: string; host: string; groups: Listing[]; skipped: Unmovable[]; remember: boolean; at: number; history: { limit: number; on: boolean } };
export const CARRY_MS = 90_000; // agent の Bash は 2 分で切れるので、それより先に断りで返す

// identity provider（これを運ぶと別の site にまでログインできてしまう）。host がこれに当たる、または cookie の domain がこれに当たる物は運ばない
export const IDP = ["accounts.google.com", "accounts.youtube.com", "login.microsoftonline.com", "login.microsoft.com", "login.live.com", "appleid.apple.com", "idmsa.apple.com", "okta.com", "auth0.com", "login.salesforce.com"];
export const isIdp = (host: string) => { const h = host.toLowerCase().replace(/^\./, ""); return IDP.some((d) => h === d || h.endsWith(`.${d}`)); };

// "localhost:3000" / "example.com" / "https://example.com/x" → { host, url }。外の形・空・怪しい物は null
export function parseTarget(s: string): { host: string; url: string } | null {
  const t = String(s ?? "").trim();
  if (!t || t.length > 200) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `${/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(t) ? "http" : "https"}://${t}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password) return null;
    return { host: u.hostname.toLowerCase(), url: `${u.protocol}//${u.host}/` };
  } catch { return null; }
}

// 運べない理由（card に薄く 1 行で出す）
export const WHY_IDP = "ログインの窓口（Google などの認証の入口）なので運びません";
export const WHY_PART = "別の site の中でだけ使われるログイン情報なので運びません";
const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
// 拡張が返した cookie から、運んでよい物だけ。外す物 = IdP の domain・頼んだ site の外の分割保存（親の site が空 / 別 site）。外した物は理由つきで返す（card に薄く出す）
export function pick<T extends { domain: string; partitionKey?: { topLevelSite?: string } }>(cookies: T[], host = ""): { kept: T[]; skipped: Unmovable[] } {
  const kept: T[] = [];
  const skipped = new Map<string, Unmovable>();
  const foreign = (c: T) => { if (!c.partitionKey) return false; const top = c.partitionKey.topLevelSite; if (!top) return true; try { return !!host && !sameSite(new URL(top).hostname, host); } catch { return true; } };
  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, "");
    const why = isIdp(c.domain) ? WHY_IDP : foreign(c) ? WHY_PART : "";
    why ? skipped.set(`${domain}\t${why}`, { domain, reason: why }) : kept.push(c);
  }
  return { kept, skipped: [...skipped.values()] };
}

// W8g-3: 履歴は cookie と別の承諾（card の checkbox・既定 off）。渡すのは「題と URL（query と # は落とす）」を頼んだ host の分だけ・直近 HISTORY_LIMIT 件。人の Chrome の History DB は読まない（拡張の chrome.history.search だけ）
export const HISTORY_LIMIT = 20;
export type Visit = { url: string; title: string };
export function shapeHistory(items: { url?: string; title?: string }[], host: string, limit = HISTORY_LIMIT): Visit[] {
  const seen = new Set<string>();
  const out: Visit[] = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (out.length >= Math.min(limit, HISTORY_LIMIT)) break;
    try {
      const u = new URL(String(it?.url ?? ""));
      const h = u.hostname.toLowerCase();
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || !(h === host || h.endsWith(`.${host}`))) continue;
      const url = `${u.origin}${u.pathname}`; // query と fragment は落とす（token が入りうる）
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, title: String(it?.title ?? "").replace(/\s+/g, " ").slice(0, 200) });
    } catch { /* 読めない URL は渡さない */ }
  }
  return out;
}

// 前回の選択 = 運んだ domain の名前だけ。値・cookie の名前は型の上でも受けない（domain の形でない文字は捨てる）
export const DOMAIN_RE = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)$/;
export function makePrefs(file: () => string) {
  const read = (): string[] => { try { const j = JSON.parse(readFileSync(file(), "utf8")); return Array.isArray(j?.domains) ? j.domains.filter((d: unknown) => typeof d === "string" && d.length <= 253 && DOMAIN_RE.test(d)) : []; } catch { return []; } };
  return {
    domains: read,
    remember(domains: string[]) {
      const next = [...new Set([...read(), ...domains.map((d) => d.toLowerCase().replace(/^\./, "")).filter((d) => d.length <= 253 && DOMAIN_RE.test(d))])].slice(-50);
      if (!next.length) return;
      mkdirSync(dirname(file()), { recursive: true });
      const tmp = `${file()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ domains: next }), { mode: 0o600 });
      renameSync(tmp, file());
    },
    forget: () => { rmSync(file(), { force: true }); },
  };
}

// card に出す物 = domain ごとの cookie の名前と件数だけ。値は型の上でも持たない
export function listing(cookies: { name: string; domain: string }[], remembered: string[] = []): Listing[] {
  const m = new Map<string, string[]>();
  for (const c of cookies) m.set(c.domain.replace(/^\./, ""), [...(m.get(c.domain.replace(/^\./, "")) ?? []), c.name]);
  return [...m].map(([domain, names]) => ({ domain, names: [...new Set(names)].sort(), count: names.length, remembered: remembered.includes(domain) }));
}
const keyOf = (c: { name: string; domain: string; path: string }) => `${c.domain}\t${c.path}\t${c.name}`;

// 一覧（人が見た物）に無い cookie は入れない。拡張が承諾の後で増やした物・食い違いは落とす
export const onlyListed = <T extends { name: string; domain: string; path: string }>(got: T[], seen: { name: string; domain: string; path: string }[]) => {
  const ok = new Set(seen.map(keyOf));
  return got.filter((c) => ok.has(keyOf(c)));
};

// chrome.cookies の形 → CDP の CookieParam
export function toCdp(c: Cookie) {
  const ss = c.sameSite === "no_restriction" ? "None" : c.sameSite === "lax" ? "Lax" : c.sameSite === "strict" ? "Strict" : undefined;
  return {
    name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
    ...(ss ? { sameSite: ss } : {}),
    ...(c.session || c.expirationDate == null ? {} : { expires: c.expirationDate }),
    ...(c.partitionKey ? { partitionKey: { topLevelSite: c.partitionKey.topLevelSite, hasCrossSiteAncestor: !!c.partitionKey.hasCrossSiteAncestor } } : {}),
  };
}

// 値を文字から消す。error 文・頁の本文など「外へ出る文字」は必ずこれを通す（短すぎる値は偶然の一致が多いので 4 字以上だけ）
export function scrub(text: string, values: string[]): string {
  let out = text;
  for (const v of [...new Set(values)].filter((x) => x.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(v).join("＊＊＊");
  return out;
}

// ---- CDP（browser 全体の口に 1 本）----
export type Cdp = { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>; close: () => void };
export async function cdpConnect(browserUrl: string): Promise<Cdp> {
  const v = (await (await fetch(`${browserUrl}/json/version`, { signal: AbortSignal.timeout(3000) })).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ブラウザの口に繋げません")); });
  let seq = 0;
  const wait = new Map<number, { res: (r: any) => void; rej: (e: Error) => void }>();
  ws.onmessage = (e) => {
    const j = JSON.parse(String(e.data));
    const w = wait.get(j.id);
    if (!w) return;
    wait.delete(j.id);
    j.error ? w.rej(new Error(`${j.error.message}`)) : w.res(j.result);
  };
  ws.onclose = () => { for (const w of wait.values()) w.rej(new Error("ブラウザの口が閉じました")); wait.clear(); };
  return {
    send: (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = ++seq;
      const t = setTimeout(() => { wait.delete(id); rej(new Error(`${method} が返りません`)); }, 15_000);
      wait.set(id, { res: (r) => { clearTimeout(t); res(r); }, rej: (e) => { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
    close: () => ws.close(),
  };
}

type Verdict = "yes" | "no" | "timeout" | "gone";
export type CarryOpts = {
  web: () => Driver; faces?: (owner: string) => { tabId: number }[]; // 値を運ぶ宛先 = この頼みの tab を持つ拡張の口（tabId で引く）
  browserUrl: () => Promise<string | null>;
  onChange?: () => void; approvalMs?: number;
  prefsFile?: () => string; // 前回の選択（domain の名前だけ）を置く file。無ければ覚えない
  connect?: (browserUrl: string) => Promise<Cdp>; // 試験用
};

// 頼みごと（owner）ごとの表。承諾待ち（card）と、運んだ後の browser context（頁を開く先）
export function makeCarry(opts: CarryOpts) {
  const waits = new Map<string, { card: CarryCard; settle: (v: Verdict) => void }>();
  const ctxs = new Map<string, { cdp: Cdp; contextId: string; hosts: Set<string>; values: string[] }>();
  const connect = opts.connect ?? cdpConnect;
  const prefs = opts.prefsFile ? makePrefs(opts.prefsFile) : null;
  const epoch = new Map<string, number>(); // end / endAll のたびに +1。承諾の後で取り戻された ask が、終わった後に context を作らないための印
  const pending = new Set<string>(); // 承諾待ち以前の段（拡張に一覧を頼む間）も含めて、1 つの頼みに ask は 1 本
  const bump = (o: string) => epoch.set(o, (epoch.get(o) ?? 0) + 1);

  const askHuman = (card: CarryCard) => new Promise<Verdict>((resolve) => {
    const settle = (v: Verdict) => { clearTimeout(t); waits.delete(card.id); opts.onChange?.(); resolve(v); };
    const t = setTimeout(() => settle("timeout"), opts.approvalMs ?? (Number(process.env.KANGAE_CARRY_MS) || CARRY_MS));
    waits.set(card.id, { card, settle });
    opts.onChange?.();
  });

  const drop = async (owner: string) => {
    const c = ctxs.get(owner);
    if (!c) return false;
    ctxs.delete(owner);
    await c.cdp.send("Target.disposeBrowserContext", { browserContextId: c.contextId }).catch(() => {});
    c.cdp.close();
    c.values.length = 0;
    return true;
  };

  return {
    cards: () => [...waits.values()].map((w) => w.card),
    // card の「覚えない」: 覚えている domain を消し、この card の運びも覚えない。card は待ち続ける（運ぶかは別に人が決める）
    forget: (id: string) => { const w = waits.get(id); if (!w) return false; prefs?.forget(); w.card.remember = false; w.card.groups.forEach((g) => (g.remembered = false)); opts.onChange?.(); return true; },
    // history は card の checkbox が on の時だけ true。無い承諾は履歴なし
    answer: (id: string, yes: boolean, history = false) => { const w = waits.get(id); if (!w) return false; w.card.history.on = yes && history === true; w.settle(yes ? "yes" : "no"); return true; },
    has: (owner: string) => ctxs.has(owner),
    // 頼みの終わり・取り戻す・全部止める: 待っている card は断りと同じ・運んだ物は context ごと捨てる
    end: async (owner: string) => {
      bump(owner);
      for (const w of [...waits.values()]) if (w.card.owner === owner) w.settle("gone");
      return drop(owner);
    },
    endAll: async () => {
      for (const o of new Set([...pending, ...ctxs.keys()])) bump(o);
      for (const w of [...waits.values()]) w.settle("gone");
      for (const o of [...ctxs.keys()]) await drop(o);
    },

    async ask(owner: string, target: string): Promise<{ ok: true; text: string } | { ok: false; hint: string }> {
      const t = parseTarget(target);
      if (!t) return { ok: false, hint: "運ぶ site を host で渡してください（例: kangae carry example.com）" };
      if (isIdp(t.host)) return { ok: false, hint: `${t.host} はログインの窓口（Google などの認証の入口）なので運びません。運ぶのは頼まれた site のログインだけです` };
      if (pending.has(owner)) return { ok: false, hint: "この頼みの承諾を、人がまだ答えていません" };
      pending.add(owner);
      const e0 = epoch.get(owner) ?? 0;
      try { return await this.carry(owner, t, e0); } finally {
        pending.delete(owner);
        // 履歴の許可は運び終わり（成功・断り・時間切れ・取り戻し）で Chrome から外す。次の on はまた人の click の中で request する
        await opts.web().call("history_revoke", {}).catch(() => {});
      }
    },
    async carry(owner: string, t: { host: string; url: string }, e0: number): Promise<{ ok: true; text: string } | { ok: false; hint: string }> {
      const gone = () => (epoch.get(owner) ?? 0) !== e0;
      let browser: string | null;
      try { browser = await opts.browserUrl(); } catch (e) { return { ok: false, hint: (e as Error).message }; }
      if (!browser) return { ok: false, hint: "agent 用のブラウザ（headless Chrome）が使えません" };
      const tabId = opts.faces?.(owner)[0]?.tabId;
      const names = await opts.web().call("cookie_names", { url: t.url, tabId });
      const got = names.data as { cookies?: { name: string; domain: string; path: string }[] } | null;
      if (names.isError || !got?.cookies) return { ok: false, hint: `人のブラウザの拡張から cookie の一覧を取れませんでした（${(names.text || "拡張が応答しません").slice(0, 120)}）。ログインが要ります` };
      const seen = pick(got.cookies, t.host);
      if (!seen.kept.length) return { ok: false, hint: `${t.host} のログインが人のブラウザに見つかりません。ログインが要ります` };
      const card: CarryCard = { id: crypto.randomUUID(), owner, host: t.host, groups: listing(seen.kept, prefs?.domains() ?? []), skipped: seen.skipped, remember: !!prefs, at: Date.now(), history: { limit: HISTORY_LIMIT, on: false } };
      const v = await askHuman(card);
      if (v !== "yes") return { ok: false, hint: v === "no" ? "人が運ぶのを断りました。ログインが要ります" : v === "timeout" ? "時間内に答えがありませんでした。何も運んでいません。ログインが要ります" : "取り戻されたので何も運んでいません" };
      // 値を取る。承諾した一覧に無い物は落とす
      if (gone()) return { ok: false, hint: "取り戻されたので何も運んでいません" };
      const res = await opts.web().call("cookie_get", { url: t.url, tabId });
      const all = (res.data as { cookies?: Cookie[] } | null)?.cookies;
      if (res.isError || !all) return { ok: false, hint: "cookie を取れませんでした。何も運んでいません。ログインが要ります" };
      // 履歴: checkbox が on の承諾だけ。拡張から取った物を、ここでもう一度 host・件数・query で絞る
      let hist = "履歴は渡されていません。";
      if (card.history.on) {
        const h = await opts.web().call("history_get", { host: t.host, limit: HISTORY_LIMIT, tabId });
        const items = (h.data as { items?: { url?: string; title?: string }[] } | null)?.items;
        if (h.isError || !items) hist = `履歴は渡されていません（取れませんでした: ${(h.text || "拡張が応答しません").slice(0, 100)}）。`;
        else {
          const v = shapeHistory(items, t.host);
          hist = v.length ? `この site で前に見た頁（直近 ${v.length} 件・題と URL だけ・渡したのはこの一覧だけ）:\n${v.map((x) => `- ${x.title || "(題なし)"} ${x.url}`).join("\n")}` : "この site の履歴は 0 件でした。";
        }
      }
      const take = onlyListed(pick(all, t.host).kept, seen.kept);
      const values = take.map((c) => c.value);
      try {
        let c = ctxs.get(owner);
        if (!c) {
          const cdp = await connect(browser);
          const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: false });
          c = { cdp, contextId: browserContextId, hosts: new Set(), values: [] };
          ctxs.set(owner, c);
        }
        await c.cdp.send("Storage.setCookies", { cookies: take.map(toCdp), browserContextId: c.contextId });
        if (gone()) { await drop(owner); return { ok: false, hint: "取り戻されたので何も運んでいません" }; }
        c.hosts.add(t.host);
        c.values.push(...values);
        if (card.remember) prefs?.remember(take.map((x) => x.domain)); // 覚えるのは domain の名前だけ
        const miss = seen.kept.length - take.length;
        return { ok: true, text: `${t.host} のログイン（cookie ${take.length} 件・値は見せません${miss > 0 ? `・取れなかった ${miss} 件は運んでいません` : ""}）を、この頼み専用の見えないブラウザに運びました。頁は \`carry-read <url>\` で読めます。頼みが終わると捨てられます\n${hist}` };
      } catch (e: any) {
        return { ok: false, hint: `運べませんでした: ${scrub(String(e?.message ?? e), values).slice(0, 160)}` };
      } finally {
        values.length = 0;
      }
    },

    // 運んだ site の頁を、その頼み専用の context で開いて読む（default の context には cookie が無い）
    async read(owner: string, url: string): Promise<{ ok: true; text: string } | { ok: false; hint: string }> {
      const c = ctxs.get(owner);
      if (!c) return { ok: false, hint: "運んだログインがありません。先に `carry <host>` で人に頼んでください" };
      const t = parseTarget(url);
      if (!t || ![...c.hosts].some((h) => t.host === h || t.host.endsWith(`.${h}`))) return { ok: false, hint: `運んだ site（${[...c.hosts].join("、")}）の頁だけ読めます` };
      let targetId = "";
      try {
        ({ targetId } = await c.cdp.send("Target.createTarget", { url: "about:blank", browserContextId: c.contextId }));
        const { sessionId } = await c.cdp.send("Target.attachToTarget", { targetId, flatten: true });
        await c.cdp.send("Page.navigate", { url: /^https?:\/\//i.test(url) ? url : t.url }, sessionId);
        // 回数でなく 15 秒の締切（40 回では遅い機械で evaluate が長引くと総時間が伸びて頁の途中を読んだ）。越えたら今ある所までを読む
        await pollUntil(async () => (await c.cdp.send("Runtime.evaluate", { expression: "location.href==='about:blank'?'':document.readyState", returnByValue: true }, sessionId)).result?.value === "complete", 15_000, 150);
        const r = await c.cdp.send("Runtime.evaluate", { expression: "JSON.stringify({u:location.href,t:document.title,b:(document.body&&document.body.innerText)||''})", returnByValue: true }, sessionId);
        const j = JSON.parse(r.result?.value ?? "{}") as { u?: string; t?: string; b?: string };
        let endHost = ""; try { endHost = new URL(String(j.u)).hostname.toLowerCase(); } catch {} // 移動（redirect）の先も運んだ site の中か。外なら中身は返さない
        if (!endHost || ![...c.hosts].some((h) => endHost === h || endHost.endsWith(`.${h}`))) return { ok: false, hint: `運んだ site の外（${endHost || "?"}）へ移ったので、中身は返しません。login が切れているかもしれません` };
        return { ok: true, text: scrub(`読んだ頁 ${j.u}（題: ${j.t}）\n${(j.b ?? "").slice(0, 20_000)}`, c.values) };
      } catch (e: any) {
        return { ok: false, hint: `読めませんでした: ${scrub(String(e?.message ?? e), c.values).slice(0, 160)}` };
      } finally {
        if (targetId) await c.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      }
    },
  };
}
