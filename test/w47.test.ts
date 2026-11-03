// W47（EXP-1 B）: 「Canvas の来週の task を Google Doc にまとめる」を画面操作なし・クリップボードなしの 1 本の通り道として、偽の Canvas / Docs の上で通す。
// 実 Canvas・実 Docs は実験役（Canvas の API の形は cutoff 時点の公式 REST の知識・未測）
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { WEB_OPS, checkParams, parseBody, weekOf } from "../src/webops.ts";

let dir: string, calls: { tool: string; args: Record<string, any> }[];
beforeEach(() => { dir = mktmp("w47"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const NOW = new Date(2026, 9, 14, 10, 0, 0); // 2026-10-14（水）→ 来週 = 10-19（月）〜 10-25（日）
const CANVAS = "https://school.instructure.com";
const planner = [
  { plannable_date: "2026-10-21T14:59:00Z", context_name: "CS101", plannable_type: "assignment", plannable: { title: "Lab 3", points_possible: 20 }, submissions: { submitted: false } },
  { plannable_date: "2026-10-20T03:00:00Z", context_name: "MATH200", plannable_type: "quiz", plannable: { title: "Quiz 5", points_possible: 10 }, planner_override: { marked_complete: true } },
];
let status = 200, bodyText = "while(1);" + JSON.stringify(planner);
const b64 = (s: string) => Buffer.from(s).toString("base64");
const web = (): Driver => ({ call: async (tool, args) => {
  calls.push({ tool, args });
  if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: args.tabId === 7 ? "DC" : "DD" } };
  if (tool === "tab_info") return { text: "", isError: false, data: { url: args.tabId === 7 ? `${CANVAS}/` : "https://docs.google.com/document/d/abc/edit", docId: args.tabId === 7 ? "DC" : "DD" } };
  if (tool === "api_fetch") return { text: "", isError: false, data: { status, url: args.url, headers: [], body: b64(bodyText) } };
  return { text: "ok", isError: false, data: null };
}, close() {} });
const mk = () => { const cards: { tool: string; danger?: boolean; note?: string }[] = []; const L: ReturnType<typeof makeLeases> = makeLeases(dir, { web: web(), defaultMode: "ask", approvalMs: 2000, now: () => NOW.getTime(), onChange: () => queueMicrotask(() => L.approvals().forEach((a) => { cards.push({ tool: a.tool, danger: (a as any).danger, note: (a as any).note }); L.answer(a.id, true, true); })) }); return { L, cards }; };
const faces = (L: ReturnType<typeof makeLeases>) => {
  const c = L.give({ tabId: 7, docId: "DC", app: "web", title: "Canvas", url: `${CANVAS}/` }, "s:1"), d = L.give({ tabId: 8, docId: "DD", app: "web", title: "週報", url: "https://docs.google.com/document/d/abc/edit" }, "s:1");
  if (!c.ok || !d.ok) throw new Error();
  return { canvas: tokenOf(c.lease), docs: tokenOf(d.lease) };
};
const sent = () => calls.filter((c) => !["tab_state", "tab_info", "gate_on"].includes(c.tool)).map((c) => c.tool);

test("W47 週の窓: 来週 = 次の月曜〜日曜・今週 = この週の月曜〜日曜（水曜・日曜・月曜の今日で）", () => {
  expect(weekOf(new Date(2026, 9, 14), "next")).toEqual({ start: "2026-10-19", end: "2026-10-25" });
  expect(weekOf(new Date(2026, 9, 14), "this")).toEqual({ start: "2026-10-12", end: "2026-10-18" });
  expect(weekOf(new Date(2026, 9, 18), "next")).toEqual({ start: "2026-10-19", end: "2026-10-25" }); // 日曜
  expect(weekOf(new Date(2026, 9, 19), "next")).toEqual({ start: "2026-10-26", end: "2026-11-01" }); // 月曜
  expect(weekOf(new Date(2026, 11, 30), "next")).toEqual({ start: "2027-01-04", end: "2027-01-10" }); // 年またぎ
});

test("W47 欄の検査・while(1); の除去: 表に無い欄の値は断り、頭の while(1); を落として読む", () => {
  const op = WEB_OPS.find((o) => o.name === "canvas-week")!;
  expect(checkParams(op, {})).toEqual({ ok: true, p: { week: "next" } });
  expect(checkParams(op, { week: "this" })).toEqual({ ok: true, p: { week: "this" } });
  expect(checkParams(op, { week: "../../x" }).ok).toBe(false);
  expect(parseBody('while(1);[{"a":1}]')).toEqual([{ a: 1 }]);
  expect(parseBody("<html>login</html>")).toBeUndefined();
});

test("W47 通し: Canvas の tab で web_op（card 無し・日付順・来週の窓の GET だけ）→ Doc の tab で click → type_text（毎回 card・clipboard 0・Canvas の tab には書かない）", async () => {
  const { L, cards } = mk();
  const t = faces(L);
  const r = await L.act(t.canvas, "web_op", { op: "canvas-week" });
  expect(r.ok).toBe(true);
  const j = JSON.parse((r as any).text);
  expect(j.week).toBe("next");
  expect(j.items.map((i: any) => i.title)).toEqual(["Quiz 5", "Lab 3"]); // 日付順
  expect(j.items[1]).toMatchObject({ course: "CS101", type: "assignment", points: 20, done: false });
  expect(j.items[0].done).toBe(true);
  expect(cards).toEqual([]); // 読むだけは card 無し
  const f = calls.find((c) => c.tool === "api_fetch")!;
  expect(f.args).toMatchObject({ url: `${CANVAS}/api/v1/planner/items?start_date=2026-10-19&end_date=2026-10-25&per_page=50`, method: "GET", tabId: 7 });
  // 要約を Doc へ（2 回書く: 2 回とも card・「この頼みの間」を押されても聞き直す）
  const summary = j.items.map((i: any) => `- ${i.due.slice(0, 10)} ${i.course} ${i.title}`).join(" / "); // 1 行（改行は Enter 扱いで別の理由の danger になるので使わない）
  expect((await L.act(t.docs, "click", { x: 100, y: 200 })).ok).toBe(true);
  expect((await L.act(t.docs, "type_text", { text: summary })).ok).toBe(true);
  expect((await L.act(t.docs, "type_text", { text: "以上" })).ok).toBe(true);
  const docCards = cards.filter((c) => c.tool === "type_text");
  expect(docCards).toHaveLength(2);
  expect(docCards.every((c) => c.danger === true && /Google Docs/.test(c.note ?? ""))).toBe(true);
  const typed = calls.filter((c) => c.tool === "type_text");
  expect(typed.map((c) => c.args.tabId)).toEqual([8, 8]); // 書いたのは Doc の tab だけ
  expect(typed[0]!.args.text).toContain("Lab 3");
  expect(sent().filter((x) => ["hotkey", "press_key"].includes(x))).toEqual([]); // clipboard の key は 1 つも無い
  expect(calls.filter((c) => c.tool === "api_fetch").every((c) => c.args.method === "GET")).toBe(true);
});

test("W47 agent が渡せない物: url・path・method・別の origin は無視され、読むのは貸した tab の origin の表の path だけ。op の欄は表の値だけ", async () => {
  const { L } = mk();
  const t = faces(L);
  await L.act(t.canvas, "web_op", { op: "canvas-week", url: "https://evil.example/steal", path: "/x", method: "POST", tabId: 8, headers: { cookie: "x" } });
  const f = calls.find((c) => c.tool === "api_fetch")!;
  expect(f.args.url.startsWith(`${CANVAS}/api/v1/planner/items?`)).toBe(true);
  expect(f.args.method).toBe("GET");
  expect(f.args.tabId).toBe(7);
  expect(JSON.stringify(f.args.headers)).not.toContain("cookie");
  expect((await L.act(t.canvas, "web_op", { op: "canvas-week", week: "../x" })).ok).toBe(false);
  expect((await L.act(t.canvas, "web_op", { op: "nope" })).ok).toBe(false);
});

test("W47 Canvas 側の失敗は人の言葉で返す: 401（login 切れ）・HTML（API の無い頁）・取り戻された面・app の窓では使えない", async () => {
  const { L } = mk();
  const t = faces(L);
  status = 401; bodyText = "{}";
  expect(await L.act(t.canvas, "web_op", { op: "canvas-week" })).toMatchObject({ ok: false, hint: expect.stringContaining("login していません") });
  status = 200; bodyText = "<html>sign in</html>";
  expect(await L.act(t.canvas, "web_op", { op: "canvas-todo" })).toMatchObject({ ok: false, hint: expect.stringContaining("Canvas ではない") });
  status = 200; bodyText = "while(1);" + JSON.stringify(planner);
  L.takeback("tab:7");
  expect((await L.act(t.canvas, "web_op", { op: "canvas-week" })).ok).toBe(false);
  const La = makeLeases(dir, { driver: () => ({ call: async () => ({ text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } }), close() {} }), defaultMode: "allow" });
  const g = La.give({ pid: 10, windowId: 1, app: "Pad", title: "" }, "s:2");
  if (!g.ok) throw new Error();
  expect(await La.act(tokenOf(g.lease), "web_op", { op: "canvas-week" })).toMatchObject({ ok: false, hint: expect.stringContaining("web の tab") });
  status = 200;
});

test("W47 Canvas の tab・Doc の tab 以外への書き込みの card は従来どおり（Doc だけ毎回）: Canvas の tab への type_text は「この頼みの間」で聞き直さない", async () => {
  const { L, cards } = mk();
  const t = faces(L);
  await L.act(t.canvas, "type_text", { text: "a", element_token: "d1" });
  await L.act(t.canvas, "type_text", { text: "b", element_token: "d1" });
  expect(cards.filter((c) => c.tool === "type_text")).toHaveLength(1); // 1 回目の答え（turn）が 2 回目に効く
});
