// W50b: ops.jsonl の回転（2MB で .1 へ・2 世代まで・0600・recentFor は .1 / .2 も読む）と、review27 で未測だった「turn を実際に走らせる fake spawn の通し」（定時の turn の後の人の turn は待たない）
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPS_KEEP, OPS_MAX_BYTES, appendOps, recentFor } from "../src/opsview.ts";
import { tokenOf, type Driver, type OpRecord } from "../src/lease.ts";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { mktmp } from "./tmp.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000);

let dir: string;
beforeEach(() => { dir = mktmp("w50b"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const rec = (i: number, owner = "s:1"): OpRecord => ({ at: i, face: "tab:5", app: "web", gen: 1, op: "type_text", value: `v${i}`, result: "ok", owner, where: "Canvas" });
const mode = (f: string) => statSync(f).mode & 0o777;

test("W50b 回転: 上限を超えたら .1 に送り、.2 まで（それより古い記録は消える）・どの file も 0600・新しい記録は今の file に入る", () => {
  const f = join(dir, "ops.jsonl");
  const line = (i: number) => JSON.stringify(rec(i));
  const max = 400; // 試験用の小さい上限（本物は 2MB）
  for (let i = 0; i < 40; i++) appendOps(f, line(i), max);
  expect(readdirSync(dir).filter((x) => x.startsWith("ops.jsonl")).sort()).toEqual(["ops.jsonl", "ops.jsonl.1", "ops.jsonl.2"]); // .3 は無い
  for (const x of ["ops.jsonl", "ops.jsonl.1", "ops.jsonl.2"]) expect(mode(join(dir, x)), x).toBe(0o600);
  // 今の file は上限を（1 行ぶん以上は）超えない・古い file は上限に近い大きさ
  expect(statSync(f).size).toBeLessThan(max + 200);
  const newest = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l).at);
  expect(newest.at(-1)).toBe(39);
  // 最古の記録（at=0）は 2 世代の外へ消えている
  const all = ["ops.jsonl", "ops.jsonl.1", "ops.jsonl.2"].flatMap((x) => readFileSync(join(dir, x), "utf8").trim().split("\n").map((l) => JSON.parse(l).at));
  expect(all).not.toContain(0);
  expect(all.length).toBeLessThan(40);
  expect(OPS_KEEP).toBe(2);
  expect(OPS_MAX_BYTES).toBe(2 * 1024 * 1024);
});

test("W50b recentFor は回転後も、今の file → .1 → .2 の順に足りるまで読む（新しい順・5 件・別の会話は混ざらない・.1 の壊れた行は飛ばす）", () => {
  const f = join(dir, "ops.jsonl");
  writeFileSync(`${f}.2`, [rec(1), rec(2, "s:2"), rec(3)].map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(`${f}.1`, [rec(4), "{壊れた", rec(5, "s:2"), rec(6)].map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  writeFileSync(f, [rec(7)].map((r) => JSON.stringify(r)).join("\n") + "\n");
  expect(recentFor(f, "s:1").map((x) => x.at)).toEqual([7, 6, 4, 3, 1]); // 3 つの file をまたいで 5 件
  expect(recentFor(f, "s:2").map((x) => x.at)).toEqual([5, 2]);
  expect(recentFor(f, "s:1", 2).map((x) => x.at)).toEqual([7, 6]); // 足りたら古い file は読まない
  expect(recentFor(join(dir, "none.jsonl"), "s:1")).toEqual([]);
  expect(recentFor(f, "../x")).toEqual([]);
});

test("W50b 回転の瞬間にも記録は 1 行も落ちず、回した直後の新しい行が今の file の先頭に入る", () => {
  const f = join(dir, "ops.jsonl");
  for (let i = 0; i < 6; i++) appendOps(f, JSON.stringify(rec(i)), 200); // 数回回る
  const seen = ["ops.jsonl.2", "ops.jsonl.1", "ops.jsonl"].filter((x) => existsSync(join(dir, x))).flatMap((x) => readFileSync(join(dir, x), "utf8").trim().split("\n").map((l) => JSON.parse(l).at));
  expect(seen).toEqual([...seen].sort((a, b) => a - b)); // 古い file ほど古い記録（順序が崩れない）
  expect(seen.at(-1)).toBe(5);
  expect(new Set(seen).size).toBe(seen.length); // 重複なし
});

test("W50b 配線: 常駐の 2 つの書き手（act の記録・下書きの記録）は appendOps を通り、ops.jsonl に直接 appendFileSync する所は無い", () => {
  const m = readFileSync(join(import.meta.dir, "..", "src/main.ts"), "utf8");
  const direct = m.split("\n").filter((l) => /appendFileSync\(join\(uiHome\(\), "ops\.jsonl"\)/.test(l));
  expect(direct).toEqual([]);
  expect((m.match(/appendOps\(join\(uiHome\(\), "ops\.jsonl"\)/g) ?? []).length).toBe(2);
});

// ---- turn を実際に走らせる通し（fake spawn） ----
const fakeDriver = () => { const writes: string[] = []; const d: Driver = { call: async (tool, args) => { if (tool === "type_text") writes.push(String(args.text)); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }; }, close() {} }; return { d, writes }; };
type Proc = { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill: () => void };
const controllableSpawn = () => {
  const finishers: (() => void)[] = [];
  const spawn = (): Proc => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>; let done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
    const exited = new Promise<number>((r) => (done = r));
    finishers.push(() => { try { ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ type: "result", result: "終わりました" }) + "\n")); ctrl.close(); } catch {} done(0); });
    return { stdout, exited, kill: () => { try { ctrl.close(); } catch {} done(143); } };
  };
  return { spawn, finishOne: () => finishers.shift()?.(), started: () => finishers.length };
};

test("W50b 通し（fake spawn・本物の turn）: 定時の turn は人が見ている面への write を離れるまで待ち、その turn が終わった後の人の turn は同じ状況でも待たない", async () => {
  const store = openStore(":memory:");
  const root = store.add(null, "user", "頼み", true);
  const ui = join(dir, "ui");
  const clock = { t: Date.UTC(2026, 9, 14, 0, 0) };
  const sp = controllableSpawn();
  const fd = fakeDriver();
  const ws = { ...defaultWorkspace(), dir: join(dir, "ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn: sp.spawn, browserUrl: async () => null } as any;
  const H: any = makeHandler(store, async () => [], undefined, ws, { uiHome: ui, leaseDriver: () => fd.d, routineDeps: { now: () => clock.t, setTimer: () => 0, clearTimer: () => {} } } as any);
  const peer = {};
  const idle = async () => { for (let i = 0; i < 400; i++) { const r: any = await H({ op: "runs", nodeIds: [root.id] }, {}); if (r.runs.at(-1)?.status !== "running") return; await tick(10); } throw new Error("turn が終わらない"); };
  const running = async () => { for (let i = 0; i < 400; i++) { const r: any = await H({ op: "runs", nodeIds: [root.id] }, {}); if (r.runs.at(-1)?.status === "running") return r.runs.at(-1); await tick(10); } throw new Error("turn が始まらない"); };
  expect((await H({ op: "agentName", rootId: root.id, name: "alice" }, {})).ok).toBe(true);
  await H({ op: "humanHello" }, peer);
  const seeFront = (pid: number) => H({ op: "humanSeen", kind: "front", pid }, peer);
  // 1 回目: 人の最初の頼み → その turn が終わる
  await H({ op: "workspace", nodeId: root.id, agent: true, text: "頼み" }, {});
  await running(); sp.finishOne(); await idle();
  // 面を渡す（人は別の app を見ている＝hold 無し）・表は「許す」
  await seeFront(99);
  const given: any = await H({ op: "leaseGive", rootId: root.id, pid: 10, windowId: 1, app: "Pad", title: "" }, {});
  expect(given.ok, JSON.stringify(given)).toBe(true);
  await H({ op: "leaseMode", app: "Pad", mode: "allow" }, {});
  const tok = tokenOf(given.lease);
  const act = (text: string) => H({ op: "act", lease: tok, tool: "type_text", args: { text } }, {});
  // 定時の turn: routine が起こす
  expect((await H({ op: "routine", action: "add", name: "alice", spec: { every: "5" }, text: "定時の用" }, {})).ok).toBe(true);
  clock.t += 6 * 60_000;
  await H.routines.tick();
  await running();
  await seeFront(10); // 人がこの面を見始めた
  const sched = act("sched");
  await tick(120);
  expect(fd.writes).toEqual([]); // 定時の write は離れるまで待つ
  await seeFront(99); // 人が離れた
  expect((await sched).ok).toBe(true);
  expect(fd.writes).toEqual(["sched"]);
  sp.finishOne(); await idle(); // 定時の turn が終わる
  // 人の頼み（同じ run に続けて）: 人はまた同じ面を見ている
  const run: any = (await H({ op: "runs", nodeIds: [root.id] }, {})).runs.at(-1);
  await H({ op: "instruct", runId: run.id, text: "人の頼み" }, {});
  await running();
  await seeFront(10);
  const human = await Promise.race([act("human"), tick(1500).then(() => "waiting" as const)]);
  expect(human, "人の turn の write が待たされた（定時の印が turn の後に残っている）").not.toBe("waiting");
  expect((human as any).ok).toBe(true);
  expect(fd.writes).toEqual(["sched", "human"]);
  sp.finishOne(); await idle();
  H.routines?.stop?.();
});
