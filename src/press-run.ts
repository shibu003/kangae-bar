// W62: 押す（SPEC-press §4）。段ごとに ①前提が満たされていれば飛ばす ②通った手を同じ門で再生 ③結果が落ちたら先に面を読む（効いていれば打ち直さない）→ 効いていなければ打ち直さず 1 turn の探し直し（agent が面を読んでから）④それでも駄目なら止めて人に聞く（続けるなら段 N の前提から・前の段は再生しない）
// 門・面・agent・人は全部 deps（試験は fake）。受領証は <home>/presses/<id>.runs.jsonl に追記（0600・値は書かない・note は決まった語だけ）
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bumpRuns, validateFields, type Check, type FieldRef, type Press, type Stage, type Way } from "./press";

export type Gate = { ok: boolean; text: string; noFace?: boolean }; // noFace = その app の面を会話が持っていない（web なら url の欄で開ける）
export type View = { title: string; names: string[] } | null; // 面の読み（get_window_state の要素名）。面が無ければ null
export type Stop = { n: number; goal: string; why: string };
export type PressDeps = {
  act(app: string, tool: string, args: Record<string, string>): Promise<Gate>; // leases.act（面は会話が持つ物から app で毎回引く）
  op(app: string, name: string, slots: Record<string, string>): Promise<Gate>; // leases.opRun
  runCmd(name: string): Promise<Gate>; // leases.runCmd
  api(site: string, op: string, params: Record<string, string>): Promise<Gate>; // runApi call
  read(app: string): Promise<View>;
  openTab(url: string): Promise<Gate>; // leases.openTabFree
  askAgent(text: string): Promise<Gate>; // その会話の agent の 1 turn
  askHuman(stop: Stop): Promise<"continue" | "stop">;
  now(): number;
};
export type Receipt = { at: number; run: string; stage: number; result: "ok" | "skipped" | "healed" | "stopped" | "asked"; note: string };
export type RunOut = { ok: true; run: string; clean: boolean; stopped: boolean; receipts: Receipt[] } | { ok: false; hint: string };

const NOTE = { pre: "前提が満たされていた", way: "通った手で済んだ", read: "読み直すと済んでいた", agent: "探し直して済んだ", stop: "人がやめた", go: "人が続けた", noFace: "面がない", miss: "結果が合わない", bad: "門が断った" } as const;

const appOf = (w: Way) => (w.kind === "act" || w.kind === "op" ? w.app : "");
const resolve = (refs: Record<string, FieldRef>, values: Record<string, string>) =>
  Object.fromEntries(Object.entries(refs).map(([k, r]) => [k, "const" in r ? r.const : Object.hasOwn(values, r.field) ? values[r.field]! : ""])); // 宣言の無い欄（constructor 等）は空: 継承した物を値にしない

// 検査: face / elements は面の読み（read）で・none / result / cmd-exit0 は直前の門の返事で。前提（last 無し）では none / cmd-exit0 / result は「分からない」＝満たされていない（飛ばさない）
async function holds(c: Check, app: string, last: Gate | null, d: PressDeps): Promise<boolean> {
  if (c.kind === "face" || c.kind === "elements") {
    const v = await d.read(c.kind === "face" ? c.app : app);
    if (!v) return false;
    return c.kind === "face" ? !c.titleLike || v.title.includes(c.titleLike) : c.names.every((n) => v.names.includes(n));
  }
  if (!last) return false;
  if (c.kind === "result") return last.ok && last.text.includes(c.like);
  return last.ok; // none・cmd-exit0（runCmd の返事が ok ＝ 0 で終わった）
}

async function play(w: Way, values: Record<string, string>, d: PressDeps): Promise<Gate> {
  if (w.kind === "act") {
    const args = resolve(w.args, values);
    const r = await d.act(w.app, w.tool, args);
    if (!r.noFace || !values.url) return r;
    const o = await d.openTab(values.url); // web の面が無い: 欄の url で開いて（人が許す）、もう 1 度だけ
    return o.ok ? d.act(w.app, w.tool, args) : o;
  }
  if (w.kind === "op") return d.op(w.app, w.name, resolve(w.slots, values));
  if (w.kind === "runCmd") return d.runCmd(w.name);
  if (w.kind === "api") return d.api(w.site, w.op, resolve(w.params, values));
  return { ok: false, text: "通った手がない" };
}

const wayText = (w: Way) => w.kind === "act" ? `${w.app} で ${w.tool}（${Object.keys(w.args).join("・") || "引数なし"}）` : w.kind === "op" ? `kangae op ${w.app} ${w.name}` : w.kind === "runCmd" ? `kangae run ${w.name}` : w.kind === "api" ? `kangae api ${w.site} ${w.op}` : w.hint;
const checkText = (c: Check) => c.kind === "elements" ? `面に「${c.names.join("」「")}」が在る` : c.kind === "face" ? `${c.app} の面を持っている` : c.kind === "result" ? `返事に「${c.like}」が在る` : c.kind === "cmd-exit0" ? `${c.name} が 0 で終わる` : "門が通す";
// 探し直しの 1 turn に渡す文（SPEC §4 ③）。値は欄の物だけ渡す
export const healText = (p: Press, s: Stage, values: Record<string, string>) =>
  `押す操作「${p.name}」の段 ${s.n} で、通った手では結果が合いませんでした。この段だけを済ませてください。\n段 ${s.n} の目的: ${s.goal}\n通った手: ${wayText(s.way)}\n済んだかの検査: ${checkText(s.post)}\n決まり: まず面を読む（get_window_state）。使ってよいのは名前つきの操作（fill / press_button / select_option・登録した op / command）だけ。画面の座標で押さない。値は次の欄の物だけ: ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(" / ") || "なし"}。他の段はやらない。済まなければ何も変えずに理由を 1 行で返す。`;

export async function runPress(home: string, p: Press, given: Record<string, string>, d: PressDeps, run = crypto.randomUUID().slice(0, 8)): Promise<RunOut> {
  const v = validateFields(p, given);
  if (!v.ok) return v; // 幅の外: 段は 1 つも走らせない
  if (p.limits.expires && d.now() > p.limits.expires) return { ok: false, hint: "この押す操作は期限が切れています" };
  if (p.limits.maxRuns && p.runs.total >= p.limits.maxRuns) return { ok: false, hint: `この押す操作は ${p.limits.maxRuns} 回までです` };
  const values = v.values, receipts: Receipt[] = [];
  const put = (stage: number, result: Receipt["result"], note: string) => {
    const r: Receipt = { at: d.now(), run, stage, result, note };
    receipts.push(r);
    mkdirSync(join(home, "presses"), { recursive: true, mode: 0o700 });
    appendFileSync(join(home, "presses", `${p.id}.runs.jsonl`), JSON.stringify(r) + "\n", { mode: 0o600 });
  };
  let clean = true;
  for (let i = 0; i < p.stages.length; ) {
    const s = p.stages[i]!, app = appOf(s.way);
    if (s.pre && s.pre.kind !== "none" && (await holds(s.pre, app, null, d))) { put(s.n, "skipped", NOTE.pre); i++; continue; }
    let why: string = NOTE.miss;
    if (s.way.kind !== "agent") {
      const r = await play(s.way, values, d);
      // 結果は門の返事（結果不明・時間切れでも）より先に面を読む: 効いていたら打ち直さない（vision §11-F・二重送信しない）
      // 済んでいなくても同じ門で打ち直さない: 面の反映が遅いだけの時に 2 度送る（review-press: 予定の「保存」が 2 件になる）→ 探し直し（agent が面を読んでから）
      if (await holds(s.post, app, r, d)) { put(s.n, "ok", r.ok ? NOTE.way : NOTE.read); i++; continue; }
      if (r.noFace) why = NOTE.noFace; else if (!r.ok) why = NOTE.bad;
    }
    const h = await d.askAgent(healText(p, s, values)); // ponytail: 結果の読めない検査（none / result）は agent の返事で見る。agent が面で確かめる前提
    if (h.ok && (await holds(s.post, app, h, d))) { put(s.n, "healed", NOTE.agent); i++; continue; }
    clean = false;
    if ((await d.askHuman({ n: s.n, goal: s.goal, why })) === "stop") { put(s.n, "stopped", NOTE.stop); break; }
    put(s.n, "asked", NOTE.go); // 続ける: 人が面に触った後なので、段 N の前提から（前の段は再生しない）
  }
  const stopped = receipts.at(-1)?.result === "stopped";
  bumpRuns(home, p.id, clean, d.now());
  return { ok: true, run, clean, stopped, receipts };
}
