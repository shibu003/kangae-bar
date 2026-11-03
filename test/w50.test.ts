// W50: 人が裏の仕事を見る面。ops.jsonl（W42a の記録）を agent ごとの直近 5 件の 1 行にして Bar の agent の行に出す。人の panel だけが読む
import { HUMAN_OPS } from "../src/main.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { lineOf, recentFor } from "../src/opsview.ts";
import { makeLeases, tokenOf, type Driver, type OpRecord } from "../src/lease.ts";
import { mktmp } from "./tmp.ts";

let dir: string;
beforeEach(() => { dir = mktmp("w50"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const src = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const rec = (o: Partial<OpRecord> = {}): OpRecord => ({ at: 1, face: "tab:5", app: "web", gen: 1, op: "type_text", value: "hello", result: "ok", owner: "s:1", where: "Canvas", ...o });
const write = (rs: OpRecord[]) => { for (const r of rs) appendFileSync(join(dir, "ops.jsonl"), JSON.stringify(r) + "\n"); return join(dir, "ops.jsonl"); };

test("W50 1 行: どの tab / 窓で・何を・どうなった（人の言葉・内部の語を使わない）", () => {
  expect(lineOf(rec())).toBe("tab「Canvas」で文字を入れた（hello） → できた");
  expect(lineOf(rec({ face: "10:1", app: "Calculator", where: "", op: "click", value: "", result: "error" }))).toBe("窓（Calculator）で押した → うまくいかなかった");
  expect(lineOf(rec({ result: "refused:human" }))).toContain("人の確認が要るので止まった");
  expect(lineOf(rec({ result: "refused:waiting" }))).toContain("あなたが見ている間は待った");
  expect(lineOf(rec({ op: "draft:submit_form", value: "氏名,住所", result: "draft" }))).toBe("tab「Canvas」: 「submit_form」は自動でやらず、下書きにして止めた（欄: 氏名,住所）");
  for (const r of [rec(), rec({ result: "refused:gen" }), rec({ op: "draft:x", result: "draft" })]) expect(lineOf(r)).not.toMatch(/面|世代|lease|gen\b/);
});

test("W50 値は伏せたまま: secure の欄の中身（〈伏せ〉）は 1 行にも出ない・JSON の引数も出さない", () => {
  const l = lineOf(rec({ value: "〈伏せ〉" }));
  expect(l).toContain("中身は伏せ");
  expect(l).not.toContain("hunter2");
  expect(lineOf(rec({ op: "scroll", value: '{"direction":"down"}' }))).not.toContain("direction");
});

test("W50 recentFor: その会話の分だけ・新しい順・5 件まで・壊れた行は飛ばす・別の会話や file が無い時は空", () => {
  const f = write([...Array.from({ length: 8 }, (_, i) => rec({ at: i, value: `v${i}` })), rec({ owner: "s:2", value: "other" })]);
  appendFileSync(f, "{壊れた行\n");
  const got = recentFor(f, "s:1");
  expect(got.map((x) => x.at)).toEqual([7, 6, 5, 4, 3]);
  expect(got.some((x) => x.line.includes("other"))).toBe(false);
  expect(recentFor(f, "s:9")).toEqual([]);
  expect(recentFor(join(dir, "none.jsonl"), "s:1")).toEqual([]);
  expect(recentFor(f, "../x")).toEqual([]); // 会話の形でない owner は読まない
});

test("W50 記録に owner と where（面の題）が入る: lease の act が書く", async () => {
  const d: Driver = { call: async (tool) => ({ text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }), close() {} };
  const recs: OpRecord[] = [];
  const L: ReturnType<typeof makeLeases> = makeLeases(dir, { driver: () => d, web: d, defaultMode: "allow", record: (e) => recs.push(e), onChange: () => queueMicrotask(() => L.approvals().forEach((x) => L.answer(x.id, true))) });
  const g = L.give({ pid: 10, windowId: 1, app: "Calc", title: "計算\n機" }, "s:3");
  if (!g.ok) throw new Error();
  await L.act(tokenOf(g.lease), "click", { x: 1, y: 2 });
  await Bun.sleep(20);
  expect(recs[0]).toMatchObject({ owner: "s:3", where: "計算 機", app: "Calc" });
});

test("W50 配線: 常駐の opsRecent は人の panel だけ（CLI・owner つき・agent は断る）・panel は textContent で 5 件まで・agent の行に出す", () => {
  const m = src("src/main.ts");
  const body = m.slice(m.indexOf('case "opsRecent"'), m.indexOf('case "openFolder"')); // 次の case（同じ guard を持つ）まで入れない
  expect(Object.keys(HUMAN_OPS)).toContain("opsRecent"); // 人の panel だけ＝入口の判定（sec1・HUMAN_OPS）が断る。断る事は test/sec1.test.ts が集合で測る
  expect(body).toContain("recentFor(");
  const p = src("extension/panel.js");
  const fn = p.slice(p.indexOf("async function fillAgentOps"), p.indexOf("async function fillAgentOps") + 1200);
  expect(fn).toContain("textContent");
  expect(fn).toContain("slice(0, 5)");
  expect(fn).not.toContain("innerHTML");
  expect(p).toContain("void fillAgentOps(li, r);");
});
