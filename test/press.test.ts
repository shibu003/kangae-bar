import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mktmp } from "./tmp";
import { join } from "node:path";
import { bumpRuns, extractPress, fixField, pressLine, readPress, readPresses, rmPress, savePress, validateFields, type AimedRecord, type Press } from "../src/press";
import { makeAims } from "../src/press-cli";
import { runPress } from "../src/press-run";
import type { OpRecord } from "../src/lease";

const rec = (op: string, value = "", extra: Partial<OpRecord> = {}): OpRecord => ({ at: 1, face: "f", app: "Calendar", gen: 1, op, value, result: "ok", owner: "s:1", ...extra });
const five = [rec("open_app"), rec("fill", "会議"), rec("runCmd:build"), rec("fill", "10:00"), rec("press_button", "保存")];
const home = () => mktmp("kangae-press");

describe("W61 press", () => {
  test("AC1: 5 件 → 段 5・env が先 2 つ・op が後 3 つ・欄は fill の 2 つが ask", () => {
    const p = extractPress(five, { owner: "s:1" });
    expect(p.stages.map((s) => s.kind)).toEqual(["env", "env", "op", "op", "op"]);
    expect(p.stages.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
    expect(Object.values(p.fields)).toEqual([{ ask: true }, { ask: true }]);
    expect(JSON.stringify(p)).not.toContain("会議"); // 入れた値は持たない
  });

  test("AC2: 〈伏せ〉は ask のまま fixField しても const にならない（負の対照: 伏せでない欄は const）", () => {
    const p = extractPress([rec("fill", "〈伏せ〉"), rec("fill", "x")], { owner: "s:1" });
    const [secret, plain] = Object.keys(p.fields) as [string, string];
    const a = fixField(p, secret, "pw");
    expect(a.fields[secret]).toEqual({ ask: true });
    expect(JSON.stringify(a.stages)).not.toContain("const");
    const b = fixField(p, plain, "固定値");
    expect(b.fields[plain]).toEqual({ fixed: "固定値" });
    expect(JSON.stringify(b.stages)).toContain('"const":"固定値"');
    expect(fixField(p, plain, "x".repeat(501))).toBe(p);
    expect(fixField(p, plain, "a‮b")).toBe(p);
  });

  test("AC3: draft:* は段にならない", () => {
    expect(extractPress([rec("draft:gift"), rec("fill", "a"), rec("draft:x")], { owner: "s:1" }).stages).toHaveLength(1);
  });

  test("AC4: 保存 → 読み戻し・0600・壊れた JSON は飛ばす・id が不正なら触らない", () => {
    const h = home();
    const p = extractPress(five, { owner: "s:1" });
    const q = extractPress([rec("fill", "b")], { owner: "s:1" });
    expect(savePress(h, p) && savePress(h, q)).toBe(true);
    expect(readPress(h, p.id)).toEqual(p);
    expect(statSync(join(h, "presses", `${p.id}.json`)).mode & 0o777).toBe(0o600);
    writeFileSync(join(h, "presses", "deadbeef.json"), "{broken");
    expect(readPresses(h).map((x) => x.id).sort()).toEqual([p.id, q.id].sort());
    expect(readPress(h, "../../x")).toBeNull();
    expect(savePress(h, { ...p, id: "../evil" })).toBe(false);
    expect(rmPress(h, p.id)).toBe(true);
    expect(readPress(h, p.id)).toBeNull();
    expect(bumpRuns(h, q.id, true, 5)?.runs).toEqual({ total: 1, clean: 1, lastAt: 5 });
    expect(bumpRuns(h, q.id, false, 6)?.runs).toEqual({ total: 2, clean: 1, lastAt: 6 });
    expect(readPress(h, q.id)!.runs.total).toBe(2);
    expect(JSON.parse(readFileSync(join(h, "presses", `${q.id}.json`), "utf8")).v).toBe(1);
  });

  test("AC5: validateFields — range の外・choice に無い・ask が空 → 断る。中なら values", () => {
    const base = extractPress([rec("fill", "a")], { owner: "s:1" });
    const p: Press = { ...base, fields: { n: { range: ["1", "10"] }, w: { range: ["b", "d"] }, c: { choice: ["x", "y"] }, a: { ask: true }, f: { fixed: "F" } } };
    const ok = { n: "10", w: "c", c: "x", a: "hi", f: "ignored" };
    expect(validateFields(p, ok)).toEqual({ ok: true, values: { n: "10", w: "c", c: "x", a: "hi", f: "F" } });
    expect(validateFields(p, { ...ok, n: "1" }).ok).toBe(true); // 端は中
    expect(validateFields(p, { ...ok, n: "11" }).ok).toBe(false);
    expect(validateFields(p, { ...ok, n: "9x" }).ok).toBe(false);
    expect(validateFields(p, { ...ok, n: "2" }).ok).toBe(true); // 数値（辞書順なら "2" > "10"）
    expect(validateFields(p, { ...ok, w: "e" }).ok).toBe(false);
    expect(validateFields(p, { ...ok, c: "z" }).ok).toBe(false);
    expect(validateFields(p, { ...ok, a: "  " }).ok).toBe(false);
    expect(validateFields(p, { ...ok, a: undefined as any }).ok).toBe(false);
    const { n: _n, ...noN } = ok;
    const r = validateFields(p, noN);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.hint).toContain("n");
  });

  test("AC6: 名前は 60 字・制御文字を落とす・regex に合わない op は欄にしない", () => {
    const p = extractPress(five, { owner: "s:1", name: "‮" + "あ".repeat(80) + "\u0007" });
    expect(p.name).toBe("あ".repeat(60));
    const q = extractPress([rec("fill あ", "v"), rec("fill", "v")], { owner: "s:1" });
    expect(q.stages).toHaveLength(2);
    expect(Object.keys(q.fields)).toHaveLength(1);
    for (const k of Object.keys(q.fields)) expect(/^[A-Za-z0-9_.-]{1,40}$/.test(k)).toBe(true);
    const many = extractPress(Array.from({ length: 25 }, () => rec("fill", "v")), { owner: "s:1" });
    expect(Object.keys(many.fields)).toHaveLength(20);
    expect(extractPress([rec("fill", "v", { owner: "s:2" })], { owner: "s:1" }).stages).toHaveLength(0);
  });

  test("AC7: pressLine に内部語が無い", () => {
    const line = pressLine({ ...extractPress(five, { owner: "s:1" }), runs: { total: 4, clean: 3 } });
    expect(line).toContain("3/4");
    expect(line).not.toMatch(/lease|gen|token/i);
    expect(pressLine(extractPress(five, { owner: "s:1" }))).not.toMatch(/lease|gen|token/i);
  });
});

// W72 AC2: 記録の「的」（常駐の makeAims が act の args から足す）→ extract が way.args の { const } / { field } に落とす → runPress が同じ門で通す
test("W72 AC2: 的（fill の欄名・press_button の名前・click の要素）が way.args に残り、runPress は探し直さずに通る（負の対照: 的が無いと askAgent に落ちる）", async () => {
  const aims = makeAims(), recs: AimedRecord[] = [], tok = "tab:9|3|s:1";
  const gate = { act: async (_t: string, tool: string, args: Record<string, unknown>) => {
    const r = tool === "get_window_state" ? { ok: true, isError: false, text: "snapshot s1 / 要素 2\ne1\tButton\t送信\ne2\ttextbox\t秘密の値" } : { ok: true, isError: false, text: "ok" };
    recs.push(aims.tag({ at: 1, face: "tab:9", app: "Chrome", gen: 3, op: tool, value: String(args.value ?? (tool === "press_button" ? JSON.stringify({ name: args.name }) : "{}")), result: "ok", owner: "s:1" }));
    return r;
  } };
  await aims.act(gate, tok, "get_window_state", {});
  await aims.act(gate, tok, "fill", { field: "メモ", value: "秘密の値" });
  await aims.act(gate, tok, "press_button", { name: "保存" });
  await aims.act(gate, tok, "click", { element_token: "e1" });
  await aims.act(gate, tok, "click", { element_token: "e2" }); // 欄（button 類でない）: 名前を取らない＝値を名前と取り違えない
  const p = extractPress(recs, { owner: "s:1" });
  const field = Object.keys(p.fields)[0]!;
  expect(p.stages.slice(1).map((s) => s.way.kind === "act" && s.way.args)).toEqual([{ value: { field }, field: { const: "メモ" } }, { name: { const: "保存" } }, { element_token: { const: "e1" } }, { element_token: { const: "e2" } }]);
  expect(p.fields[field]).toEqual({ ask: true, label: "メモ" });
  expect(p.stages[3]!.goal).toBe("Chromeで押す（送信）");
  expect(JSON.stringify(p)).not.toContain("秘密の値"); // 値そのものは入れない

  const run = async (q: Press) => {
    const acted: [string, Record<string, string>][] = []; let healed = 0;
    const out = await runPress(home(), q, { [field]: "二度目" }, {
      act: async (_a, tool, args) => { acted.push([tool, args]); const ok = tool === "fill" ? !!args.field && !!args.value : tool === "press_button" ? !!args.name : !!args.element_token; return { ok, text: ok ? "ok" : "field を渡してください" }; }, // 門の振る舞い（web.js: 名前が無ければ断る）
      op: async () => ({ ok: false, text: "" }), runCmd: async () => ({ ok: false, text: "" }), api: async () => ({ ok: false, text: "" }), read: async () => null, openTab: async () => ({ ok: false, text: "" }),
      askAgent: async () => { healed++; return { ok: true, text: "済" }; }, askHuman: async () => "stop", now: () => 1,
    });
    return { out, acted, healed };
  };
  const ok = await run({ ...p, stages: p.stages.slice(1, 3) });
  expect(ok.healed).toBe(0);
  expect(ok.acted).toEqual([["fill", { value: "二度目", field: "メモ" }], ["press_button", { name: "保存" }]]);
  expect(ok.out).toMatchObject({ ok: true, clean: true });
  const blind = extractPress(recs.map(({ target: _t, el: _e, ...r }) => r), { owner: "s:1" }); // 負の対照: 的を落とす
  const bad = await run({ ...blind, stages: blind.stages.slice(1, 3) });
  expect(bad.healed).toBe(2);
});

test("W72: op:<app>/<name> と api:<site>/<op> の記録は way.op / way.api になる（欄は記録の名前・既定は聞く）", () => {
  const p = extractPress([rec("op:Calendar/add", "title,day"), rec("api:github.com/issues", "q")], { owner: "s:1" });
  expect(p.stages.map((s) => s.way)).toEqual([
    { kind: "op", app: "Calendar", name: "add", slots: { title: { field: "title_1" }, day: { field: "day_1" } } },
    { kind: "api", site: "github.com", op: "issues", params: { q: { field: "q_2" } } },
  ]);
  expect(p.fields).toEqual({ title_1: { ask: true, label: "title" }, day_1: { ask: true, label: "day" }, q_2: { ask: true, label: "q" } });
});
