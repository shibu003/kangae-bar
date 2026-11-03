// review27: 4d が書いた W49（定時は人が見ている面に書く前に待つ）・W50（Bar の直近 5 件）・wtnew を、書いていない目で攻撃
//  W49: 定時の印が turn の外（人の turn・終わった後）に漏れて、普通の会話まで待たされないか／待ちを諦めた hold が残らないか
//  W50: 記録の 1 行が肥大して人の panel を空にできないか・値や secure 欄が漏れないか・agent が別の名で読めないか
//  wtnew: 名前の検査が locale ですり抜けないか・指す先の無い symlink で branch だけ残らないか・同じ名前の同時実行
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver, type OpRecord } from "../src/lease.ts";
import { LINE_MAX, lineOf, recentFor } from "../src/opsview.ts";
import { makeSched } from "../src/sched.ts";
import { mktmp } from "./tmp.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000); // R27-9 は locale × 名前で 48 回 sh を起こす（混んだ機械で 5 秒を超えた）

const root = join(import.meta.dir, "..");
const src = (f: string) => readFileSync(join(root, f), "utf8");
let dir: string;
beforeEach(() => { dir = realpathSync(mktmp("r27")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ================= W49 =================
test("R27-1 定時の印は turn のもの: 定時の turn が終われば消え、次の人の turn は定時でない・人の turn に続けて並んだ定時の turn だけ定時", () => {
  const runningOf = new Set<string>();
  const s = makeSched((o) => runningOf.has(o));
  // 定時の turn（routine が起こす）
  runningOf.add("s:1"); s.begin("s:1", true);
  expect(s.is("s:1")).toBe(true);
  // turn が終わる（run は idle・印は end で消える）。以前は印が残り、次の人の turn が「定時」になった
  runningOf.delete("s:1"); s.end("s:1");
  runningOf.add("s:1"); s.begin("s:1", false); // 人の turn
  expect(s.is("s:1")).toBe(false);
  s.end("s:1"); runningOf.delete("s:1");
  // end を忘れても（異常終了）、次の人の turn の begin(false) で外れる
  runningOf.add("s:1"); s.begin("s:1", true); runningOf.delete("s:1");
  runningOf.add("s:1"); s.begin("s:1", false);
  expect(s.is("s:1")).toBe(false);
  // 走っていない間は、印が残っていても定時と言わない
  s.begin("s:2", true); expect(s.is("s:2")).toBe(false);
  // 他の会話の印は混ざらない
  runningOf.add("s:3"); s.begin("s:3", true); expect(s.is("s:3")).toBe(true); expect(s.is("s:1")).toBe(false);
});

test("R27-2 配線: fire は scheduled:true を渡し、turn の始めに begin・終わりに end・queue も印を運ぶ・owner 全体の旧い Set は無い", () => {
  const m = src("src/main.ts");
  expect(m).not.toContain("scheduledOwners");
  const fire = m.slice(m.indexOf("fire: (r, text) =>"), m.indexOf("fire: (r, text) =>") + 900);
  expect(fire).toContain("scheduled: true");
  expect((fire.match(/scheduled: true/g) ?? []).length).toBe(2); // instruct と workspace の両方
  expect(m).toMatch(/^\s*sched\.begin\(`s:\$\{r\.nodeId\}`, !!r\.sched\);/m); // コメントに残った文字では通らない（行の頭の呼び）
  expect(m).toMatch(/^\s*sched\.end\(`s:\$\{r\.nodeId\}`\);/m);
  expect(m).toContain("scheduled: m.scheduled === true"); // 走っている run に並べる時
  expect(m).toContain("next.scheduled === true");        // 並んだ turn が始まる時
  expect(m).toContain("scheduled: sched.is");
});

const mkFake = () => { const calls: string[] = []; const d: Driver = { call: async (tool) => { calls.push(tool); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }; }, close() {} }; return { d, writes: () => calls.filter((t) => t === "type_text").length }; };

test("R27-3 待ちを諦めた定時の hold は残らない: 定時の write が時間切れで断られた後、次の（定時でない）turn の write は、人が同じ面を見ていても待たされない", async () => {
  const f = mkFake();
  let scheduled = true;
  const L = makeLeases(dir, { driver: () => f.d, defaultMode: "allow", leaveMs: 40, scheduled: () => scheduled });
  L.seeFront(99);
  const g = L.give({ pid: 10, windowId: 1, app: "Pad", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  expect(g.lease.hold).toBeFalsy();
  const t = tokenOf(g.lease);
  L.seeFront(10); // 人がこの面を見始めた
  const r1 = await L.act(t, "type_text", { text: "a" });
  expect(r1).toMatchObject({ ok: false, why: "waiting" }); // 定時の write は待って、時間切れで断られた
  expect(f.writes()).toBe(0);
  expect(L.list()[0]!.hold).toBeFalsy(); // 定時の待ちのために足した hold は戻る
  expect(L.list()[0]!.waitSince).toBeFalsy();
  scheduled = false; // 次は人の turn
  const r2 = await L.act(t, "type_text", { text: "b" });
  expect(r2.ok).toBe(true);
  expect(f.writes()).toBe(1);
});

test("R27-4 定時の write は人が離れるまで待ち、その間に読む（get_window_state）は待たない・面を触らない仕事は何も待たない", async () => {
  const f = mkFake();
  const L = makeLeases(dir, { driver: () => f.d, defaultMode: "allow", leaveMs: 60_000, scheduled: () => true });
  L.seeFront(99);
  const g = L.give({ pid: 10, windowId: 1, app: "Pad", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  const t = tokenOf(g.lease);
  L.seeFront(10);
  expect((await L.act(t, "get_window_state", {})).ok).toBe(true);
  const p = L.act(t, "type_text", { text: "a" });
  await tick(30);
  expect(f.writes()).toBe(0);
  L.seeFront(99);
  expect((await p).ok).toBe(true);
  expect(f.writes()).toBe(1);
});

// ================= W50 =================
test("R27-5 agent が知らない道具の名前を巨大にしても、記録の 1 行は肥大しない（以前は op に名前がそのまま入り、1 行が MB になって人の panel が空になった）", async () => {
  const recs: OpRecord[] = [];
  const f = mkFake();
  const L = makeLeases(dir, { driver: () => f.d, defaultMode: "allow", record: (e) => recs.push(e) });
  const g = L.give({ pid: 10, windowId: 1, app: "Pad", title: "x".repeat(500) }, "s:1");
  if (!g.ok) throw new Error();
  await L.act(tokenOf(g.lease), "x".repeat(900_000), { text: "y".repeat(900_000) });
  await tick(30);
  expect(recs).toHaveLength(1);
  expect(JSON.stringify(recs[0]).length).toBeLessThan(1024);
  expect(recs[0]!.op.length).toBeLessThanOrEqual(40);
  expect(recs[0]!.result).toBe("refused:tool");
});

test("R27-6 肥大した行（古い記録・手で足された行）が最新の位置にあっても、手前の記録まで届く・LINE_MAX を超える行は読まない", () => {
  const f = join(dir, "ops.jsonl");
  const rec = (i: number): OpRecord => ({ at: i, face: "tab:5", app: "web", gen: 1, op: "type_text", value: `v${i}`, result: "ok", owner: "s:1", where: "Canvas" });
  for (let i = 0; i < 7; i++) appendFileSync(f, JSON.stringify(rec(i)) + "\n");
  appendFileSync(f, JSON.stringify({ ...rec(99), op: "x".repeat(900_000) }) + "\n"); // 最新が 900KB の 1 行
  appendFileSync(f, JSON.stringify({ ...rec(98), value: "z".repeat(LINE_MAX + 10) }) + "\n");
  const got = recentFor(f, "s:1");
  expect(got.map((x) => x.at)).toEqual([6, 5, 4, 3, 2]);
});

test("R27-7 壊れた行・型の違う行・null・別の会話・巨大な owner は飛ばし、値は伏せたまま（secure の中身も JSON の引数も出ない）", () => {
  const f = join(dir, "ops.jsonl");
  const ok = (o: Partial<OpRecord>): OpRecord => ({ at: 1, face: "tab:5", app: "web", gen: 1, op: "type_text", value: "hello", result: "ok", owner: "s:1", where: "Canvas", ...o });
  for (const l of ["null", "123", '"str"', "[]", '{"owner":"s:1","op":5,"result":"ok"}', '{"owner":"s:1","op":"click","result":{"a":1}}', '{"owner":"s:1","op":"click","result":"ok","face":7,"value":[1]}', "{壊れた", ""]) appendFileSync(f, l + "\n");
  appendFileSync(f, JSON.stringify(ok({ value: "〈伏せ〉", at: 2 })) + "\n");
  appendFileSync(f, JSON.stringify(ok({ op: "scroll", value: '{"direction":"down","text":"hunter2"}', at: 3 })) + "\n");
  appendFileSync(f, JSON.stringify(ok({ owner: "s:2", value: "OTHER", at: 4 })) + "\n");
  const got = recentFor(f, "s:1");
  const text = got.map((x) => x.line).join("\n");
  expect(text).toContain("中身は伏せ");
  expect(text).not.toMatch(/hunter2|direction|OTHER/);
  expect(got.every((x) => x.line.length < 200)).toBe(true);
  expect(lineOf(ok({ value: "x".repeat(10_000), where: "w".repeat(10_000) })).length).toBeLessThan(300);
});

test("R27-8 agent は opsRecent を読めない: 別の名・大文字小文字・余白・owner つき・CLI・agent 印は全部断る／ops.jsonl を読む所は opsview 1 つだけ", async () => {
  const { makeHandler, defaultWorkspace } = await import("../src/main.ts");
  const { openStore } = await import("../src/store.ts");
  const ui = join(dir, "ui"); mkdirSync(ui);
  const s = openStore(":memory:");
  const rt = s.add(null, "user", "頼み", true);
  appendFileSync(join(ui, "ops.jsonl"), JSON.stringify({ at: 1, face: "tab:5", app: "web", gen: 1, op: "click", value: "", result: "ok", owner: `s:${rt.id}`, where: "x" }) + "\n");
  const H: any = makeHandler(s, async () => [], undefined, { ...defaultWorkspace(), dir: join(dir, "nodes") }, { uiHome: ui, leaseDriver: () => null });
  expect((await H({ op: "opsRecent", rootId: rt.id }, {})).items).toHaveLength(1); // 人の panel
  for (const [msg, owner] of [[{ op: "opsRecent", rootId: rt.id }, { write() {} }], [{ op: "opsRecent", rootId: rt.id, owner: "s:1" }, {}], [{ op: "opsRecent", rootId: rt.id, agent: true }, {}], [{ op: "opsrecent", rootId: rt.id }, {}], [{ op: "OpsRecent", rootId: rt.id }, {}], [{ op: " opsRecent", rootId: rt.id }, {}], [{ op: "opsRecent\n", rootId: rt.id }, {}], [{ op: "ops", rootId: rt.id }, {}]] as const) {
    const r = await H(msg, owner);
    expect(r.items, JSON.stringify(msg)).toBeUndefined();
  }
  // ops.jsonl を読む src は opsview だけ（main は追記だけ）
  const readers = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts") && /ops\.jsonl/.test(src(`src/${f}`)) && /readFileSync|openSync|createReadStream/.test(src(`src/${f}`).split("\n").filter((l) => /ops\.jsonl/.test(l)).join("\n")));
  expect(readers).toEqual([]); // ops.jsonl という名前を持つ行で読む物は無い（読むのは recentFor に file の path が渡る所だけ）
  expect(src("src/main.ts").match(/recentFor\(/g)!.length).toBe(1);
});

// ================= wtnew =================
function repo() {
  const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" });
  const r = join(dir, "repo"); mkdirSync(r);
  git(r, "init", "-q"); git(r, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(join(r, "tools")); copyFileSync(join(root, "tools/wt-new.sh"), join(r, "tools/wt-new.sh"));
  const wts = join(dir, "wts"); mkdirSync(wts);
  const make = (name: string, env: Record<string, string> = {}) => Bun.spawnSync(["sh", join(r, "tools/wt-new.sh"), name], { env: { ...Bun.env, KANGAE_WT_DIR: wts, KANGAE_WT_BASE: "HEAD", KANGAE_WT_NO_INSTALL: "1", ...env } as Record<string, string>, cwd: r, stdout: "pipe", stderr: "pipe" });
  const branches = () => git(r, "branch", "--list", "impl/*").stdout.toString().split("\n").map((l) => l.replace(/^[+* ]+/, "").trim()).filter(Boolean);
  return { r, wts, make, branches };
}

test("R27-9 wtnew の名前の検査は locale に左右されない: en_US.UTF-8 で é・ñ・全角・濃音などが通らず、何も作られない（以前は é が通って branch と dir ができた）", () => {
  const { wts, make, branches } = repo();
  for (const loc of ["C", "en_US.UTF-8", "ja_JP.UTF-8"]) for (const n of ["A", "É", "é", "ñ", "ｗ51", "Ａ", "w5 1", "w51;id", "$(id)", ".", "..", "w51\nx", "w51\tx", "ｗ", "ü", "ß"]) {
    const r = make(n, { LC_ALL: loc });
    expect(r.exitCode, `${loc} [${n}] ${r.stderr}`).toBe(2);
  }
  expect(branches()).toEqual([]);
  expect(readdirSync(wts)).toEqual([]);
  expect(make("ok-1", { LC_ALL: "en_US.UTF-8" }).exitCode).toBe(0); // 正しい名前は通る
});

test("R27-10 wtnew: 指す先の無い symlink がある名前は『既にあります』で止まり、branch を残さない・symlink の先に何も作らない", () => {
  const { wts, make, branches } = repo();
  const out = join(dir, "outside"); mkdirSync(out);
  symlinkSync(join(out, "new"), join(wts, "dang"));
  const r = make("dang");
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("既にあります");
  expect(branches()).toEqual([]);
  expect(readdirSync(out)).toEqual([]);
});

test("R27-11 wtnew: 同じ名前を同時に 2 本打つと、1 本だけ作られ、もう 1 本は既存の worktree・branch を壊さない", async () => {
  const { wts, make, branches } = repo();
  const rs = await Promise.all([0, 1].map(async () => make("race")));
  const codes = rs.map((x) => x.exitCode).sort();
  expect(codes[0]).toBe(0);
  expect(codes[1]).not.toBe(0);
  expect(branches()).toEqual(["impl/race"]);
  expect(existsSync(join(wts, "race", ".git"))).toBe(true);
  expect(Bun.spawnSync(["git", "-C", join(wts, "race"), "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim()).toBe("impl/race");
});
