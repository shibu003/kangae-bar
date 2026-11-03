// W8g: ログイン状態を運ぶ。値が外に出ない・承諾が無ければ運ばない・IdP と一覧の外を入れない・頼みごとの context に閉じる
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cdp, type Cookie, WHY_IDP, WHY_PART, makeCarry, makePrefs, onlyListed, parseTarget, pick, scrub, toCdp } from "../src/carry.ts";
import { pollUntil } from "../src/wait.ts";

const SECRET = "s3cr3t-session-VALUE-8812";
const OTHER = "csrf-token-VALUE-4431";
const jar: Cookie[] = [
  { name: "sid", value: SECRET, domain: "app.example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", hostOnly: true },
  { name: "csrf", value: OTHER, domain: ".example.com", path: "/", secure: true, httpOnly: false, sameSite: "no_restriction", expirationDate: 2e9 },
  { name: "g", value: "google-VALUE-0001", domain: "accounts.google.com", path: "/", secure: true, httpOnly: true },
];
const names = (cs: Cookie[]) => cs.map(({ name, domain, path }) => ({ name, domain, path }));
const leaks = (outs: string[], values = [SECRET, OTHER]) => outs.filter((o) => values.some((v) => o.includes(v))).length;

// 偽の browser: context ごとの cookie 入れ。頁を読むと、その context の cookie があれば「ようこそ」
function fakeCdp(redirectTo?: string) { // redirectTo = 移動の先（頼んだ url とは別の host へ飛ばされた場面）
  const store = new Map<string, { name: string; value: string }[]>();
  const sent: string[] = [];
  let n = 0, nav = "http://x/";
  const cdp: Cdp = {
    send: async (method, params: any = {}) => {
      sent.push(method);
      if (method === "Target.createBrowserContext") return { browserContextId: `ctx${++n}` };
      if (method === "Storage.setCookies") { const k = params.browserContextId ?? "default"; store.set(k, [...(store.get(k) ?? []), ...params.cookies]); return {}; }
      if (method === "Target.disposeBrowserContext") { store.delete(params.browserContextId); return {}; }
      if (method === "Page.navigate") { nav = redirectTo ?? params.url; return {}; }
      if (method === "Target.createTarget") return { targetId: `t:${params.browserContextId ?? "default"}` };
      if (method === "Target.attachToTarget") return { sessionId: params.targetId };
      if (method === "Runtime.evaluate") {
        const ctx = String(params.expression).includes("readyState") ? "" : "";
        void ctx;
        return { result: { value: String(params.expression).includes("readyState") ? "complete" : JSON.stringify({ u: nav, t: "マイページ", b: "ようこそ" }) } };
      }
      return {};
    },
    close() {},
  };
  return { cdp, store, sent };
}
const web = (calls: string[] = []) => ({
  call: async (tool: string) => {
    calls.push(tool);
    return { text: "", isError: false, data: { cookies: tool === "cookie_get" ? jar : names(jar) } };
  },
  close() {},
});
const make = (o: Partial<Parameters<typeof makeCarry>[0]> & { calls?: string[]; redirectTo?: string } = {}) => {
  const f = fakeCdp(o.redirectTo);
  const changes: number[] = [];
  const c = makeCarry({ web: () => web(o.calls), browserUrl: async () => "http://127.0.0.1:1", onChange: () => changes.push(1), approvalMs: 80, ...o, connect: async () => f.cdp });
  return { c, f, changes };
};
const nextCard = async (c: ReturnType<typeof makeCarry>) => { await pollUntil(() => c.cards().length, 40_000, 5); return c.cards()[0]!; };

test("承諾 → 運ぶ。card は名前と件数だけ・値はどの出力にも出ない・IdP は外す・context に入る（default には 0）", async () => {
  const { c, f } = make({ approvalMs: 2000 });
  const logs: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a) => logs.push(a.join(" ")); console.error = (...a) => logs.push(a.join(" "));
  try {
    const p = c.ask("s:1", "app.example.com");
    const card = await nextCard(c);
    expect(card.groups.map((g) => [g.domain, g.count]).sort()).toEqual([["app.example.com", 1], ["example.com", 1]]);
    expect(card.skipped).toEqual([{ domain: "accounts.google.com", reason: WHY_IDP }]);
    const r = await (c.answer(card.id, true), p);
    expect(r.ok).toBe(true);
    const r2 = await c.read("s:1", "http://app.example.com/me");
    expect(r2.ok).toBe(true);
    const outs = [JSON.stringify(card), JSON.stringify(r), JSON.stringify(r2), ...logs];
    expect(leaks(outs)).toBe(0);
    expect(leaks([`わざと ${SECRET} を書く`])).toBe(1); // 負の対照: 検査は値が出たら赤くなれる
  } finally { console.log = log; console.error = err; }
  const all = [...f.store].flatMap(([k, v]) => v.map((x) => [k, x.name]));
  expect(all).toEqual([["ctx1", "sid"], ["ctx1", "csrf"]]); // IdP の g は無い・default の context には 0
  expect(f.store.get("default")).toBeUndefined();
});

test("承諾が無ければ運ばない: 断る / 時間切れ / 取り戻す(end) は同じ「何も運ばない」で、値を取りにも行かない", async () => {
  for (const how of ["no", "timeout", "gone"] as const) {
    const calls: string[] = [];
    const { c, f } = make({ calls, approvalMs: how === "timeout" ? 30 : 2000 });
    const p = c.ask("s:1", "app.example.com");
    const card = await nextCard(c);
    if (how === "no") c.answer(card.id, false);
    if (how === "gone") await c.end("s:1");
    const r = await p;
    expect(r.ok).toBe(false);
    expect(calls).toEqual(["cookie_names", "history_revoke"]); // cookie_get（値）は一度も頼んでいない・終わりに履歴の許可を外す
    expect(f.sent).toEqual([]); // browser にも何も送っていない
    expect(c.cards().length).toBe(0); // 待ちは片づく
  }
  const { c } = make({ approvalMs: 2000 });
  const p = c.ask("s:2", "app.example.com");
  await nextCard(c);
  await c.endAll(); // 全部止める
  expect((await p).ok).toBe(false);
});

test("identity provider そのものは頼まれても運ばない・host の形が怪しい物は拒否", async () => {
  const { c } = make();
  expect((await c.ask("s:1", "accounts.google.com")).ok).toBe(false);
  expect((await c.ask("s:1", "sub.okta.com")).ok).toBe(false);
  expect((await c.ask("s:1", "")).ok).toBe(false);
  expect((await c.ask("s:1", "http://user:pw@example.com")).ok).toBe(false);
  expect(parseTarget("localhost:3000")).toEqual({ host: "localhost", url: "http://localhost:3000/" });
  expect(parseTarget("example.com")?.url).toBe("https://example.com/");
});

test("domain の絞り: 承諾した一覧に無い cookie は入れない・IdP の cookie は外す", () => {
  const seen = names(jar.slice(0, 1));
  expect(onlyListed(jar, seen).map((c) => c.name)).toEqual(["sid"]);
  expect(pick(jar).kept.length).toBe(2);
  expect(pick(jar).skipped.map((x) => x.domain)).toEqual(["accounts.google.com"]);
});

test("別の頼みごと（owner）の context からは cookie 0・context を外す(default に入れる)と赤になる", async () => {
  const { c, f } = make({ approvalMs: 2000 });
  const p = c.ask("s:1", "app.example.com");
  c.answer((await nextCard(c)).id, true);
  await p;
  expect((await c.read("s:2", "http://app.example.com/me")).ok).toBe(false); // 別の owner は読む context 自体を持たない
  expect(c.has("s:2")).toBe(false);
  expect(f.store.get("default")).toBeUndefined();
  // 負の対照: browserContextId を付けずに入れる壊れた実装だと default に入る = この検査が赤になる
  const broken = fakeCdp();
  await broken.cdp.send("Storage.setCookies", { cookies: [{ name: "sid" }] });
  expect(broken.store.get("default")?.length).toBe(1);
  // 頼みの終わりで context ごと捨てる
  await c.end("s:1");
  expect(f.store.size).toBe(0);
  expect(c.has("s:1")).toBe(false);
  expect((await c.read("s:1", "http://app.example.com/me")).ok).toBe(false);
});

test("運んだ site の外の頁は読ませない・scrub は外へ出る文字から値を消す・toCdp の形", async () => {
  const { c } = make({ approvalMs: 2000 });
  const p = c.ask("s:1", "app.example.com");
  c.answer((await nextCard(c)).id, true);
  await p;
  expect((await c.read("s:1", "https://evil.example.org/")).ok).toBe(false);
  expect(scrub(`error ${SECRET} ${OTHER}`, [SECRET, OTHER])).toBe("error ＊＊＊ ＊＊＊");
  expect(toCdp(jar[1]!)).toMatchObject({ sameSite: "None", expires: 2e9 });
  expect(toCdp(jar[0]!)).toMatchObject({ sameSite: "Lax", httpOnly: true });
  expect("expires" in toCdp(jar[0]!)).toBe(false);
});

test("承諾の後に拡張が増やした cookie（一覧に無い物）は入れない", async () => {
  const f = fakeCdp();
  const late: Cookie = { name: "late", value: "late-VALUE-9999", domain: "evil.example.net", path: "/", secure: true, httpOnly: false };
  const c = makeCarry({ web: () => ({ call: async (t: string) => ({ text: "", isError: false, data: { cookies: t === "cookie_get" ? [...jar, late] : names(jar) } }), close() {} }), browserUrl: async () => "http://x", connect: async () => f.cdp, approvalMs: 2000 });
  const p = c.ask("s:1", "app.example.com");
  c.answer((await nextCard(c)).id, true);
  await p;
  expect([...f.store.values()].flat().map((x) => x.name)).toEqual(["sid", "csrf"]);
});

// ---- W8g-2: 前回の選択（domain の名前だけ）・運べない物は薄く理由つき ----
const prefsPath = () => join(mktmp("w8g2"), "carry-prefs.json");
const withPrefs = (file: string, o: Partial<Parameters<typeof makeCarry>[0]> = {}) => make({ prefsFile: () => file, approvalMs: 2000, ...o });
const carryOnce = async (c: ReturnType<typeof makeCarry>, owner: string, yes = true) => { const p = c.ask(owner, "app.example.com"); const card = await nextCard(c); const snap = structuredClone(card); c.answer(card.id, yes); return { r: await p, card: snap }; };

test("覚えるのは domain の名前だけ: file に値も cookie の名前も 0 件・2 回目の card に印・値や名前を渡しても書かれない", async () => {
  const file = prefsPath();
  const { c } = withPrefs(file);
  const one = await carryOnce(c, "s:1");
  expect(one.r.ok).toBe(true);
  expect(one.card.groups.every((g) => !g.remembered)).toBe(true); // 初回は印なし
  const raw = readFileSync(file, "utf8");
  expect(JSON.parse(raw).domains.sort()).toEqual(["app.example.com", "example.com"]);
  expect([SECRET, OTHER, "sid", "csrf", "google"].filter((x) => raw.includes(x))).toEqual([]); // 値・名前・IdP は 0 件
  await c.end("s:1");
  const two = await carryOnce(c, "s:2");
  expect(two.card.groups.map((g) => [g.domain, g.remembered]).sort()).toEqual([["app.example.com", true], ["example.com", true]]);
  expect(two.card.skipped.every((x) => x.domain === "accounts.google.com")).toBe(true);
  // 負の対照: 値や名前を覚えさせようとしても書かれない（domain の形だけ通る）。検査が赤くなれることは leaks で示す
  const p = makePrefs(() => file);
  p.remember([SECRET, "sid", "a b", "x".repeat(300), "new.example.org"]);
  const after = readFileSync(file, "utf8");
  expect(JSON.parse(after).domains).toContain("new.example.org");
  expect([SECRET, "sid"].filter((x) => after.includes(x))).toEqual([]);
  expect(leaks([`{"domains":["${SECRET}"]}`])).toBe(1);
});

test("運べない物（IdP・取り出せない partitioned）は理由つきで一覧に出るが、運ばれない・覚えられない", async () => {
  const part: Cookie = { name: "px", value: "part-VALUE-7777", domain: "app.example.com", path: "/", secure: true, httpOnly: false, partitionKey: { topLevelSite: "https://top.example" } };
  const f = fakeCdp();
  const file = prefsPath();
  const full = [...jar, part];
  const c = makeCarry({ web: () => ({ call: async (t: string) => ({ text: "", isError: false, data: { cookies: t === "cookie_get" ? full : names(full).map((n, i) => ({ ...n, ...(full[i]!.partitionKey ? { partitionKey: full[i]!.partitionKey } : {}) })) } }), close() {} }), browserUrl: async () => "http://x", connect: async () => f.cdp, approvalMs: 2000, prefsFile: () => file });
  const { r, card } = await carryOnce(c, "s:1");
  expect(r.ok).toBe(true);
  expect(card.skipped.map((x) => x.reason).sort()).toEqual([WHY_IDP, WHY_PART].sort());
  expect(JSON.stringify(card.groups)).not.toContain("px"); // 一覧（運ぶ物）には入らない
  expect([...f.store.values()].flat().map((x) => x.name)).toEqual(["sid", "csrf"]); // context の cookie に px と g は 0
  expect(readFileSync(file, "utf8")).not.toContain("google");
  expect(pick([part], "app.example.com").kept.length).toBe(0);
  expect(pick([{ ...part, partitionKey: { topLevelSite: "" } }]).kept.length).toBe(0); // 親が空（取り出せない）
  const third: Cookie = { ...part, partitionKey: { topLevelSite: "https://top.example" } };
  expect(pick([third], "app.example.com").kept.length).toBe(0); // 別の site の中でだけ使われる物は運ばない
  expect(pick([{ ...part, partitionKey: { topLevelSite: "https://example.com" } }], "app.example.com").kept.length).toBe(1); // 頼んだ site 自身の分割保存は運べる
});

test("「覚えない」: file が消え・その card の運びも書かず・次の card に印が無い", async () => {
  const file = prefsPath();
  const { c } = withPrefs(file);
  await carryOnce(c, "s:1");
  await c.end("s:1");
  expect(existsSync(file)).toBe(true);
  const p = c.ask("s:2", "app.example.com");
  const card = await nextCard(c);
  expect(card.groups.some((g) => g.remembered)).toBe(true);
  expect(c.forget(card.id)).toBe(true);
  expect(existsSync(file)).toBe(false);
  expect(c.cards()[0]!.groups.some((g) => g.remembered)).toBe(false);
  expect(c.cards()[0]!.remember).toBe(false);
  c.answer(card.id, true);
  expect((await p).ok).toBe(true); // 運ぶかは別に人が決める
  expect(existsSync(file)).toBe(false); // 今回の運びも覚えない
  await c.end("s:2");
  const three = await carryOnce(c, "s:3");
  expect(three.card.groups.every((g) => !g.remembered)).toBe(true);
  expect(c.forget("nope")).toBe(false);
});

// ---- W8g-3: 履歴は別の承諾（既定 off）----
import { HISTORY_LIMIT, shapeHistory } from "../src/carry.ts";
import { readdirSync } from "node:fs";

const visits = [
  { url: "http://app.example.com/a?token=SECRETQ1#frag-9", title: "記事 A" },
  { url: "http://app.example.com/a?other=2", title: "記事 A（重複）" },
  { url: "http://evil.com/x", title: "別 domain" },
  { url: "http://notapp.example.com.evil.com/", title: "似た名前" },
  { url: "http://sub.app.example.com/b", title: "記事 B" },
  { url: "chrome://history", title: "chrome" },
];
const hweb = (calls: string[]) => ({ call: async (tool: string) => { calls.push(tool); return tool === "history_get" ? { text: "", isError: false, data: { items: visits } } : { text: "", isError: false, data: { cookies: tool === "cookie_get" ? jar : names(jar) } }; }, close() {} });
const runHist = async (history: boolean) => {
  const calls: string[] = [];
  const f = fakeCdp();
  const c = makeCarry({ web: () => hweb(calls), browserUrl: async () => "http://127.0.0.1:1", connect: async () => f.cdp, approvalMs: 2000 });
  const p = c.ask("s:1", "app.example.com");
  const card = await nextCard(c);
  expect(card.history.on).toBe(false); // 既定 off
  c.answer(card.id, true, history);
  return { r: await p, calls };
};

test("履歴: checkbox が無い承諾は履歴なし（拡張にも頼まない）・on なら host の分だけ・query と # は落ちる", async () => {
  const off = await runHist(false);
  expect(off.calls).not.toContain("history_get");
  expect(off.r.ok && off.r.text).toContain("履歴は渡されていません");
  const on = await runHist(true);
  expect(on.calls).toContain("history_get");
  const t = on.r.ok ? on.r.text : "";
  expect(t).toContain("http://app.example.com/a");
  expect(t).toContain("http://sub.app.example.com/b");
  expect(t).not.toContain("evil.com");
  expect(t).not.toContain("chrome://");
  expect(t).not.toMatch(/SECRETQ1|frag-9|other=2/);
});

test("履歴: 件数の上限・重複排除・query/fragment を落とす（外すと赤）", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ url: `http://h.com/p${i}?q=${i}#f`, title: `t${i}` }));
  const out = shapeHistory(many, "h.com", 999);
  expect(out.length).toBe(HISTORY_LIMIT);
  expect(out.every((v) => !/[?#]/.test(v.url))).toBe(true);
  expect(shapeHistory(visits, "app.example.com").map((v) => v.url)).toEqual(["http://app.example.com/a", "http://sub.app.example.com/b"]);
  // 負の対照: 絞らない実装なら query が残る = 上の検査は赤になれる
  expect(visits.map((v) => v.url).some((u) => /[?#]/.test(u))).toBe(true);
});

test("履歴の許可 dialog の発火元は panel の「運ぶ」click の 1 か所だけ（agent の頼み・時間切れ・常駐・拡張の sw からは request を呼ばない）", () => {
  const scan = (files: Record<string, string>) => Object.entries(files).flatMap(([f, s]) => (s.match(/permissions\.request\(/g) ?? []).map(() => f));
  const read = (d: string) => readdirSync(d).filter((f) => /\.(js|ts|html)$/.test(f)).map((f) => [`${d}/${f}`, readFileSync(`${d}/${f}`, "utf8")] as const);
  const files = Object.fromEntries([...read("extension"), ...read("src")]);
  expect(scan(files)).toEqual(["extension/panel.js"]);
  const panel = files["extension/panel.js"];
  expect(panel).toMatch(/approveEl\(async \(choice\) => \{[^}]*if \(yes && hb\.checked\) history = await chrome\.permissions\.request/s);
  // 負の対照: 常駐に request が増えたら scan は 2 件になる
  expect(scan({ ...files, "src/carry.ts": "chrome.permissions.request({})" }).length).toBe(2);
});

test("F1: 運び終わり（承諾・断り・時間切れ）で履歴の許可を外す／request は panel の click だけ・remove は拡張の側にある", async () => {
  for (const ans of ["yes", "no", "timeout"] as const) {
    const calls: string[] = [];
    const c = makeCarry({ web: () => hweb(calls), browserUrl: async () => "http://127.0.0.1:1", connect: async () => fakeCdp().cdp, approvalMs: ans === "timeout" ? 30 : 2000 });
    const p = c.ask("s:1", "app.example.com");
    if (ans !== "timeout") { const card = await nextCard(c); c.answer(card.id, ans === "yes", true); }
    await p;
    expect(calls.at(-1)).toBe("history_revoke");
  }
  expect(readFileSync("extension/web.js", "utf8")).toMatch(/history_revoke[\s\S]*permissions\.remove\(\{ permissions: \["history"\] \}\)/);
});
