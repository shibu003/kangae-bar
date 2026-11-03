import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentColors, AGENT_COLORS } from "../extension/groups.js";
import { RESUME_TEXT, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import type { Driver } from "../src/lease.ts";

// 画面なしの agent: 起こされた command を覚え、kill されたかを見る
function fakeSpawn() {
  const calls: { cmd: string[]; killed: boolean }[] = [];
  const spawn = (cmd: string[]) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
    const exited = new Promise<number>((r) => (done = r));
    const call = { cmd, killed: false };
    calls.push(call);
    return { stdout, exited, kill: () => { call.killed = true; try { ctrl.close(); } catch {} done(143); } };
  };
  return { calls, spawn };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

function setup() {
  const fs = fakeSpawn();
  const acted: string[] = [];
  const driver: Driver = { call: async (tool) => { if (tool !== "list_windows") acted.push(tool); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }, { pid: 20, window_id: 2 }] } : null }; }, close() {} };
  const s = openStore(":memory:");
  const h = makeHandler(s, async () => [], undefined,
    { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn: fs.spawn, browserUrl: async () => null },
    { uiHome: mktmp("kangae-ui"), leaseDriver: () => driver });
  return { fs, h, s, acted };
}

test("W4d 代わる: その会話の agent だけ止まり・面は人に戻り・承認待ちは実行されず・別の会話は続く", async () => {
  const { fs, h, s, acted } = setup();
  const a = s.add(null, "user", "A 頁を読む", true), b = s.add(null, "user", "B file を書く", true);
  const ra: any = await h({ op: "workspace", nodeId: a.id, agent: true, text: "go" });
  const rb: any = await h({ op: "workspace", nodeId: b.id, agent: true, text: "go" });
  const ga: any = await h({ op: "leaseGive", rootId: a.id, pid: 10, windowId: 1, app: "Calc", title: "" });
  const gb: any = await h({ op: "leaseGive", rootId: b.id, pid: 20, windowId: 2, app: "Edit", title: "x" });
  expect(ga.ok && gb.ok).toBe(true);
  const tokA = `10:1|${ga.lease.gen}|s:${a.id}`;
  const pending = h({ op: "act", lease: tokA, tool: "type_text", args: { text: "書く" } }); // 承認待ちになる
  await tick();
  expect(((await h({ op: "leaseList" })) as any).approvals).toHaveLength(1);

  const r: any = await h({ op: "handover", rootId: a.id });
  expect(r).toMatchObject({ ok: true, took: true, stopped: 1 });
  expect(await pending).toMatchObject({ ok: false, code: "gen" }); // 承認も消え、実行されない
  expect(acted).toEqual([]);
  expect(((await h({ op: "leaseList" })) as any).approvals).toEqual([]);
  expect(((await h({ op: "runs", nodeIds: [a.id, b.id] })) as any).runs.map((x: any) => [x.id === ra.run.id ? "A" : "B", x.status])).toEqual([["A", "stopped"], ["B", "running"]]);
  expect(fs.calls.map((c) => c.killed)).toEqual([true, false]); // 止まったのは A の process だけ
  expect(((await h({ op: "leaseList" })) as any).leases.map((l: any) => l.owner)).toEqual([`s:${b.id}`]); // B の面は残る
  expect(await h({ op: "act", lease: tokA, tool: "click", args: {} })).toMatchObject({ ok: false, code: "gen" }); // 前の操作権は拒否(gen)
  expect(rb.ok).toBe(true);
});

test("W4d 続けて: 呼び直しても前の操作権は戻らない・面の渡し直しを頼む文で起きる・止まっていない agent の面は触らない", async () => {
  const { fs, h, s } = setup();
  const a = s.add(null, "user", "A", true);
  await h({ op: "workspace", nodeId: a.id, agent: true, text: "go" });
  const g: any = await h({ op: "leaseGive", rootId: a.id, pid: 10, windowId: 1, app: "Calc", title: "" });
  await h({ op: "handover", rootId: a.id });
  const r: any = await h({ op: "resume", rootId: a.id });
  expect(r.ok).toBe(true);
  expect(fs.calls).toHaveLength(2);
  expect(fs.calls[1]!.cmd[2]).toContain(RESUME_TEXT.slice(0, 20));
  expect(fs.calls[1]!.cmd[2]).toContain("もう一度渡して"); // 要る面は渡し直しを頼ませる
  expect(((await h({ op: "leaseList" })) as any).leases).toEqual([]); // 操作権は戻っていない
  expect(fs.calls[1]!.cmd.join(" ")).not.toContain("step:*"); // 面の操作の道具（step）は渡していない。act:* は W23 で面なしにも付く（最初の open_app だけ・面の操作は CLI と常駐が面なしを断る）
  expect(await h({ op: "act", lease: `10:1|${g.lease.gen}|s:${a.id}`, tool: "click", args: {} })).toMatchObject({ ok: false });
  expect(await h({ op: "resume", rootId: 99999 })).toMatchObject({ ok: false });
});

test("W4d 色: 並んだ agent は色の数まで同じ色にならない・同じ並びなら同じ色", () => {
  const ids = [1, 7, 13, 2, 8, 14]; // 全部 id % 6 が衝突する並び
  const m = agentColors(ids);
  expect(new Set(m.values()).size).toBe(AGENT_COLORS);
  expect([...agentColors(ids.reverse())]).toEqual([...m]);
  expect(agentColors([5]).get(5)).toBe(5);
});

test("W4d-2 言葉: 人が押す button は「代わる」1 つ（帯も行も）・帯も同じ handover を呼ぶ（取り戻す の button は無い）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../extension/panel.js", import.meta.url), "utf8");
  expect(src).not.toMatch(/textContent = "取り戻す"/);
  expect(src).toMatch(/take\.textContent = "代わる"[\s\S]{0,260}call\("handover"/);
  expect(src.replace(/kg-agent-remove[\s\S]{0,500}?call\("remove"/, "")).not.toMatch(/call\("leaseTakeback"/); // 帯から面だけ戻して agent を止めない道を作らない（W92: agent を消す手順が先に面を人へ戻すのは除く）
});

test("W4d-2 窓の面（pid + windowId）の「代わる」も同じ: その持ち主の agent だけ止まり・面が戻り・承認も消え・古い操作権は gen", async () => {
  const { fs, h, s, acted } = setup();
  const a = s.add(null, "user", "窓の A", true), b = s.add(null, "user", "窓の B", true);
  await h({ op: "workspace", nodeId: a.id, agent: true, text: "go" });
  await h({ op: "workspace", nodeId: b.id, agent: true, text: "go" });
  const ga: any = await h({ op: "leaseGive", rootId: a.id, pid: 10, windowId: 1, app: "Calc", title: "" });
  await h({ op: "leaseGive", rootId: b.id, pid: 20, windowId: 2, app: "Edit", title: "x" });
  const tok = `10:1|${ga.lease.gen}|s:${a.id}`;
  const pending = h({ op: "act", lease: tok, tool: "type_text", args: { text: "x" } });
  await tick();
  expect(await h({ op: "handover", rootId: a.id })).toMatchObject({ ok: true, took: true, stopped: 1 });
  expect(await pending).toMatchObject({ ok: false, code: "gen" });
  expect(acted).toEqual([]);
  expect(fs.calls.map((c) => c.killed)).toEqual([true, false]);
  expect(((await h({ op: "leaseList" })) as any).leases.map((l: any) => l.surface.pid)).toEqual([20]); // B の窓だけ残る
  expect(await h({ op: "act", lease: tok, tool: "click", args: {} })).toMatchObject({ ok: false, code: "gen" });
});

test("W11e-2 道具: 読めるのは作業場所と shots の中だけ（無印の Read / Glob / Grep なし）・面を持つ turn は WebSearch / WebFetch なし・持たない調べ物は残る", async () => {
  const { fs, h, s } = setup();
  const a = s.add(null, "user", "調べる", true);
  const r0: any = await h({ op: "workspace", nodeId: a.id, agent: true, text: "go" });
  const tools = (i: number) => fs.calls[i]!.cmd[fs.calls[i]!.cmd.indexOf("--allowedTools") + 1]!.split(/,(?![^(]*\))/); // Bash(… note:*) の中の , では割らない
  const t0 = tools(0);
  for (const bare of ["Read", "Glob", "Grep"]) expect(t0).not.toContain(bare);
  const reads = t0.filter((x) => x.startsWith("Read("));
  expect(reads).toHaveLength(4);
  expect(reads[2]).toMatch(/\/win\/s_\d+\/\*\*\)$/); // review17-2: 窓の絵・command の出力は、自分の会話の置き場だけ（win 全体は許さない）
  expect(reads[3]).toMatch(/\/att\/s_\d+\/\*\*\)$/); // W75a: 人が載せた file は自分の会話の att だけ（att 全体は許さない）
  expect(reads[0]).toBe(`Read(//${realpathSync(r0.run.dir).slice(1)}/**)`);
  expect(reads[1]).toMatch(/\/shots\/\*\*\)$/);
  expect(t0).toContain("WebSearch"); // 面が無い = 調べ物だけ
  expect(t0).toContain("WebFetch");
  await h({ op: "stopRun", runId: r0.run.id });
  const g: any = await h({ op: "leaseGive", rootId: a.id, pid: 10, windowId: 1, app: "Calc", title: "" });
  expect(g.ok).toBe(true);
  await h({ op: "resume", rootId: a.id });
  const t1 = tools(1);
  expect(t1.some((x) => x.startsWith("Bash(") && x.includes("act:*"))).toBe(true); // 面を持つ turn
  expect(t1).not.toContain("WebSearch");
  expect(t1).not.toContain("WebFetch");
  for (const bare of ["Read", "Glob", "Grep"]) expect(t1).not.toContain(bare);
});
