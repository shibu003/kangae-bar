// W61: 押す操作（press）。終わった仕事を「段の目的の鎖」と「欄の幅」にして <KANGAE_HOME>/presses/<id>.json に 0600 で置く（契約 = docs/SPEC-press.md §2・§3）
// 覚えるのは結果（何を・どの値で）だけ。入れた値・座標・cookie は持たない（値は欄の幅になり、既定は「実行の時に聞く」）
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpRecord } from "./lease";

export type Press = {
  v: 1; id: string;
  name: string;
  madeAt: number; madeBy?: { fp: string; name?: string };
  fields: Record<string, FieldSpec>;
  stages: Stage[];
  expect: { result: string; state?: string };
  onMismatch: "ask" | "skip" | "alt";
  limits: { expires?: number; maxRuns?: number; priceMax?: number };
  claims?: string[];                   // 作り手の宣言「戻せる物」（W63 が契約に足した・card の 1 行）
  alternatives?: string[];
  runs: { total: number; clean: number; lastAt?: number };
};
export type FieldSpec = { fixed: string } | { range: [string, string] } | { choice: string[] } | { ask: true; label?: string };
export type Stage = {
  n: number; kind: "env" | "op";
  goal: string;
  requires?: Requirement[];
  pre?: Check; post: Check;
  way: Way;
};
export type Requirement = "chromium-ext" | "brew" | "adb" | "bw" | `login:${string}` | `app:${string}` | `cmd:${string}`;
export type Check =
  | { kind: "none" }
  | { kind: "face"; app: string; titleLike?: string }
  | { kind: "elements"; names: string[] }
  | { kind: "cmd-exit0"; name: string }
  | { kind: "result"; like: string };
export type FieldRef = { field: string } | { const: string };
export type Way =
  | { kind: "act"; app: string; tool: string; args: Record<string, FieldRef> }
  | { kind: "op"; app: string; name: string; slots: Record<string, FieldRef> }
  | { kind: "runCmd"; name: string }
  | { kind: "api"; site: string; op: string; params: Record<string, FieldRef> }
  | { kind: "agent"; hint: string };

const NAME = /^[A-Za-z0-9_.-]{1,40}$/; // drafts.ts:7 と同じ
const ID = /^[0-9a-f]{8}$/;
const MAX_FIELDS = 20;
const MAX_VALUE = 500;
const DEC = /^-?\d+(\.\d+)?$/;
const SECRET = "〈伏せ〉";
const SECRET_SUFFIX = "-secret"; // 伏せの欄は名前で見分ける（FieldSpec の形は契約のまま {ask:true}）
const CTRL = /[\p{Cc}\p{Cf}]/gu;
const INPUT_OPS = /^(fill|type_text|set_value|select|select_option|upload)$/; // 値を持つ入力。press_button 等の値（押した物の名前）は欄にしない
const GOAL: Record<string, string> = { fill: "欄に入力する", type_text: "文字を入力する", set_value: "値を入れる", select: "選ぶ", select_option: "選ぶ", press_button: "ボタンを押す", click: "押す", press_key: "キーを押す", hotkey: "ショートカットを押す", open_tab: "ページを開く", upload: "ファイルを渡す" };

const dir = (home: string) => join(home, "presses");
const file = (home: string, id: string) => join(dir(home), `${id}.json`);
const clean = (s: string, max: number) => s.replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, max);

const shaped = (j: any): j is Press => !!j && j.v === 1 && typeof j.id === "string" && ID.test(j.id) && typeof j.name === "string" && Array.isArray(j.stages) && !!j.fields && typeof j.fields === "object" && !!j.runs && typeof j.runs.total === "number";
export function readPress(home: string, id: string): Press | null {
  if (!ID.test(id)) return null;
  try { const j = JSON.parse(readFileSync(file(home, id), "utf8")); return shaped(j) && j.id === id ? j : null; } catch { return null; }
}
export function readPresses(home: string): Press[] {
  let names: string[];
  try { names = readdirSync(dir(home)); } catch { return []; }
  const out: Press[] = [];
  for (const f of names) { const m = /^([0-9a-f]{8})\.json$/.exec(f); const p = m && readPress(home, m[1]!); if (p) out.push(p); }
  return out.sort((a, b) => b.madeAt - a.madeAt);
}
export function savePress(home: string, p: Press): boolean {
  if (!ID.test(p.id)) return false;
  mkdirSync(dir(home), { recursive: true, mode: 0o700 });
  writeFileSync(file(home, p.id) + ".tmp", JSON.stringify(p), { mode: 0o600 });
  renameSync(file(home, p.id) + ".tmp", file(home, p.id));
  return true;
}
export function rmPress(home: string, id: string): boolean {
  if (!ID.test(id) || !existsSync(file(home, id))) return false;
  rmSync(file(home, id), { force: true });
  return true;
}

// W72: 記録の「的」（常駐が act の args から足す・press-cli.ts の makeAims）。target = fill / select_option の欄名・press_button の名前・click の対象の名前（button 類だけ）、el = click の要素
export type AimedRecord = OpRecord & { target?: string; el?: string };
const VALUE_KEY: Record<string, string> = { type_text: "text", select_option: "option" }; // 門へ渡す値の key（他は value）

// 覚える（SPEC §3）: runCmd:* と open_app → env・draft:* は段にしない・それ以外 → op・1 記録 1 段・値は欄（既定は聞く）・〈伏せ〉は常に聞く
// 的は { const }（欄名・ボタン名は値ではない）・op:<app>/<name> と api:<site>/<op> は way.op / way.api（value = 欄の名前を , で）
export function extractPress(records: AimedRecord[], opts: { name?: string; owner: string }): Press {
  const mine = records.filter((r) => (!r.owner || r.owner === opts.owner) && !/^draft:/.test(r.op) && r.result !== "error" && !String(r.result).startsWith("refused"));
  const isEnv = (r: OpRecord) => r.op === "open_app" || r.op.startsWith("runCmd:");
  const ordered = [...mine.filter(isEnv), ...mine.filter((r) => !isEnv(r))];
  const fields: Record<string, FieldSpec> = {};
  const stages: Stage[] = ordered.map((r, i): Stage => {
    const n = i + 1;
    if (r.op.startsWith("runCmd:")) {
      const name = r.op.slice(7);
      return { n, kind: "env", goal: clean(`「${name}」が済んでいる`, 80), requires: NAME.test(name) ? [`cmd:${name}`] : undefined, post: { kind: "cmd-exit0", name }, way: { kind: "runCmd", name } };
    }
    if (r.op === "open_app") return { n, kind: "env", goal: clean(`${r.app || "アプリ"} が開いている`, 80), requires: r.app ? [`app:${r.app}`] : undefined, pre: { kind: "face", app: r.app }, post: { kind: "face", app: r.app }, way: { kind: "act", app: r.app, tool: "open_app", args: {} } };
    const slotted = /^(op|api):([^/]+)\/(.+)$/.exec(r.op);
    if (slotted) { // 欄の名前だけ記録にある（値は無い）→ 全部「押す時に聞く」
      const refs: Record<string, FieldRef> = {};
      for (const k of String(r.value ?? "").split(",").filter((k) => NAME.test(k))) {
        const f = `${k}_${n}`;
        if (!NAME.test(f) || Object.keys(fields).length >= MAX_FIELDS) continue;
        fields[f] = { ask: true, label: k };
        refs[k] = { field: f };
      }
      const [, kind, a = "", b = ""] = slotted;
      return kind === "op"
        ? { n, kind: "op", goal: clean(`${a}で「${b}」をする`, 80), post: { kind: "none" }, way: { kind: "op", app: a, name: b, slots: refs } }
        : { n, kind: "op", goal: clean(`${a} の「${b}」を読む`, 80), post: { kind: "none" }, way: { kind: "api", site: a, op: b, params: refs } };
    }
    const args: Record<string, FieldRef> = {};
    const secret = r.value === SECRET;
    const target = typeof r.target === "string" ? clean(r.target, 80) : "";
    const base = String(r.op).replace(/[^A-Za-z0-9_.-]/g, "?");
    const name = `${base}_${n}${secret ? SECRET_SUFFIX : ""}`;
    if ((secret || (INPUT_OPS.test(r.op) && r.value && !/^\{.*\}$/.test(r.value))) && NAME.test(name) && Object.keys(fields).length < MAX_FIELDS) {
      fields[name] = target ? { ask: true, label: target } : { ask: true };
      args[VALUE_KEY[r.op] ?? "value"] = { field: name };
    }
    if (target && (r.op === "fill" || r.op === "select_option")) args.field = { const: target };
    if (target && r.op === "press_button") args.name = { const: target };
    if (r.op === "click" && typeof r.el === "string" && r.el) args.element_token = { const: r.el.slice(0, 40) }; // ponytail: 記録の時の要素。面が読み直されて変われば門が断り、探し直し（goal の名前で）に落ちる
    return { n, kind: "op", goal: clean(`${r.app ? r.app + "で" : ""}${GOAL[r.op] ?? "操作する"}${target ? `（${target}）` : ""}`, 80), post: { kind: "none" }, way: { kind: "act", app: r.app, tool: r.op, args } };
  });
  const last = [...stages].reverse().find((s) => s.kind === "op") ?? stages[stages.length - 1];
  const suggested = clean(opts.name ?? "", 60) || clean(last?.goal ?? "", 60) || "押す操作";
  return {
    v: 1, id: crypto.randomUUID().slice(0, 8), name: suggested, madeAt: Date.now(),
    fields, stages, expect: { result: last?.way.kind === "act" ? `${last.way.app || "app"}.${last.way.tool}`.toLowerCase() : "done" },
    onMismatch: "ask", limits: {}, runs: { total: 0, clean: 0 },
  };
}

// maker が card で「固定」にした欄だけ { fixed } にし、段の参照を { const } へ。伏せの欄・存在しない欄・長すぎる / 制御文字入りの値は何も変えない
export function fixField(p: Press, name: string, value: string): Press {
  if (!Object.hasOwn(p.fields, name) || name.endsWith(SECRET_SUFFIX) || typeof value !== "string" || value.length > MAX_VALUE || /[\p{Cc}\p{Cf}]/u.test(value)) return p;
  const sub = (refs: Record<string, FieldRef>) => Object.fromEntries(Object.entries(refs).map(([k, r]) => [k, "field" in r && r.field === name ? { const: value } : r]));
  const stages = p.stages.map((s): Stage => s.way.kind === "act" ? { ...s, way: { ...s.way, args: sub(s.way.args) } } : s.way.kind === "op" ? { ...s, way: { ...s.way, slots: sub(s.way.slots) } } : s.way.kind === "api" ? { ...s, way: { ...s.way, params: sub(s.way.params) } } : s);
  return { ...p, fields: { ...p.fields, [name]: { fixed: value } }, stages };
}

// 実行の前に幅を見る。外れていれば断る（hint は人向け）
export function validateFields(p: Press, given: Record<string, string>): { ok: true; values: Record<string, string> } | { ok: false; hint: string } {
  const values: Record<string, string> = {};
  for (const [name, spec] of Object.entries(p.fields)) {
    if ("fixed" in spec) { values[name] = spec.fixed; continue; }
    const v = Object.hasOwn(given, name) ? given[name] : undefined;
    if (typeof v !== "string" || !v.trim()) return { ok: false, hint: `「${name}」を入れてください` };
    if (v.length > MAX_VALUE || /[\p{Cc}\p{Cf}]/u.test(v)) return { ok: false, hint: `「${name}」は ${MAX_VALUE} 字までの文字だけにしてください` };
    if ("range" in spec) {
      const [lo, hi] = spec.range;
      const num = [lo, hi].every((x) => DEC.test(x)); // 幅が 10 進の数なら値も 10 進の綴りだけ（"1e1"・"0x50"・"+5" は別の綴りで同じ数を通し、受ける app が違う数に読む）
      if (num && !DEC.test(v)) return { ok: false, hint: `「${name}」は ${lo} から ${hi} の間の数（例 ${lo}）にしてください` };
      const inside = num ? Number(v) >= Number(lo) && Number(v) <= Number(hi) : v >= lo && v <= hi;
      if (!inside) return { ok: false, hint: `「${name}」は ${lo} から ${hi} の間にしてください` };
    } else if ("choice" in spec && !spec.choice.includes(v)) return { ok: false, hint: `「${name}」は次のどれかにしてください: ${spec.choice.join("・")}` };
    values[name] = v;
  }
  return { ok: true, values };
}

export const pressLine = (p: Press): string => `🧷 ${p.name}（${p.stages.length} 段・欄 ${Object.keys(p.fields).length}・${p.runs.total ? `再現 ${p.runs.clean}/${p.runs.total}` : "まだ押していません"}）`;

export function bumpRuns(home: string, id: string, ok: boolean, at: number): Press | null {
  const p = readPress(home, id);
  if (!p) return null;
  const q: Press = { ...p, runs: { total: p.runs.total + 1, clean: p.runs.clean + (ok ? 1 : 0), lastAt: at } };
  return savePress(home, q) ? q : null;
}
