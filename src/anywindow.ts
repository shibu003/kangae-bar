// AW1: AnyWindow Runtime の片 1・2（docs/design-anywindow.md・docs/BRIEF-aw1.md・図 docs/diagrams.md §AW1）。
// agent は「操作名 + 欄の値」だけを送る。カタログに在る物だけを、承認・lease の世代・競合の鍵を通してから Adapter が 1 回だけ実行する。
// 無い物は実行せず下書き（src/drafts.ts）で止まる。画面操作（click / type_text）へは落ちない。Adapter の本物: Reminders = 片 3（下の remindersAdapter）・Hide = 片 4
import { randomUUID } from "node:crypto";
import { addDraft } from "./drafts.ts";
import { scriptGate, shownText } from "./mods.ts";
import type { OpRecord, Why, makeLeases } from "./lease.ts";

// ---------- 操作の定義（カタログ） ----------
export type Field = { type: "string" | "number" | "boolean"; required?: boolean; max?: number };
export type OpDef = {
  name: string; // reminders.add
  label: string; // 承認 card に出す人の言葉
  app: string; // lease の面の app 名（この名前の面に貸された物だけが対象）
  bundle: string; // 競合の鍵の元（bundle ID）
  scope: "app" | "window" | "tab" | "file"; // 作用する範囲。reminders.add は面が 1 窓でも app 全体に書く＝ "app"
  perm: "read" | "write";
  background: "unverified" | "verified" | "no"; // 隠したまま動くか
  actor: "human" | "agent"; // 実行できる者（human = 人だけ・agent = 人が明示に許した agent も）
  via: "native" | "ax"; // どの Adapter で動くか
  input: Record<string, Field>;
  verify: string; // 実行後の照合のやり方（Adapter が verified に書く）
};
export const CATALOG: readonly OpDef[] = [
  { name: "reminders.add", label: "リマインダーを足す", app: "Reminders", bundle: "com.apple.reminders", scope: "app", perm: "write", background: "unverified", actor: "agent", via: "native",
    input: { title: { type: "string", required: true, max: 200 }, notes: { type: "string", max: 2000 }, list: { type: "string", max: 200 } }, verify: "返った id（無ければ reminders.list で title）で読み直して title の一致を見る" },
  { name: "reminders.list", label: "リマインダーを読む", app: "Reminders", bundle: "com.apple.reminders", scope: "app", perm: "read", background: "unverified", actor: "agent", via: "native",
    input: { list: { type: "string", max: 200 } }, verify: "読んだ件数と返した件数の一致" },
];

// ---------- 競合の鍵 ----------
// 同じ app で、片方が app 全体なら必ず競合・両方が窓 / tab / file なら同じ物の時だけ競合。別 app は競合しない
export type Key = { app: string; sub?: string };
export const conflicts = (a: Key, b: Key) => a.app === b.app && (a.sub === undefined || b.sub === undefined || a.sub === b.sub);
// 範囲が分からない（窓の番号が無い・file の欄が無い）書きは app 単位に倒す
export function lockKey(def: OpDef, face: Face, input: Record<string, unknown>): Key {
  const app = def.bundle;
  const sub = def.scope === "window" && face.windowId !== undefined ? `win:${face.pid}:${face.windowId}`
    : def.scope === "tab" && face.tabId !== undefined ? `tab:${face.tabId}`
    : def.scope === "file" && typeof input.path === "string" && input.path ? `file:${input.path}` : undefined;
  return sub ? { app, sub } : { app };
}
// 書きの順番待ち。先に来た競合する者が居る間は待つ（同じ app の書きは到着順に 1 つずつ・別 app は並行）
function makeLocks() {
  const held = new Set<Key>(), waiting: { k: Key; go: () => void }[] = [];
  const pump = () => {
    for (let i = 0; i < waiting.length; i++) {
      const w = waiting[i]!;
      if ([...held].some((h) => conflicts(h, w.k)) || waiting.slice(0, i).some((e) => conflicts(e.k, w.k))) continue;
      waiting.splice(i--, 1);
      held.add(w.k);
      w.go();
    }
  };
  return (k: Key) => new Promise<() => void>((resolve) => {
    waiting.push({ k, go: () => resolve(() => { held.delete(k); pump(); }) });
    pump();
  });
}

// ---------- 入口 ----------
export type Face = { key: string; owner: string; gen: number; app: string; pid?: number; windowId?: number; tabId?: number; write: "off" | "ask" | "turn" | "allow" | "mod" };
type Gate = { ok: true; face: Face } | { ok: false; why: Why | string; hint: string };
export type Adapter = { execute(def: OpDef, input: Record<string, unknown>, ctx: { face: Face; request_id: string; signal?: AbortSignal }): Promise<{ ok: true; result: unknown; verified?: string } | { ok: false; error: string; unknown?: boolean }> };
export type Deps = {
  check(token: string): Gate; // lease の検査（持ち主・世代・期限）＋面の情報と承認の表
  ask(token: string, op: string, what: string): Promise<{ ok: true } | { ok: false; why: Why | string; hint: string }>; // 人への承認（write で表が「先に聞く」の時）
  adapters: Partial<Record<OpDef["via"], Adapter>>;
  draft(d: { owner: string; face: string; gen: number; op: string; fields: Record<string, unknown>; why: string }): { ok: true; id: string } | { ok: false; hint: string };
  humanOps: Readonly<Record<string, string>>; // 人が押す op（main.ts の HUMAN_OPS）。カタログに入れず、入口でも断る
  catalog?: readonly OpDef[];
  record?: (r: OpRecord) => void; // 実行記録（ops.jsonl）。値は残さず欄の名前だけ
  hidden?: (face: Face) => boolean; // 片 4: 面が隠されている間は、隠したままで動くと検証済みの操作だけ
  timeoutMs?: number; // Adapter が返らない時の締切。過ぎたら「結果が分からない」にして鍵を返す
  now?: () => number;
};
export type Req = { op: string; target: string; input: Record<string, unknown>; request_id: string; why?: string };
export type Receipt = { id: string; request_id: string; op: string; app: string; lock: string; gen: number; at: number; fields: string[]; verified: string | null };
export type Code = "bad" | "human" | "lease" | "draft" | "actor" | "off" | "background" | "unsupported" | "denied" | "failed" | "unknown";
export type Out = { ok: true; op: string; result: unknown; receipt: Receipt; replay?: true } | { ok: false; code: Code; hint: string };

const fail = (code: Code, hint: string): Out => ({ ok: false, code, hint });
const NAME = /^[A-Za-z0-9_.-]{1,40}$/, ID = /^[A-Za-z0-9_.:-]{1,80}$/;

// 欄の検査。カタログに無い欄・型違い・長すぎ・必須の欠けは断る（agent が余計な欄で別の操作を紛れ込ませない）
function checkInput(def: OpDef, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input は { 欄の名前: 値 } の形で渡してください";
  for (const k of Object.keys(input)) if (!Object.hasOwn(def.input, k)) return `「${k}」は ${def.name} の欄ではありません（欄: ${Object.keys(def.input).join(", ") || "なし"}）`;
  for (const [k, f] of Object.entries(def.input)) {
    const v = (input as Record<string, unknown>)[k];
    if (v === undefined) { if (f.required) return `欄「${k}」が要ります`; continue; }
    if (typeof v !== f.type || (typeof v === "number" && !Number.isFinite(v))) return `欄「${k}」は ${f.type} で渡してください`;
    if (typeof v === "string" && (v.length > (f.max ?? 1000) || (f.required && !v.trim()))) return `欄「${k}」は ${f.required ? "空でなく " : ""}${f.max ?? 1000} 字までです`;
  }
  return null;
}

export function makeRuntime(deps: Deps) {
  const now = deps.now ?? Date.now, catalog = new Map((deps.catalog ?? CATALOG).map((d) => [d.name, d]));
  for (const n of catalog.keys()) if (!NAME.test(n) || Object.hasOwn(deps.humanOps, n)) throw new Error(`カタログに入れられない操作名: ${n}`);
  const lock = makeLocks();
  // request_id ごとの結果。実行に入った物（結果が分からない物も）だけ残す＝再送で 2 度実行しない。断った物は残さない（直して同じ id で出し直せる）
  const seen = new Map<string, { print: string; p: Promise<Out> }>();

  async function run(req: Req, by: "agent" | "human"): Promise<Out> {
    const token = String(req.target ?? "");
    const gate = deps.check(token);
    if (!gate.ok) return fail("lease", gate.hint);
    const def = catalog.get(req.op);
    if (!def) { // カタログに無い: 実行せず下書き。面は貸されている agent だけ（下書きの置き場を荒らさせない）
      const d = deps.draft({ owner: gate.face.owner, face: gate.face.app, gen: gate.face.gen, op: req.op, fields: req.input && typeof req.input === "object" && !Array.isArray(req.input) ? req.input : {}, why: String(req.why ?? "").trim() || "カタログに無い操作" });
      return d.ok ? fail("draft", `「${req.op}」は操作のカタログに無いので実行していません。下書き（${d.id}）として人に残しました。画面操作（click / type_text）で代わりに済ませず、ここで止まって人に伝えてください`) : fail("bad", d.hint);
    }
    if (def.actor === "human" && by !== "human") return fail("actor", `${def.name} は人だけが実行できる操作です（agent からは実行できません）`);
    if (gate.face.app !== def.app) return fail("lease", `${def.name} は ${def.app} の面に貸された時だけ使えます（この面は ${gate.face.app}）`);
    const bad = checkInput(def, req.input);
    if (bad) return fail("bad", bad);
    if (!deps.adapters[def.via]) return fail("unsupported", `${def.name} を実行する道（${def.via}）がまだありません。何も実行していません`);
    if (deps.hidden?.(gate.face) && def.background !== "verified") return fail("background", `${def.name} は隠したままで動くと確かめられていません（${def.background === "no" ? "不可" : "未検証"}）。何も実行していません`);

    // 同じ request_id の 2 度目: 前の結果を返す（実行中なら同じ結果を待つ）。別の内容で使い回された id は断る
    const sid = `${gate.face.owner}|${req.request_id}`, print = JSON.stringify([req.op, gate.face.key, req.input]);
    const prev = seen.get(sid);
    if (prev) return prev.print !== print ? fail("bad", "その request_id は別の内容で使われています。新しい request_id で送ってください") : prev.p.then((o) => (o.ok ? { ...o, replay: true as const } : o));
    const p = execute(def, req, token, gate.face, by).catch((e): Out => fail("failed", `実行の前で止まりました（${String(e?.message ?? e)}）。何も実行していません`));
    seen.set(sid, { print, p });
    if (seen.size > 500) seen.delete(seen.keys().next().value!);
    void p.then((o) => { if (!o.ok && o.code !== "unknown") seen.delete(sid); }); // 断りも「何も変えていない失敗」も残さない（同じ id で出し直せる）。結果が分からない物と成功だけ残す
    return p;
  }

  async function execute(def: OpDef, req: Req, token: string, face: Face, by: "agent" | "human"): Promise<Out> {
    // 承認（read は表に関係なく通る）。write は承認の表: 切る = 断る・先に聞く = 人に聞く・許す = 通す
    if (def.perm === "write" && by === "agent") {
      if (face.write === "off" || face.write === "mod") return fail("off", `${face.app} は人が「読むだけ」にしているので、${def.name} は実行できません。何も実行していません`);
      if (face.write === "ask") {
        const what = `${def.app} に「${def.label}」: ${Object.entries(req.input).map(([k, v]) => `${k}=${shownText(v, 40)}`).join(" / ")}`;
        const a = await deps.ask(token, def.name, what);
        if (!a.ok) return fail("denied", a.hint);
      }
    }
    const key = lockKey(def, face, req.input);
    const release = def.perm === "write" ? await lock(key) : () => {};
    try {
      // 実行の直前（承認や順番待ちの間に取り戻された物は送らない）
      const g = deps.check(token);
      if (!g.ok) return fail("lease", g.hint);
      if (deps.hidden?.(g.face) && def.background !== "verified") return fail("background", `${def.name} は隠したままで動くと確かめられていません。何も実行していません`);
      // 締切を過ぎたら signal を落とす。Adapter は次の手に進まず、動いている子 process も止める（鍵を返した後に書きが走らない）
      const ac = new AbortController();
      const r = await withTimeout(deps.adapters[def.via]!.execute(def, req.input, { face: g.face, request_id: req.request_id, signal: ac.signal }), deps.timeoutMs ?? 30_000).catch((e): { ok: false; error: string; unknown: boolean } => { ac.abort(); return { ok: false, error: String(e?.message ?? e), unknown: true }; });
      try { deps.record?.({ at: now(), face: face.key, app: face.app, owner: face.owner, gen: g.face.gen, op: def.name, value: Object.keys(req.input).join(","), result: r.ok ? "ok" : r.unknown ? "unknown" : "error" }); } catch {}
      if (!r.ok) return r.unknown ? fail("unknown", `${def.name} を送った後に結果が分からなくなりました（${r.error}）。同じ操作を送り直さず、${def.verify}ことで確かめてください`) : fail("failed", `${def.name} は実行できませんでした（${r.error}）。何も変えていません`);
      return { ok: true, op: def.name, result: r.result, receipt: { id: randomUUID().slice(0, 8), request_id: req.request_id, op: def.name, app: def.bundle, lock: key.sub ? `${key.app}#${key.sub}` : key.app, gen: g.face.gen, at: now(), fields: Object.keys(req.input), verified: r.verified ?? null } };
    } finally { release(); }
  }

  // 外から入る口。by は呼ぶ側の配線が決める（要求の中身からは決まらない）。既定は agent＝人専用の物は通らない
  return async (req: Req, by: "agent" | "human" = "agent"): Promise<Out> => {
    if (!req || typeof req !== "object" || typeof req.op !== "string" || typeof req.target !== "string" || typeof req.request_id !== "string" || !ID.test(req.request_id)) return fail("bad", "op・target（貸された面）・request_id（英数字と _ . : - の 80 字まで）が要ります");
    if (Object.hasOwn(deps.humanOps, req.op)) return fail("human", `${deps.humanOps[req.op]}は人が押す物です（Runtime からは呼べません）`);
    return run(req, by);
  };
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`${ms}ms で返りませんでした`)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

// ---------- Fake Adapter（片 1・2 の試験用。実機には触れない） ----------
// 呼ばれた回数と入力を記録するだけ。hold を渡すと、その間は返らない（競合の試験で「実行中」を作る）
export function fakeAdapter(hold?: (def: OpDef) => Promise<void>) {
  const calls: { op: string; input: Record<string, unknown>; request_id: string }[] = [];
  const adapter: Adapter = {
    async execute(def, input, ctx) {
      calls.push({ op: def.name, input: { ...input }, request_id: ctx.request_id });
      await hold?.(def);
      return { ok: true, result: { fake: true, n: calls.length }, verified: "fake: 記録だけ（実機は未接触）" };
    },
  };
  return Object.assign(adapter, { calls });
}

// ---------- 本物の Adapter: Reminders（片 3・docs/BRIEF-aw3.md・図 docs/diagrams.md §AW1） ----------
// 約束: 画面・マウス・キー・clipboard は使わない。Reminders を前に出さない・起こさない。
//  - 送る script は全部 scriptGate（W41 と同じ。activate / launch / open / run / quit / System Events などの語を拒む）を通す
//  - 起動していなければ何も送らない（`tell application` は未起動の app を起こして Dock に出す）。起動の確認は `is running`（起こさない）
//  - 書く前に読みを 1 回通す（Automation の許可 dialog はここで出る＝書きの最中に止まって「結果が分からない」にならない）
// 注: 「既存の名前つき op の Reminders」は APP_OPS に無かった（Obsidian・Notes・Terminal だけ）。script の組み立てはここ 1 か所
export type Osa = (script: string, o?: { signal?: AbortSignal; source?: boolean }) => Promise<{ ok: boolean; text: string; killed?: boolean }>;
// osascript を 1 回（lease.ts の osa の既定と同じ・15 秒で kill）。signal が落ちたら止める。source = `-s s`（文字列が引用符つきで返る＝読みの区切りが曖昧にならない）
export const runOsa: Osa = async (script, o) => {
  const p = Bun.spawn(["osascript", ...(o?.source ? ["-s", "s"] : []), "-e", script], { stdout: "pipe", stderr: "pipe" });
  let killed = false;
  const kill = () => { killed = true; p.kill(); };
  const t = setTimeout(kill, 15_000);
  if (o?.signal?.aborted) kill(); else o?.signal?.addEventListener("abort", kill, { once: true });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(t);
  o?.signal?.removeEventListener("abort", kill);
  return { ok: code === 0, text: (code === 0 ? out : err).trim(), ...(killed ? { killed } : {}) };
};

// AppleScript の文字列 literal。改行・tab は escape で 1 行のまま持つ（scriptGate は script 内の改行を断る）
export const asLit = (v: string) => `"${v.replace(/[\\"\n\r\t]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c]!)}"`;

// `osascript -s s` の出力（{{"a", "b"}, {"c", "d"}}）を読む。文字列・入れ子の { }・裸の語（missing value など）だけ
export function parseOsaList(src: string): unknown {
  let i = 0;
  const sp = () => { while (src[i] === " ") i++; };
  const val = (): unknown => {
    sp();
    if (src[i] === "{") {
      i++;
      const a: unknown[] = [];
      for (;;) {
        sp();
        if (src[i] === "}") { i++; return a; }
        if (i >= src.length) throw new Error("閉じていない {");
        a.push(val());
        sp();
        if (src[i] === ",") i++;
      }
    }
    if (src[i] === '"') {
      let s = "";
      for (i++; i < src.length && src[i] !== '"'; i++) { if (src[i] === "\\") i++; s += src[i] ?? ""; }
      if (i >= src.length) throw new Error("閉じていない \"");
      i++;
      return s;
    }
    const m = /^[^,{}]+/.exec(src.slice(i));
    if (!m) throw new Error("読めない出力");
    i += m[0].length;
    return m[0].trim();
  };
  const v = val();
  if (src.slice(i).trim()) throw new Error("出力の後ろに余りがあります");
  return v;
}

const REM = 'application id "com.apple.reminders"', tellRem = (body: string) => `tell ${REM} to ${body}`;
const ONE_LINE = /[\x00-\x1f\x7f]/, MULTI_LINE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/; // lease.ts の op の slot と同じ（notes だけ改行・tab を許す）
const same = (a: string, b: string) => { const n = (x: string) => x.replace(/\r\n?/g, "\n").trim().normalize("NFC"); return n(a) === n(b); };
const LIST_MAX = 50;
// 受け取った後かもしれない失敗（Apple event の締切 -1712・接続切れ -609）
const MAYBE_DONE = /\(-1712\)|\(-609\)/;
const why = (t: string) => /\(-1743\)/.test(t) ? "Reminders への操作が許されていません。システム設定 > プライバシーとセキュリティ > オートメーション で、Kangae を動かしている app（Terminal など）に Reminders を許してください" : t.slice(0, 200) || "Reminders から返事がありません";

export function remindersAdapter(osa: Osa = runOsa): Adapter {
  return {
    async execute(def, input, ctx) {
      const stop = () => ctx.signal?.aborted ? { ok: false as const, error: "締切を過ぎたので、次の手に進まず中止しました" } : null;
      const send = async (script: string, source = false): ReturnType<Osa> => { const g = scriptGate(script); return g ? { ok: false, text: g } : osa(script, { signal: ctx.signal, source }); };
      const list = input.list === undefined ? undefined : String(input.list);
      if (def.name !== "reminders.add" && def.name !== "reminders.list") return { ok: false, error: `${def.name} は Reminders の Adapter が持つ操作ではありません` };
      if (list !== undefined && ONE_LINE.test(list)) return { ok: false, error: "list は 1 行です（改行・制御文字は渡せません）" };
      const title = String(input.title ?? ""), notes = input.notes === undefined ? "" : String(input.notes);
      if (def.name === "reminders.add" && (ONE_LINE.test(title) || MULTI_LINE.test(notes))) return { ok: false, error: "title は 1 行です（notes は改行と tab 以外の制御文字を渡せません）" };

      // 読みを 1 回（起動・許可・リストの在り処）。ここまでは何も変えない＝失敗は failed
      const up = await send(`${REM} is running`);
      if (!up.ok) return { ok: false, error: why(up.text) };
      if (up.text !== "true") return { ok: false, error: "Reminders が起動していません。agent は app を起こしません（Dock に出るため）。人に起動を頼み、起きてからもう一度頼んでください" };
      let where: string;
      if (list !== undefined) {
        const n = await send(tellRem(`count of (lists whose name is ${asLit(list)})`));
        if (!n.ok) return { ok: false, error: why(n.text) };
        if (n.text !== "1") return { ok: false, error: n.text === "0" ? `リスト「${shownText(list, 40)}」がありません（リストは作りません）` : `リスト「${shownText(list, 40)}」は ${n.text} 個あり、どれか決められません（名前が同じ）` };
        where = list;
      } else {
        const d = await send(tellRem("name of default list"));
        if (!d.ok) return { ok: false, error: why(d.text) };
        where = d.text;
      }
      if (stop()) return stop()!;

      if (def.name === "reminders.list") {
        const r = await send(tellRem(`get {id, name} of (${list !== undefined ? `reminders of list ${asLit(list)}` : "reminders"} whose completed is false)`), true);
        if (!r.ok) return { ok: false, error: why(r.text) }; // 読みは何も変えない＝締切で止めても failed
        let ids: unknown, names: unknown;
        try { [ids, names] = parseOsaList(r.text) as unknown[]; } catch (e) { return { ok: false, error: `Reminders の返事を読めませんでした（${(e as Error).message}）` }; }
        if (!Array.isArray(ids) || !Array.isArray(names) || ids.length !== names.length || ![...ids, ...names].every((x) => typeof x === "string")) return { ok: false, error: "Reminders の返事の形が想定と違います" };
        const items = ids.slice(0, LIST_MAX).map((id, i) => ({ id, title: names[i] }));
        return { ok: true, result: { list: where, count: ids.length, items, ...(ids.length > LIST_MAX ? { truncated: true } : {}) }, verified: `${ids.length} 件を読み、${items.length} 件を返した（上限 ${LIST_MAX}）` };
      }

      // 書く（1 回だけ）。返ってきた id で読み直して照合する
      const make = `make new reminder ${list !== undefined ? `at end of reminders of list ${asLit(list)} ` : ""}with properties {name:${asLit(title)}${notes ? `, body:${asLit(notes)}` : ""}}`;
      const w = await send(tellRem(`get id of (${make})`));
      if (!w.ok) return w.killed || MAYBE_DONE.test(w.text) ? { ok: false, unknown: true, error: `Reminders に送った後で返事が途切れました（${why(w.text)}）` } : { ok: false, error: why(w.text) };
      const id = w.text;
      const lost = (m: string) => ({ ok: false as const, unknown: true, error: `足したはずですが、${m}` });
      if (!/^[\x21-\x7e]{1,200}$/.test(id)) return lost("id が返りませんでした");
      const nm = await send(tellRem(`get name of reminder id ${asLit(id)}`));
      if (!nm.ok || !same(nm.text, title)) return lost(`id ${shownText(id, 80)} を読み直しても title が一致しません`);
      if (notes) {
        const bd = await send(tellRem(`get body of reminder id ${asLit(id)}`));
        if (!bd.ok || !same(bd.text, notes)) return lost(`id ${shownText(id, 80)} の notes が読み直しと一致しません`);
      }
      return { ok: true, result: { id, title, ...(notes ? { notes } : {}), list: where }, verified: `id ${id} で読み直し、title${notes ? " と notes" : ""} が一致` };
    },
  };
}

// ---------- 配線: 本物の下書き（drafts.ts）・leases（lease.ts の check / askOp / list）に繋ぐ ----------
export const draftsTo = (home: string): Deps["draft"] => (d) => { const r = addDraft(home, d); return r.ok ? { ok: true, id: r.draft.id } : r; };
export const fromLeases = (leases: Pick<ReturnType<typeof makeLeases>, "check" | "askOp" | "list">): Pick<Deps, "check" | "ask"> => ({
  check(token) {
    const c = leases.check(token);
    if (!c.ok) return c;
    const l = leases.list().find((x) => x.key === token.split("|")[0]);
    if (!l) return { ok: false, why: "unknown", hint: "分からない面です" };
    const s = l.surface;
    return { ok: true, face: { key: l.key, owner: l.owner, gen: l.gen, app: s.app, ...("pid" in s ? { pid: s.pid, windowId: s.windowId } : { tabId: s.tabId }), write: l.rights.write } };
  },
  ask: (token, op, what) => leases.askOp(token, op, what),
});
