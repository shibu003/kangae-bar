// W48（EXP-1 A の物差し）: ER_Triage_GUI の csv の形と priority の規則を、実物の読み（docs/verify/w48/ER_TRIAGE.md の file:line）どおりに写した物差し（test/er-triage-oracle.ts）の検査。通しの試験は W48b（test/w48b.test.ts）
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addCmd } from "../src/cmds.ts";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { HEADER, assignPriority, csvEscape, loadCsv, parseCsvLine, rowsFor, type P } from "./er-triage-oracle.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000);

let top: string, ui: string, work: string, proj: string;
const A = { pid: 10, windowId: 1, app: "Zed", title: "" };
const driver = (): Driver => ({ call: async (tool) => ({ text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }), close() {} });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const mk = () => makeLeases(join(top, "lease"), { driver, defaultMode: "allow", approvalMs: 4000 });
const ctx = () => ({ uiHome: ui, workDir: work });
const reg = (name: string, argv: string[]) => { const r = addCmd(ui, name, proj, argv); if (!r.ok) throw new Error(r.hint); return r.cmd; };
const yes = async (L: ReturnType<typeof mk>) => { for (let i = 0; i < 300 && !L.approvals().length; i++) await tick(); L.answer(L.approvals()[0]!.id, true, true); };

beforeEach(() => {
  top = realpathSync(mktmp("w48"));
  ui = join(top, "ui"); work = join(top, "work"); proj = join(top, "ER_Triage_GUI");
  for (const d of [ui, work, proj, join(top, "lease"), join(proj, "src")]) mkdirSync(d);
  writeFileSync(join(proj, "data.csv"), "uinfiuwnfun nweifnini  fjnienfi"); // 実物と同じ: 患者の行が 0 で header でもない 1 行
});
afterEach(() => rmSync(top, { recursive: true, force: true }));

const THREE: P[] = [
  { name: "山田 太郎", age: 80, symptoms: "転倒 腰痛", painLevel: 5 },          // age >= 75 → Medium
  { name: "Ann \"A\" Lee", age: 30, symptoms: "chest tightness", painLevel: 4, chestPain: true }, // High（引用符と , を含む）
  { name: "佐藤", age: 25, symptoms: "のどの痛み", painLevel: 2 },                // Low
];

test("W48 規則: priority は読んだ規則どおり（境界: pain 9 / 6・age 1 / 2 / 74 / 75・各 flag）・csv は引用符の欄を往復できる", () => {
  const p = (o: Partial<P>): P => ({ name: "x", age: 30, symptoms: "s", painLevel: 0, ...o });
  expect(assignPriority(p({ painLevel: 9 }))).toBe("High");
  expect(assignPriority(p({ painLevel: 8 }))).toBe("Medium"); // 6 以上 9 未満
  expect(assignPriority(p({ painLevel: 6 }))).toBe("Medium");
  expect(assignPriority(p({ painLevel: 5 }))).toBe("Low");
  expect([1, 2, 74, 75].map((age) => assignPriority(p({ age })))).toEqual(["Medium", "Low", "Low", "Medium"]);
  for (const f of ["chestPain", "breathingTrouble", "heavyBleeding", "unconsciousOrConfused"] as const) expect(assignPriority(p({ [f]: true }))).toBe("High");
  expect(assignPriority(p({ severePain: true }))).toBe("Medium");
  expect(parseCsvLine(`1,${csvEscape('a,"b"')},3`)).toEqual(["1", 'a,"b"', "3"]);
});

test("W48 壊れた行は app が全体を断る（12 欄でない・数でない）: 実物と同じ失敗を、足す側が先に検出できる", async () => {
  expect(loadCsv(`${HEADER}\n1,a,3,s,1,0,0,0,0,0,Low\n`)).toMatchObject({ ok: false, error: expect.stringContaining("12 fields") });
  expect(loadCsv(`${HEADER}\n1,a,x,s,1,0,0,0,0,0,Low,1\n`)).toMatchObject({ ok: false, error: expect.stringContaining("invalid") });
  expect(() => rowsFor(`${HEADER}\nbad\n`, THREE)).toThrow();
  // 続き番号: 既に 2 人いれば 3 から
  const two = rowsFor("x", THREE.slice(0, 2));
  const three = rowsFor(two, THREE.slice(2));
  expect((loadCsv(three) as any).patients.map((p: any) => p.id).sort()).toEqual([1, 2, 3]);
  expect((loadCsv(three) as any).patients.map((p: any) => p.arrivalOrder).sort()).toEqual([1, 2, 3]);
});

// 物差しが実物とずれていないか: 実物（あれば）の規則の行が、写した規則と同じ語を持つ（実物が無い環境では何も言わない）
const REAL = join(process.env.HOME ?? "", "Downloads/ER_Triage_GUI/src/triage_core.hpp");
test.skipIf(!existsSync(REAL))("W48 物差し: 実物の triage_core.hpp の規則（priority の条件・12 欄・header の読み飛ばし）が写しと同じ語を持つ", () => {
  const src = readFileSync(REAL, "utf8");
  for (const w of ["patient.unconsciousOrConfused || patient.breathingTrouble || patient.chestPain", "patient.heavyBleeding || patient.painLevel >= 9", "patient.severePain || patient.painLevel >= 6 || patient.age < 2 || patient.age >= 75", "fields.size() != 12", "std::getline(input, line); // header", HEADER]) expect(src.replace(/\s+/g, " ").replace(/" "/g, "")).toContain(w.replace(/\s+/g, " "));
});
