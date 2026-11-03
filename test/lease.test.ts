import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { axReadPath, axWanted, keyOf, makeLeases, tokenOf, type Driver } from "../src/lease.ts";

let dir: string;
let calls: { tool: string; args: Record<string, unknown> }[];
let wins: { pid: number; window_id: number }[];
const fake = (): Driver => ({
  call: async (tool, args) => {
    calls.push({ tool, args });
    return { text: "ok", isError: false, data: tool === "list_windows" ? (wins ? { windows: wins } : null) : null };
  },
  close() {},
});
// 既存の検査は門の他の層（持ち主・世代・期限…）を測る。承認の層は下の W4a の検査が持つので、ここでは「許す」にしておく
// 「許す」の app でも、押す先が分からない操作は門が聞く（W8a）。ここは他の層の検査なので、「許す」の mk では出た card を全部許す。聞く側の検査は test/w8a.test.ts
const mk = (o: Parameters<typeof makeLeases>[1] = {}) => {
  const L: ReturnType<typeof makeLeases> = makeLeases(dir, { driver: fake, defaultMode: "allow", ...o, onChange: () => { o.onChange?.(); if ((o.defaultMode ?? "allow") === "allow") queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))); } });
  return L;
};
const A = { pid: 10, windowId: 1, app: "Calc", title: "" };
const B = { pid: 20, windowId: 2, app: "Edit", title: "x" };
const acted = () => calls.filter((c) => c.tool !== "list_windows" && c.tool !== "tab_state" && !c.tool.startsWith("gate_"));

beforeEach(() => { dir = mktmp("lease"); calls = []; wins = [{ pid: 10, window_id: 1 }, { pid: 20, window_id: 2 }]; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("通る: 持ち主・世代が合えば実行され、pid と window_id は門が差し込む（agent の別の面は捨てる）", async () => {
  const L = mk();
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const r = await L.act(tokenOf(g.lease), "click", { element_token: "s1:2", pid: 20, window_id: 2, delivery_mode: "foreground", session: "x" });
  expect(r.ok).toBe(true);
  expect(acted()).toEqual([{ tool: "click", args: { element_token: "s1:2", pid: 10, window_id: 1 } }]);
});

test("AC-2: 1 つの面に持ち主は 1 人・2 人は互いの面に書けない", async () => {
  const L = mk();
  const a = L.give(A, "s:1"), b = L.give(B, "s:2");
  if (!a.ok || !b.ok) throw new Error();
  expect(L.give(A, "s:2").ok).toBe(false); // 持ち主が居る面
  expect(L.give(B, "s:1").ok).toBe(false); // 1 人 1 面
  const r = await L.act(`${keyOf(a.lease.surface)}|${a.lease.gen}|s:2`, "click", {});
  expect(r).toMatchObject({ ok: false, why: "owner" });
  await L.act(tokenOf(a.lease), "type_text", { text: "a" });
  await L.act(tokenOf(b.lease), "type_text", { text: "b" });
  expect(acted().map((c) => `${c.args.pid}:${c.args.text}`)).toEqual(["10:a", "20:b"]);
});

test("AC-4: 取り戻すと古い操作権の操作は 0 件・agent は止まる・渡し直しても古いのは通らない", async () => {
  const revoked: string[] = [];
  const L = mk({ onRevoke: (o) => { revoked.push(o); } });
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const old = tokenOf(g.lease);
  expect(L.takeback("10:1")).toBe(true);
  expect(revoked).toEqual(["s:1"]);
  expect(await L.act(old, "click", {})).toMatchObject({ ok: false, why: "gen" });
  const g2 = L.give(A, "s:1");
  if (!g2.ok) throw new Error();
  expect(g2.lease.gen).toBeGreaterThan(g.lease.gen);
  expect(await L.act(old, "click", {})).toMatchObject({ ok: false, why: "gen" });
  expect(acted()).toEqual([]);
});

test("人がその app を触ったら取り戻す（別の app は触らない）", () => {
  const L = mk();
  L.give(A, "s:1"); L.give(B, "s:2");
  expect(L.touch(30)).toBe(0);
  expect(L.touch(10)).toBe(1);
  expect(L.list().map((l) => l.owner)).toEqual(["s:2"]);
});

test("期限・面の消失・許していない tool は拒否", async () => {
  let t = 1000;
  const L = mk({ now: () => t });
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  expect(await L.act(tokenOf(g.lease), "kill_app", {})).toMatchObject({ why: "tool" });
  wins = [];
  expect(await L.act(tokenOf(g.lease), "click", {})).toMatchObject({ why: "surface" });
  wins = undefined as any; // 一覧が読めない（driver が timeout）は「窓が無い」ではない
  expect(await L.act(tokenOf(g.lease), "click", {})).toMatchObject({ why: "driver" });
  wins = [{ pid: 10, window_id: 1 }];
  t += 31 * 60_000;
  expect(await L.act(tokenOf(g.lease), "click", {})).toMatchObject({ why: "exp" });
  expect(await L.act("", "click", {})).toMatchObject({ why: "bad" });
  expect(acted()).toEqual([]);
});

test("AC-5: 常駐を起こし直したら再確認するまで動けない・再確認すると古い操作権は通らず新しいのが通る", async () => {
  const g = mk().give(A, "s:1");
  if (!g.ok) throw new Error();
  const L = mk(); // 起こし直し
  expect(await L.act(tokenOf(g.lease), "click", {})).toMatchObject({ ok: false, why: "unknown" });
  const r = L.reconfirm("10:1");
  if (!r.ok) throw new Error();
  expect(await L.act(tokenOf(g.lease), "click", {})).toMatchObject({ ok: false, why: "gen" });
  expect(await L.act(tokenOf(r.lease), "click", {})).toMatchObject({ ok: true });
});

test("床（file の写し）が無ければ再確認は no-floor で拒否・黙って 0 から始めない", async () => {
  mk().give(A, "s:1");
  unlinkSync(join(dir, "leases.json"));
  writeFileSync(join(dir, "leases.json"), JSON.stringify({ floor: {}, leases: [{ surface: A, owner: "s:1", exp: Date.now() + 1e6 }] }));
  expect(mk().reconfirm("10:1")).toMatchObject({ ok: false, why: "no-floor" });
});

test("取り戻した後に起こし直しても床は残り、古い操作権は通らない", async () => {
  const g = mk().give(A, "s:1");
  if (!g.ok) throw new Error();
  const L1 = mk(); L1.reconfirm("10:1"); L1.takeback("10:1");
  const L2 = mk();
  expect(await L2.act(tokenOf(g.lease), "click", {})).toMatchObject({ why: "gen" });
});

test("窓の一覧を読んでいる間に取り戻されたら、実行しない", async () => {
  let L: ReturnType<typeof mk>;
  L = mk({ driver: () => ({ call: async (tool, args) => { calls.push({ tool, args }); if (tool === "list_windows") L.takeback("10:1"); return { text: "", isError: false, data: { windows: wins } }; }, close() {} }) });
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  expect(await L.act(tokenOf(g.lease), "click", {})).toMatchObject({ ok: false, why: "gen" });
  expect(acted()).toEqual([]);
});

test("get_window_state は既定で木を絞る（呼び手の指定が勝つ）", async () => {
  const L = mk();
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  await L.act(tokenOf(g.lease), "get_window_state", {});
  await L.act(tokenOf(g.lease), "get_window_state", { max_elements: 5 });
  expect(acted().map((c) => c.args.max_elements)).toEqual([300, 5]);
  expect(acted()[0]!.args).toMatchObject({ include_screenshot: false, pid: 10, window_id: 1 });
});

test("get_window_state が要素 0 件で返った（混雑）なら、読めなかったと言う（成功の「要素 0」を返さない）", async () => {
  const L = mk({ driver: () => ({ call: async (tool) => ({ text: "", isError: false, data: tool === "list_windows" ? { windows: wins } : { elements: [] } }), close() {} }) });
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const r = await L.act(tokenOf(g.lease), "get_window_state", {});
  expect(r).toMatchObject({ ok: true, isError: true });
  expect((r as any).text).toContain("読めませんでした");
});

// ---- W2e: web の面（tab） ----
const T1 = { tabId: 5, docId: "d1", app: "web", title: "t1" };
let doc = "d1", tabAlive = true;
const web: Driver = { call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "tab_state" ? { exists: tabAlive, docId: doc } : null }; }, close() {} };

test("W2e: tab も同じ門を通る・tabId と docId は門が差し込む（agent の別の tab は捨てる）", async () => {
  doc = "d1"; tabAlive = true;
  const L = mk({ web });
  const g = L.give(T1, "s:1");
  if (!g.ok) throw new Error();
  expect(await L.act(tokenOf(g.lease), "click", { element_token: "d1", tabId: 9, docId: "x" })).toMatchObject({ ok: true });
  expect(acted()).toEqual([{ tool: "click", args: { element_token: "d1", guard: true, tabId: 5, docId: "d1", gen: g.lease.gen } }]); // guard = W60a の「書く直前に人が居るか」（門が付ける）
  expect(await L.act(`tab:5|${g.lease.gen}|s:2`, "click", {})).toMatchObject({ why: "owner" });
});

test("W2e: 文書が変わったら（再読み込み・別 site）世代を上げて拒否・agent を止める・新しい文書にも効かない", async () => {
  doc = "d1"; tabAlive = true;
  const revoked: string[] = [];
  const L = mk({ web, onRevoke: (o) => { revoked.push(o); } });
  const g = L.give(T1, "s:1");
  if (!g.ok) throw new Error();
  doc = "d2";
  expect(await L.act(tokenOf(g.lease), "click", {})).toMatchObject({ ok: false, why: "gen" });
  expect(revoked).toEqual(["s:1"]);
  doc = "d1";
  expect(await L.act(tokenOf(g.lease), "click", {})).toMatchObject({ ok: false, why: "gen" });
  expect(acted()).toEqual([]);
});

test("W2e: 人が tab を触ったら取り戻す・tab が消えたら surface・app の窓と tab は別の持ち主で互いの面に書けない", async () => {
  doc = "d1"; tabAlive = true;
  const L = mk({ web });
  const w = L.give(A, "s:1"), t = L.give(T1, "s:2");
  if (!w.ok || !t.ok) throw new Error();
  expect(L.touchTab(77)).toBe(0);
  expect(L.touch(10)).toBe(1); // 窓の持ち主だけ外れる
  expect(L.list().map((l) => l.owner)).toEqual(["s:2"]);
  tabAlive = false;
  expect(await L.act(tokenOf(t.lease), "click", {})).toMatchObject({ why: "surface" });
  tabAlive = true;
  expect(L.touchTab(5)).toBe(1);
  expect(await L.act(tokenOf(t.lease), "click", {})).toMatchObject({ why: "gen" });
  expect(acted()).toEqual([]);
});

test("W2e: press_key に 1 文字を渡すと拒否して type_text を案内する（黙って違う結果にしない）", async () => {
  const L = mk();
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  for (const key of ["+", "=", "7"]) expect(await L.act(tokenOf(g.lease), "press_key", { key })).toMatchObject({ ok: false, why: "tool" });
  expect(await L.act(tokenOf(g.lease), "press_key", { key: "return" })).toMatchObject({ ok: true });
  expect(acted().map((c) => c.args.key)).toEqual(["return"]);
});

// ---- W2f: agent 自身の移動・web の残りの道具 ----
const web2 = (): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "tab_state" ? { exists: true, docId: doc } : tool === "tab_info" ? { docId: doc, title: "next", url: "u" } : null }; }, close() {} });
// 時計を持つ門を作り、click（時刻 100〜120）の後に nav を流す
async function afterClick(nav: { dt: number; type?: string; quals?: string[] } | null) {
  doc = "d1";
  let t = 1000;
  const L = mk({ web: web2(), now: () => t });
  const g = L.give(T1, "s:1");
  if (!g.ok) throw new Error();
  const token = tokenOf(g.lease); // 渡された時に agent の手元に在る token（移動で世代が上がっても同じ物を使い続ける）
  t = 1100;
  await L.act(token, "click", { element_token: "d1" });
  t = 1120;
  doc = "d2";
  const r = nav ? await L.navigated(5, { startedAt: nav.dt, type: nav.type ?? "link", quals: nav.quals ?? [] }) : 0;
  return { L, g, r, token };
}

test("W2f: agent の click の直後の link 移動は操作権を保つ（世代は上がり・手元の token は通り・新しい文書に効く・次の返事に 1 度だけ知らせる）", async () => {
  const { L, r, token } = await afterClick({ dt: 1101 });
  expect(r).toBe(0);
  const now = L.list()[0]!;
  expect(now.gen).toBe(Number(token.split("|")[1]) + 1);
  expect((now.surface as { docId: string }).docId).toBe("d2");
  calls = [];
  const a = await L.act(token, "click", { element_token: "d1" });
  expect(a).toMatchObject({ ok: true });
  expect((a as { text: string }).text).toContain("ページが移動しました");
  expect(calls.find((c) => c.tool === "click")!.args).toMatchObject({ docId: "d2" });
  expect(((await L.act(token, "click", {})) as { text: string }).text).not.toContain("移動");
});

test("W2f: 人が起こした・分からない移動は取り戻す（操作の外の時刻・typed・reload・戻る・client redirect・アドレスバー・同じ操作で 2 回目）", async () => {
  for (const nav of [{ dt: 900 }, { dt: 1120 + 301 }, { dt: 1101, type: "typed" }, { dt: 1101, type: "reload" }, { dt: 1101, type: "auto_bookmark" }, { dt: 1101, quals: ["forward_back"] }, { dt: 1101, quals: ["client_redirect"] }, { dt: 1101, quals: ["from_address_bar"] }]) {
    const { L, r, token } = await afterClick(nav);
    expect([JSON.stringify(nav), r]).toEqual([JSON.stringify(nav), 1]);
    expect(await L.act(token, "click", {})).toMatchObject({ ok: false, why: "gen" });
  }
  const { L, token } = await afterClick({ dt: 1101 });
  expect(await L.navigated(5, { startedAt: 1102, type: "link", quals: [] })).toBe(1); // 1 つの操作では 1 回の移動しか説明できない
  expect(await L.act(token, "click", {})).toMatchObject({ ok: false });
});

test("W2f: 操作の無い移動・get_window_state だけの後の移動は取り戻す", async () => {
  doc = "d1";
  let t = 1000;
  const L = mk({ web: web2(), now: () => t });
  const g = L.give(T1, "s:1");
  if (!g.ok) throw new Error();
  expect(await L.navigated(5, { startedAt: 1001, type: "link", quals: [] })).toBe(1);
  const g2 = L.give(T1, "s:1");
  if (!g2.ok) throw new Error();
  t = 1100;
  await L.act(tokenOf(g2.lease), "get_window_state", {});
  expect(await L.navigated(5, { startedAt: 1101, type: "link", quals: [] })).toBe(1);
});

test("W2f: 取り戻した後に移動前の token は通らず、渡し直すと移動前の世代は通らない", async () => {
  const { L, token } = await afterClick({ dt: 1101 });
  expect(L.touchTab(5)).toBe(1);
  expect(await L.act(token, "click", {})).toMatchObject({ ok: false, why: "gen" });
  const g = L.give(T1, "s:1");
  if (!g.ok) throw new Error();
  expect(await L.act(token, "click", {})).toMatchObject({ ok: false, why: "gen" });
});

test("W2f: web の hotkey / drag / double_click / right_click は門を通る・browser 自身の操作は理由つきで断る", async () => {
  doc = "d1";
  const L = mk({ web: web2() });
  const g = L.give(T1, "s:1");
  if (!g.ok) throw new Error();
  const tk = tokenOf(g.lease);
  for (const keys of [["cmd", "t"], ["ctrl", "w"], ["cmd", "l"], ["command", "shift", "n"]]) expect(await L.act(tk, "hotkey", { keys })).toMatchObject({ ok: false, why: "tool" });
  calls = [];
  for (const [tool, args] of [["hotkey", { keys: ["cmd", "k"] }], ["hotkey", { keys: ["t"] }], ["double_click", { element_token: "d1" }], ["right_click", { element_token: "d1" }], ["drag", { element_token: "d1", to_element_token: "d2" }]] as const)
    expect(await L.act(tk, tool, args)).toMatchObject({ ok: true });
  expect(calls.filter((c) => c.tool !== "tab_state" && !c.tool.startsWith("gate_")).map((c) => c.tool)).toEqual(["hotkey", "hotkey", "double_click", "right_click", "drag"]);
});

// W3c: 渡された tab と同じ site の別の頁を、画面に何も増やさずに読む（fetch_url / render_url）。人の cookie が乗るので別 site には使わせない
const webAt = (url: string): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "tab_state" ? { exists: true, docId: doc } : tool === "tab_info" ? { docId: doc, title: "t", url } : null }; }, close() {} });
const reads = () => calls.filter((c) => c.tool === "fetch_url" || c.tool === "render_url");

test("W3c: fetch_url / render_url は同じ site の url だけ通り、url の省略は tab の今の頁・別 site / 別 scheme / 不正は拒否で 0 件実行", async () => {
  doc = "d1";
  const L = mk({ web: webAt("https://bank.example/account?x=1") });
  const g = L.give(T1, "s:1");
  if (!g.ok) throw new Error();
  const tok = tokenOf(g.lease);
  expect(await L.act(tok, "fetch_url", { url: "/balance" })).toMatchObject({ ok: true }); // 相対は tab の今の頁から解く
  expect(await L.act(tok, "render_url", {})).toMatchObject({ ok: true });
  expect(reads().map((c) => [c.tool, c.args.url])).toEqual([["fetch_url", "https://bank.example/balance"], ["render_url", "https://bank.example/account?x=1"]]);
  for (const bad of ["https://evil.example/steal", "http://bank.example/", "https://bank.example.evil.example/", "file:///etc/passwd", "javascript:alert(1)", "//evil.example/x", "https://bank.example@evil.example/"]) {
    expect(await L.act(tok, "fetch_url", { url: bad })).toMatchObject({ ok: false, why: "tool" });
  }
  expect(reads()).toHaveLength(2); // 拒否された物は 1 件も常駐から拡張へ渡っていない
});

test("W3c: fetch_url は窓の面には使えない・agent が起こした操作として数えない（移動の判定の窓を作らない）", async () => {
  doc = "d1";
  const LW = mk();
  const gw = LW.give(B, "s:9");
  if (!gw.ok) throw new Error();
  expect(await LW.act(tokenOf(gw.lease), "fetch_url", { url: "https://x.example/" })).toMatchObject({ ok: false, why: "tool" });
  const L = mk({ web: webAt("https://bank.example/") });
  const g = L.give(T1, "s:1"); // 別の持ち主 s:1 は窓を持っていない（窓は s:9）
  if (!g.ok) throw new Error();
  await L.act(tokenOf(g.lease), "fetch_url", {});
  const tabLease = () => L.list().find((l) => l.key === "tab:5")!;
  expect(tabLease().op).toBeUndefined();
  await L.act(tokenOf(g.lease), "click", { element_token: "d1" });
  expect(tabLease().op).toBeDefined(); // 対照: 変える操作は数える
});

// ---- W4a: 承認の門。「先に聞く」の操作は、人が許すまで 0 件・許した 1 件だけ実行・断る / 時間切れ / 全停止は 0 件 ----
const ask = (o: Parameters<typeof makeLeases>[1] = {}) => mk({ defaultMode: "ask", ...o });
const given = (L: ReturnType<typeof mk>) => { const g = L.give(A, "s:1"); if (!g.ok) throw new Error(); return tokenOf(g.lease); };
const tick = () => new Promise((r) => setTimeout(r, 5));

test("W4a AC-2: 先に聞く（既定）の操作は、許されるまで実行 0 件・許した 1 件だけ実行される", async () => {
  const L = ask();
  const tk = given(L);
  const p1 = L.act(tk, "type_text", { text: "a" });
  await tick();
  expect(acted()).toEqual([]); // 保留
  expect(L.approvals()).toMatchObject([{ tool: "type_text", app: "Calc", what: "文字を入れる「a」" }]);
  L.answer(L.approvals()[0]!.id, true);
  expect((await p1).ok).toBe(true);
  expect(acted().length).toBe(1);
  const p2 = L.act(tk, "type_text", { text: "b" }); // 次の 1 件は、また聞く（許しは 1 件限り）
  await tick();
  expect(acted().length).toBe(1);
  expect(L.approvals().length).toBe(1);
  L.answer(L.approvals()[0]!.id, false);
  expect(await p2).toMatchObject({ ok: false, why: "denied" });
  expect(acted().length).toBe(1);
});

test("W4a: 読むだけの道具は聞かずに通る（get_window_state・scroll・fetch_url・render_url）", async () => {
  const L = ask();
  const tk = given(L);
  expect((await L.act(tk, "get_window_state", {})).ok).toBe(true);
  expect((await L.act(tk, "scroll", { direction: "down" })).ok).toBe(true);
  expect(L.approvals()).toEqual([]);
});

test("W4a: 時間切れは断ると同じ（実行 0 件・理由つき）・「切る」は聞かずに拒否・「許す」は聞かない", async () => {
  const L = ask({ approvalMs: 20 });
  const tk = given(L);
  expect(await L.act(tk, "click", { element_token: "x" })).toMatchObject({ ok: false, why: "timeout" });
  expect(acted()).toEqual([]);
  expect(L.approvals()).toEqual([]); // 片付く
  L.setMode("Calc", "off");
  expect(await L.act(tk, "click", {})).toMatchObject({ ok: false, why: "off" });
  L.setMode("Calc", "allow");
  expect((await L.act(tk, "type_text", { text: "a" })).ok).toBe(true); // 書くだけなら聞かない（押す先が分からない click は W8a で「許す」でも聞く・test/w8a.test.ts）
  expect(acted().length).toBe(1);
});

test("W4a AC-2/F2: 全停止は承認待ちの操作も実行せず、以後の操作は gen で拒否される", async () => {
  const revoked: string[] = [];
  const L = ask({ onRevoke: (o) => { revoked.push(o); } });
  const tk = given(L);
  const p = L.act(tk, "type_text", { text: "長い書き込み" });
  await tick();
  expect(L.stopAll()).toBe(1);
  expect(await p).toMatchObject({ ok: false, why: "gen" });
  expect(await L.act(tk, "type_text", { text: "x" })).toMatchObject({ ok: false, why: "gen" });
  expect(acted()).toEqual([]);
  expect(revoked).toEqual(["s:1"]);
  expect(L.approvals()).toEqual([]);
});

test("W4a: 承認を待つ間に人が窓に触って取り戻したら、許しても実行しない", async () => {
  const L = ask();
  const tk = given(L);
  const p = L.act(tk, "click", {});
  await tick();
  L.touch(10);
  expect(await p).toMatchObject({ ok: false, why: "gen" });
  expect(acted()).toEqual([]);
});

// ---- W4a-2: 「この頼みの間、この窓に許す」。許しは lease の上にだけ在り、その turn が終わる・全停止・取り戻し・世代が変わるのどれかで消える（図 §35）----
const grant = async (L: ReturnType<typeof mk>, tk: string, text = "a") => {
  const p = L.act(tk, "type_text", { text });
  await tick();
  L.answer(L.approvals()[0]!.id, true, true);
  return p;
};

test("W4a-2 AC-3: 「この頼みの間」を許すと、同じ窓の次の操作は聞かずに通る（別の窓・別の持ち主には効かない）", async () => {
  const L = ask();
  const tk = given(L);
  expect((await grant(L, tk)).ok).toBe(true);
  expect((await L.act(tk, "type_text", { text: "b" })).ok).toBe(true); // card 無し
  expect((await L.act(tk, "press_key", { key: "tab" })).ok).toBe(true); // return は送信になりうる＝W8a で別（test/w8a.test.ts）
  expect(L.approvals()).toEqual([]);
  expect(acted().length).toBe(3);
  const g2 = L.give(B, "s:2"); // 別の窓・別の会話は、また聞く
  if (!g2.ok) throw new Error();
  const p = L.act(tokenOf(g2.lease), "type_text", { text: "x" });
  await tick();
  expect(L.approvals().length).toBe(1);
  expect(acted().length).toBe(3);
  L.answer(L.approvals()[0]!.id, false);
  expect(await p).toMatchObject({ ok: false, why: "denied" });
});

test("W4a-2 AC-3: 「この 1 件だけ」は次をまた聞く・「この頼みの間」は断る / 時間切れでは付かない", async () => {
  const L = ask({ approvalMs: 30 });
  const tk = given(L);
  const p = L.act(tk, "click", {});
  await tick();
  L.answer(L.approvals()[0]!.id, true, false); // 1 件だけ
  expect((await p).ok).toBe(true);
  expect(await L.act(tk, "click", {})).toMatchObject({ ok: false, why: "timeout" }); // また聞かれて、答えずに時間切れ
  const p2 = L.act(tk, "click", {});
  await tick();
  L.answer(L.approvals()[0]!.id, false, true); // 断る＋turn は断るだけ
  expect(await p2).toMatchObject({ ok: false, why: "denied" });
  expect(await L.act(tk, "click", {})).toMatchObject({ ok: false, why: "timeout" });
});

test("W4a-2 AC-3: その turn が終わると許しは消える（次の頼みはまた聞く）・待っている card も実行しない", async () => {
  const L = ask();
  const tk = given(L);
  await grant(L, tk);
  expect(L.list()[0]!.turnAllow).toBe(true);
  expect(L.endTurn("s:2")).toBe(0); // 別の会話の turn の終わりでは消えない
  expect((await L.act(tk, "type_text", { text: "b" })).ok).toBe(true);
  expect(L.endTurn("s:1")).toBe(1);
  expect(L.list()[0]!.turnAllow).toBeUndefined();
  const n = acted().length;
  const p = L.act(tk, "type_text", { text: "次の頼み" });
  await tick();
  expect(L.approvals().length).toBe(1); // また card
  expect(acted().length).toBe(n);
  L.endTurn("s:1"); // 待っている間に turn が終わった（agent が死んだ）→ 後から許されても実行しない
  expect(await p).toMatchObject({ ok: false, why: "gen" });
  expect(acted().length).toBe(n);
  expect(L.approvals()).toEqual([]);
});

test("W4a-2 AC-3: 全部止める・取り戻すと許しは消える（渡し直しても付いてこない）", async () => {
  for (const stop of [(L: ReturnType<typeof mk>) => L.stopAll(), (L: ReturnType<typeof mk>) => L.takeback("10:1"), (L: ReturnType<typeof mk>) => L.touch(10)]) {
    calls = [];
    const L = ask();
    const tk = given(L);
    await grant(L, tk);
    stop(L);
    expect(await L.act(tk, "type_text", { text: "止めた後" })).toMatchObject({ ok: false, why: "gen" });
    const tk2 = given(L); // 渡し直し
    expect(L.list()[0]!.turnAllow).toBeUndefined();
    const p = L.act(tk2, "type_text", { text: "again" });
    await tick();
    expect(L.approvals().length).toBe(1);
    L.answer(L.approvals()[0]!.id, false);
    await p;
    expect(acted().length).toBe(1); // 許した最初の 1 件だけ
  }
});

test("W4a-2 AC-3: 世代が変わると許しは消える（再確認・web の頁の移動）", async () => {
  const L = ask();
  const tk = given(L);
  await grant(L, tk);
  const r = L.reconfirm("10:1");
  if (!r.ok) throw new Error();
  const p = L.act(tokenOf(r.lease), "type_text", { text: "x" });
  await tick();
  expect(L.approvals().length).toBe(1); // 世代が上がった後は、また聞く
  L.answer(L.approvals()[0]!.id, false);
  await p;

  doc = "d1";
  let t = 1000;
  const W = ask({ web: web2(), now: () => t });
  const g = W.give(T1, "s:3");
  if (!g.ok) throw new Error();
  const wt = tokenOf(g.lease);
  t = 1100;
  const pw = W.act(wt, "click", { element_token: "d1" });
  await tick();
  W.answer(W.approvals()[0]!.id, true, true);
  expect((await pw).ok).toBe(true);
  t = 1120;
  doc = "d2";
  expect(await W.navigated(5, { startedAt: 1101, type: "link", quals: [] })).toBe(0); // agent 自身の移動は持ち主を保つが、許しは前の頁の物
  expect(W.list()[0]!.turnAllow).toBeUndefined();
  const pn = W.act(wt, "click", { element_token: "d1" });
  await tick();
  expect(W.approvals().length).toBe(1);
  W.answer(W.approvals()[0]!.id, false);
  await pn;
});

test("W4a-2: 同じ窓で待っている他の card も「この頼みの間」で一緒に許される・読むだけは今まで通り聞かない", async () => {
  const L = ask();
  const tk = given(L);
  const p1 = L.act(tk, "type_text", { text: "1" }), p2 = L.act(tk, "type_text", { text: "2" });
  await tick();
  expect(L.approvals().length).toBe(2);
  L.answer(L.approvals()[0]!.id, true, true);
  expect([(await p1).ok, (await p2).ok]).toEqual([true, true]);
  expect(L.approvals()).toEqual([]);
  expect((await L.act(tk, "get_window_state", {})).ok).toBe(true);
});

// W4h: 別の Space の窓は、読むだけ普通の AX の helper で読む（押す・書くは測れるまで理由つき拒否）。AX がその窓を持っていない時だけ理由を言う
test("W4h-2: 常駐は kangae の隣の「Kangae Bar 読み取り.app」を見つける（bar の bundle: Contents/Resources/bin）・環境変数が先・無ければ undefined", () => {
  const d = mktmp("axp");
  const bin = join(d, "Resources/bin");
  mkdirSync(bin, { recursive: true });
  expect(axReadPath(join(bin, "kangae"), { HOME: join(d, "nohome") })).toBeUndefined();
  mkdirSync(join(bin, "Kangae Bar 読み取り.app"));
  expect(axReadPath(join(bin, "kangae"), { HOME: join(d, "nohome") })).toBe(join(bin, "Kangae Bar 読み取り.app"));
  writeFileSync(join(d, "env-helper"), "");
  expect(axReadPath(join(bin, "kangae"), { HOME: join(d, "nohome"), KANGAE_AX_READ: join(d, "env-helper") })).toBe(join(d, "env-helper"));
  rmSync(d, { recursive: true, force: true });
});

// ---- W4h / W4h-2: 別の Space の窓。押す・書くは理由つき拒否。読むだけは driver → 0 件なら普通の AX の helper。理由は混ぜない（helper が無い / 許可が無い / AX が窓を持たない）----
const offSpace = (on: boolean | undefined) => { wins = [{ pid: 10, window_id: 1, on_current_space: on } as any, { pid: 20, window_id: 2 }]; };
const withEls: Driver = { call: async (tool, args) => (calls.push({ tool, args }), { text: "ok", isError: false, data: tool === "list_windows" ? { windows: wins } : tool === "get_window_state" ? { snapshot_id: "s1", elements: [{ element_token: "s1:0", role: "AXWindow", label: "窓" }] } : null }), close() {} };
const head = (r: any) => (r.ok ? r.text : r.hint);

test("W4h-2: 別の Space の窓の押す・書くは 0 件実行で拒否（読むなら get_window_state と案内）・同じ Space なら通る", async () => {
  const L = mk();
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const tk = tokenOf(g.lease);
  offSpace(false);
  for (const tool of ["click", "type_text", "set_value"]) expect(await L.act(tk, tool, { element_token: "x", text: "y" })).toMatchObject({ ok: false, why: "surface", hint: expect.stringContaining("get_window_state") });
  expect(acted()).toEqual([]);
  offSpace(true);
  expect((await L.act(tk, "click", {})).ok).toBe(true);
});

test("W4h-2: 別の Space の窓の get_window_state は、まず driver・要素が返ればそのまま（helper は呼ばない）", async () => {
  const asked: number[] = [];
  const L = mk({ driver: () => withEls, axRead: async (pid) => (asked.push(pid), null) });
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  offSpace(false);
  const r = await L.act(tokenOf(g.lease), "get_window_state", {});
  expect(r).toMatchObject({ ok: true });
  expect(head(r)).toContain("s1:0");
  expect(asked).toEqual([]);
});

test("W4h-2: driver が 0 件なら helper で読む。理由を混ぜない（helper 無し / 許可無し=誰に出すか / AX が窓を持たない / 読めた）", async () => {
  const cases: [string, any, (h: string) => void][] = [
    ["helper 無し", null, (h) => expect(h).toContain("helper（Kangae Bar 読み取り）が見つかりません")],
    ["許可無し（helper が別の app 名＝Chrome を返しても、出す先は読み取り .app だけ）", { error: "no-ax-permission", responsible: "Google Chrome", app: "/x/Kangae Bar.app/Contents/Resources/bin/Kangae Bar 読み取り.app" }, (h) => { expect(h).toContain("システム設定 › プライバシーとセキュリティ › アクセシビリティ"); expect(h).toContain("「Kangae Bar 読み取り」"); expect(h).toContain("Kangae Bar.app/Contents/Resources/bin"); expect(h).not.toContain("Chrome"); }],
    ["返事を受け取れない", { error: "no-reply" }, (h) => { expect(h).toContain("返事を受け取れませんでした"); expect(h).not.toContain("見つかりません"); }],
    ["AX が窓を持たない", { found: false }, (h) => expect(h).toContain("一度も画面に出ていない")],
    ["読めた", { found: true, elements: [{ depth: 0, role: "Window", label: "週報", value: "" }, { depth: 1, role: "TextArea", label: "", value: "行 1" }] }, (h) => { expect(h).toContain("要素 2"); expect(h).toContain("TextArea\t行 1"); expect(h).toContain("押す・書くはできません"); }],
  ];
  const hints = new Set<string>();
  for (const [name, ax, check] of cases) {
    const d = mktmp("w4h2");
    const L = makeLeases(d, { driver: fake, defaultMode: "allow", axRead: async () => ax });
    const g = L.give(A, "s:1");
    if (!g.ok) throw new Error();
    offSpace(false);
    const r = await L.act(tokenOf(g.lease), "get_window_state", {});
    expect([name.startsWith("読めた"), r.ok]).toEqual([name === "読めた", name === "読めた"]);
    check(head(r));
    if (name === "helper 無し") expect(axWanted()).toBe(false); // W21: 許可が無くて読めなかった時だけ「要る」が立つ（最初の画面の許可の案内の条件）
    if (name.startsWith("許可無し")) expect(axWanted()).toBe(true);
    hints.add(head(r));
    L.closeAll();
    rmSync(d, { recursive: true, force: true });
  }
  expect(hints.size).toBe(5); // 5 つの理由は全部違う言葉
  expect(acted().every((c) => c.tool === "get_window_state")).toBe(true);
});
