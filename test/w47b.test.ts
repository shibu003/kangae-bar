// W47b: Canvas の API の形（公式文書で確認）・頁送り・失敗の文。出典（2026-10-13 に読んだ）:
//  planner: https://developerdocs.instructure.com/services/canvas/resources/planner（start_date / end_date は yyyy-mm-dd または ISO 8601・応答は配列・plannable_date と context_name は例に無い）
//  頁送り: https://developerdocs.instructure.com/services/canvas/basics/file.pagination（既定 10 件・Link は opaque・rel=next が無くなるまで辿る・rel=last は無いことがある）
//  while(1); は公式文書に記述が無い（community の投稿: Accept に application/json が無いと付く）。念のため落として読む
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { MAX_ITEMS, MAX_PAGES, WEB_OPS, nextOf } from "../src/webops.ts";

let dir: string, calls: { tool: string; args: Record<string, any> }[];
beforeEach(() => { dir = mktmp("w47b"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const NOW = new Date(2026, 9, 14, 10, 0, 0);
const O = "https://school.instructure.com";
const b64 = (s: string) => Buffer.from(s).toString("base64");
// 公式の例に近い形（plannable_date と context_name が無い・course_id と plannable の中の due_at だけ）
const docItem = (n: number) => ({ context_type: "Course", course_id: 42, plannable_id: String(n), plannable_type: "assignment", plannable: { id: n, title: `課題 ${n}`, due_at: `2026-10-${String(19 + (n % 6)).padStart(2, "0")}T14:59:00Z`, points_possible: 10 }, planner_override: null, submissions: { excused: false, graded: false, late: false, missing: false, needs_grading: false, with_feedback: false }, html_url: `/courses/42/assignments/${n}` });

type Resp = { status?: number; url?: string; body?: string; headers?: [string, string][]; err?: string };
let route: (url: string) => Resp;
const web = (): Driver => ({ call: async (tool, args) => {
  calls.push({ tool, args });
  if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: "DC" } };
  if (tool === "tab_info") return { text: "", isError: false, data: { url: `${O}/`, docId: "DC" } };
  if (tool === "api_fetch") { const r = route(String(args.url)); return r.err ? { text: r.err, isError: true, data: null } : { text: "", isError: false, data: { status: r.status ?? 200, url: r.url ?? args.url, headers: r.headers ?? [], body: b64(r.body ?? "[]") } }; }
  return { text: "ok", isError: false, data: null };
}, close() {} });
const setup = (o = O) => { const L = makeLeases(dir, { web: web(), defaultMode: "allow", now: () => NOW.getTime() }); const g = L.give({ tabId: 7, docId: "DC", app: "web", title: "Canvas", url: `${o}/` }, "s:1"); if (!g.ok) throw new Error(); return { L, t: tokenOf(g.lease) }; };
const fetched = () => calls.filter((c) => c.tool === "api_fetch").map((c) => c.args.url as string);
const run = async (t = "") => { const { L, t: tok } = setup(); return { r: await L.act(tok, "web_op", { op: "canvas-week" }), L }; };

test("W47b 公式の例に近い形（plannable_date / context_name / submitted が無い）でも、日付・授業・題・点・完了を落とさない", async () => {
  route = () => ({ body: JSON.stringify([docItem(3), docItem(1)]) });
  const { r } = await run();
  const j = JSON.parse((r as any).text);
  expect(j.items.map((i: any) => i.title)).toEqual(["課題 1", "課題 3"]);
  expect(j.items[0]).toMatchObject({ due: "2026-10-20T14:59:00Z", course: "course_42", type: "assignment", points: 10, done: false, url: "/courses/42/assignments/1" });
  expect(j).toMatchObject({ week: "next", from: "2026-10-19", to: "2026-10-25" });
});

test("W47b 頁送り: Link の rel=next を同 origin の /api/v1/ だけ辿り、無くなったら止まる（大文字小文字・複数の rel・opaque な URL）", async () => {
  const p2 = `${O}/api/v1/planner/items?page=bookmark:abc&per_page=50`, p3 = `${O}/api/v1/planner/items?page=bookmark:def&per_page=50`;
  route = (u) => u.includes("bookmark:abc") ? { body: JSON.stringify([docItem(2)]), headers: [["Link", `<${p3}>; rel="next", <${p2}>; rel="current"`]] } : u.includes("bookmark:def") ? { body: JSON.stringify([docItem(3)]), headers: [["link", `<${O}/api/v1/planner/items?page=1>; rel="first"`]] } : { body: JSON.stringify([docItem(1)]), headers: [["link", `<${p2}>; rel="next", <${O}/x?page=9>; rel="last"`]] };
  const { r } = await run();
  expect(JSON.parse((r as any).text).items.map((i: any) => i.title)).toEqual(["課題 1", "課題 2", "課題 3"]);
  expect(fetched()).toHaveLength(3);
  expect(fetched()[1]).toBe(p2); // opaque: 作り直さずそのまま
  expect(calls.filter((c) => c.tool === "api_fetch").every((c) => c.args.method === "GET")).toBe(true);
});

test("W47b 頁送りの歯止め: 別 origin・/api/v1/ の外・不正な next は辿らない／next を永遠に返す site は安全の上限で止まり truncated を返す", async () => {
  expect(nextOf(`<https://evil.example/api/v1/x>; rel="next"`, O)).toBeNull();
  expect(nextOf(`<${O}/courses/1>; rel="next"`, O)).toBeNull();
  expect(nextOf(`<not a url>; rel="next"`, O)).toBeNull();
  expect(nextOf(`<${O}/api/v1/a>; rel="prev"`, O)).toBeNull();
  expect(nextOf(undefined, O)).toBeNull();
  route = () => ({ body: JSON.stringify([docItem(1)]), headers: [["link", `<https://evil.example/api/v1/steal>; rel="next"`]] });
  await run();
  expect(fetched().every((u) => u.startsWith(O))).toBe(true);
  expect(fetched()).toHaveLength(1);
  // 無限に next を返す site（応答が即時）: 安全の上限 MAX_PAGES で止まる
  calls = [];
  let n = 0;
  route = () => ({ body: JSON.stringify([docItem(++n)]), headers: [["link", `<${O}/api/v1/planner/items?page=${n + 1}>; rel="next"`]] });
  const { r } = await run();
  expect(fetched()).toHaveLength(MAX_PAGES);
  expect(JSON.parse((r as any).text)).toMatchObject({ truncated: true, note: expect.stringContaining("安全の上限") });
  expect(JSON.parse((r as any).text).note).toContain("一部のみ");
  // 件数の安全の上限
  calls = [];
  route = () => ({ body: JSON.stringify(Array.from({ length: 120 }, (_, i) => docItem(i))), headers: [["link", `<${O}/api/v1/planner/items?page=2>; rel="next"`]] });
  const big = await run();
  expect(JSON.parse((big.r as any).text).items.length).toBe(MAX_ITEMS);
  expect(JSON.parse((big.r as any).text).note).toContain("件");
});

test("W47b 0 件: 「無い」と決めつけず、人の次の一手（Canvas の予定表で確かめる）と『課題を足さない』を返す", async () => {
  route = () => ({ body: "while(1);[]" });
  const { r } = await run();
  const j = JSON.parse((r as any).text);
  expect(j.items).toEqual([]);
  expect(j.note).toContain("0 件");
  expect(j.note).toContain("予定表");
  expect(j.note).toContain("推測で課題を足さない");
});

test("W47b 未 login: 401・403・login 頁への redirect（同 origin の /login）・別 origin の SSO への redirect は、どれも「Canvas の tab で login してから」を返す", async () => {
  for (const resp of [{ status: 401, body: '{"errors":[{"message":"user authorisation required"}]}' }, { status: 403 }, { status: 200, url: `${O}/login/canvas`, body: "<html>login</html>" }, { err: "別の site（https://sso.example）へ移されました。login が切れているかもしれません" }] as Resp[]) {
    route = () => resp;
    const { r } = await run();
    expect(r).toMatchObject({ ok: false, hint: expect.stringContaining("Canvas の tab で login してから") });
  }
});

test("W47b Canvas でない origin: 404・HTML・{errors} など配列でない返りは「Canvas の tab を渡して」と返し、中身は渡さない", async () => {
  for (const resp of [{ status: 404, body: "<html>not found</html>" }, { status: 200, body: "<html>hello</html>" }, { status: 200, body: '{"errors":[{"message":"x"}]}' }, { status: 200, body: '{"items":[1]}' }] as Resp[]) {
    route = () => resp;
    const { r } = await run();
    const hint = String((r as any).hint); // bun の toMatchObject は非対称 matcher で受け取り側の値を書き換えるので先に取る
    expect(r.ok).toBe(false);
    expect(hint).toContain("Canvas の tab");
    expect(hint).not.toContain("hello");
  }
  route = () => ({ status: 500 });
  expect(((await run()).r as any).hint).toContain("HTTP 500");
});

test("W47b 取り戻された面は、頁送りの途中でも結果を渡さない", async () => {
  const { L, t } = setup();
  let first = true;
  route = (u) => { if (first) { first = false; L.takeback("tab:7"); return { body: JSON.stringify([docItem(1)]), headers: [["link", `<${O}/api/v1/planner/items?page=2>; rel="next"`]] }; } return { body: JSON.stringify([docItem(2)]) }; };
  const r = await L.act(t, "web_op", { op: "canvas-week" });
  expect(r).toMatchObject({ ok: false, why: "gen" });
  expect(fetched()).toHaveLength(1);
});

test("W47b op の表: 出典の URL が表の根拠として残っている・planner の欄は公式の名前（start_date / end_date）", () => {
  const op = WEB_OPS.find((o) => o.name === "canvas-week")!;
  expect(op.build({ week: "next" }, NOW)).toBe("/api/v1/planner/items?start_date=2026-10-19&end_date=2026-10-25&per_page=50");
});

// ---- W60f: 頁送りは最後まで・上限は時間で・途中の結果も返す ----
test("W60f 最後まで: 旧い上限（5 頁・200 件）を超える 12 頁 × 50 件 = 600 件が、全部・日付順で返り、truncated は付かない", async () => {
  let page = 0;
  route = () => { page++; return { body: JSON.stringify(Array.from({ length: 50 }, (_, i) => docItem(page * 100 + i))), headers: page < 12 ? [["link", `<${O}/api/v1/planner/items?page=${page + 1}>; rel="next"`]] : [] }; };
  const { r } = await run();
  const j = JSON.parse((r as any).text);
  expect(fetched()).toHaveLength(12);
  expect(j.items).toHaveLength(600);
  expect(j.truncated).toBeUndefined();
  expect(j.note).toBeUndefined();
});

test("W60f 時間の上限: 応答が遅い site は、時間（試験は 60ms の予算・1 頁 25ms の偽の時計）で止まり、ここまでの結果を truncated と「時間の上限」つきで返す（失敗にしない）", async () => {
  let clock = 1_000_000, page = 0;
  const spy = spyOn(Date, "now").mockImplementation(() => clock); // 実時間に頼らない（混んだ機械で揺れる）: 1 頁ごとに偽の時計を 25ms 進める
  try {
    const slow = (b: number) => { const L = makeLeases(dir, { web: { ...web(), call: async (tool: string, args: Record<string, any>) => { if (tool === "api_fetch") { clock += 25; page++; calls.push({ tool, args }); return { text: "", isError: false, data: { status: 200, url: args.url, headers: [["link", `<${O}/api/v1/planner/items?page=${page + 1}>; rel="next"`]], body: b64(JSON.stringify([docItem(page)])) } }; } return web().call(tool, args); } } as Driver, defaultMode: "allow", now: () => NOW.getTime(), webOpBudgetMs: b }); const g = L.give({ tabId: 7, docId: "DC", app: "web", title: "Canvas", url: `${O}/` }, "s:1"); if (!g.ok) throw new Error(); return L.act(tokenOf(g.lease), "web_op", { op: "canvas-week" }); };
    const r = await slow(60);
    const j = JSON.parse((r as any).text);
    expect(r.ok).toBe(true);
    expect(j.items).toHaveLength(3); // 25・50・75ms の 3 頁（3 頁目の後に 75 >= 60 で止まる）
    expect(j.truncated).toBe(true);
    expect(j.note).toContain("時間の上限");
    expect(j.note).toContain("3 件を返します");
    // 予算を替えても（無限に next を返す遅い site でも）時間で必ず止まる
    page = 0; calls = [];
    const r2 = await slow(30);
    expect(JSON.parse((r2 as any).text).items).toHaveLength(2);
    expect(JSON.parse((r2 as any).text).truncated).toBe(true);
  } finally { spy.mockRestore(); }
});
