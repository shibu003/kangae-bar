// W48b: priority を agent が書かない（triage_core の規則を使う登録 command が出す）・app は起動引数 --load の時だけ csv を読む。
// 偽の folder は実物の triage_core.hpp（test/fixtures/er-triage/）を C++ で本当に build する（clang++）。実 ImGui・実 cmake は実験役
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addCmd } from "../src/cmds.ts";
import { mktmp } from "./tmp.ts";
import { makeLeases, type Driver } from "../src/lease.ts";
import { assignPriority, loadCsv, type P } from "./er-triage-oracle.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(240_000);

const FX = join(import.meta.dir, "fixtures", "er-triage");
const ADD_HEADER = "name,age,symptoms,painLevel,chestPain,breathingTrouble,heavyBleeding,unconsciousOrConfused,severePain";
let top: string, ui: string, work: string, proj: string, calls: string[];
const driver = (): Driver => ({ call: async (tool) => { calls.push(tool); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }; }, close() {} });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const ctx = () => ({ uiHome: ui, workDir: work });
const reg = (name: string, argv: string[]) => { const r = addCmd(ui, name, proj, argv); if (!r.ok) throw new Error(r.hint); };
let L: ReturnType<typeof makeLeases>;
const run = async (name: string) => { const p = L.runCmd("s:1", name, ctx()); for (let i = 0; i < 300 && !L.approvals().length; i++) await tick(); L.answer(L.approvals()[0]!.id, true, true); const r = await p; return { r, text: r.ok ? r.text : "" }; };
const data = () => readFileSync(join(proj, "data.csv"), "utf8");
const rows = (ps: P[]) => ps.map((p) => [csvq(p.name), p.age, csvq(p.symptoms), p.painLevel, +!!p.chestPain, +!!p.breathingTrouble, +!!p.heavyBleeding, +!!p.unconsciousOrConfused, +!!p.severePain].join(",")).join("\n");
const csvq = (v: string) => (/[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const writeAdd = (ps: P[], header = ADD_HEADER) => writeFileSync(join(proj, "add_patients.csv"), `${header}\n${rows(ps)}\n`);

const THREE: P[] = [
  { name: "山田 太郎", age: 80, symptoms: "転倒 腰痛", painLevel: 5 },
  { name: 'Ann "A" Lee', age: 30, symptoms: "chest tightness, since morning", painLevel: 4, chestPain: true },
  { name: "佐藤", age: 25, symptoms: "のどの痛み", painLevel: 2 },
];

beforeEach(async () => {
  calls = [];
  top = realpathSync(mktmp("w48b"));
  ui = join(top, "ui"); work = join(top, "work"); proj = join(top, "ER_Triage_GUI");
  for (const d of [ui, work, proj, join(top, "lease"), join(proj, "src")]) mkdirSync(d);
  for (const f of ["triage_core.hpp", "er_triage_add.cpp", "app_stub.cpp"]) copyFileSync(join(FX, f), join(proj, "src", f));
  writeFileSync(join(proj, "data.csv"), "uinfiuwnfun nweifnini  fjnienfi"); // 実物と同じ: 患者の行が 0 の 1 行
  writeFileSync(join(proj, "build.sh"), `mkdir -p build
/usr/bin/clang++ -std=c++17 -Isrc -o build/er_triage_add src/er_triage_add.cpp || exit 1
/usr/bin/clang++ -std=c++17 -Isrc -o build/er_app src/app_stub.cpp || exit 1
`);
  reg("build", ["/bin/sh", "build.sh"]);
  L = makeLeases(join(top, "lease"), { driver, defaultMode: "allow", approvalMs: 4000 });
  if (!L.give({ pid: 10, windowId: 1, app: "Zed", title: "" }, "s:1").ok) throw new Error();
  const b = await run("build");
  if (!b.r.ok) throw new Error(JSON.stringify(b.r));
  // 登録は実行 file が在る時だけ通る＝build の後に人が登録する（agent は登録できない）
  reg("er-triage-add", [join(proj, "build/er_triage_add")]);
  reg("app", [join(proj, "build/er_app"), "--load", "data.csv"]); // launch の登録: 起動引数つき
  reg("app-plain", [join(proj, "build/er_app")]);                  // 人が普通に起こした時（引数なし）
});
afterEach(() => rmSync(top, { recursive: true, force: true }));

test("W48b 通し: build → agent は素の値だけを add_patients.csv に書く → run er-triage-add が規則で priority を出して data.csv へ → --load で起こした app に 3 人（画面操作 0）", async () => {
  expect(existsSync(join(proj, "build/er_triage_add"))).toBe(true);
  writeAdd(THREE);
  const a = await run("er-triage-add");
  expect(a.r).toMatchObject({ ok: true });
  expect(a.text).toContain("saved: 3 patients");
  expect(existsSync(join(proj, "add_patients.csv"))).toBe(false); // 入力は使い切って消える（二重に足さない）
  const loaded = loadCsv(data());
  expect(loaded.ok).toBe(true);
  const got = (loaded as any).patients as { id: number; name: string; priority: string; arrivalOrder: number }[];
  expect(got.map((p) => [p.name, p.priority])).toEqual([['Ann "A" Lee', "High"], ["山田 太郎", "Medium"], ["佐藤", "Low"]]); // 実物の triage_core が出した priority と並び
  for (const p of THREE) expect(got.find((x) => x.name === p.name)!.priority).toBe(assignPriority(p)); // 写し（物差し）と一致
  expect(got.map((p) => p.id).sort()).toEqual([1, 2, 3]);
  const s = await run("app");
  expect(s.text).toContain("waiting: 3");
  expect(s.text).toContain("patient: Ann \"A\" Lee / High");
  expect(s.text.indexOf("Ann")).toBeLessThan(s.text.indexOf("山田"));
  expect(s.text.indexOf("山田")).toBeLessThan(s.text.indexOf("佐藤"));
  expect(calls.filter((t) => ["click", "type_text", "set_value", "press_key", "hotkey", "drag"].includes(t))).toEqual([]);
});

test("W48b 引数なしでは読まない: 人が普通に起こした時（--load 無し）の app は data.csv に患者が居ても 0 人のまま", async () => {
  writeAdd(THREE);
  await run("er-triage-add");
  const s = await run("app-plain");
  expect(s.text).toContain("waiting: 0");
  expect(s.text).not.toContain("patient:");
  // --load の csv が壊れていても app は落ちず、理由を出して 0 人
  writeFileSync(join(proj, "data.csv"), `header\n1,a,3,s\n`);
  const bad = await run("app");
  expect(bad.text).toContain("toast: CSV row 2 does not have 12 fields.");
  expect(bad.text).toContain("waiting: 0");
});

test("W48b priority を agent が書く道が無い: priority / id / arrivalOrder の欄を持つ入力は header で断り data.csv は 1 byte も変わらない・不正な値が 1 行でもあれば全体を断る", async () => {
  writeAdd(THREE);
  await run("er-triage-add");
  const before = data();
  for (const [header, body] of [
    [`${ADD_HEADER},priority`, "x,30,s,1,0,0,0,0,0,Low"],
    ["id,name,age,symptoms,painLevel,chestPain,breathingTrouble,heavyBleeding,unconsciousOrConfused,severePain,priority,arrivalOrder", "9,x,30,s,1,0,0,0,0,0,Low,9"],
    [ADD_HEADER, "x,200,s,1,0,0,0,0,0"],      // age
    [ADD_HEADER, "x,30,s,11,0,0,0,0,0"],      // pain
    [ADD_HEADER, "x,30,s,1,2,0,0,0,0"],       // flag
    [ADD_HEADER, ",30,s,1,0,0,0,0,0"],        // name 空
    [ADD_HEADER, "x,30,s,1,0,0,0,0"],         // 8 欄
  ] as const) {
    writeFileSync(join(proj, "add_patients.csv"), `${header}\n${body}\n`);
    const r = await run("er-triage-add");
    expect(r.text).toMatch(/exit [23]\b/); // 非 0 で終わる
    expect(data()).toBe(before);
    expect(existsSync(join(proj, "add_patients.csv"))).toBe(true); // 失敗した入力は残る（直して再実行できる）
  }
  writeAdd([{ name: "ok", age: 30, symptoms: "s", painLevel: 1 }, { name: "bad", age: -1, symptoms: "s", painLevel: 1 }]);
  expect((await run("er-triage-add")).text).toMatch(/exit [23]\b/);
  expect(data()).toBe(before); // 1 行目が良くても、2 行目が悪ければ何も足さない
});

test("W48b 手で書かれた priority は効かない: data.csv に規則と違う priority が書いてあっても、--load の app は規則で出し直し、er-triage-add は保存し直す", async () => {
  const HEAD = "id,name,age,symptoms,painLevel,chestPain,breathingTrouble,heavyBleeding,unconsciousOrConfused,severePain,priority,arrivalOrder";
  writeFileSync(join(proj, "data.csv"), `${HEAD}\n1,胸痛の人,40,chest,3,1,0,0,0,0,Low,1\n2,元気,20,cold,1,0,0,0,0,0,High,2\n`); // 嘘の priority
  const s = await run("app");
  expect(s.text.indexOf("胸痛の人 / High")).toBeGreaterThan(-1);
  expect(s.text).toContain("元気 / Low");
  expect(s.text.indexOf("胸痛の人")).toBeLessThan(s.text.indexOf("元気")); // 並びも規則どおり
  writeAdd([{ name: "新規", age: 30, symptoms: "s", painLevel: 7 }]);
  await run("er-triage-add");
  const after = (loadCsv(data()) as any).patients as { id: number; name: string; priority: string }[];
  expect(after.map((p) => [p.id, p.priority])).toEqual([[1, "High"], [3, "Medium"], [2, "Low"]]);
});

test("W48b 続き番号: 2 回に分けて足しても id と arrivalOrder は 1,2,3 と続く", async () => {
  writeAdd(THREE.slice(0, 2));
  await run("er-triage-add");
  writeAdd(THREE.slice(2));
  await run("er-triage-add");
  const ps = (loadCsv(data()) as any).patients as { id: number; arrivalOrder: number }[];
  expect(ps.map((p) => p.id).sort()).toEqual([1, 2, 3]);
  expect(ps.map((p) => p.arrivalOrder).sort()).toEqual([1, 2, 3]);
});

test("W48b 実物への差分（main.cpp）の文書は、stand-in の差分と同じ行を持つ・案内文は新しい順序（素の値を入力 file へ・規則は登録 command が出す・--load の launch・手で priority を書かない）", () => {
  const stub = readFileSync(join(FX, "app_stub.cpp"), "utf8");
  const block = stub.slice(stub.indexOf("for (int i = 1;"), stub.indexOf("// ---- ここまで ----")).trim();
  const doc = readFileSync(join(import.meta.dir, "..", "docs/verify/w48b/MAIN_CPP_PATCH.md"), "utf8");
  expect(doc).toContain(block);
  const m = readFileSync(join(import.meta.dir, "..", "src/main.ts"), "utf8");
  const i = m.indexOf("データを足す」仕事は");
  expect(i).toBeGreaterThan(0);
  const para = m.slice(i, i + 1200);
  for (const w of ["click / type_text で操作せず", "素の値", "priority", "手で書かない", "登録した command", "--load", "launch", "window_image"]) expect(para).toContain(w);
  expect(para).not.toContain("自分で計算して書く"); // 旧: agent が priority を計算する道
});
