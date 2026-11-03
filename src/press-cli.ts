// W62: 押す操作の口（SPEC-press §3・§4）。常駐の op `press`（action = list / save / run / answer / rm）と CLI `kangae press list|show|run|rm`。
// agent の呼びは list と run だけ（save / rm / answer は人の一覧だけ）。「覚えますか？」の候補は turn の終わりに作り、押されるまで file に書かない
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadCmds } from "./cmds";
import type { OpRecord } from "./lease";
import { appendOps, LINE_MAX } from "./opsview";
import { extractPress, fixField, pressLine, readPress, readPresses, rmPress, savePress, validateFields, type AimedRecord, type Press } from "./press";
import type { EnvDeps } from "./press-env";
import { runPress, type PressDeps, type Receipt, type Stop } from "./press-run";
import { exportPress, importPress, keepShared, readShared } from "./press-share";

export type Offer = { name: string; press: Press };
type Ask = Stop & { run: string; press: string; name: string; node: number; answer: (a: "continue" | "stop") => void };
// 常駐の間だけの状態: 会話ごとの候補・人の答えを待つ段・走っている押し（同じ押す操作は 1 本ずつ＝送り直しで二重に走らない）
export const makePressHub = () => ({ offers: new Map<number, Offer>(), asks: new Map<string, Ask>(), active: new Map<string, { press: string; node: number }>(), incoming: new Map<string, Press>() }); // incoming = 読み込んで card を見せている物（「始める」まで file に書かない・1 つだけ）
export type PressHub = ReturnType<typeof makePressHub>;
type Res = { ok: boolean; [k: string]: unknown };

const CTRL = /[\p{Cc}\p{Cf}]/gu;
const text = (s: unknown, max: number) => String(s ?? "").replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, max);

// runCmd / op / api の記録 1 行（SPEC §3: op は runCmd:<name> / op:<app>/<name> / api:<site>/<op>・value は欄の名前だけ）。main.ts の各 case の直後から。書きは appendOps（回転・0600）を通す・失敗は操作に響かせない
export const recordOp = (file: string, owner: string, op: string, keys: string[], out: { ok: boolean; isError?: boolean; why?: string }) => {
  try { appendOps(file, JSON.stringify({ at: Date.now(), face: "", app: "", owner, where: "", gen: 0, op: op.slice(0, 80), value: keys.join(","), result: out.ok ? (out.isError ? "error" : "ok") : `refused:${out.why ?? "tool"}` } satisfies OpRecord)); } catch {}
};
// W72: 記録に「的」を足す（lease.ts の記録は値しか持たない）。常駐が act の args を覚え、record の時に同じ面・世代・操作の行へ足す（record は act の返事より先に呼ばれる）
// 的 = fill / select_option の欄名・press_button の名前・click の要素と、その名前（直前の get_window_state の読みから・button 類だけ＝入れた値を名前と取り違えない。link は名前を取らない＝link の文字は頁の中身（件名・金額）で、goal を通って渡す file に載る・W81）
// 同じ面・世代・操作は lane で 1 本ずつにする（review-press2: 並行 2 本だと的が入れ替わった）
const BTN = /^(AX)?(button|popupbutton|menuitem|tab|checkbox|radio|radiobutton)$/i; // role の完全一致（Table の行の label＝中身を名前にしない）
export function makeAims() {
  const pending = new Map<string, { target?: string; el?: string }>(), lane = new Map<string, Promise<unknown>>(), seen = new Map<string, Map<string, string>>();
  const key = (face: string, gen: unknown, op: string) => `${face}|${Number(gen)}|${op}`;
  return {
    // 同じ面・世代・操作は 1 本ずつ（記録は完了順に 1 行ずつ来るので、並行だと先の的を後の記録が持っていく）
    async act<R extends { ok: boolean }>(gate: { act(tok: string, tool: string, args: Record<string, unknown>): Promise<R> }, tok: string, tool: string, args: Record<string, unknown>): Promise<R> {
      const lk = key(String(tok ?? "").split("|")[0] ?? "", String(tok ?? "").split("|")[1] ?? "", tool), prev = lane.get(lk) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(() => this.actOne(gate, tok, tool, args));
      lane.set(lk, run);
      try { return await run; } finally { if (lane.get(lk) === run) lane.delete(lk); }
    },
    async actOne<R extends { ok: boolean }>(gate: { act(tok: string, tool: string, args: Record<string, unknown>): Promise<R> }, tok: string, tool: string, args: Record<string, unknown>): Promise<R> {
      const [face = "", gen = ""] = String(tok ?? "").split("|"), k = key(face, gen, tool);
      const el = tool === "click" && typeof args.element_token === "string" ? text(args.element_token, 40) : "";
      const named = tool === "fill" || tool === "select_option" ? args.field : tool === "press_button" ? args.name : el ? seen.get(face)?.get(el) : undefined;
      const target = typeof named === "string" ? text(named, 80) : "";
      pending.delete(k);
      const mine = target || el ? { ...(target ? { target } : {}), ...(el ? { el } : {}) } : null;
      if (mine) pending.set(k, mine);
      let r: R;
      try { r = await gate.act(tok, tool, args); } finally { if (mine && pending.get(k) === mine) pending.delete(k); } // 記録が来なかった（門が throw）的を残さない: 残ると aims を通らない次の記録（step の道）に古い的が付き、別の要素を押す press になる
      const t = (r as { text?: unknown; isError?: unknown }).text;
      if (tool === "get_window_state" && r.ok && !(r as { isError?: unknown }).isError && typeof t === "string")
        seen.set(face, new Map(t.split("\n").slice(1).map((l) => l.split("\t")).filter((c) => c.length >= 3 && BTN.test(c[1]!)).map((c) => [c[0]!.trim(), text(c.slice(2).join(" ").split(" = ")[0], 80)] as [string, string]).filter(([, n]) => n)));
      return r;
    },
    tag(e: OpRecord): AimedRecord { const k = key(e.face, e.gen, e.op), a = pending.get(k); if (!a) return e; pending.delete(k); return { ...e, ...a }; },
  };
}

// 読み込みの環境（SPEC §5）: 実機を見る既定。拡張が繋がっているかだけは常駐が知っている
export const hostEnv = (home: string, ext: boolean): EnvDeps => ({
  exists: existsSync, which: (b) => Bun.which(b) != null, extensionConnected: () => ext,
  appInstalled: (a) => ["/Applications", "/System/Applications", join(homedir(), "Applications")].some((d) => existsSync(join(d, `${a}.app`))),
  cmds: loadCmds(home).map((c) => c.name),
});

// get_window_state の返す文（1 行目 = snapshot・以降 `token\t種類\t名前 = 値`）→ 面の読み
export const viewOf = (title: string, t: string) => ({ title, names: t.split("\n").slice(1).map((l) => l.split("\t")[2] ?? "").filter((x) => x) });

// その turn の記録（記録の file を会話と時刻で絞る・file の path は常駐が渡す）。ponytail: 今の file だけ読む（turn の途中で 2MB の回転が起きると前半を落とす。困ったら .1 も）・肥大した行は opsview と同じく読まない
// ponytail: 読む道が opsview（recentFor・整形済みの行だけ返す）と 2 本になる。生の記録を返す読みを opsview に寄せるのが本筋（W60 の面なので触らない）
export function turnRecords(file: string, owner: string, since: number): OpRecord[] {
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  const out: OpRecord[] = [];
  for (const l of raw.split("\n")) { if (l.length > LINE_MAX) continue; try { const r = JSON.parse(l) as OpRecord; if (r.owner === owner && Number(r.at) >= since && typeof r.op === "string") out.push(r); } catch {} }
  return out;
}
// turn の終わり: 段が 2 つ以上なら「覚えますか？」の 1 行と候補（SPEC §3）。名前は会話の最初の行の先頭 40 字
export function pressOffer(file: string, node: number, since: number, first: string): { line: string; offer: Offer } | null {
  const press = extractPress(turnRecords(file, `s:${node}`, since), { owner: `s:${node}`, name: text(first, 40) || undefined });
  if (press.stages.length < 2) return null;
  return { line: `🧷 この仕事を押す操作にしますか（${press.stages.length} 手・欄 ${Object.keys(press.fields).length}）。一覧の「押す操作にする」を押すと保存します`, offer: { name: press.name, press } };
}

const home = () => process.env.HOME || homedir(); // bun の homedir() は起動後の HOME を見ない（試験は HOME を temp に置いて本物の Downloads に書かない）
// 人が欄に入れた file の場所: 前後の空白と引用符・~/ ・file:// を受ける（絶対 path にならなければ null）
const filePathOf = (v: unknown): string | null => {
  let s = String(v ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
  if (s.startsWith("file://")) { try { s = fileURLToPath(s); } catch { return null; } }
  if (s === "~" || s.startsWith("~/")) s = join(home(), s.slice(1));
  return isAbsolute(s) ? s : null;
};
// 書き出す場所: 名前から file に使えない字を除き、在れば「 (2)」…（同じ名前の別の押す操作を上書きしない）
const sharePath = (p: Press): string => {
  const base = p.name.replace(/[\p{Cc}\p{Cf}/\\:*?"<>|]/gu, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 60) || p.id, dir = join(home(), "Downloads");
  for (let i = 1; ; i++) { const f = join(dir, `${base}${i > 1 ? ` (${i})` : ""}.kangae-press.json`); if (!existsSync(f)) return f; }
};

const view = (p: Press) => ({
  id: p.id, name: p.name, line: pressLine(p), runs: p.runs,
  stages: p.stages.map((s) => ({ n: s.n, kind: s.kind, goal: s.goal })),
  fields: Object.entries(p.fields).map(([name, f]) => ({ name, ...f })),
});

export type HandleDeps = {
  home: string; hub: PressHub;
  agent: boolean; // agent の CLI（unix socket）か owner つきの呼び
  node: number | null; // 走らせる会話（agent は自分の会話・人は見ている会話）
  busy(node: number): boolean; // その会話の agent がいま動いている
  deps(node: number, agent: boolean): Omit<PressDeps, "askHuman">;
  say(node: number, line: string): void; // 会話に 1 行
  ext(): boolean; // 拡張が繋がっている（読み込みの環境）
};
export async function handlePress(m: { action?: unknown; path?: unknown; key?: unknown; press?: unknown; fields?: unknown; run?: unknown; yes?: unknown; name?: unknown; fixed?: unknown; wait?: unknown }, d: HandleDeps): Promise<Res> {
  const action = String(m.action ?? ""), h = d.hub;
  if (d.agent && action !== "list" && action !== "run") return { ok: false, code: "bad", hint: "押す操作の保存・消す・止まった段への答え・渡す・受け取るは、人が一覧で行います（agent からはできません）" };
  if (action === "list") {
    const offer = d.node == null ? undefined : h.offers.get(d.node);
    return { ok: true, ext: d.ext(), presses: readPresses(d.home).map(view), offer: offer ? { ...view(offer.press), name: offer.name } : null, asks: [...h.asks.values()].map(({ answer: _, ...a }) => a), active: [...h.active.keys()] };
  }
  if (action === "save") {
    const of = d.node == null ? undefined : h.offers.get(d.node);
    if (!of) return { ok: false, hint: "押す操作にできる仕事がありません（会話の終わりに「押す操作にしますか」が出た時だけ作れます）" };
    let p: Press = { ...of.press, name: text(m.name, 60) || of.press.name };
    const fixed = m.fixed && typeof m.fixed === "object" && !Array.isArray(m.fixed) ? (m.fixed as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(fixed)) if (typeof v === "string") p = fixField(p, k, v); // 「固定」にした欄だけ値を持つ（他は押す時に聞く）
    if (!savePress(d.home, p)) return { ok: false, hint: "保存できませんでした" };
    h.offers.delete(d.node!);
    return { ok: true, press: p.id, line: pressLine(p) };
  }
  if (action === "share") { // W81: 人の一覧の「渡す」（agent は上で断る）。書く場所は常駐が決める（~/Downloads/<名前>.kangae-press.json・在れば (2)…）
    const p = readPress(d.home, String(m.press ?? ""));
    if (!p) return { ok: false, hint: "その押す操作は見つかりません" };
    const r = exportPress(d.home, p.id, sharePath(p));
    return r.ok ? { ok: true, path: r.path, fp: r.fp } : r;
  }
  if (action === "import") { // W81: 人の一覧の「受け取る」。path → 確かめて card を返す（保存しない）・key →「始める」で保存
    if (m.key != null) {
      const p = h.incoming.get(String(m.key));
      if (!p) return { ok: false, hint: "始める押す操作がありません（もう一度 file を読み込んでください）" };
      h.incoming.clear();
      const kept = keepShared(d.home, p);
      return kept ? { ok: true, press: kept.id, line: pressLine(kept) } : { ok: false, hint: "保存できませんでした" };
    }
    const path = filePathOf(m.path);
    if (!path) return { ok: false, hint: "file の場所を / から始まる形で入れてください（Finder で file を選び、option を押しながら右クリック →「パス名をコピー」）" };
    const r = readShared(path, hostEnv(d.home, d.ext()));
    if (!r.ok) return r;
    const key = crypto.randomUUID().slice(0, 8);
    h.incoming.clear();
    h.incoming.set(key, r.press);
    return { ok: true, key, line: pressLine(r.press), card: r.card, cardOk: r.cardOk, missing: r.missing };
  }
  if (action === "rm") {
    const id = String(m.press ?? "");
    if (!rmPress(d.home, id)) return { ok: false, hint: "その押す操作は見つかりません" };
    rmSync(join(d.home, "presses", `${id}.runs.jsonl`), { force: true });
    return { ok: true };
  }
  if (action === "answer") {
    const a = h.asks.get(String(m.run ?? ""));
    if (!a) return { ok: false, hint: "答えを待っている段はありません（もう答えたか、止まっています）" };
    h.asks.delete(a.run);
    a.answer(m.yes === true ? "continue" : "stop");
    return { ok: true };
  }
  if (action === "run") {
    const p = readPress(d.home, String(m.press ?? ""));
    if (!p) return { ok: false, hint: "その押す操作は見つかりません" };
    const given = m.fields && typeof m.fields === "object" && !Array.isArray(m.fields) ? Object.fromEntries(Object.entries(m.fields as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};
    const v = validateFields(p, given);
    if (!v.ok) return v; // 走らせる前に幅を見る（段は 1 つも走らない）
    if (d.node == null) return { ok: false, hint: "どの会話で押すかが分かりません。会話を開いてから押してください" };
    if (!d.agent && d.busy(d.node)) return { ok: false, hint: "この会話の agent がいま動いています。終わってから押してください" };
    if ([...h.active.values()].some((x) => x.press === p.id)) return { ok: false, hint: "この押す操作はいま走っています。終わってから押してください" };
    const run = crypto.randomUUID().slice(0, 8), node = d.node;
    h.active.set(run, { press: p.id, node });
    const askHuman = (s: Stop) => new Promise<"continue" | "stop">((answer) => {
      h.asks.set(run, { ...s, run, press: p.id, name: p.name, node, answer });
      d.say(node, `🧷 押す操作「${p.name}」は段 ${s.n}（${s.goal}）で止まりました: ${s.why}。押す操作の一覧で「続ける」か「やめる」を選んでください`);
    });
    const done = runPress(d.home, p, given, { ...d.deps(node, d.agent), askHuman }, run)
      .then((out) => { if (out.ok) d.say(node, `🧷 押す操作「${p.name}」: ${out.stopped ? "途中でやめました" : out.clean ? "全部の段が済みました" : "人が手伝って済みました"}（${out.receipts.length} 行の受領証）`); return out; })
      .finally(() => { h.active.delete(run); h.asks.delete(run); });
    if (m.wait !== true) { done.catch(() => {}); return { ok: true, run }; }
    const out = await done.catch((e) => ({ ok: false as const, hint: `押す途中で落ちました（${text((e as Error).message, 120)}）` }));
    return out.ok ? { ...out, ok: true } : out;
  }
  return { ok: false, hint: "press は list / save / run / answer / rm / share / import です" };
}

const RESULT: Record<Receipt["result"], string> = { ok: "済んだ", skipped: "飛ばした", healed: "探し直して済んだ", stopped: "止めた", asked: "人が続けた" };
const fieldText = (f: Press["fields"][string]) => "fixed" in f ? `固定「${f.fixed}」` : "range" in f ? `${f.range[0]}〜${f.range[1]}` : "choice" in f ? `次のどれか: ${f.choice.join("・")}` : "押す時に聞く";
// CLI: list / show は file を読むだけ・run は常駐へ（終わるまで待つ）・rm は人の terminal だけ（agent の env では断る）
export async function pressArgv(args: string[], d: { home: string; owner?: string; send(msg: Record<string, unknown>): Promise<Res>; out(s: string): void; err(s: string): void }): Promise<number> {
  const [sub = "", id = "", ...kvs] = args;
  if (sub === "list") {
    const ps = readPresses(d.home);
    d.out(ps.length ? ps.map((p) => `${p.id} ${pressLine(p)}`).join("\n") : "押す操作はまだありません（会話の終わりの「押す操作にしますか」から作ります）");
    return 0;
  }
  if (sub === "show") {
    const p = readPress(d.home, id);
    if (!p) { d.err(`押す操作「${id.slice(0, 20)}」は見つかりません（kangae press list で一覧）`); return 1; }
    d.out([pressLine(p), ...p.stages.map((s) => `  段 ${s.n}: ${s.goal}`), ...Object.entries(p.fields).map(([k, f]) => `  欄 ${k}: ${fieldText(f)}`)].join("\n"));
    return 0;
  }
  if (sub === "run") {
    if (!id) { d.err("使い方: kangae press run <id> [欄=値 …]"); return 2; }
    const fields: Record<string, string> = {};
    for (const a of kvs) { const i = a.indexOf("="); if (i < 1) { d.err(`欄は 名前=値 で渡してください: ${a.slice(0, 40)}`); return 2; } fields[a.slice(0, i)] = a.slice(i + 1); }
    const r = await d.send({ op: "press", action: "run", press: id, fields, owner: d.owner ?? "", wait: true });
    if (!r.ok) { d.err(String(r.hint ?? "押せませんでした")); return 1; }
    d.out((r.receipts as Receipt[]).map((x) => `段 ${x.stage}: ${RESULT[x.result]}（${x.note}）`).join("\n"));
    return r.stopped ? 1 : 0;
  }
  // W72: share / import は file だけの仕事なので CLI の process で（常駐の unix socket は agent の口として扱われ、人の操作を断るため）。import は人の terminal だけ
  if (sub === "share") {
    if (!id) { d.err("使い方: kangae press share <id> [書き出す file]"); return 2; }
    if (d.owner) { d.err("押す操作を書き出すのは人です（agent からは書き出せません）"); return 1; }
    const r = exportPress(d.home, id, resolve(kvs[0] ?? `${id}.kangae-press.json`));
    if (!r.ok) { d.err(r.hint); return 1; }
    d.out(`書き出しました: ${r.path}（送り手の指紋 ${r.fp.slice(0, 8)}）。入れた値は入っていません。この file を相手に渡すと、相手は kangae press import <file> で読み込めます`);
    return 0;
  }
  if (sub === "import") {
    if (!id) { d.err("使い方: kangae press import <file>"); return 2; }
    if (d.owner) { d.err("押す操作を読み込むのは人です（agent からは読み込めません）"); return 1; }
    const ext = await d.send({ op: "press", action: "list" }).then((x) => x.ext === true, () => false);
    const r = importPress(d.home, resolve(id), hostEnv(d.home, ext));
    if (!r.ok) { d.err(r.hint); return 1; }
    const c = r.card;
    d.out([`読み込みました: ${r.press.id} ${pressLine(r.press)}`, c.title, ...c.lines.map((l) => `  ${l}`), ...(r.cardOk ? [] : ["  （この押す操作の説明には、画面に出さない語が混じっていました。押す前に kangae press show で段を確かめてください）"])].join("\n"));
    return 0;
  }
  if (sub === "rm") {
    if (d.owner) { d.err("押す操作を消すのは人です（agent からは消せません）"); return 1; }
    if (!rmPress(d.home, id)) { d.err(`押す操作「${id.slice(0, 20)}」は見つかりません`); return 1; }
    rmSync(join(d.home, "presses", `${id}.runs.jsonl`), { force: true });
    d.out(`消しました: ${id}`);
    return 0;
  }
  d.err("使い方: kangae press list | show <id> | run <id> [欄=値 …] | rm <id> | share <id> [file] | import <file>");
  return 2;
}
