// W78o（inventory §10.0 #5）: 「開くだけ」の既定 openMode（allow|ask）。allow = open_tab / open_app の card を出さず裏で開き、開いたと知らせる（onOpened → toast）。
// 書き込みの Mode（許す / 先に聞く / 切る）とは別の値＝取り違えない。既定は ask（今まで通り card）。切り替えは人の設定だけ（W39c と同じ門）。実機の toast の見た目は未測（要 operator）
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeLeases, type Driver } from "../src/lease.ts";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
setDefaultTimeout(60_000);

let top: string, calls: { tool: string; args: Record<string, any> }[], told: any[];
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const NEW = { tabId: 9, docId: "nd", title: "課題", url: "https://canvas.example/courses/1" };
const web = (): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "", isError: false, data: tool === "open_tab" ? NEW : null }; }, close() {} });
const cua = (): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); if (tool === "launch_app") return { text: "", isError: false, data: { pid: 30, windows: [{ pid: 30, window_id: 7, title: "メモ", app_name: "Preview" }] } }; return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 30, window_id: 7 }] } : null }; }, close() {} });
const mk = (openMode?: () => "allow" | "ask", write: "allow" | "ask" = "ask") => makeLeases(join(top, "lease"), { web: web(), driver: cua, defaultMode: write, approvalMs: 5000, windowMs: 200, openMode, onOpened: (o) => told.push(o) });
const src = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const opens = () => calls.filter((c) => c.tool === "open_tab" || c.tool === "launch_app");
beforeEach(() => { top = realpathSync(mktmp("w78o")); mkdirSync(join(top, "lease")); calls = []; told = []; });
afterEach(() => rmSync(top, { recursive: true, force: true }));

test("W78o openMode=allow: open_tab / open_app は card 無しで裏で開き、開いたと知らせる（誰が・何を）", async () => {
  const L = mk(() => "allow");
  expect(await L.openTabFree("s:1", { url: "https://canvas.example/courses/1" })).toMatchObject({ ok: true });
  expect(L.approvals()).toEqual([]);
  expect(told).toEqual([{ owner: "s:1", kind: "tab", label: "https://canvas.example" }]);
  expect(await L.openAppFree("s:2", { app: "Preview" })).toMatchObject({ ok: true });
  expect(L.approvals()).toEqual([]);
  expect(told[1]).toEqual({ owner: "s:2", kind: "app", label: "Preview" });
  expect(opens().map((c) => c.tool)).toEqual(["open_tab", "launch_app"]);
});

test("W78o openMode=ask（既定・未指定も）: 今まで通り card が出て、許す前は開かず、許しても知らせは出ない（人が自分で許したので）", async () => {
  for (const om of [undefined, () => "ask" as const]) {
    calls = []; told = [];
    const L = mk(om);
    const p = L.openTabFree("s:1", { url: "https://canvas.example/courses/1" });
    for (let i = 0; i < 300 && !L.approvals().length; i++) await tick();
    expect(L.approvals()[0]).toMatchObject({ tool: "open_tab", owner: "s:1" });
    await tick(30);
    expect(opens()).toHaveLength(0);
    L.answer(L.approvals()[0]!.id, true);
    expect(await p).toMatchObject({ ok: true });
    expect(told).toEqual([]);
  }
});

test("W78o 書き込みの Mode とは別の値: 書き込みが「許す」でも openMode=ask なら card・書き込みが「聞く」でも openMode=allow なら card 無し・allow でも書く操作の card は残る", async () => {
  const a = mk(() => "ask", "allow");
  const p = a.openTabFree("s:1", { url: "https://canvas.example/courses/1" });
  for (let i = 0; i < 300 && !a.approvals().length; i++) await tick();
  expect(a.approvals()).toHaveLength(1); // 表が「許す」でも開くのは聞く
  a.answer(a.approvals()[0]!.id, false); await p;
  const b = mk(() => "allow", "ask");
  const g = await b.openTabFree("s:1", { url: "https://canvas.example/courses/1" });
  expect(g).toMatchObject({ ok: true });
  expect(b.approvals()).toEqual([]);
  const lease = src("src/lease.ts");
  expect(lease.match(/askOpen\(/g)!.length).toBe(2); // openMode を見るのは open_tab / open_app の 2 か所だけ（書く操作の card は asked のまま）
  expect(lease).toContain('askOpen(l, k, gen, "open_app"'); expect(lease).toContain('askOpen(l, k, gen, "open_tab"');
});

test("W78o 開く時の安全は残る: editor・不正な URL・読むだけの面・面の上限は openMode=allow でも断る（card を省くだけ）", async () => {
  const L = mk(() => "allow");
  expect(await L.openAppFree("s:1", { app: "Zed" })).toMatchObject({ ok: false, why: "tool" });
  expect(await L.openTabFree("s:1", { url: "https://canvas.example/a?x=1" })).toMatchObject({ ok: false, why: "tool" });
  expect(await L.openTabFree("s:1", { url: "javascript:alert(1)" })).toMatchObject({ ok: false });
  expect(opens()).toHaveLength(0);
  expect(told).toEqual([]);
});

test("W78o 切り替えは人の設定だけ（W39c と同じ門）: 既定 ask・agent の CLI・owner つき・真偽でない値は断り、lease の openMode と同じ file", async () => {
  const ui = join(top, "ui"); mkdirSync(ui); mkdirSync(join(top, "nodes"));
  const H: any = makeHandler(openStore(":memory:"), async () => [], undefined, { ...defaultWorkspace(), dir: join(top, "nodes") }, { uiHome: ui, leaseDriver: () => null });
  const f = join(ui, "open-allow");
  expect(await H({ op: "openMode" }, {})).toMatchObject({ ok: true, on: false });
  expect(await H({ op: "openMode", on: true }, { write() {} })).toMatchObject({ ok: false });
  expect(await H({ op: "openMode", on: true, owner: "s:1" }, {})).toMatchObject({ ok: false });
  expect(await H({ op: "openMode", on: "yes" }, {})).toMatchObject({ ok: false });
  expect(existsSync(f)).toBe(false);
  expect(await H({ op: "openMode", on: true }, {})).toMatchObject({ ok: true, on: true });
  expect(existsSync(f)).toBe(true);
  expect(await H({ op: "openMode", on: false, owner: "s:1" }, {})).toMatchObject({ ok: false });
  expect(existsSync(f)).toBe(true); // agent は消せない
  expect(await H({ op: "openMode", on: false }, {})).toMatchObject({ ok: true, on: false });
  expect(src("src/main.ts")).toContain('openMode: () => (existsSync(join(uiHome(), "open-allow")) ? "allow" : "ask")');
});

test("W78o panel: 歯車の 1 行（既定は聞く・内部語なし）・toggle は openMode の口・開いた知らせは toast 1 行", () => {
  const html = src("extension/panel.html"), js = src("extension/panel.js");
  expect(html).toContain('<kg-toggle id="open-allow" label="必要な tab や app を、聞かずに裏で開く"');
  expect(html.match(/<kg-toggle id="open-allow"[^>]*>/)![0]).not.toMatch(/lease|token|origin|\bop\b|openMode/);
  expect(js).toContain('call("openMode", { on: e.detail.on })');
  expect(js).toContain("void loadOpenAllow();");
  expect(js).toMatch(/res\.type === "opened"\) \{ toast\(`\$\{plain\(res\.who, 40\)\}が\$\{plain\(res\.label, 60\)\}を開きました`\)/);
});
