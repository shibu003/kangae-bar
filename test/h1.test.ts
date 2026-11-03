// H1（docs/BRIEF-h1.md）: 一覧の agent の行へ落とす・.app を落とす・Bar に落ちた URL・同じ URL の tab が 2 つ以上の時だけ選ぶ。
// 実機（Chrome の icon を Bar の NSPanel / side panel の行に落とせるか・Finder の .app が File で届くか）は未測（要 operator）。読む file を literal で名指す: "extension/panel.js" "extension/web.js"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeLeases, type Driver } from "../src/lease.ts";
import { HUMAN_OPS, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const between = (src: string, a: string, b: string) => src.slice(src.indexOf(a), src.indexOf(b));

// panel.js の関数を、DOM の無いまま stub を渡して動かす（読み込むと DOM を触る file なので、関数の本文だけ切り出す）
const panel = code(read("extension/panel.js"));
function giveUrlWith(env: { chrome?: any; call: (op: string, x?: any) => Promise<any>; pickTab?: (t: any[], who: string) => Promise<any> }) {
  const src = between(panel, "async function giveDroppedUrl", "async function giveDroppedApp");
  const out: { toasts: string[] } = { toasts: [] };
  const f = new Function("chrome", "call", "toast", "assigneeName", "pickTab", "gaveToast", "winId", "rootId", `${src}; return giveDroppedUrl;`)(
    env.chrome, env.call, (t: string) => out.toasts.push(t), (id: number) => `agent${id}`, env.pickTab ?? (async () => { throw new Error("聞いてはいけない"); }),
    (r: any, who: string) => out.toasts.push(r.ok ? `${who} に渡しました` : r.hint), undefined, 99,
  ) as (url: string, id?: number) => Promise<void>;
  // 実装は globalThis.chrome を見る（Bar には無い）。呼ぶ間だけ差す
  const run = async (url: string, id?: number) => { const g = globalThis as any, had = g.chrome; g.chrome = env.chrome; try { await f(url, id); } finally { g.chrome = had; } };
  return { f: run, out };
}
const tabsOf = (...t: { id: number; url: string; title?: string }[]) => ({ tabs: { query: async () => t, create: async () => { throw new Error("開いてはいけない"); } } });

test("H1-1 一覧の行への drop: 開いている会話（99）ではなく、行の担当（7）の leaseGive になる。会話を開かなくてよい", async () => {
  const calls: any[] = [];
  const { f, out } = giveUrlWith({ chrome: tabsOf({ id: 5, url: "https://ex.test/a#x", title: "A" }, { id: 6, url: "https://other.test/" }), call: async (op, x) => (calls.push({ op, ...x }), { ok: true }) });
  await f("https://ex.test/a", 7);
  expect(calls).toEqual([{ op: "leaseGive", rootId: 7, tabId: 5, title: "A" }]);
  expect(out.toasts).toEqual(["agent7 に渡しました"]);
  // 配線: 行（li）の dragover / drop は行の担当 r.id を渡し、会話の drop は開いている rootId。行の file は添付せず断る（inChat=false）
  expect(panel).toContain('li.addEventListener("dragover", (e) => dropOver(e, r.id, false))');
  expect(panel).toContain('li.addEventListener("drop", (e) => dropDo(e, r.id, false))');
  expect(panel).toContain('$("chat").addEventListener("drop", (e) => dropDo(e, rootId, true))');
  expect(panel).toContain("ここに落とすと ${assigneeName(id)} に渡します");
  // 負の対照: id を無視して rootId（99）に渡す実装に戻すと赤
  const bad = new Function("chrome", "call", "toast", "assigneeName", "pickTab", "gaveToast", "winId", "rootId", `${between(panel, "async function giveDroppedUrl", "async function giveDroppedApp").replace("rootId: id", "rootId: rootId")}; return giveDroppedUrl;`)(tabsOf({ id: 5, url: "https://ex.test/a" }), async (op: string, x: any) => (calls.push({ op, ...x }), { ok: true }), () => {}, () => "x", async () => null, () => {}, undefined, 99);
  calls.length = 0;
  (globalThis as any).chrome = tabsOf({ id: 5, url: "https://ex.test/a" });
  try { await bad("https://ex.test/a", 7); } finally { delete (globalThis as any).chrome; }
  expect(calls[0].rootId).toBe(99);
});

test("H1-2 同じ URL の tab が 2 つ以上の時だけ選ぶ: 1 つなら聞かない・2 つなら選んだ tab・やめたら渡さない・1 つも無ければ裏で開く", async () => {
  const same = [{ id: 1, url: "https://ex.test/a", title: "A1" }, { id: 2, url: "https://ex.test/a#top", title: "A2" }];
  for (const [tabs, pick, want] of [[same.slice(0, 1), null, [1]], [same, same[1], [2]], [same, null, []]] as const) {
    const calls: any[] = []; let asked: any[] | null = null;
    const { f } = giveUrlWith({ chrome: tabsOf(...tabs), call: async (op, x) => (calls.push({ op, ...x }), { ok: true }), pickTab: async (t) => ((asked = t), pick) });
    await f("https://ex.test/a", 7);
    expect(calls.filter((c) => c.op === "leaseGive").map((c) => c.tabId)).toEqual([...want]);
    expect(asked === null).toBe(tabs.length === 1); // 聞くのは 2 つ以上の時だけ
  }
  const made: any[] = [];
  const { f } = giveUrlWith({ chrome: { tabs: { query: async () => [], create: async (x: any) => (made.push(x), { id: 9, title: "" }) } }, call: async () => ({ ok: true }) });
  await f("https://ex.test/new", 7);
  expect(made[0]).toMatchObject({ url: "https://ex.test/new", active: false });
  // 選びは kg-approve の choice（既存の card の部品）で、同じ題でも選べるよう番号を付ける
  expect(between(panel, "function pickTab", "const gaveToast")).toContain('k.setAttribute("kind", "choice")');
  expect(panel).toContain("`${i + 1}. ${plain(");
});

test("H1-3 Bar（chrome.tabs 無し）: 常駐の urlTabs に聞いて leaseGive。拡張が居なければ hint を toast して leaseGive は打たない", async () => {
  const calls: any[] = [];
  const ok = giveUrlWith({ call: async (op, x) => (calls.push({ op, ...x }), op === "urlTabs" ? { ok: true, tabs: [{ id: 4, title: "T" }] } : { ok: true }) });
  await ok.f("https://ex.test/a", 7);
  expect(calls).toEqual([{ op: "urlTabs", url: "https://ex.test/a" }, { op: "leaseGive", rootId: 7, tabId: 4, title: "T" }]);
  calls.length = 0;
  const none = giveUrlWith({ call: async (op, x) => (calls.push({ op, ...x }), { ok: false, hint: "Chrome の Kangae を開いてください" }) });
  await none.f("https://ex.test/a", 7);
  expect(calls.map((c) => c.op)).toEqual(["urlTabs"]);
  expect(none.out.toasts).toEqual(["Chrome の Kangae を開いてください"]);
});

test("H1-4 落とした物の種類: 1 つだけの .app は app・他の file は file（添付）・uri-list は url。http(s) 以外の URL は何も呼ばない", () => {
  const kind = new Function(`${between(panel, "function dropKind", "function assigneeName")}; return dropKind;`)() as (dt: any) => string;
  const files = (...n: string[]) => ({ items: n.map(() => ({ kind: "file" })), files: n.map((name) => ({ name })), types: ["Files"] });
  expect(kind(files("Safari.app"))).toBe("app");
  expect(kind(files("SAFARI.APP"))).toBe("app");
  expect(kind(files("a.txt"))).toBe("file");
  expect(kind(files("A.app", "b.txt"))).toBe("file");
  expect(kind({ items: [{ kind: "file" }], files: [], types: ["Files"] })).toBe("file"); // dragover の間は名前が読めない
  expect(kind({ items: [{ kind: "string" }], types: ["text/uri-list"] })).toBe("url");
  expect(kind({ items: [], types: ["text/plain"] })).toBe("");
  // drop の入口: .app は giveDroppedApp・断った URL は giveDroppedUrl を呼ばない
  const calls: string[] = [];
  const dropDo = new Function("dropKind", "addFiles", "giveDroppedApp", "giveDroppedUrl", "droppedHttpUrl", "toast", `${between(panel, "function dropDo", '$("chat").addEventListener("dragover"')}; return dropDo;`)(
    kind, () => calls.push("attach"), (f: any, id: number) => calls.push(`app:${f.name}:${id}`), (u: string, id: number) => calls.push(`url:${u}:${id}`),
    (raw: string) => (/^https?:/.test(raw) ? raw : ""), (t: string) => calls.push(`toast:${t.slice(0, 6)}`),
  ) as (e: any, id: number, inChat: boolean) => void;
  const ev = (dt: any) => ({ dataTransfer: dt, preventDefault() {}, currentTarget: { classList: { remove() {} }, querySelector: () => null } });
  const withUri = (v: string) => ({ ...{ items: [{ kind: "string" }], types: ["text/uri-list"] }, getData: () => v });
  dropDo(ev(files("Safari.app")), 7, false);
  dropDo(ev(withUri("https://ex.test/a")), 7, false);
  dropDo(ev(withUri("javascript:alert(1)")), 7, false);
  dropDo(ev(files("a.txt")), 7, true);
  dropDo(ev(files("a.txt")), 7, false);
  expect(calls).toEqual(["app:Safari.app:7", "url:https://ex.test/a:7", "attach", "toast:file は"]);
});

test("H1-5 拡張: tabs_by_url は # より前の完全一致（match pattern を通さない）", () => {
  const web = code(read("extension/web.js"));
  const body = between(web, 'if (tool === "tabs_by_url")', 'if (tool === "tab_shot"');
  expect(body).toContain('.split("#")[0] === q');
  expect(body).not.toContain("url:"); // chrome.tabs.query({ url: … }) の pattern を使わない（* や port を含む URL が他の tab に当たる）
});

// ---- 常駐 ----
let top: string, home: string, calls: { tool: string; args: Record<string, any> }[];
beforeEach(() => { top = realpathSync(mktmp("h1")); home = join(top, "home"); mkdirSync(home); mkdirSync(join(top, "lease")); calls = []; });
afterEach(() => rmSync(top, { recursive: true, force: true }));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const web = (tabs: { id: number; title: string }[]): Driver => ({ call: async (tool, args) => (calls.push({ tool, args }), tool === "tabs_by_url" ? { text: "", isError: false, data: { tabs } } : tool === "open_tab" ? { text: "", isError: false, data: { tabId: 9, title: "新しい頁" } } : { text: "ok", isError: false, data: null }), close() {} });
const mk = (webDriver: Driver, leaseDriver: () => Driver | null = () => null) => {
  const s = openStore(":memory:");
  const ws = { dir: join(top, "ws"), bin: "/x/kangae", open: async () => true, clis: async () => [], spawn: (() => { throw new Error("spawn しない"); }) as any, browserUrl: async () => null };
  const h: any = makeHandler(s, async () => [], undefined, ws, { uiHome: home, webDriver, leaseDriver });
  return { s, h };
};

test("H1-6 Bar → 拡張: urlTabs は同じ URL の tab を返す・無ければ裏で開いた 1 枚・http(s) 以外は断る。agent の口は断られる", async () => {
  const two = mk(web([{ id: 1, title: "A1" }, { id: 2, title: "A2" }]));
  expect(await two.h({ op: "urlTabs", url: "https://ex.test/a#x" }, {})).toEqual({ ok: true, tabs: [{ id: 1, title: "A1" }, { id: 2, title: "A2" }], id: undefined });
  expect(calls).toEqual([{ tool: "tabs_by_url", args: { url: "https://ex.test/a#x" } }]);
  calls.length = 0;
  const none = mk(web([]));
  expect(await none.h({ op: "urlTabs", url: "https://ex.test/new" }, {})).toMatchObject({ ok: true, tabs: [{ id: 9, title: "新しい頁" }] });
  expect(calls.map((c) => c.tool)).toEqual(["tabs_by_url", "open_tab"]);
  calls.length = 0;
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "", "not a url"]) expect(await none.h({ op: "urlTabs", url: bad }, {})).toMatchObject({ ok: false });
  expect(calls).toEqual([]); // 拡張に何も送らない
  expect(await none.h({ op: "urlTabs", url: "https://ex.test/a" }, { write() {} })).toMatchObject({ ok: false, hint: `${HUMAN_OPS.urlTabs}は人が押す物です（agent からは押せません）` });
  expect(HUMAN_OPS.dropApp).toBeTruthy();
});

test("H1-7 .app を落とす: card 無しで launch_app（名前だけ・.app は外す）→ その窓がこの会話の面になる。編集器・agent の口・消えた会話は起こさない", async () => {
  const cua = (): Driver => ({ call: async (tool, args) => (calls.push({ tool, args }), tool === "launch_app" ? { text: "", isError: false, data: { pid: 30, windows: [{ pid: 30, window_id: 7, title: "無題", app_name: "Preview" }] } } : { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 30, window_id: 7 }] } : null }), close() {} });
  const { s, h } = mk(web([]), cua);
  const root = s.add(null, "user", "調べもの", true);
  const r = await h({ op: "dropApp", rootId: root.id, name: "Preview.app" }, {});
  expect(r).toMatchObject({ ok: true });
  expect(calls.filter((c) => c.tool === "launch_app")).toEqual([{ tool: "launch_app", args: { name: "Preview" } }]); // 許しの card を待たずに 1 回
  expect((await h({ op: "leaseList" })).approvals).toEqual([]);
  const faces = (await h({ op: "leaseList" })).leases;
  expect(faces).toHaveLength(1);
  expect(faces[0].owner).toBe(`s:${root.id}`);
  // 破られる所
  calls.length = 0;
  expect(await h({ op: "dropApp", rootId: root.id, name: "Zed.app" }, {})).toMatchObject({ ok: false }); // 編集器は前に出て画面を奪う
  expect(await h({ op: "dropApp", rootId: root.id, name: "../../bin/sh" }, {})).toMatchObject({ ok: false }); // path は渡せない
  expect(await h({ op: "dropApp", rootId: 9999, name: "Preview.app" }, {})).toMatchObject({ ok: false, hint: "session が見つかりません" });
  expect(await h({ op: "dropApp", rootId: root.id, name: "Preview.app" }, { write() {} })).toMatchObject({ ok: false, hint: `${HUMAN_OPS.dropApp}は人が押す物です（agent からは押せません）` });
  expect(calls.filter((c) => c.tool === "launch_app")).toEqual([]);
  // 負の対照: agent の経路（openAppFree）は今までどおり card を出して待つ
  const L = makeLeases(join(top, "lease"), { driver: cua, defaultMode: "allow", approvalMs: 5000, windowMs: 200 });
  const p = L.openAppFree("s:5", { app: "Preview" });
  for (let i = 0; i < 300 && !L.approvals().length; i++) await tick();
  expect(L.approvals()[0]).toMatchObject({ tool: "open_app", owner: "s:5" });
  L.answer(L.approvals()[0]!.id, false);
  expect(await p).toMatchObject({ ok: false });
});
