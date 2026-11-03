import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHandler } from "../src/main.ts";
import { distill } from "../src/mods.ts";
import { openStore } from "../src/store.ts";
import type { Driver } from "../src/lease.ts";

// 人の値・画面の文字（これが mod に残ったら失敗）
const HUMAN_VALUE = "田中さんの電話090-1234-5678";
const SCREEN_TEXT = "画面の秘密ラベルABC";

function setup() {
  const procs: { end: () => void }[] = [];
  const spawn = () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
    const exited = new Promise<number>((r) => (done = r));
    procs.push({ end: () => { ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ type: "result", result: "書きました" }) + "\n")); ctrl.close(); done(0); } });
    return { stdout, exited, kill: () => { try { ctrl.close(); } catch {} done(143); } };
  };
  const driver: Driver = { call: async (tool) => ({
    text: "ok", isError: false,
    data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 7 }, { pid: 20, window_id: 2 }, { pid: 30, window_id: 3 }]}
      : tool === "get_window_state" ? { snapshot_id: "s1", elements: [{ element_token: "e1", role: "AXButton", label: SCREEN_TEXT, value: "" }, { element_token: "e2", role: "AXTextField", label: "", value: HUMAN_VALUE }] } : null }), close() {} };
  const modsRoot = mktmp("mods");
  const s = openStore(":memory:");
  const h = makeHandler(s, async () => [], undefined,
    { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn: spawn as any, browserUrl: async () => null },
    { uiHome: mktmp("kangae-ui"), leaseDriver: () => driver, modsRoot });
  return { h: h as (m: any) => Promise<any>, s, procs, modsRoot };
}
type S = ReturnType<typeof setup>;

// 会話を作り・窓を渡し・agent を起こし・act を並べ・turn を終える
async function run(t: S, root: number, pid: number, acts: [string, any][], opts: { wait?: boolean } = {}) {
  await t.h({ op: "leaseMode", app: "ScratchPad", mode: "allow" });
  expect((await t.h({ op: "leaseGive", rootId: root, pid, windowId: ({ 10: 7, 20: 2, 30: 3 } as Record<number, number>)[pid], app: "ScratchPad", title: "" })).ok).toBe(true);
  const n = t.procs.length;
  expect((await t.h({ op: "send", rootId: root, text: "書いて" })).ok).toBe(true);
  const l = (await t.h({ op: "leaseList" })).leases.find((x: any) => x.owner === `s:${root}`);
  const tok = `${l.key}|${l.gen}|${l.owner}`;
  await t.h({ op: "act", lease: tok, tool: "get_window_state", args: {} });
  for (const [tool, args] of acts) expect((await t.h({ op: "act", lease: tok, tool, args })).ok).toBe(true);
  t.procs[n]!.end();
  for (let i = 0; i < 100; i++) { // turn の終わり（後始末）を待つ
    if ((await t.h({ op: "runs", nodeIds: [root] })).runs.every((r: any) => r.status !== "running")) break;
    await Bun.sleep(10);
  }
  await Bun.sleep(20);
}
const three: [string, any][] = [["click", { element_token: "e1" }], ["type_text", { element_token: "e2", text: HUMAN_VALUE }], ["click", { element_token: "e1" }]];

test("UC-d1 3 手の走り → 「mod にしますか」→ 押す → off の mod（mod.json・prompt.md に人の値・画面の文字が無い）", async () => {
  const t = setup();
  const a = t.s.add(null, "user", "会話A", true);
  await run(t, a.id, 10, three);
  const o = await t.h({ op: "mods", rootId: a.id });
  expect(o.offer).toEqual({ app: "ScratchPad", steps: 3 });
  expect(t.s.children(a.id).some((n) => n.text.includes("この手順を覚えますか"))).toBe(true); // 会話の終わりの行
  expect(o.mods).toEqual([]); // 押すまで file には何も書かない
  const g = await t.h({ op: "distillMake", rootId: a.id });
  expect(g.ok).toBe(true);
  const m = (await t.h({ op: "mods" })).mods[0];
  expect(m).toMatchObject({ app: "ScratchPad", on: false, permission: "write", origin: "手順から作った〈会話A〉", seen: 1 });
  const dir = join(t.modsRoot, "ScratchPad", m.name);
  const all = readFileSync(join(dir, "mod.json"), "utf8") + readFileSync(join(dir, "prompt.md"), "utf8") + readFileSync(join(dir, "distill.json"), "utf8");
  for (const bad of [HUMAN_VALUE, SCREEN_TEXT, "e1", "e2", "090"]) expect(all).not.toContain(bad);
  expect(all).toContain("人に聞いて"); // 値が要る手は「人に聞く」
  expect(all).toContain("Button");
  expect(existsSync(join(t.modsRoot, ".on.json")) ? readFileSync(join(t.modsRoot, ".on.json"), "utf8") : "{}").toBe("{}"); // on の記録は作らない
  expect((await t.h({ op: "mods", rootId: a.id })).offer).toBeNull();
});

test("UC-d2 同じ形をもう 1 回 → 新しい mod は増えず「2 回」・違う形は別の mod", async () => {
  const t = setup();
  const a = t.s.add(null, "user", "A", true), b = t.s.add(null, "user", "B", true), c = t.s.add(null, "user", "C", true);
  await run(t, a.id, 10, three);
  await t.h({ op: "distillMake", rootId: a.id });
  await run(t, b.id, 20, [["click", { element_token: "e1" }], ["click", { element_token: "e1" }], ["type_text", { element_token: "e2", text: "別の値" }], ["click", { element_token: "e1" }]]); // retry の連続は 1 手 → 同じ形
  expect((await t.h({ op: "mods", rootId: b.id })).offer).toBeNull();
  expect(t.s.children(b.id).some((n) => n.text.includes("寄せました（2 回）"))).toBe(true);
  const l = (await t.h({ op: "mods" })).mods;
  expect(l).toHaveLength(1);
  expect(l[0].seen).toBe(2);
  await run(t, c.id, 30, [["click", { element_token: "e1" }], ["press_key", { key: "escape" }]]); // 別の形
  expect((await t.h({ op: "mods", rootId: c.id })).offer).toMatchObject({ steps: 2 });
});

test("蒸留は 2〜8 手だけ・1 手と 9 手は候補にならない・mod の走りは蒸留しない", () => {
  const st = (n: number) => Array.from({ length: n }, (_, i) => ({ tool: i % 2 ? "type_text" : "click", kind: `K${"abcdefgh"[i]}` }));
  expect(distill("A", st(1))).toBeNull();
  expect(distill("A", st(2))).not.toBeNull();
  expect(distill("A", st(8))).not.toBeNull();
  expect(distill("A", st(9))).toBeNull();
  expect(distill("A", [{ tool: "click", kind: "Button" }, { tool: "click", kind: "Button" }])).toBeNull(); // 連続は 1 手
  expect(distill("A", st(3))!.shape).toBe(distill("a", st(3))!.shape);
  expect(distill("A", st(3))!.shape).not.toBe(distill("A", st(4))!.shape);
});

test("UC-d3 AI が書く: 形の検査を通った mod が off で一覧に・出所に頼みが出る・on にして押すと動く", async () => {
  const t = setup();
  const w = await t.h({ op: "modWrite", app: "ScratchPad", name: "greet", by: "今日の挨拶を書く mod を作って", spec: { label: "挨拶", permission: "write", prompt: "1 行目に今日の日付と挨拶を書く" } });
  expect(w).toMatchObject({ ok: true, key: "ScratchPad/greet" });
  const m = (await t.h({ op: "mods" })).mods[0];
  expect(m).toMatchObject({ on: false, origin: "agent が書いた〈今日の挨拶を書く mod を作って〉" });
  const root = t.s.add(null, "user", "会話", true);
  expect(await t.h({ op: "modRun", key: m.key, rootId: root.id, pid: 10, app: "ScratchPad" })).toMatchObject({ ok: false }); // off の間は動かない
  await t.h({ op: "modOn", key: m.key, yes: true });
  expect(await t.h({ op: "modRun", key: m.key, rootId: root.id, pid: 10, app: "ScratchPad" })).toMatchObject({ ok: true });
});

test("AC-3 人が置いた mod は一覧で「人が置いた」・agent が書いた mod と区別できる", async () => {
  const t = setup();
  const d = join(t.modsRoot, "ScratchPad", "h");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "mod.json"), JSON.stringify({ label: "人", permission: "read" }));
  writeFileSync(join(d, "prompt.md"), "読む");
  await t.h({ op: "modWrite", app: "ScratchPad", name: "ai", by: "", spec: { label: "AI", permission: "read", prompt: "読む" } });
  expect((await t.h({ op: "mods" })).mods.map((x: any) => x.origin)).toEqual(["agent が書いた", "人が置いた"]);
});

test("UC-d4 / AC-3 書く口: 秘密・env の値・形の崩れ・人が置いた物の上書きは拒否・同じ名前の上書きは off に戻る", async () => {
  const t = setup();
  const w = (spec: any, name = "x", by = "") => t.h({ op: "modWrite", app: "ScratchPad", name, by, spec });
  const ok = { label: "x", permission: "read", prompt: "読む" };
  expect(await w({ ...ok, prompt: "token は sk-abcdefghijklmnop1234 を使う" })).toMatchObject({ ok: false, hint: expect.stringContaining("秘密") });
  expect(await w({ ...ok, prompt: "password: hunter2 で入る" })).toMatchObject({ ok: false, hint: expect.stringContaining("秘密") });
  expect(await w({ ...ok, label: "AKIAABCDEFGHIJKLMNOP" })).toMatchObject({ ok: false });
  expect(await w({ ...ok, mcp: { a: { command: "bun", args: ["--key=sk-abcdefghijklmnop1234"] } } })).toMatchObject({ ok: false, hint: expect.stringContaining("秘密") });
  expect(await w({ ...ok, mcp: { a: { command: "bun", args: ["--key=sk-abcdefghijklmnop1234"] } } })).toMatchObject({ hint: expect.stringContaining("mcp「a」の command・args") }); // どこが当たったかを言う
  expect(await w({ ...ok, mcp: { a: { command: "touch", args: ["/var/folders/l8/myyjs1zd0bl9btjrgyzdh_3r0000gn/T/kangae-w6b-WPE0dD/pwned"] } } }, "longpath")).toMatchObject({ ok: true }); // 長い path は秘密ではない
  expect(await w({ ...ok, mcp: { a: { command: "bun", env: { API_KEY: "value-1" } } } })).toMatchObject({ ok: false, hint: expect.stringContaining("env の値") });
  expect(await w({ ...ok, permission: "admin" })).toMatchObject({ ok: false, hint: expect.stringContaining("読めません") });
  expect(await w({ ...ok, prompt: "" })).toMatchObject({ ok: false, hint: expect.stringContaining("読めません") });
  expect(await w({ ...ok, label: "x".repeat(31) })).toMatchObject({ ok: false });
  expect(await t.h({ op: "modWrite", app: "../etc", name: "x", spec: ok })).toMatchObject({ ok: false });
  expect((await t.h({ op: "mods" })).mods.map((m: any) => m.name)).toEqual(["longpath"]); // 断った物は何も書かれていない
  // 頼みに秘密が混ざっていたら、出所には書かない
  await w(ok, "s", "sk-abcdefghijklmnop1234 で作って");
  expect((await t.h({ op: "mods" })).mods[0].origin).toBe("agent が書いた");
  // 危ない宣言（任意の command）は書けるが off のまま・宣言が見える
  expect(await w({ ...ok, mcp: { evil: { command: "sh", args: ["-c", "echo hi"], env: { TOKEN: "" } } } }, "danger", "任意のコマンドを起こす mod")).toMatchObject({ ok: true });
  const d = (await t.h({ op: "mods" })).mods.find((m: any) => m.name === "danger");
  expect(d).toMatchObject({ on: false, runs: "evil: sh -c echo hi（env: TOKEN）" });
  const root = t.s.add(null, "user", "会話", true);
  expect(await t.h({ op: "modRun", key: d.key, rootId: root.id, pid: 10, app: "ScratchPad" })).toMatchObject({ ok: false });
  // 人が置いた物は書き換えない
  const hd = join(t.modsRoot, "ScratchPad", "human");
  mkdirSync(hd, { recursive: true });
  writeFileSync(join(hd, "mod.json"), JSON.stringify(ok));
  writeFileSync(join(hd, "prompt.md"), "人の手順");
  expect(await w(ok, "human")).toMatchObject({ ok: false, hint: expect.stringContaining("人が置いた") });
  expect(readFileSync(join(hd, "prompt.md"), "utf8")).toBe("人の手順");
  // on の mod を同じ宣言で書き直しても、許可は引き継がない
  await t.h({ op: "modOn", key: "ScratchPad/s", yes: true });
  expect((await t.h({ op: "mods" })).mods.find((m: any) => m.name === "s").on).toBe(true);
  await w({ ...ok, prompt: "別の手順" }, "s");
  expect((await t.h({ op: "mods" })).mods.find((m: any) => m.name === "s").on).toBe(false);
});

test("mod の走りは「mod にしますか」を出さない（同じ物を増やさない）", async () => {
  const t = setup();
  await t.h({ op: "leaseMode", app: "ScratchPad", mode: "allow" });
  await t.h({ op: "modWrite", app: "ScratchPad", name: "m", by: "", spec: { label: "m", permission: "write", prompt: "書く" } });
  await t.h({ op: "modOn", key: "ScratchPad/m", yes: true });
  const a = t.s.add(null, "user", "A", true);
  expect((await t.h({ op: "modRun", key: "ScratchPad/m", rootId: a.id, pid: 10, app: "ScratchPad" })).ok).toBe(true);
  const l = (await t.h({ op: "leaseList" })).leases[0];
  const tok = `${l.key}|${l.gen}|${l.owner}`;
  await t.h({ op: "act", lease: tok, tool: "get_window_state", args: {} });
  for (const [tool, args] of three) await t.h({ op: "act", lease: tok, tool, args });
  t.procs[0]!.end();
  await Bun.sleep(100);
  expect((await t.h({ op: "mods", rootId: a.id })).offer).toBeNull();
});
