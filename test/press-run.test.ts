// W62 AC1〜6: 段の梯子（SPEC-press §4）を fake の門で。本物の面・agent・人は呼ばない
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readPress, savePress, type Press } from "../src/press.ts";
import { runPress, type Gate, type PressDeps, type View } from "../src/press-run.ts";

let home = "";
beforeEach(() => { home = mktmp("press-run"); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

// 3 段: env（runCmd）→ op: fill → op: press_button。値は欄（title）と固定（欄の名前・ボタンの名前）
const mkPress = (o: Partial<Press> = {}): Press => {
  const p: Press = {
    v: 1, id: "a1b2c3d4", name: "予定を足す", madeAt: 1, fields: { title: { ask: true } },
    stages: [
      { n: 1, kind: "env", goal: "「sync」が済んでいる", post: { kind: "cmd-exit0", name: "sync" }, way: { kind: "runCmd", name: "sync" } },
      { n: 2, kind: "op", goal: "web で欄に入力する", post: { kind: "elements", names: ["題: 会議"] }, way: { kind: "act", app: "web", tool: "fill", args: { field: { const: "題" }, value: { field: "title" } } } },
      { n: 3, kind: "op", goal: "web でボタンを押す", post: { kind: "none" }, way: { kind: "act", app: "web", tool: "press_button", args: { name: { const: "保存" } } } },
    ],
    expect: { result: "calendar.event.created" }, onMismatch: "ask", limits: {}, runs: { total: 0, clean: 0 }, ...o,
  };
  savePress(home, p);
  return p;
};

type Call = [string, ...unknown[]];
// 面の読みは「fill が効いたか」で決まる（effect）。各門の返事は差し替えられる
const fake = (o: { fill?: (n: number) => Gate; afterFill?: boolean; agentFixes?: boolean; human?: ("continue" | "stop")[]; runCmd?: Gate; pre?: string[] } = {}) => {
  const calls: Call[] = [];
  let fills = 0, filled = false;
  const human = [...(o.human ?? [])];
  const view = (): View => ({ title: "予定", names: [...(filled ? ["題: 会議"] : ["題"]), ...(o.pre ?? [])] });
  const d: PressDeps = {
    act: async (app, tool, args) => {
      calls.push(["act", app, tool, args]);
      if (tool === "fill") { fills++; const g = o.fill?.(fills) ?? { ok: true, text: "ok" }; if (o.afterFill ?? g.ok) filled = true; return g; }
      return { ok: true, text: "ok" };
    },
    op: async (app, name, slots) => { calls.push(["op", app, name, slots]); return { ok: true, text: "ok" }; },
    runCmd: async (name) => { calls.push(["runCmd", name]); return o.runCmd ?? { ok: true, text: "exit 0" }; },
    api: async (site, op) => { calls.push(["api", site, op]); return { ok: true, text: "ok" }; },
    read: async (app) => { calls.push(["read", app]); return view(); },
    openTab: async (url) => { calls.push(["openTab", url]); return { ok: true, text: "opened" }; },
    askAgent: async (text) => { calls.push(["askAgent", text]); if (o.agentFixes) filled = true; return { ok: true, text: "済みました" }; },
    askHuman: async (s) => { calls.push(["askHuman", s.n, s.goal]); return human.shift() ?? "stop"; },
    now: () => 1000,
  };
  return { d, calls, gates: () => calls.filter((c) => ["act", "op", "runCmd", "api"].includes(c[0])) };
};
const receipts = () => readFileSync(join(home, "presses", "a1b2c3d4.runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("AC1: 3 段が同じ門で順に再生され、受領証 3 行（ok）・runs 1/1・値は受領証に無い", async () => {
  const p = mkPress(), f = fake();
  const r = await runPress(home, p, { title: "会議" }, f.d);
  expect(r).toMatchObject({ ok: true, clean: true, stopped: false });
  expect(f.gates()).toEqual([["runCmd", "sync"], ["act", "web", "fill", { field: "題", value: "会議" }], ["act", "web", "press_button", { name: "保存" }]]);
  expect(receipts().map((x) => [x.stage, x.result])).toEqual([[1, "ok"], [2, "ok"], [3, "ok"]]);
  expect(readFileSync(join(home, "presses", "a1b2c3d4.runs.jsonl"), "utf8")).not.toContain("会議");
  expect(statSync(join(home, "presses", "a1b2c3d4.runs.jsonl")).mode & 0o777).toBe(0o600);
  expect(readPress(home, p.id)!.runs).toMatchObject({ total: 1, clean: 1 });
});

test("AC2: 段 1 の前提が満たされていれば門を呼ばず skipped", async () => {
  const p = mkPress();
  p.stages[0] = { ...p.stages[0]!, pre: { kind: "elements", names: ["同期済み"] } };
  const f = fake({ pre: ["同期済み"] });
  const r = await runPress(home, p, { title: "会議" }, f.d);
  expect(r.ok).toBe(true);
  expect(f.calls.some((c) => c[0] === "runCmd")).toBe(false);
  expect(receipts()[0]).toMatchObject({ stage: 1, result: "skipped" });
});

test("AC3: 段 2 の結果が合わず、読んでも効いていない → 探し直しを 1 回 → healed・clean に数える", async () => {
  const p = mkPress(), f = fake({ afterFill: false, agentFixes: true });
  const r = await runPress(home, p, { title: "会議" }, f.d);
  expect(r).toMatchObject({ ok: true, clean: true });
  expect(f.calls.filter((c) => c[0] === "askAgent").length).toBe(1);
  expect(String(f.calls.find((c) => c[0] === "askAgent")![1])).toContain("段 2 の目的: web で欄に入力する");
  expect(String(f.calls.find((c) => c[0] === "askAgent")![1])).toContain("title=会議");
  expect(f.calls.some((c) => c[0] === "askHuman")).toBe(false);
  expect(receipts().map((x) => x.result)).toEqual(["ok", "healed", "ok"]);
  expect(readPress(home, p.id)!.runs).toMatchObject({ total: 1, clean: 1 });
});

test("AC4: 門が「結果不明」でも面を読んで済んでいれば打ち直さない（二重送信しない）", async () => {
  const p = mkPress(), f = fake({ fill: () => ({ ok: false, text: "結果不明" }), afterFill: true });
  const r = await runPress(home, p, { title: "会議" }, f.d);
  expect(r).toMatchObject({ ok: true, clean: true });
  expect(f.calls.filter((c) => c[0] === "act" && c[2] === "fill").length).toBe(1);
  expect(f.calls.some((c) => c[0] === "askAgent")).toBe(false);
  expect(receipts()[1]).toMatchObject({ stage: 2, result: "ok", note: "読み直すと済んでいた" });
});

test("AC5a: 探し直しでも駄目 → 人の card（段 2）→ やめる → stopped・clean は増えない・段 3 は走らない", async () => {
  const p = mkPress(), f = fake({ afterFill: false, human: ["stop"] });
  const r = await runPress(home, p, { title: "会議" }, f.d);
  expect(r).toMatchObject({ ok: true, clean: false, stopped: true });
  expect(f.calls.filter((c) => c[0] === "askHuman")).toEqual([["askHuman", 2, "web で欄に入力する"]]);
  expect(f.calls.some((c) => c[0] === "act" && c[2] === "press_button")).toBe(false);
  expect(receipts().map((x) => x.result)).toEqual(["ok", "stopped"]);
  expect(readPress(home, p.id)!.runs).toMatchObject({ total: 1, clean: 0 });
});

test("AC5b: 続ける → 段 2 の前提から再開し、前の段（runCmd）は再生しない", async () => {
  const p = mkPress(), f = fake({ afterFill: false });
  f.d.askHuman = async (s) => { f.calls.push(["askHuman", s.n, s.goal]); f.d.read = async () => ({ title: "予定", names: ["題: 会議"] }); return "continue"; }; // 人が面で直した
  const r = await runPress(home, p, { title: "会議" }, f.d);
  expect(r).toMatchObject({ ok: true, clean: false, stopped: false });
  expect(f.calls.filter((c) => c[0] === "runCmd").length).toBe(1);
  expect(receipts().map((x) => [x.stage, x.result])).toEqual([[1, "ok"], [2, "asked"], [2, "ok"], [3, "ok"]]);
  expect(readPress(home, p.id)!.runs).toMatchObject({ total: 1, clean: 0 });
});

test("AC6: 欄の幅の外・欠けた欄 → 段は 1 つも走らず ok: false", async () => {
  const p = mkPress({ fields: { title: { choice: ["会議", "昼"] } } }), f = fake();
  const r = await runPress(home, p, { title: "飲み会" }, f.d);
  expect(r).toEqual({ ok: false, hint: "「title」は次のどれかにしてください: 会議・昼" });
  expect(await runPress(home, p, {}, f.d)).toMatchObject({ ok: false });
  expect(f.calls).toEqual([]);
  expect(readPress(home, p.id)!.runs.total).toBe(0);
});

test("web の面が無い → 欄の url で開いて（openTab）もう 1 度だけ", async () => {
  const p = mkPress({ fields: { title: { ask: true }, url: { ask: true } } }), f = fake();
  let first = true;
  const orig = f.d.act;
  f.d.act = async (app, tool, args) => { if (first) { first = false; f.calls.push(["act-noface"]); return { ok: false, text: "面がありません", noFace: true }; } return orig(app, tool, args); };
  p.stages = p.stages.slice(1);
  const r = await runPress(home, p, { title: "会議", url: "https://calendar.example/" }, f.d);
  expect(r).toMatchObject({ ok: true, clean: true });
  expect(f.calls.filter((c) => c[0] === "openTab")).toEqual([["openTab", "https://calendar.example/"]]);
});
