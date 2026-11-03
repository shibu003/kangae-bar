// W16b: agent が新しい tab を裏で開いて面にする（open_tab）。正本 docs/BRIEF-w16.md §2
// affected が拡張の変更でこの unit を拾えるよう、読む file を literal で名指す: "extension/web.js" "extension/tabs.js" "extension/panel.js"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT_HANDOFF, classify, keyOf, makeLeases, openUrlOf, tokenOf, type Driver } from "../src/lease.ts";
import { CARD_RULE, EXT_ASK, NEXT_RULE, TAB_ASK, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { installChrome, load } from "./fake-chrome";
import { pickDiscard } from "../extension/tabs.js";

let dir: string;
let calls: { tool: string; args: Record<string, unknown> }[];
let reply: (args: Record<string, unknown>) => { text: string; isError: boolean; data: any; unknown?: boolean };
const NEW = { tabId: 9, docId: "nd", title: "無題のドキュメント", url: "https://docs.google.com/document/d/abc123def/edit" };
const web = (): Driver => ({
  call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "open_tab") return reply(args);
    return { text: "ok", isError: false, data: tool === "tab_state" ? { exists: true, docId: args.tabId === 9 ? "nd" : "d" } : tool === "tab_info" ? { docId: "d", url: "https://canvas.example/courses/1" } : null };
  },
  close() {},
});
const CANVAS = { tabId: 1, docId: "d", app: "web", title: "Canvas", url: "https://canvas.example/courses/1" };
const opens = () => calls.filter((c) => c.tool === "open_tab");
const tick = () => new Promise((r) => setTimeout(r, 5));
const mk = (o: Parameters<typeof makeLeases>[1] = {}) => makeLeases(dir, { web: web(), defaultMode: "ask", ...o });

beforeEach(() => { dir = mktmp("w16b"); calls = []; reply = () => ({ text: "", isError: false, data: NEW }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("AC-1 承認なしに tab を作らない: card（danger・開く origin・全 URL）が出て、断れば open_tab は 1 回も送られない", async () => {
  const L = mk();
  const g = L.give(CANVAS, "s:1");
  if (!g.ok) throw 0;
  const p = L.act(tokenOf(g.lease), "open_tab", { url: "https://docs.google.com/document/create" });
  await tick();
  const [a] = L.approvals();
  expect(a).toMatchObject({ tool: "open_tab", danger: true, open: "https://docs.google.com", what: "新しい tab で https://docs.google.com を開きます" });
  expect(a!.note).toContain("https://docs.google.com【頁: /document/create】"); // card は origin と path を分けて出す（全 URL が読める形）
  expect(opens()).toHaveLength(0);
  L.answer(a!.id, false);
  expect(await p).toMatchObject({ ok: false, why: "denied" });
  expect(opens()).toHaveLength(0);
  expect(L.facesOf("s:1")).toHaveLength(1);
});

test("AC-2 許した後: 拡張に 1 回だけ頼み（今の面の tab の近く）、出た tab がその会話の 2 枚目の面「tab2」になる", async () => {
  const L = mk();
  const g = L.give(CANVAS, "s:1");
  if (!g.ok) throw 0;
  const p = L.act(tokenOf(g.lease), "open_tab", { url: "https://docs.google.com/document/create" });
  await tick();
  L.answer(L.approvals()[0]!.id, true);
  const r = await p;
  expect(r).toMatchObject({ ok: true });
  expect((r as any).text).toContain("面「tab2」");
  expect(opens()).toEqual([{ tool: "open_tab", args: { url: "https://docs.google.com/document/create", near: 1 } }]);
  const faces = L.facesOf("s:1");
  expect(faces.map((l) => l.surface)).toEqual([CANVAS, { tabId: 9, docId: "nd", app: "web", title: "無題のドキュメント", url: NEW.url }]);
  expect(faces[1]!.hold).toBe(false); // 裏の tab＝人は見ていない
  expect(calls.some((c) => c.tool === "gate_on" && c.args.tabId === 9)).toBe(true); // 渡した tab の見張り
  // 新しい面にも門がそのまま効く（書き換えは承認の表どおり聞く）
  const w = L.act(tokenOf(faces[1]!), "type_text", { text: "課題 1" });
  await tick();
  expect(L.approvals()[0]).toMatchObject({ tool: "type_text", title: "無題のドキュメント" });
  L.answer(L.approvals()[0]!.id, true);
  expect(await w).toMatchObject({ ok: true });
});

test("AC-3 「この頼みの間」の許し・表の「許す」でも毎回聞く・他の card の turn 許しに巻き込まれない", async () => {
  const L = mk();
  const g = L.give(CANVAS, "s:1");
  if (!g.ok) throw 0;
  const t = tokenOf(g.lease);
  const w = L.act(t, "type_text", { text: "x" });
  const o = L.act(t, "open_tab", { url: "https://docs.google.com/" });
  await tick();
  const typing = L.approvals().find((a) => a.tool === "type_text")!;
  L.answer(typing.id, true, true); // この頼みの間、この窓に許す
  await w;
  expect(L.approvals().map((a) => a.tool)).toEqual(["open_tab"]); // 巻き込まれず残る
  expect(opens()).toHaveLength(0);
  const open = L.approvals()[0]!;
  expect(L.answer(open.id, true, true)).toBe(true); // 「この頼みの間」と答えても 1 件だけ
  expect(await o).toMatchObject({ ok: true });
  expect(L.list()[0]!.turnAllow).toBe(true);
  // 表が「許す」の app でも聞く
  const A = mk({ defaultMode: "allow" });
  const g2 = A.give({ ...CANVAS, tabId: 2 }, "s:2");
  if (!g2.ok) throw 0;
  const q = A.act(tokenOf(g2.lease), "open_tab", { url: "https://docs.google.com/" });
  await tick();
  expect(A.approvals()).toHaveLength(1);
  A.answer(A.approvals()[0]!.id, false);
  await q;
});

test("AC-4 url の断り（読んだ物を載せて外へ出す口にしない）: 聞く前に断り、card も頼みも出ない", async () => {
  const bad = ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "data:text/html,x", "https://evil.example/?q=秘密", "https://evil.example/#x", "https://evil.example/?", "https://u:p@evil.example/", `https://evil.example/${"a".repeat(300)}`, "evil.example", ""];
  for (const u of bad) expect(openUrlOf(u).ok).toBe(false);
  expect(openUrlOf("https://docs.google.com/document/create").ok).toBe(true);
  const L = mk();
  const g = L.give(CANVAS, "s:1");
  if (!g.ok) throw 0;
  for (const u of bad) expect(await L.act(tokenOf(g.lease), "open_tab", { url: u })).toMatchObject({ ok: false, why: "tool" });
  expect(L.approvals()).toHaveLength(0);
  expect(opens()).toHaveLength(0);
});

test("AC-5 面の数・読むだけ・取り戻し: tab を作る前に断る（孤児の tab を残さない）", async () => {
  const L = mk();
  const g = L.give(CANVAS, "s:1");
  L.give({ ...CANVAS, tabId: 2, title: "two" }, "s:1");
  if (!g.ok) throw 0;
  expect(await L.act(tokenOf(g.lease), "open_tab", { url: "https://docs.google.com/" })).toMatchObject({ ok: false, why: "tool" });
  expect(L.approvals()).toHaveLength(0);
  // 待つ間に 2 枚目が渡された
  const M = mk();
  const h = M.give({ ...CANVAS, tabId: 3 }, "s:2");
  if (!h.ok) throw 0;
  const p = M.act(tokenOf(h.lease), "open_tab", { url: "https://docs.google.com/" });
  await tick();
  M.give({ ...CANVAS, tabId: 4 }, "s:2");
  M.answer(M.approvals()[0]!.id, true);
  expect(await p).toMatchObject({ ok: false, why: "tool" });
  // 待つ間に取り戻された
  M.takeback("tab:4");
  const q = M.act(tokenOf(M.facesOf("s:2")[0]!), "open_tab", { url: "https://docs.google.com/" });
  await tick();
  M.stopAll();
  expect(await q).toMatchObject({ ok: false, why: "gen" });
  // 読むだけ（mod の宣言・表の「切る」）
  const R = mk();
  const r = R.give({ ...CANVAS, tabId: 5 }, "s:3");
  if (!r.ok) throw 0;
  R.setCap("s:3", "read");
  expect(await R.act(tokenOf(r.lease), "open_tab", { url: "https://docs.google.com/" })).toMatchObject({ ok: false, why: "mod" });
  R.setCap("s:3", undefined);
  R.setMode("web", "off");
  expect(await R.act(tokenOf(r.lease), "open_tab", { url: "https://docs.google.com/" })).toMatchObject({ ok: false, why: "off" });
  expect(opens()).toHaveLength(0);
});

test("AC-6 拡張が無い: 聞かずに「拡張を入れて」（手順 3 つの handoff）を返す・返事の無い拡張は結果不明にしない", async () => {
  const L = mk({ webReady: () => false });
  const g = L.give(CANVAS, "s:1");
  if (!g.ok) throw 0;
  const r = await L.act(tokenOf(g.lease), "open_tab", { url: "https://docs.google.com/" });
  expect(r).toMatchObject({ ok: false, why: "driver" });
  expect((r as any).hint).toContain(EXT_HANDOFF);
  expect(EXT_HANDOFF).toMatch(/1\. .*2\. .*3\. /);
  expect(L.approvals()).toHaveLength(0);
  expect(opens()).toHaveLength(0);
  // 繋がっているが返事が来ない（8 秒切れ）: 開いたか分からない・同じ操作を繰り返さない。書き換えを止める「結果不明」にはしない
  reply = () => ({ text: "ブラウザが応答しません", isError: true, data: null, unknown: true });
  const M = mk({ defaultMode: "ask" });
  const h = M.give({ ...CANVAS, tabId: 6 }, "s:2"); // 同じ dir の leases.json に tab 1 は s:1 の物として残る
  if (!h.ok) throw 0;
  const p = M.act(tokenOf(h.lease), "open_tab", { url: "https://docs.google.com/" });
  await tick();
  M.answer(M.approvals()[0]!.id, true);
  expect((await p as any).hint).toContain("開いたかどうか分かりません");
  M.setMode("web", "allow");
  expect(await M.act(tokenOf(h.lease), "type_text", { text: "x" })).toMatchObject({ ok: true });
});

test("AC-7 Docs の共有は「この tab の外にも効く」: 毎回聞く（「この頼みの間」の許しでも）", () => {
  expect(classify("click", {}, { role: "button", label: "共有" })).toBe("crossing");
  expect(classify("click", {}, { role: "button", label: "Share" })).toBe("crossing");
  expect(classify("click", {}, { role: "button", label: "Shared drives" })).toBe("write");
});

test("AC-8 拡張: tabs.create は active:false・前面も今の tab も替えない・読み込み後の文書の印を返す・渡す前から discard しない", async () => {
  const c = installChrome();
  const created: any[] = [], fronted: string[] = [];
  const ch = (globalThis as any).chrome;
  ch.tabs.create = async (o: any) => { created.push(o); c.tabs.add(9); return { id: 9, windowId: 2 }; };
  ch.tabs.update = async () => { fronted.push("tabs.update"); return {}; };
  ch.windows.update = async () => { fronted.push("windows.update"); return {}; };
  const get = ch.tabs.get;
  ch.tabs.get = async (id: number) => ({ ...(await get(id)), windowId: id === 1 ? 2 : 1, status: "complete" });
  const { webRun, keep } = await load("web");
  await c.settle();
  const r = await webRun("open_tab", { url: "https://docs.google.com/document/create", near: 1 });
  expect(created).toEqual([{ url: "https://docs.google.com/document/create", active: false, windowId: 2 }]);
  expect(fronted).toEqual([]);
  expect(r.data).toMatchObject({ tabId: 9, docId: "d" });
  expect(keep().has(9)).toBe(true);
  expect(pickDiscard([{ id: 9, active: false, lastAccessed: 0 }, { id: 3, active: false, lastAccessed: 1 }], 1, keep())).toEqual([3]);
  expect((await webRun("open_tab", { url: "javascript:alert(1)" })).error).toBe(true);
  expect(created).toHaveLength(1);
});

test("AC-9 常駐: 途中で開いた面は env に無い名前「tab2」を持ち主で引いて使える・生の token や他人の面は引けない・拡張が無ければ面の無い turn の頼みに手順が載る", async () => {
  calls = [];
  const spawned: string[][] = [];
  const spawn = (cmd: string[]) => { spawned.push(cmd); let done!: (c: number) => void; return { stdout: new ReadableStream<Uint8Array>({ start: () => {} }), exited: new Promise<number>((r) => (done = r)), kill: () => done(143) }; };
  const s = openStore(":memory:");
  const ws = { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude" as const, path: "/bin/claude", env: {} }], spawn, browserUrl: async () => null };
  const h: any = makeHandler(s, async () => [], undefined, ws, { uiHome: mktmp("kangae-ui"), webDriver: web(), leaseDriver: () => null });
  const a = s.add(null, "user", "課題", true);
  expect((await h({ op: "leaseGive", rootId: a.id, tabId: 1 })).ok).toBe(true);
  const l = (await h({ op: "leaseList" })).leases[0];
  const p = h({ op: "act", lease: l.token, tool: "open_tab", args: { url: "https://docs.google.com/document/create" } });
  await tick();
  await h({ op: "approvalAnswer", id: (await h({ op: "leaseList" })).approvals[0].id, yes: true });
  expect(await p).toMatchObject({ ok: true });
  await h({ op: "leaseMode", app: "web", mode: "allow" });
  expect(await h({ op: "act", owner: `s:${a.id}`, on: "tab2", tool: "get_window_state", args: {} })).toMatchObject({ ok: true });
  expect(calls.filter((c) => c.tool === "get_window_state").at(-1)!.args.tabId).toBe(9);
  expect(await h({ op: "act", owner: `s:${a.id}`, on: "tab3", tool: "get_window_state", args: {} })).toMatchObject({ ok: false, code: "face" });
  expect(await h({ op: "act", owner: `s:${a.id + 1}`, on: "tab2", tool: "get_window_state", args: {} })).toMatchObject({ ok: false, code: "face" });
  expect(await h({ op: "act", owner: "x", on: "tab2", lease: "", tool: "get_window_state", args: {} })).toMatchObject({ ok: false, code: "bad" });
  // 拡張の繋がっていない常駐（webDriver なし・webHello 0）: 面の無い turn の頼みに手順 3 つの handoff が載る
  const h2: any = makeHandler(s, async () => [], undefined, ws, { uiHome: mktmp("kangae-ui"), leaseDriver: () => null });
  const b = s.add(null, "user", "canvas の課題を docs に", true);
  await h2({ op: "send", rootId: b.id, text: "canvas の課題を docs に" });
  expect(spawned.at(-1)![2]).toBe(("canvas の課題を docs に" + CARD_RULE + NEXT_RULE).replace(TAB_ASK, EXT_ASK));
  expect(spawned.at(-1)![2]).toContain(EXT_HANDOFF);
  // 繋がっている常駐（webDriver あり）では今まで通り tab を渡してと頼む
  const c = s.add(null, "user", "x", true);
  await h({ op: "send", rootId: c.id, text: "x" });
  expect(spawned.at(-1)![2]).toBe("x" + CARD_RULE + NEXT_RULE);
});

test("W16b-2 断り・時間切れ・取り戻しの文は open_tab 固有に「tab は開いていません」（汎用の「実行していません」だけにしない）", async () => {
  for (const [ans, why] of [[false, "denied"], [undefined, "timeout"]] as const) {
    const L = mk({ approvalMs: 20 });
    const g = L.give(CANVAS, "s:1");
    if (!g.ok) throw 0;
    const p = L.act(tokenOf(g.lease), "open_tab", { url: "https://docs.google.com/" });
    await tick();
    if (ans === false) L.answer(L.approvals()[0]!.id, false);
    const r = await p;
    expect(r).toMatchObject({ ok: false, why });
    expect((r as any).hint).toContain("tab は開いていません");
    expect(opens()).toHaveLength(0);
  }
  const L = mk();
  const g = L.give(CANVAS, "s:1");
  if (!g.ok) throw 0;
  const p = L.act(tokenOf(g.lease), "open_tab", { url: "https://docs.google.com/" });
  await tick();
  L.takeback(keyOf(CANVAS));
  L.answer(L.approvals()[0]?.id ?? "", true);
  const r = await p;
  expect(r).toMatchObject({ ok: false });
  expect(opens()).toHaveLength(0);
});

test("W16b-2 通し（画面に出ない fake の面）: open_app で窓の面が増えた後の open_tab は「面が 2 枚」で聞かず断る→窓の面を取り戻すと open_tab が通り、面は 2 枚のまま", async () => {
  const cua: Driver = { call: async (tool) => tool === "launch_app" ? { text: "", isError: false, data: { pid: 30, windows: [{ pid: 30, window_id: 7, title: "x — Preview", app_name: "Preview" }] } } : { text: "ok", isError: false, data: null }, close() {} };
  const L = makeLeases(dir, { web: web(), driver: () => cua, defaultMode: "ask", windowMs: 50 });
  const g = L.give(CANVAS, "s:1");
  if (!g.ok) throw 0;
  const o = L.act(tokenOf(g.lease), "open_app", { app: "Preview" });
  await tick();
  expect(L.approvals()[0]).toMatchObject({ tool: "open_app" });
  L.answer(L.approvals()[0]!.id, true);
  expect(await o).toMatchObject({ ok: true });
  const faces = L.facesOf("s:1");
  expect(faces).toHaveLength(2);
  expect(await L.act(tokenOf(faces[0]!), "open_tab", { url: "https://docs.google.com/" })).toMatchObject({ ok: false, why: "tool" });
  expect(L.approvals()).toHaveLength(0); // 聞かずに断る＝承認 card は増えない
  expect(opens()).toHaveLength(0);
  const zed = faces.find((l) => "pid" in l.surface)!;
  expect(L.takeback(keyOf(zed.surface))).toBe(true);
  const p = L.act(tokenOf(faces[0]!), "open_tab", { url: "https://docs.google.com/document/create" });
  await tick();
  expect(L.approvals()[0]).toMatchObject({ tool: "open_tab", danger: true });
  L.answer(L.approvals()[0]!.id, true);
  expect(await p).toMatchObject({ ok: true });
  expect(opens()).toHaveLength(1);
  expect(L.facesOf("s:1")).toHaveLength(2);
});
