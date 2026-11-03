// W65 holdout: SPEC-press（契約）と BRIEF-w61〜w64 の公開面だけから書いた検査。src/press*.ts は読んでいない。
// 実装に合わせて直す時は「契約が曖昧だった所」だけ（下の ASSUMED を見る）。落ちた時は、まず実装が契約を破っていないかを疑う。
//
// ASSUMED（契約に戻り値の形が無く、BRIEF の文から推した所）:
//  - runPress(home, p, deps) の「欄に渡す値」は deps.fields と 4 本目の引数の両方に置く（どちらでも拾える）
//    → review-press で実物に合わせた: 実物は runPress(home, p, given, deps)・read は View { title, names } | null（契約に形が無かった所だけ）
//  - importPress の拒否は throw か { ok: false } のどちらでもよい（refused() が両方拾う）
//  - cardText の戻りは { title, lines, steps: {who,text,state}[], detail } ・checkCardText は { ok, word? }
//  - runs.jsonl の 1 行 = { at, run, stage, result, note }（SPEC §4）・home は KANGAE_HOME そのもの
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { mktmp } from "./tmp.ts";
import { join } from "node:path";
import { extractPress, fixField, readPress, readPresses, savePress, validateFields } from "../src/press.ts";
import type { Check, FieldSpec, Press, Stage } from "../src/press.ts";
import { runPress } from "../src/press-run.ts";
import { exportPress, importPress, writeReceipt } from "../src/press-share.ts";
import { resolveRequirements } from "../src/press-env.ts";
import { cardText, checkCardText } from "../src/press-card.ts";

const mk = () => mktmp("pressho"); // 試験の temp は test/tmp.ts の mktmp を通す（tmpleak1 の許可表）
const none = { kind: "none" } as const;
const stage = (n: number, o: Partial<Stage> = {}): Stage => ({ n, kind: "op", goal: `手${n}`, post: none, way: { kind: "act", app: "Docs", tool: "click", args: {} }, ...o });
const mkPress = (o: Partial<Press> = {}): Press => ({
  v: 1, id: "abcd1234", name: "テスト", madeAt: 1, fields: {}, stages: [stage(1)], expect: { result: "x.done" }, onMismatch: "ask", limits: {}, runs: { total: 0, clean: 0 }, ...o,
});
const rec = (op: string, value = "", n = 0) => ({ at: 1000 + n, face: "f", app: "Docs", gen: 1, op, value, result: "ok", owner: "s:1" });
const rows = (home: string, id: string) => { const f = join(home, "presses", `${id}.runs.jsonl`); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
// 拒否は throw か ok:false のどちらでも
const refused = async (fn: () => unknown) => { try { const r: any = await fn(); return r === false || r == null ? true : r.ok === false; } catch { return true; } };

// 全部差し替える fake deps。呼び順は log に残る
function fakeDeps(o: { read?: () => string[]; askAgent?: () => void; human?: "continue" | "stop"; actDelay?: number } = {}) {
  const log: string[] = [];
  const d: any = {
    log,
    act: async (app: string, tool: string) => { log.push(`act:${tool}`); if (o.actDelay) await Bun.sleep(o.actDelay); return { ok: true, text: "ok" }; },
    op: async (_a: string, name: string) => { log.push(`op:${name}`); return { ok: true, text: "ok" }; },
    runCmd: async (name: string) => { log.push(`runCmd:${name}`); return { ok: true, text: "ok" }; },
    api: async () => { log.push("api"); return { ok: true, text: "ok" }; },
    read: async () => { log.push("read"); return { title: "", names: o.read ? o.read() : [] }; },
    openTab: async () => { log.push("openTab"); return { ok: true }; },
    askAgent: async () => { log.push("askAgent"); o.askAgent?.(); return { ok: true, text: "ok" }; },
    askHuman: async () => { log.push("askHuman"); return o.human ?? "stop"; },
    now: () => 5000,
  };
  return d;
}
const run = (home: string, p: Press, d: any, given: Record<string, string> = {}) => runPress(home, p, given, d);
const done: Check = { kind: "elements", names: ["done"] };

describe("store（§2）", () => {
  let home: string;
  beforeEach(() => { home = mk(); });
  test("保存 → 読み戻しが同じ・0600・壊れた file と空 file を飛ばして他は読める・無い id は空", () => {
    const p = mkPress({ id: "aaaa0001", fields: { q: { ask: true } } });
    savePress(home, p);
    expect(readPress(home, "aaaa0001")).toEqual(p);
    expect(statSync(join(home, "presses", "aaaa0001.json")).mode & 0o777).toBe(0o600);
    writeFileSync(join(home, "presses", "bad00001.json"), "{not json");
    writeFileSync(join(home, "presses", "empty001.json"), "");
    savePress(home, mkPress({ id: "aaaa0002" }));
    expect(readPresses(home).map((x) => x.id).sort()).toEqual(["aaaa0001", "aaaa0002"]);
    expect(readPress(home, "zzzz9999")).toBeFalsy();
    expect(readdirSync(join(home, "presses")).some((f) => f.endsWith(".tmp"))).toBe(false); // .tmp が残らない
  });
});

describe("validateFields（§2・幅の外は断る）", () => {
  const p = mkPress({ fields: { r: { range: ["b", "d"] }, n: { range: ["10", "20"] }, c: { choice: ["Red", "Blue"] }, a: { ask: true }, f: { fixed: "FIX" } } });
  const ok = { r: "b", n: "10", c: "Red", a: "x" };
  test("range の両端は含む・1 つ外は断る・数値は辞書順でなく大きさ（9 は 10..20 の外）", () => {
    for (const v of ["b", "c", "d"]) expect((validateFields(p, { ...ok, r: v }) as any).ok).toBe(true);
    for (const v of ["a", "e", "da"]) expect((validateFields(p, { ...ok, r: v }) as any).ok).toBe(false);
    for (const v of ["10", "15", "20"]) expect((validateFields(p, { ...ok, n: v }) as any).ok).toBe(true);
    for (const v of ["9", "21", "25"]) expect((validateFields(p, { ...ok, n: v }) as any).ok).toBe(false);
  });
  test("choice は一致だけ（大文字小文字・前後の空白・部分一致は断る）", () => {
    expect((validateFields(p, ok) as any).ok).toBe(true);
    for (const v of ["red", "RED", " Red", "Red ", "Re", "Redd", ""]) expect((validateFields(p, { ...ok, c: v }) as any).ok).toBe(false);
  });
  test("ask は空文字・欠けを断る・断る時は人向けの hint・fixed は given を無視して固定値", () => {
    for (const bad of [{ ...ok, a: "" }, (({ a, ...r }) => r)(ok)]) { const r: any = validateFields(p, bad as any); expect(r.ok).toBe(false); expect(typeof r.hint).toBe("string"); expect(r.hint.length).toBeGreaterThan(0); expect(r.hint).not.toMatch(/lease|token|gen\b/i); }
    const r: any = validateFields(p, { ...ok, f: "HACK" });
    expect(r.ok).toBe(true);
    expect(r.values.f).toBe("FIX");
  });
});

describe("extractPress / fixField（§3）", () => {
  const recs = [rec("open_app", "Docs", 0), rec("runCmd:build", "", 1), rec("draft:gift", "", 2), rec("fill", "SECRET-ONE", 3), rec("fill", "SECRET-TWO", 4), rec("press_button", "保存", 5)];
  test("env が先・op が後・draft は段にならない・値は欄に入れず ask・入れた値が保存物のどこにも無い", () => {
    const p: any = extractPress(recs as any, { owner: "s:1" });
    expect(p.stages.length).toBe(5);
    expect(p.stages.map((s: Stage) => s.kind)).toEqual(["env", "env", "op", "op", "op"]);
    expect(p.stages.map((s: Stage) => s.n)).toEqual([1, 2, 3, 4, 5]);
    const specs = Object.values(p.fields) as FieldSpec[];
    expect(specs.length).toBeGreaterThanOrEqual(1);
    expect(specs.length).toBeLessThanOrEqual(20);
    for (const s of specs) expect(s).toMatchObject({ ask: true });
    for (const k of Object.keys(p.fields)) expect(k).toMatch(/^[A-Za-z0-9_.-]{1,40}$/);
    const raw = JSON.stringify(p);
    expect(raw).not.toContain("SECRET-ONE");
    expect(raw).not.toContain("SECRET-TWO");
  });
  test("〈伏せ〉は ask のまま・fixField しても const にならない・伏せでない欄は固定にできる（負の対照）", () => {
    const hidden: any = extractPress([rec("open_app", "Docs", 0), rec("fill", "〈伏せ〉", 1), rec("fill", "公開の値", 2)] as any, { owner: "s:1" });
    const [secretName = "", openName] = Object.keys(hidden.fields);
    expect(secretName).toBeTruthy();
    const fixedSecret: any = fixField(hidden, secretName, "oops");
    expect(JSON.stringify(fixedSecret)).not.toContain("oops");
    expect((fixedSecret.fields?.[secretName] ?? hidden.fields[secretName])).toMatchObject({ ask: true });
    if (openName) { const f: any = fixField(hidden, openName, "公開の値"); expect(JSON.stringify(f)).toContain("公開の値"); }
  });
  test("名前は 60 字で切れ・制御文字と RTL が落ちる・500 字を超える固定値は断る", () => {
    const p: any = extractPress(recs as any, { owner: "s:1", name: `${"あ".repeat(100)}‮\u0007x` });
    expect(p.name.length).toBeLessThanOrEqual(60);
    expect(p.name).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    const q: any = extractPress([rec("fill", "v", 0)] as any, { owner: "s:1", name: "‮\u0000" });
    expect(typeof q.name).toBe("string"); // 全部落ちても壊れない
    expect(q.name).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    const name = Object.keys(p.fields)[0]!;
    let threw = false; let res: any;
    try { res = fixField(p, name, "x".repeat(501)); } catch { threw = true; }
    expect(threw || !JSON.stringify(res ?? {}).includes("x".repeat(501))).toBe(true);
  });
  test("記録が 21 件の fill でも欄は 20 個まで・名前は regex に合う", () => {
    const many = Array.from({ length: 21 }, (_, i) => rec("fill", `v${i}`, i));
    const p: any = extractPress(many as any, { owner: "s:1" });
    expect(Object.keys(p.fields).length).toBeLessThanOrEqual(20);
    for (const k of Object.keys(p.fields)) expect(k).toMatch(/^[A-Za-z0-9_.-]{1,40}$/);
  });
});

describe("runPress（§4・梯子）", () => {
  let home: string;
  beforeEach(() => { home = mk(); });
  const three = () => mkPress({ stages: [
    stage(1, { kind: "env", way: { kind: "runCmd", name: "build" } }),
    stage(2, { way: { kind: "act", app: "Docs", tool: "fill", args: {} } }),
    stage(3, { way: { kind: "act", app: "Docs", tool: "press_button", args: {} } }),
  ] });

  test("通し: 3 段が順に走り受領証 3 行 ok・runs.total=1 clean=1", async () => {
    const p = three(); savePress(home, p);
    const d = fakeDeps();
    await run(home, p, d);
    expect(d.log.filter((x: string) => /^(act|runCmd|op)/.test(x))).toEqual(["runCmd:build", "act:fill", "act:press_button"]);
    expect(rows(home, p.id).map((r) => r.result)).toEqual(["ok", "ok", "ok"]);
    expect(readPress(home, p.id)!.runs).toMatchObject({ total: 1, clean: 1 });
  });

  test("pre が満たされていれば way を呼ばず skipped", async () => {
    const p = mkPress({ stages: [stage(1, { pre: { kind: "elements", names: ["there"] } })] }); savePress(home, p);
    const d = fakeDeps({ read: () => ["there"] });
    await run(home, p, d);
    expect(d.log.some((x: string) => x.startsWith("act"))).toBe(false);
    expect(rows(home, p.id).map((r) => r.result)).toEqual(["skipped"]);
  });

  test("post が落ちても、面を読み直して効いていれば打ち直さない（二重送信なし）", async () => {
    const p = mkPress({ stages: [stage(1, { post: done })] }); savePress(home, p);
    let reads = 0;
    const d = fakeDeps({ read: () => (++reads >= 2 ? ["done"] : []) }); // 1 回目は遅れて未反映・2 回目で見える
    await run(home, p, d);
    expect(d.log.filter((x: string) => x.startsWith("act")).length).toBe(1);
    expect(rows(home, p.id).some((r) => r.result === "stopped")).toBe(false);
  });

  test("効いていなければ askAgent の 1 turn で healed・human は呼ばれない・clean に数える", async () => {
    const p = mkPress({ stages: [stage(1, { post: done })] }); savePress(home, p);
    let healed = false;
    const d = fakeDeps({ read: () => (healed ? ["done"] : []), askAgent: () => { healed = true; } });
    await run(home, p, d);
    expect(d.log.filter((x: string) => x === "askAgent").length).toBe(1);
    expect(d.log).not.toContain("askHuman");
    expect(rows(home, p.id).map((r) => r.result)).toContain("healed");
    expect(readPress(home, p.id)!.runs).toMatchObject({ total: 1, clean: 1 });
  });

  test("askAgent でも落ちたら askHuman・stop は stopped で clean は増えず total は増える", async () => {
    const p = mkPress({ stages: [stage(1, { post: done })] }); savePress(home, p);
    const d = fakeDeps({ read: () => [], human: "stop" });
    await run(home, p, d);
    expect(d.log.filter((x: string) => x === "askHuman").length).toBe(1);
    expect(rows(home, p.id).map((r) => r.result)).toContain("stopped");
    expect(readPress(home, p.id)!.runs).toMatchObject({ total: 1, clean: 0 });
  });

  test("continue は止まった段から再開・前の段は再生しない", async () => {
    const p = mkPress({ stages: [stage(1, { way: { kind: "act", app: "Docs", tool: "first", args: {} } }), stage(2, { way: { kind: "act", app: "Docs", tool: "second", args: {} }, post: done })] }); savePress(home, p);
    let humanSeen = false;
    const d = fakeDeps({ read: () => (humanSeen ? ["done"] : []), human: "continue" });
    const askHuman = d.askHuman; d.askHuman = async (c: unknown) => { humanSeen = true; return askHuman(c); };
    await run(home, p, d);
    expect(d.log.filter((x: string) => x === "act:first").length).toBe(1);
    expect(d.log.filter((x: string) => x === "act:second").length).toBeGreaterThanOrEqual(1);
    expect(rows(home, p.id).some((r) => r.stage === 2 && r.result === "ok")).toBe(true);
  });

  test("幅の外の値なら段が 1 つも走らず・受領証に ok が無い（deps は 0 回）", async () => {
    const p = mkPress({ fields: { who: { choice: ["a", "b"] } }, stages: [stage(1, { way: { kind: "act", app: "Docs", tool: "fill", args: { text: { field: "who" } } } })] }); savePress(home, p);
    const d = fakeDeps();
    await run(home, p, d, { who: "zzz" });
    expect(d.log).toEqual([]);
    expect(rows(home, p.id).some((r) => r.result === "ok")).toBe(false);
  });

  test("受領証にも press の file にも、欄に入れた値は残らない（0600）", async () => {
    const p = mkPress({ fields: { memo: { ask: true } }, stages: [stage(1, { way: { kind: "act", app: "Docs", tool: "fill", args: { text: { field: "memo" } } } })] }); savePress(home, p);
    await run(home, p, fakeDeps(), { memo: "VALUE-MUST-NOT-LEAK-777" });
    const dir = join(home, "presses");
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8")).not.toContain("VALUE-MUST-NOT-LEAK-777");
    expect(statSync(join(dir, `${p.id}.runs.jsonl`)).mode & 0o777).toBe(0o600);
  });

  test("並行: 同じ press を 2 本同時に走らせても受領証の行が混ざらず（全行が JSON）・total が 2", async () => {
    const p = three(); savePress(home, p);
    const a = fakeDeps({ actDelay: 3 }), b = fakeDeps({ actDelay: 1 });
    await Promise.all([run(home, p, a), run(home, p, b)]);
    const raw = readFileSync(join(home, "presses", `${p.id}.runs.jsonl`), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(6);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    const byRun = new Map<unknown, number>();
    for (const l of lines) { const r = JSON.parse(l).run; byRun.set(r, (byRun.get(r) ?? 0) + 1); }
    expect([...byRun.values()]).toEqual([3, 3]); // run が 2 つに分かれ、それぞれ 3 段
    expect(readPress(home, p.id)!.runs.total).toBe(2); // 読んで足して書く間に 1 つ消えない
  });
});

describe("exportPress / importPress（§5）", () => {
  const envOk: any = { exists: () => true, which: () => "/x", extensionConnected: () => true, appInstalled: () => true, cmds: ["build"] };
  let home: string, other: string, file: string;
  const sample = () => mkPress({ id: "feed0001", name: "共有する物", fields: { memo: { ask: true, label: "メモ" }, mode: { fixed: "FIXEDVAL" } }, runs: { total: 7, clean: 5, lastAt: 99 }, stages: [stage(1, { goal: "メモを書く", way: { kind: "act", app: "Docs", tool: "fill", args: { text: { field: "memo" }, m: { const: "CONSTVAL" } } } })] });
  beforeEach(async () => { home = mk(); other = mk(); savePress(home, sample()); file = join(mk(), "x.kangae-press.json"); await exportPress(home, "feed0001", file); });
  const edit = (f: (j: any) => void) => { const j = JSON.parse(readFileSync(file, "utf8")); f(j); const out = join(mk(), "t.kangae-press.json"); writeFileSync(out, JSON.stringify(j)); return out; };

  test("書き出し: { press, sig, pub }・runs は 0・const だけ値を持つ・madeBy.fp が付く・鍵は 0600", () => {
    const j = JSON.parse(readFileSync(file, "utf8"));
    expect(j.sig).toBeTruthy(); expect(j.pub).toBeTruthy();
    expect(j.press.runs).toMatchObject({ total: 0, clean: 0 });
    expect(j.press.madeBy.fp).toMatch(/\S{8,}/);
    expect(j.press.fields.memo).toEqual({ ask: true, label: "メモ" });
    expect(readFileSync(file, "utf8")).toContain("CONSTVAL");
    expect(statSync(join(home, "press-keys.json")).mode & 0o777).toBe(0o600);
  });
  test("別の home に読み込める・madeBy.fp が送り手の指紋・保存される", async () => {
    await importPress(other, file, envOk);
    const got = readPresses(other);
    expect(got.length).toBe(1);
    expect(got[0]!.madeBy?.fp).toBe(JSON.parse(readFileSync(file, "utf8")).press.madeBy.fp);
    expect(got[0]!.runs).toMatchObject({ total: 0, clean: 0 });
  });
  test("press の 1 字・sig の 1 字・pub の 1 字・press の欄の追加を変えると断り、何も保存しない（armed）", async () => {
    const flip = (s: string) => (s[0] === "a" ? "b" : "a") + s.slice(1);
    const cases = [
      edit((j) => { j.press.name = j.press.name + "!"; }),
      edit((j) => { j.sig = flip(j.sig); }),
      edit((j) => { j.pub = flip(j.pub); }),
      edit((j) => { j.press.limits = { maxRuns: 9999 }; }),
    ];
    for (const c of cases) { expect(await refused(() => importPress(other, c, envOk))).toBe(true); }
    expect(readPresses(other).length).toBe(0);
    expect(await refused(() => importPress(other, join(mk(), "nope.json"), envOk))).toBe(true);
    const junk = join(mk(), "junk.kangae-press.json"); writeFileSync(junk, "not json at all");
    expect(await refused(() => importPress(other, junk, envOk))).toBe(true);
    expect(readPresses(other).length).toBe(0);
  });
  test("受領証: pressId・runs・from があり、欄の値は無い", async () => {
    const out = join(mk(), "r.receipt.json");
    await writeReceipt(home, "feed0001", out);
    const r = JSON.parse(readFileSync(out, "utf8"));
    expect(r.pressId).toBe("feed0001");
    expect(r).toHaveProperty("runs"); expect(r).toHaveProperty("from");
    expect(readFileSync(out, "utf8")).not.toMatch(/FIXEDVAL|CONSTVAL/);
  });
});

describe("resolveRequirements（§5）", () => {
  const deps = (o: any = {}) => ({ exists: (p: string) => /\/brew$/.test(p), which: () => null, extensionConnected: () => false, appInstalled: () => false, cmds: [] as string[], ...o });
  test("brew だけ在る → missing は adb と login の 2 行（人向けの文）", () => {
    const r: any = resolveRequirements(["brew", "adb", "login:calendar.google.com"], deps());
    expect(r.ok).toEqual(["brew"]);
    expect(r.missing.map((m: any) => m.req).sort()).toEqual(["adb", "login:calendar.google.com"]);
    for (const m of r.missing) { expect(m.line.length).toBeGreaterThan(3); expect(m.line).not.toMatch(/lease|token|\bgen\b/i); }
    expect(r.missing.find((m: any) => m.req.startsWith("login:")).line).toContain("calendar.google.com");
  });
  test("login: は他が全部在っても常に missing・空の requires は ok・cmd: は登録 command に在る時だけ ok", () => {
    const all = deps({ exists: () => true, which: () => "/bin/x", extensionConnected: () => true, appInstalled: () => true, cmds: ["scrcpy-build"] });
    expect((resolveRequirements(["login:a.example"], all) as any).missing.length).toBe(1);
    const e: any = resolveRequirements([], deps()); expect(e.missing).toEqual([]);
    expect((resolveRequirements(["cmd:scrcpy-build"], all) as any).missing).toEqual([]);
    expect((resolveRequirements(["cmd:scrcpy-build"], deps()) as any).missing.length).toBe(1);
    expect((resolveRequirements(["chromium-ext"], deps()) as any).missing.length).toBe(1);
  });
});

describe("cardText / checkCardText（§5・非エンジニアが読める）", () => {
  const BANNED = ["adb", "pairing", "ペアリング", "IP", "port", "ポート", "build", "ビルド", "ワイヤレスデバッグ", "アカウント", "token", "cookie", "sandbox", "CDP", "DOM", "AX", "lease", "gen", "worktree", "commit"];
  const mkCard = (o: any = {}) => ({ title: "予定を足す", lines: ["Google カレンダーに予定を足します"], steps: [{ who: "agent", text: "予定を足す", state: "wait" }], detail: [], ...o });
  const resolved: any = { ok: [], missing: [] };
  test("禁止語は title・lines・steps のどこにあっても赤・detail には在ってよい（armed）", () => {
    expect((checkCardText(mkCard() as any) as any).ok).toBe(true);
    for (const w of BANNED) {
      expect((checkCardText(mkCard({ title: `${w} を使う` }) as any) as any).ok).toBe(false);
      expect((checkCardText(mkCard({ lines: [`前置き ${w} 後ろ`] }) as any) as any).ok).toBe(false);
      expect((checkCardText(mkCard({ steps: [{ who: "you", text: `${w} を押す`, state: "now" }] }) as any) as any).ok).toBe(false);
      expect((checkCardText(mkCard({ detail: [`${w} の詳細`] }) as any) as any).ok).toBe(true);
    }
  });
  test("goal に技術語が入っても、主画面に出る時は checkCardText が赤・出ない時は主画面に無い（両者が食い違わない）", () => {
    const p = mkPress({ stages: [stage(1, { goal: "adb で携帯の cookie と token を読む" })] });
    const c: any = cardText(p, resolved);
    const main = JSON.stringify([c.title, c.lines, c.steps]);
    const check: any = checkCardText(c);
    expect(check.ok === false || !/adb|cookie|token/.test(main)).toBe(true);
  });
  test("制御文字・RTL は card のどこにも残らない", () => {
    const p = mkPress({ name: "名‮前\u0007", stages: [stage(1, { goal: "予定‮を\u0000足す​" })] });
    const c: any = cardText(p, resolved);
    expect(JSON.stringify(c)).not.toMatch(/[‮\u0007\u0000​]/);
    expect(JSON.stringify([c.title, ...c.lines, ...c.steps.map((s: any) => s.text), ...c.detail])).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });
  test("あなたの step（ask の欄・login）と agent の step が分かれる・ask も login も無ければ「あなた」は無い", () => {
    const p = mkPress({ fields: { memo: { ask: true } }, stages: [stage(1, { goal: "開く" }), stage(2, { goal: "書く", way: { kind: "act", app: "Docs", tool: "fill", args: { t: { field: "memo" } } } })] });
    const c: any = cardText(p, { ok: [], missing: [{ req: "login:calendar.google.com", line: "calendar.google.com にログインした tab が要ります" }] });
    const who = c.steps.map((s: any) => s.who);
    expect(who).toContain("you"); expect(who).toContain("agent");
    for (const s of c.steps) expect(["done", "now", "wait", "stopped"]).toContain(s.state);
    const plain: any = cardText(mkPress({ stages: [stage(1), stage(2)] }), resolved);
    expect(plain.steps.map((s: any) => s.who)).not.toContain("you");
  });
});
