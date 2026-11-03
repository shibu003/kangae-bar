// W22: agent A と B が同時に動く（CEO「Aとbは同時に動く必要がある」・docs/BRIEF-w22.md）。2 人が別の窓に同時に act を出し、片方が拒否・失敗・止められても他方は進む／同じ窓は後の人が断られる／card は 2 本並び取り違えない／一方の turn の終わり・取り戻し・command の kill が他方を潰さない。読む file を literal で名指す: "src/lease.ts" "src/main.ts" "src/cmds.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCmd } from "../src/cmds.ts";
import { keyOf, makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { AGENT_LIMIT, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

let top: string;
let calls: { tool: string; args: Record<string, any> }[];
let failPid = -1;
const ZED = { pid: 10, windowId: 1, app: "Zed", title: "ER_Triage_GUI" };
const PRE = { pid: 20, windowId: 2, app: "Preview", title: "課題" };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const driver = (): Driver => ({
  call: async (tool, args) => {
    await tick(15); // 2 人の呼びが本当に重なるように
    calls.push({ tool, args });
    if (args.pid === failPid && tool !== "list_windows") return { text: "driver が落ちた", isError: true, data: null };
    return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }, { pid: 20, window_id: 2 }] } : null };
  },
  close() {},
});
const mk = () => makeLeases(join(top, "lease"), { driver, defaultMode: "allow", approvalMs: 5000 });
const give = (L: ReturnType<typeof mk>, s: typeof ZED, owner: string) => { const g = L.give(s, owner); if (!g.ok) throw new Error(g.why); return g.lease; };
const by = (pid: number) => calls.filter((c) => c.args.pid === pid && c.tool !== "list_windows");
const cards = async (L: ReturnType<typeof mk>, n: number) => { for (let i = 0; i < 400 && L.approvals().length < n; i++) await tick(); return L.approvals(); };

beforeEach(() => { top = realpathSync(mktmp("w22")); mkdirSync(join(top, "lease")); calls = []; failPid = -1; });
afterEach(() => rmSync(top, { recursive: true, force: true }));

test("W22-1 同時に別の窓へ: A は Zed・B は Preview に同時に読み・書きを出し、どちらも自分の窓だけに届く（pid / window_id は門が持ち主の面から差す）", async () => {
  const L = mk();
  const a = give(L, ZED, "s:1"), b = give(L, PRE, "s:2");
  const [ra, rb, rc, rd] = await Promise.all([
    L.act(tokenOf(a), "get_window_state", { pid: 20, window_id: 2 }), // A が B の窓を名指しても、門は A の面に差し替える
    L.act(tokenOf(b), "get_window_state", { pid: 10, window_id: 1 }),
    L.act(tokenOf(a), "scroll", {}),
    L.act(tokenOf(b), "scroll", {}),
  ]);
  for (const r of [ra, rb, rc, rd]) expect(r.ok).toBe(true);
  expect(by(10).length).toBe(2);
  expect(by(20).length).toBe(2);
  expect(by(10).every((c) => c.args.window_id === 1)).toBe(true);
  expect(by(20).every((c) => c.args.window_id === 2)).toBe(true);
});

test("W22-2 片方が断られても他方は進む: A の card が出て待つ間も B は動き、A を断っても B は続き、A の操作は 1 件も実行されない", async () => {
  const L = mk();
  const a = give(L, ZED, "s:1"), b = give(L, PRE, "s:2");
  const pa = L.act(tokenOf(a), "click", { element_token: "x" }); // 押す先が分からない＝許す app でも聞く
  const [card] = await cards(L, 1);
  expect(card).toMatchObject({ owner: "s:1", app: "Zed" });
  expect((await L.act(tokenOf(b), "scroll", {})).ok).toBe(true); // A が待っている間も B は進む
  expect((await L.act(tokenOf(b), "get_window_state", {})).ok).toBe(true);
  L.answer(card!.id, false);
  expect(await pa).toMatchObject({ ok: false, why: "denied" });
  expect((await L.act(tokenOf(b), "scroll", {})).ok).toBe(true);
  expect(by(10).filter((c) => c.tool === "click")).toEqual([]);
});

test("W22-3 片方の driver が失敗しても他方は進む", async () => {
  const L = mk();
  const a = give(L, ZED, "s:1"), b = give(L, PRE, "s:2");
  failPid = 10;
  const [ra, rb] = await Promise.all([L.act(tokenOf(a), "scroll", {}), L.act(tokenOf(b), "scroll", {})]);
  expect(ra.ok === true && (ra as any).isError !== true).toBe(false);
  expect(rb.ok).toBe(true);
  expect((rb as any).isError).not.toBe(true);
  failPid = -1;
  expect((await L.act(tokenOf(a), "scroll", {})).ok).toBe(true); // A の失敗は A の面を潰さない
});

test("W22-4 同じ窓を 2 人が狙う: 後の人は渡されない（持ち主が違う）・先の人の操作は続く・取り戻された後なら後の人が持てる", async () => {
  const L = mk();
  const a = give(L, ZED, "s:1");
  const g = L.give(ZED, "s:2");
  expect(g).toMatchObject({ ok: false });
  expect((g as any).why).toContain("使っています"); // W60b1: 面の index の断り文（担当名が無ければ「別の担当」）
  expect((await L.act(tokenOf(a), "scroll", {})).ok).toBe(true);
  expect(L.facesOf("s:2")).toEqual([]);
  L.takeback(keyOf(ZED));
  expect(L.give(ZED, "s:2").ok).toBe(true);
  // 取り戻された A の token はもう効かず、B の面には届かない
  expect(await L.act(tokenOf(a), "scroll", {})).toMatchObject({ ok: false });
});

test("W22-5 card は 2 本並び、どの agent の頼みかが分かり、一方を許しても他方は許されない・実行も取り違えない", async () => {
  const L = mk();
  const a = give(L, ZED, "s:1"), b = give(L, PRE, "s:2");
  const pa = L.act(tokenOf(a), "click", { element_token: "x" });
  const pb = L.act(tokenOf(b), "click", { element_token: "y" });
  const cs = await cards(L, 2);
  expect(cs.map((c) => c.owner).sort()).toEqual(["s:1", "s:2"]);
  expect(new Set(cs.map((c) => c.id)).size).toBe(2);
  expect(new Set(cs.map((c) => c.key)).size).toBe(2);
  const ca = cs.find((c) => c.owner === "s:1")!, cb = cs.find((c) => c.owner === "s:2")!;
  expect(ca.app).toBe("Zed"); expect(cb.app).toBe("Preview");
  L.answer(ca.id, true, true); // A に「この頼みの間」と答えても
  expect((await pa).ok).toBe(true);
  expect(L.approvals().map((c) => c.id)).toEqual([cb.id]); // B の card は残り、巻き込まれない
  expect(by(20).filter((c) => c.tool === "click")).toEqual([]); // B の click はまだ 1 件も実行されていない
  L.answer(cb.id, false);
  expect(await pb).toMatchObject({ ok: false, why: "denied" });
  expect(by(10).filter((c) => c.tool === "click").length).toBe(1);
  expect(by(20).filter((c) => c.tool === "click")).toEqual([]);
});

test("W22-5b 「この頼みの間」の許しは持ち主ごと: A の turn の終わりで A の許しだけが消え、B の許しは残る・A に許しても B の card は許されない", async () => {
  const L = makeLeases(join(top, "lease"), { driver, defaultMode: "ask", approvalMs: 5000 });
  const a = give(L, ZED, "s:1"), b = give(L, PRE, "s:2");
  // 2 人の card が同時に出ている所で、A に「この頼みの間」と答える: B の card は許されず待ったまま
  const pa0 = L.act(tokenOf(a), "type_text", { text: "x" }), pb0 = L.act(tokenOf(b), "type_text", { text: "x" });
  const both = await cards(L, 2);
  L.answer(both.find((c) => c.owner === "s:1")!.id, true, true);
  expect((await pa0).ok).toBe(true);
  await tick(30);
  expect(L.approvals().map((c) => c.owner)).toEqual(["s:2"]); // B の card は A の「この頼みの間」に巻き込まれない
  expect(by(20).filter((c) => c.tool === "type_text")).toEqual([]);
  L.answer(L.approvals()[0]!.id, true, true);
  expect((await pb0).ok).toBe(true);
  expect((await L.act(tokenOf(a), "type_text", { text: "y" })).ok).toBe(true); // 許しが効いて聞かない
  expect((await L.act(tokenOf(b), "type_text", { text: "y" })).ok).toBe(true);
  expect(L.approvals()).toEqual([]);
  L.endTurn("s:1");
  const pa = L.act(tokenOf(a), "type_text", { text: "z" }); // A はまた聞く
  const [ca] = await cards(L, 1);
  expect(ca).toMatchObject({ owner: "s:1" });
  expect((await L.act(tokenOf(b), "type_text", { text: "z" })).ok).toBe(true); // B の許しは A の終わりで消えない
  L.answer(ca!.id, false); await pa;
});

test("W22-6 A の turn の終わり・取り戻しは B の card・面・待ちを潰さない（W7o と同じ型）", async () => {
  const L = mk();
  const a = give(L, ZED, "s:1"), b = give(L, PRE, "s:2");
  const pb = L.act(tokenOf(b), "click", { element_token: "y" });
  const [cb] = await cards(L, 1);
  L.endTurn("s:1"); // A の turn が終わる
  expect(L.approvals().map((c) => c.id)).toEqual([cb!.id]); // B の card は残る
  L.takeback(keyOf(ZED)); // A の面を取り戻す
  expect(L.approvals().map((c) => c.id)).toEqual([cb!.id]);
  expect(L.facesOf("s:2").length).toBe(1);
  L.answer(cb!.id, true);
  expect((await pb).ok).toBe(true);
  expect((await L.act(tokenOf(b), "scroll", {})).ok).toBe(true);
  void a;
});

test("W22-7 同時に command を走らせても取り違えない: A の面を取り戻すと A の command だけ止まり、B の command は走り終える", async () => {
  const ui = join(top, "ui"), pa = join(top, "pa"), pb = join(top, "pb"), work = join(top, "work");
  for (const d of [ui, pa, pb, work]) mkdirSync(d);
  const slowA = addCmd(ui, "slow-a", pa, ["/bin/sleep", "30"]), fastB = addCmd(ui, "fast-b", pb, ["/bin/sh", "-c", "sleep 1; echo B-done"]);
  if (!slowA.ok || !fastB.ok) throw new Error("add");
  const L = mk();
  give(L, ZED, "s:1"); give(L, PRE, "s:2");
  const ctx = { uiHome: ui, workDir: work };
  const ra = L.runCmd("s:1", "slow-a", ctx), rb = L.runCmd("s:2", "fast-b", ctx);
  const cs = await cards(L, 2);
  expect(cs.map((c) => c.owner).sort()).toEqual(["s:1", "s:2"]);
  expect(cs.every((c) => c.tool === "run_cmd" && c.danger)).toBe(true);
  for (const c of cs) L.answer(c.id, true);
  await tick(400);
  L.takeback(keyOf(ZED)); // A の面だけ取り戻す
  const [xa, xb]: any[] = await Promise.all([ra, rb]);
  expect(xa).toMatchObject({ ok: false, why: "gen" });
  expect(xb).toMatchObject({ ok: true, isError: false });
  expect(xb.text).toContain("B-done");
  const file = /全文（Read で読めます）: (.*)$/.exec(xb.text)![1]!;
  expect(readFileSync(file, "utf8")).toContain("B-done");
  expect(existsSync(join(pb, "x"))).toBe(false);
});

// ---- 常駐（handler）: 2 つの会話の agent の turn が同時に走る ----
test("W22-8 2 つの agent の turn が同時に走る: 上限は 2・3 つ目は断る・A を止めても B は走り続け面も残る・A の終わりが B の turn を潰さない", async () => {
  expect(AGENT_LIMIT).toBe(2);
  const procs: { kill: () => void; exit: (c: number) => void; end: () => void }[] = [];
  const spawn = (_cmd: string[]) => {
    let done!: (c: number) => void, close!: () => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (ctl) => { close = () => { try { ctl.close(); } catch {} }; } });
    const p = { stdout, exited: new Promise<number>((r) => (done = r)), kill: () => { close(); done(143); } };
    procs.push({ kill: p.kill, exit: (c) => { close(); done(c); }, end: close });
    return p;
  };
  const drv: Driver = { call: async (tool) => ({ text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }, { pid: 20, window_id: 2 }] } : null }), close() {} };
  const s = openStore(":memory:");
  const H: any = makeHandler(s, async () => [], undefined,
    { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => "http://127.0.0.1:9" },
    { uiHome: join(top, "ui2"), leaseDriver: () => drv });
  mkdirSync(join(top, "ui2"), { recursive: true });
  const a = s.add(null, "user", "agentA は Zed で build", true), b = s.add(null, "user", "agentB は Canvas を Docs に", true), c = s.add(null, "user", "agentC", true);
  expect((await H({ op: "leaseGive", rootId: a.id, pid: 10, windowId: 1, app: "Zed", title: "" })).ok).toBe(true);
  expect((await H({ op: "leaseGive", rootId: b.id, pid: 20, windowId: 2, app: "Preview", title: "" })).ok).toBe(true);
  const ra = await H({ op: "workspace", nodeId: a.id, agent: true, text: "go A" });
  const rb = await H({ op: "workspace", nodeId: b.id, agent: true, text: "go B" });
  expect(ra.ok && rb.ok).toBe(true);
  const rc = await H({ op: "workspace", nodeId: c.id, agent: true, text: "go C" });
  expect(rc).toMatchObject({ ok: false });
  expect(String(rc.hint)).toContain(`${AGENT_LIMIT} つまで`);
  const faces = async () => ((await H({ op: "leaseList" })) as any).leases.map((l: any) => [l.owner, l.surface.app]).sort();
  expect(await faces()).toEqual([["s:" + a.id, "Zed"], ["s:" + b.id, "Preview"]]);
  const status = async (id: string) => ((await H({ op: "runs", nodeIds: [a.id, b.id] })) as any).runs.find((r: any) => r.id === id)?.status;
  expect(await status(ra.run.id)).toBe("running");
  expect(await status(rb.run.id)).toBe("running");
  await H({ op: "stopRun", runId: ra.run.id }); // A だけ止める
  await tick(50);
  expect(await status(ra.run.id)).toBe("stopped");
  expect(await status(rb.run.id)).toBe("running"); // B は走り続ける
  expect(await faces()).toContainEqual(["s:" + b.id, "Preview"]); // B の面は残る
  // A が止まったので 3 つ目の agent を起こせる（上限は同時に走る数）
  expect((await H({ op: "workspace", nodeId: c.id, agent: true, text: "go C" })).ok).toBe(true);
  for (const p of procs) p.kill();
});
