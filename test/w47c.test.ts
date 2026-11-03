// W47c: Canvas の読みが途中まで（truncated）だった時、Doc に書く文に「一部のみ」が出るかを、W45 の道（拡張の page() の type_text が同 origin の iframe の中の編集面へ入れる）の実物の上で偽の Docs に通す。
// 偽 = Canvas の応答（1 頁 25ms の偽の時計で時間の上限に当てる）と、Docs の DOM（iframe の中の contenteditable）。拡張の page() と常駐の門は実物
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { installChrome, load } from "./fake-chrome";
import { mktmp } from "./tmp.ts";

const O = "https://school.instructure.com";
const NOW = new Date(2026, 9, 14, 10, 0, 0);
const b64 = (s: string) => Buffer.from(s).toString("base64");
let dir: string, model: string[], notes: string[];
beforeEach(() => { dir = mktmp("w47c"); model = []; notes = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); for (const k of ["document", "__kangae", "addEventListener"]) delete (globalThis as any)[k]; });

const item = (n: number) => ({ context_type: "Course", course_id: 42, plannable_id: String(n), plannable_type: "assignment", plannable: { title: `課題 ${n}`, due_at: `2026-10-${String(19 + (n % 6)).padStart(2, "0")}T14:59:00Z` }, planner_override: null, html_url: `/courses/42/assignments/${n}` });

// 偽の Docs: 同 origin の iframe（docs-texteventtarget-iframe）の中の contenteditable が focus を持つ。execCommand("insertText") が model に積む
function fakeDocs() {
  const g = globalThis as any;
  const editable = { isContentEditable: true, tagName: "DIV", focus() {}, ownerDocument: { execCommand: (_c: string, _u: boolean, t: string) => { model.push(t); return true; } } };
  const iframe = { tagName: "IFRAME", focus() {}, contentDocument: { activeElement: editable } };
  g.document = { activeElement: iframe, body: {}, hasFocus: () => false, documentElement: { getAttribute: () => null } };
  g.addEventListener = () => {};
}

async function setup(pages0: number, budgetMs: number) {
  let pages = pages0;
  installChrome({ tabs: [7, 8] });
  const g = globalThis as any, c = g.chrome;
  const exec0 = c.scripting.executeScript;
  c.scripting.executeScript = async (o: any) => (o.func?.name === "page" ? [{ result: await o.func(...(o.args ?? [])) }] : exec0(o)); // 拡張の page() だけ実際に走らせる
  fakeDocs();
  const { webRun } = await load("web");
  const docId = ((await webRun("tab_state", { tabId: 8 })) as any).data.docId as string;
  let clock = 1_000_000, page = 0;
  const spy = spyOn(Date, "now").mockImplementation(() => clock);
  const web: Driver = { close() {}, call: async (tool, args) => {
    if (args.tabId === 7) { // 偽の Canvas の tab
      if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: "DC" } };
      if (tool === "tab_info") return { text: "", isError: false, data: { url: `${O}/`, docId: "DC" } };
      if (tool === "api_fetch") { clock += 25; page++; return { text: "", isError: false, data: { status: 200, url: args.url, headers: page < pages ? [["link", `<${O}/api/v1/planner/items?page=${page + 1}>; rel="next"`]] : [], body: b64(JSON.stringify([item(page)])) } }; }
      return { text: "ok", isError: false, data: null };
    }
    const r: any = await webRun(tool, args as any); // Docs の tab は実物の拡張の道
    return { text: String(r.text ?? ""), isError: !!r.error, data: r.data ?? null };
  } };
  const L: ReturnType<typeof makeLeases> = makeLeases(dir, { web, defaultMode: "allow", now: () => NOW.getTime(), webOpBudgetMs: budgetMs, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => { notes.push(String((a as any).note ?? "")); L.answer(a.id, true); })) });
  const gc = L.give({ tabId: 7, docId: "DC", app: "web", title: "Canvas", url: `${O}/` }, "s:1"), gd = L.give({ tabId: 8, docId, app: "web", title: "週報", url: "https://docs.google.com/document/d/abc/edit" }, "s:1");
  if (!gc.ok || !gd.ok) throw new Error("give");
  return { L, canvas: tokenOf(gc.lease), docs: tokenOf(gd.lease), spy, setPages: (n: number) => { pages = n; page = 0; } };
}
const summaryOf = (j: any, withNote: boolean) => `${j.items.map((i: any) => `- ${i.due.slice(0, 10)} ${i.title}`).join(" / ")}${withNote ? "（一部のみ）" : ""}`;

test("W47c 途中までの読み: agent が「一部のみ」を入れて書くと、W45 の道で偽の Docs の編集面に「一部のみ」が入り、card に警告は出ない", async () => {
  const s = await setup(50, 60); // 1 頁 25ms・予算 60ms ＝ 3 頁で止まる
  try {
    const r = await s.L.act(s.canvas, "web_op", { op: "canvas-week" });
    const j = JSON.parse((r as any).text);
    expect(j.truncated).toBe(true);
    expect(j.note).toContain("一部のみ"); // agent への指示が返事に在る
    expect((await s.L.act(s.docs, "type_text", { text: summaryOf(j, true) })).ok).toBe(true);
    expect(model.join("")).toContain("一部のみ");
    expect(notes.at(-1)).toContain("Google Docs の本文に書き込みます");
    expect(notes.at(-1)).not.toContain("⚠");
  } finally { s.spy.mockRestore(); }
});

test("W47c 入れ忘れ: 途中までの読みなのに「一部のみ」の語が無い文を書こうとすると、card に「途中までです（時間の上限）・一部のみの語がありません」が出る（止めはしない・人が決める）", async () => {
  const s = await setup(50, 60);
  try {
    const j = JSON.parse(((await s.L.act(s.canvas, "web_op", { op: "canvas-week" })) as any).text);
    expect((await s.L.act(s.docs, "type_text", { text: summaryOf(j, false) })).ok).toBe(true);
    const n = notes.at(-1)!;
    expect(n).toContain("⚠ 直前の Canvas の読みは途中までです");
    expect(n).toContain("時間の上限");
    expect(n).toContain("「一部のみ」の語がありません");
    expect(model.join("")).not.toContain("一部のみ"); // 人が許したので書かれた（警告は止めない）
  } finally { s.spy.mockRestore(); }
});

test("W47c 全部読めた時は警告が出ない・途中までの読みの印は、その後の全部読めた読みで消える", async () => {
  const s = await setup(50, 60);
  try {
    expect(JSON.parse(((await s.L.act(s.canvas, "web_op", { op: "canvas-week" })) as any).text).truncated).toBe(true); // 途中まで
    s.setPages(2); // こんどは 2 頁で終わる（50ms < 60ms）
    const full = JSON.parse(((await s.L.act(s.canvas, "web_op", { op: "canvas-week" })) as any).text);
    expect(full.truncated).toBeUndefined();
    await s.L.act(s.docs, "type_text", { text: summaryOf(full, false) });
    expect(notes.at(-1)).not.toContain("⚠");
  } finally { s.spy.mockRestore(); }
});

test("W47c 途中までの読みの印は turn の物: turn が終われば、次の turn の別の文に警告は出ない", async () => {
  const s = await setup(50, 60);
  try {
    await s.L.act(s.canvas, "web_op", { op: "canvas-week" });
    s.L.endTurn("s:1");
    await s.L.act(s.docs, "type_text", { text: "次の turn の別の文" });
    expect(notes.at(-1)).not.toContain("⚠");
  } finally { s.spy.mockRestore(); }
});
