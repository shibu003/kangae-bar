// AW1: AnyWindow Runtime の片 1・2（src/anywindow.ts・docs/BRIEF-aw1.md・図 docs/diagrams.md §AW1）。
// 通し: {op:"reminders.add", target:<貸した面>, input:{title:"牛乳"}} → カタログに在り・承認が済み・lease が合えば Fake Adapter が 1 回だけ実行し、結果と受領証が返る。
// 負の対照（各 test の末尾コメントに「何を戻すと赤くなるか」）: 下書き経路・世代の再検査・request_id の控え・鍵・人専用の断り
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { CATALOG, conflicts, draftsTo, fakeAdapter, fromLeases, lockKey, makeRuntime, type Deps, type Face, type OpDef } from "../src/anywindow.ts";
import { readDrafts } from "../src/drafts.ts";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { HUMAN_OPS } from "../src/main.ts";

let dir: string;
beforeEach(() => { dir = mktmp("aw1"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tick = () => new Promise((r) => setTimeout(r, 5));
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; };

// ---- 偽の lease（世代・承認の表を試験が握る）。本物の leases との繋ぎは下の「本物の lease」の test ----
type F = { app: string; pid: number; windowId: number; owner: string; write?: Face["write"] };
function fakeGate() {
  const faces = new Map<string, { gen: number; f: F }>(), asked: string[] = [];
  let verdict = true;
  const add = (name: string, f: F) => { faces.set(name, { gen: 1, f }); return `${name}|1|${f.owner}`; };
  const deps: Pick<Deps, "check" | "ask"> = {
    check(token) {
      const [k, g, owner] = token.split("|"), x = faces.get(k!);
      if (!x || x.f.owner !== owner || x.gen !== Number(g)) return { ok: false, why: "gen", hint: "操作権は取り戻されました。止まってください" };
      return { ok: true, face: { key: k!, owner: x.f.owner, gen: x.gen, app: x.f.app, pid: x.f.pid, windowId: x.f.windowId, write: x.f.write ?? "allow" } };
    },
    async ask(token, op, what) { asked.push(`${op}: ${what}`); await tick(); return verdict ? { ok: true } : { ok: false, why: "denied", hint: "人が断りました" }; },
  };
  return { add, deps, asked, revoke: (name: string) => { faces.get(name)!.gen++; }, deny: () => { verdict = false; } };
}
const mkRt = (extra: Partial<Deps> = {}, hold?: (d: OpDef) => Promise<void>) => {
  const g = fakeGate(), fake = fakeAdapter(hold);
  const rt = makeRuntime({ ...g.deps, adapters: { native: fake }, draft: draftsTo(dir), humanOps: HUMAN_OPS, ...extra });
  return { rt, g, fake };
};
const R = { app: "Reminders", pid: 10, windowId: 1, owner: "s:1" };
const add = (token: string, request_id: string, title = "牛乳") => ({ op: "reminders.add", target: token, input: { title }, request_id });

test("通し: reminders.add がカタログ・承認・lease を通って Fake Adapter が 1 回だけ実行し、結果と受領証が返る", async () => {
  const { rt, g, fake } = mkRt();
  const t = g.add("10:1", R);
  const out = await rt(add(t, "r1"));
  expect(out).toMatchObject({ ok: true, op: "reminders.add", result: { fake: true }, receipt: { request_id: "r1", op: "reminders.add", app: "com.apple.reminders", lock: "com.apple.reminders", gen: 1, fields: ["title"] } });
  expect(fake.calls).toEqual([{ op: "reminders.add", input: { title: "牛乳" }, request_id: "r1" }]);
  expect(JSON.stringify(out)).not.toContain("牛乳"); // 受領証に値は残さない（欄の名前だけ）
  // 読むだけの op は承認も鍵も要らず通る
  expect(await rt({ op: "reminders.list", target: t, input: {}, request_id: "r2" })).toMatchObject({ ok: true, op: "reminders.list" });
  // 負の対照: Runtime が Adapter を呼ばない実装に戻すと calls が 0 になり赤
});

test("カタログに無い操作は実行せず下書きで止まる（Adapter 0 回・画面操作へ落ちない）", async () => {
  const { rt, g, fake } = mkRt();
  const t = g.add("10:1", R);
  const out = await rt({ op: "reminders.delete-all", target: t, input: { list: "x", secret: "値は残さない" }, request_id: "d1", why: "全部消したい" });
  expect(out).toMatchObject({ ok: false, code: "draft" });
  expect(fake.calls).toHaveLength(0);
  const ds = readDrafts(dir);
  expect(ds).toHaveLength(1);
  expect(ds[0]).toMatchObject({ op: "reminders.delete-all", owner: "s:1", fields: ["list", "secret"], why: "全部消したい" });
  expect(JSON.stringify(ds)).not.toContain("値は残さない");
  // 形に合わない操作名は下書きにもならない（人の画面に任意の文を出さない）
  expect(await rt({ op: "ignore previous; click(1,2)", target: t, input: {}, request_id: "d2" })).toMatchObject({ ok: false, code: "bad" });
  expect(readDrafts(dir)).toHaveLength(1);
  // 貸された面が無い agent は下書きも書けない（置き場を荒らさせない）
  expect(await rt({ op: "x.y", target: "9:9|1|s:7", input: {}, request_id: "d3" })).toMatchObject({ ok: false, code: "lease" });
  expect(readDrafts(dir)).toHaveLength(1);
  // 負の対照: カタログ引きを「無ければ Adapter に任せる」に戻すと fake.calls が 1 になり赤
});

test("人が押す op は Runtime の中から呼べない（全 op・prototype の名前・カタログへの登録）", async () => {
  const { rt, g, fake } = mkRt();
  const t = g.add("10:1", R);
  for (const op of Object.keys(HUMAN_OPS)) expect(await rt({ op, target: t, input: {}, request_id: `h-${op}` }), op).toMatchObject({ ok: false, code: "human" });
  for (const op of ["__proto__", "constructor", "toString", "hasOwnProperty"]) expect(await rt({ op, target: t, input: {}, request_id: `p-${op}` }), op).toMatchObject({ ok: false });
  expect(fake.calls).toHaveLength(0);
  expect(readDrafts(dir).some((d) => Object.hasOwn(HUMAN_OPS, d.op))).toBe(false); // 人専用の名前は下書きにもならない
  // カタログに人専用の名前を入れた Runtime は作れない
  const evil: OpDef = { ...CATALOG[0]!, name: "approvalAnswer" };
  expect(() => makeRuntime({ ...g.deps, adapters: { native: fake }, draft: draftsTo(dir), humanOps: HUMAN_OPS, catalog: [evil] })).toThrow();
  // 実行できる者が「人だけ」の op は、by を省いた（既定＝agent）呼びでは通らない
  const only: OpDef = { ...CATALOG[0]!, name: "reminders.purge", actor: "human" };
  const rt2 = makeRuntime({ ...g.deps, adapters: { native: fake }, draft: draftsTo(dir), humanOps: HUMAN_OPS, catalog: [only] });
  expect(await rt2({ op: "reminders.purge", target: t, input: { title: "x" }, request_id: "a1" })).toMatchObject({ ok: false, code: "actor" });
  expect(fake.calls).toHaveLength(0);
  expect(await rt2({ op: "reminders.purge", target: t, input: { title: "x" }, request_id: "a2" }, "human")).toMatchObject({ ok: true });
  // 負の対照: 入口の humanOps の断りを外すと、HUMAN_OPS の名前が下書きになり赤
});

test("許していない対象・欄に作用しない: 別 app の面・カタログに無い欄・型違い・必須の欠け・長すぎ", async () => {
  const { rt, g, fake } = mkRt();
  const notes = g.add("20:2", { app: "Notes", pid: 20, windowId: 2, owner: "s:2" });
  const t = g.add("10:1", R);
  expect(await rt(add(notes, "n1"))).toMatchObject({ ok: false, code: "lease" }); // Notes の面で reminders.add は動かない
  for (const [i, input] of [{ title: "a", script: "do shell script" }, { title: 5 }, {}, { title: "" }, { title: "x".repeat(201) }, { title: "a", ["__proto__"]: 1 }, null, [], "title"].entries())
    expect(await rt({ op: "reminders.add", target: t, input: input as any, request_id: `b${i}` }), JSON.stringify(input)).toMatchObject({ ok: false, code: "bad" });
  expect(await rt({ op: "reminders.add", target: t, input: JSON.parse('{"title":"a","__proto__":{"x":1}}'), request_id: "b-proto" })).toMatchObject({ ok: false, code: "bad" });
  expect(await rt({ op: "reminders.add", target: t, input: { title: "a" }, request_id: "bad id\n" })).toMatchObject({ ok: false, code: "bad" });
  expect(fake.calls).toHaveLength(0);
  // 負の対照: 余計な欄を通す実装に戻すと { title, script } が Adapter に届いて赤
});

test("lease の世代: 取り戻された面・他人の token は実行せず、承認や順番待ちの間に取り戻されても実行直前に断る", async () => {
  const { rt, g, fake } = mkRt();
  const t = g.add("10:1", R);
  expect(await rt(add(`10:1|1|s:2`, "o1"))).toMatchObject({ ok: false, code: "lease" }); // 持ち主が違う
  g.revoke("10:1");
  expect(await rt(add(t, "o2"))).toMatchObject({ ok: false, code: "lease" }); // 古い世代
  expect(fake.calls).toHaveLength(0);

  // 順番待ちの間に取り戻す: 1 本目が実行中・2 本目（別窓）は鍵待ち → 2 本目の面を取り戻すと、1 本目が終わっても 2 本目は送られない
  const h = gate(), r2 = mkRt({}, async () => { if (r2.fake.calls.length === 1) await h.p; });
  const t1 = r2.g.add("10:1", R), t2 = r2.g.add("10:2", { ...R, windowId: 2 });
  const p1 = r2.rt(add(t1, "w1")), p2 = r2.rt(add(t2, "w2", "卵"));
  await tick();
  r2.g.revoke("10:2");
  h.open();
  expect(await p1).toMatchObject({ ok: true });
  expect(await p2).toMatchObject({ ok: false, code: "lease" });
  expect(r2.fake.calls.map((c) => c.input.title)).toEqual(["牛乳"]);

  // 承認を待つ間に取り戻す
  const r3 = mkRt(), t3 = r3.g.add("10:1", { ...R, write: "ask" });
  const p3 = r3.rt(add(t3, "q1"));
  r3.g.revoke("10:1");
  expect(await p3).toMatchObject({ ok: false, code: "lease" });
  expect(r3.fake.calls).toHaveLength(0);
  // 負の対照: 実行直前の check（anywindow.ts execute 内の 2 回目）を外すと p2 が実行されて calls が 2 になり赤
});

test("承認の表: 切る・読むだけの mod は断る・先に聞くは人の答え次第（断れば 0 回）・許すは聞かずに通る・読むは表に関係なく通る", async () => {
  const { rt, g, fake } = mkRt();
  expect(await rt(add(g.add("a", { ...R, write: "off" }), "p1"))).toMatchObject({ ok: false, code: "off" });
  expect(await rt(add(g.add("b", { ...R, write: "mod" }), "p2"))).toMatchObject({ ok: false, code: "off" });
  expect(fake.calls).toHaveLength(0);
  const ask = g.add("c", { ...R, write: "ask" });
  expect(await rt(add(ask, "p3"))).toMatchObject({ ok: true });
  expect(g.asked).toEqual(["reminders.add: Reminders に「リマインダーを足す」: title=牛乳"]);
  expect(await rt({ op: "reminders.list", target: ask, input: {}, request_id: "p4" })).toMatchObject({ ok: true });
  expect(g.asked).toHaveLength(1); // 読むだけは聞かない
  g.deny();
  expect(await rt(add(ask, "p5", "卵"))).toMatchObject({ ok: false, code: "denied" });
  expect(fake.calls.map((c) => c.op)).toEqual(["reminders.add", "reminders.list"]);
  // 負の対照: 承認の分岐を外す（ask を飛ばす）と p5 が実行されて calls が 3 になり赤
});

test("同じ request_id は 1 回だけ実行し、2 度目・実行中の再送は前の結果を返す／別の内容での使い回しは断る／断られた物は出し直せる", async () => {
  const h = gate(), { rt, g, fake } = mkRt({}, async () => { await h.p; });
  const t = g.add("10:1", R);
  const a = rt(add(t, "same")), b = rt(add(t, "same")); // 実行中の再送
  await tick();
  h.open();
  const [ra, rb] = await Promise.all([a, b]);
  expect(ra).toMatchObject({ ok: true });
  expect(rb).toMatchObject({ ok: true, receipt: { id: (ra as any).receipt.id } });
  const c = await rt(add(t, "same")); // 終わった後の再送
  expect(c).toMatchObject({ ok: true, replay: true, receipt: { id: (ra as any).receipt.id } });
  expect(fake.calls).toHaveLength(1);
  expect(await rt(add(t, "same", "卵"))).toMatchObject({ ok: false, code: "bad" }); // 同じ id・別の内容
  expect(fake.calls).toHaveLength(1);
  // 別の持ち主の同じ id は別物（他人の id を先回りして塞げない）
  const u = g.add("20:2", { ...R, pid: 20, windowId: 2, owner: "s:2" });
  expect(await rt(add(u, "same"))).toMatchObject({ ok: true });
  expect(fake.calls).toHaveLength(2);
  // 断られた物（lease が無かった）は控えに残らない: 面を渡し直して同じ id で通る
  expect(await rt(add("30:3|1|s:3", "later"))).toMatchObject({ ok: false });
  const v = g.add("30:3", { ...R, pid: 30, windowId: 3, owner: "s:3" });
  expect(await rt(add(v, "later"))).toMatchObject({ ok: true });
  // 負の対照: seen の控えを外すと同じ id で calls が 2 → 3 に増えて赤
});

test("結果が分からなくなった書き（Adapter が返らない・例外）は再送しても実行しない／何も変えていない失敗は出し直せる", async () => {
  const stuck = gate();
  const { rt, g, fake } = mkRt({ timeoutMs: 30 }, async () => { await stuck.p; });
  const t = g.add("10:1", R);
  const out = await rt(add(t, "u1"));
  expect(out).toMatchObject({ ok: false, code: "unknown" });
  expect(await rt(add(t, "u1"))).toMatchObject({ ok: false, code: "unknown" }); // 再送しても実行しない
  expect(fake.calls).toHaveLength(1);
  // 鍵は返っている: 次の別の書きは詰まらずに進む（締切が過ぎた Adapter が居ても app 全体が止まらない）
  expect(await rt(add(t, "u2", "卵"))).toMatchObject({ ok: false, code: "unknown" });
  stuck.open();
  // 何も変えていない失敗（unknown でない）
  let n = 0;
  const bad = makeRuntime({ ...g.deps, humanOps: HUMAN_OPS, draft: draftsTo(dir), adapters: { native: { execute: async () => (++n === 1 ? { ok: false as const, error: "Reminders が開いていません" } : { ok: true as const, result: 1 }) } } });
  expect(await bad(add(t, "f1"))).toMatchObject({ ok: false, code: "failed" });
  expect(await bad(add(t, "f1"))).toMatchObject({ ok: true });
  // 負の対照: 例外を unknown でなく failed に潰すと u1 の再送が実行されて calls が 2 になり赤
});

test("競合: 同じ app の書き 2 つは直列（別窓でも）・別 app は並行・読みは並行・範囲が app 全体の書きは窓の書きと直列・窓どうしは並行", async () => {
  let live = 0, peak = 0;
  const track = async () => { live++; peak = Math.max(peak, live); await tick(); await tick(); live--; };
  const cat: OpDef[] = [
    ...CATALOG,
    { ...CATALOG[0]!, name: "notes.add", app: "Notes", bundle: "com.apple.Notes" },
    { ...CATALOG[0]!, name: "reminders.rename", scope: "window" },
    { ...CATALOG[1]!, name: "reminders.peek", input: { title: { type: "string" } } },
  ];
  const mk2 = () => mkRt({ catalog: cat }, track);
  const both = async (a: (rt: ReturnType<typeof mkRt>) => Promise<unknown>, b: (rt: ReturnType<typeof mkRt>) => Promise<unknown>) => { live = 0; peak = 0; const x = mk2(); await Promise.all([a(x), b(x)]); return peak; };
  const w = (x: ReturnType<typeof mkRt>, name: string, windowId: number, op: string, id: string, app = "Reminders") => x.rt({ op, target: x.g.add(name, { ...R, app, windowId, owner: `s:${windowId}` }), input: { title: "t" }, request_id: id });

  expect(await both((x) => w(x, "10:1", 1, "reminders.add", "a"), (x) => w(x, "10:2", 2, "reminders.add", "b"))).toBe(1); // 同じ app・別窓・範囲 app → 直列
  expect(await both((x) => w(x, "10:1", 1, "reminders.add", "a"), (x) => w(x, "20:2", 2, "notes.add", "b", "Notes"))).toBe(2); // 別 app → 並行
  expect(await both((x) => w(x, "10:1", 1, "reminders.peek", "a"), (x) => w(x, "10:2", 2, "reminders.peek", "b"))).toBe(2); // 読み → 並行
  expect(await both((x) => w(x, "10:1", 1, "reminders.add", "a"), (x) => w(x, "10:2", 2, "reminders.rename", "b"))).toBe(1); // app 全体の書き × 窓の書き → 直列
  expect(await both((x) => w(x, "10:1", 1, "reminders.rename", "a"), (x) => w(x, "10:2", 2, "reminders.rename", "b"))).toBe(2); // 窓 × 別の窓 → 並行
  expect(await both((x) => w(x, "10:1", 1, "reminders.rename", "a"), (x) => w(x, "10:1b", 1, "reminders.rename", "b"))).toBe(1); // 同じ窓 → 直列
  // 負の対照: lock() を素通しにすると 1 と書いた 3 行が 2 になり赤
});

test("鍵の導出: 範囲が分からない書き（窓の番号が無い・file の欄が無い）は app 単位に倒す／競合の判定", () => {
  const face: Face = { key: "k", owner: "s:1", gen: 1, app: "Reminders", write: "allow" };
  const win: OpDef = { ...CATALOG[0]!, scope: "window" };
  expect(lockKey(win, { ...face, pid: 10, windowId: 3 }, {})).toEqual({ app: "com.apple.reminders", sub: "win:10:3" });
  expect(lockKey(win, face, {})).toEqual({ app: "com.apple.reminders" }); // 窓の番号が無い → app 単位
  expect(lockKey({ ...win, scope: "tab" }, { ...face, tabId: 7 }, {})).toEqual({ app: "com.apple.reminders", sub: "tab:7" });
  expect(lockKey({ ...win, scope: "file" }, face, {})).toEqual({ app: "com.apple.reminders" });
  expect(lockKey({ ...win, scope: "file" }, face, { path: "/a" })).toEqual({ app: "com.apple.reminders", sub: "file:/a" });
  expect(lockKey(CATALOG[0]!, { ...face, pid: 10, windowId: 3 }, {})).toEqual({ app: "com.apple.reminders" }); // 範囲が app の op は窓の番号があっても app 単位
  expect(conflicts({ app: "a" }, { app: "a", sub: "w1" })).toBe(true);
  expect(conflicts({ app: "a", sub: "w1" }, { app: "a", sub: "w2" })).toBe(false);
  expect(conflicts({ app: "a" }, { app: "b" })).toBe(false);
});

test("隠している間: 隠したままで動くと検証済みでない書きは送らない（片 4 の口）", async () => {
  const { rt, g, fake } = mkRt({ hidden: () => true });
  expect(await rt(add(g.add("10:1", R), "z1"))).toMatchObject({ ok: false, code: "background" });
  expect(fake.calls).toHaveLength(0);
  const ok = mkRt({ hidden: () => true, catalog: [{ ...CATALOG[0]!, background: "verified" }] });
  expect(await ok.rt(add(ok.g.add("10:1", R), "z2"))).toMatchObject({ ok: true });
});

test("Adapter の道が無い op は何も実行せず断る", async () => {
  const { rt, g } = mkRt({ adapters: {} });
  expect(await rt(add(g.add("10:1", R), "y1"))).toMatchObject({ ok: false, code: "unsupported" });
});

// ---- 本物の lease（src/lease.ts の check / askOp / list）に繋ぐ ----
const driver: Driver = { call: async (tool) => ({ text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }, { pid: 20, window_id: 2 }] } : null }), close() {} };
function real(mode: "allow" | "ask") {
  const L = makeLeases(dir, { driver: () => driver, defaultMode: mode });
  const fake = fakeAdapter();
  const rt = makeRuntime({ ...fromLeases(L), adapters: { native: fake }, draft: draftsTo(dir), humanOps: HUMAN_OPS });
  const give = (app: string, pid: number, windowId: number, owner: string) => { const g = L.give({ pid, windowId, app, title: "" }, owner); if (!g.ok) throw new Error(); return tokenOf(g.lease); };
  return { L, fake, rt, give };
}

test("本物の lease: 通る・取り戻すと断る・人がその面を触ると止まる・別 app の面では動かない", async () => {
  const { L, fake, rt, give } = real("allow");
  const t = give("Reminders", 10, 1, "s:1"), other = give("Notes", 20, 2, "s:2");
  expect(await rt(add(t, "l1"))).toMatchObject({ ok: true });
  expect(await rt(add(other, "l2"))).toMatchObject({ ok: false, code: "lease" });
  expect(await rt(add(`${t.split("|")[0]}|99|s:1`, "l3"))).toMatchObject({ ok: false, code: "lease" }); // 世代の違う token
  L.touch(10); // 人がその面（Reminders の窓）を触った → lease が取り戻される
  expect(await rt(add(t, "l4"))).toMatchObject({ ok: false, code: "lease" });
  expect(fake.calls.map((c) => c.request_id)).toEqual(["l1"]);
  // 負の対照: fromLeases.check を常に ok にすると l2 / l3 / l4 が通って calls が 4 になり赤
});

test("本物の lease: 先に聞く表では承認 card が出て、人が許すまで実行しない（断れば 0 回）", async () => {
  const { L, fake, rt, give } = real("ask");
  const t = give("Reminders", 10, 1, "s:1");
  const p = rt(add(t, "m1"));
  await tick();
  const card = L.approvals();
  expect(card).toHaveLength(1);
  expect(card[0]).toMatchObject({ owner: "s:1", app: "Reminders", tool: "reminders.add", what: "Reminders に「リマインダーを足す」: title=牛乳", danger: true });
  expect(fake.calls).toHaveLength(0); // 人が答えるまで実行しない
  L.answer(card[0]!.id, true);
  expect(await p).toMatchObject({ ok: true });
  expect(fake.calls).toHaveLength(1);
  const q = rt(add(t, "m2", "卵"));
  await tick();
  L.answer(L.approvals()[0]!.id, false);
  expect(await q).toMatchObject({ ok: false, code: "denied" });
  expect(fake.calls).toHaveLength(1);
  // 読むだけは card を出さない
  expect(await rt({ op: "reminders.list", target: t, input: {}, request_id: "m3" })).toMatchObject({ ok: true });
  expect(L.approvals()).toHaveLength(0);
});
