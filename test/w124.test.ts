// W124（docs/BRIEF-w124.md）: 操作の下書きは歯車の「覚えた物」に並ぶ。案が在る行だけ［案を使って操作にする］・捨てるは 2 段。
// 本物のブラウザ・常駐には触れない（domshim で描画・call は偽物）。実機の見た目は未測（要 operator）。
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom } from "./domshim.ts";

beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const js = read("extension/panel.js");
const html = read("extension/panel.html");

const SUG = { script: "SECRET-SCRIPT-BODY", permission: "read", what: "今日のメールを集める", bundle: "b", at: 1 };
const A = { id: "d1", owner: "x", face: "f", gen: 1, op: "mailSweep", fields: [], why: "同じ手順を 2 回やりました", at: 1, suggestion: SUG };
const B = { id: "d2", owner: "x", face: "f", gen: 1, op: "notesCopy", fields: [], why: "1 回だけ", at: 2 };

function draw(listAnswer: unknown) {
  const g = globalThis as any;
  const mk = (tag: string, cls: string) => Object.assign(g.document.createElement(tag), { className: cls });
  const txt = (tag: string, cls: string, text: string) => { const x = mk(tag, cls); x.textContent = text; return x; };
  const box = g.document.createElement("section"); box.hidden = true;
  const empty = g.document.createElement("p");
  const calls: [string, any][] = [];
  const toasts: [string, any][] = [];
  let answers: Record<string, any> = { draftList: listAnswer, draftPromote: { ok: true }, draftDrop: { ok: true } };
  const call = async (op: string, extra: any = {}) => { calls.push([op, extra]); return answers[op]; };
  const $ = (id: string) => (id === "op-drafts" ? box : id === "learned-empty" ? empty : { hidden: true });
  const src = js.slice(js.indexOf("function paintOpDraft("), js.indexOf("async function loadOpenAllow()"));
  const api = new Function("mk", "txt", "plain", "$", "call", "toast", "paintLearnedEmpty", `${src}\nreturn { loadOpDrafts };`)(
    mk, txt, (s: unknown) => String(s ?? ""), $, call, (t: string, o: any) => toasts.push([t, o]), () => {},
  ) as { loadOpDrafts: () => Promise<void> }; // any を spread すると draw() の返りが丸ごと any になる
  const buttons = () => box.querySelectorAll("button");
  const find = (label: string) => buttons().find((b: any) => b.textContent === label);
  return { box, calls, toasts, answers: (v: Record<string, any>) => { answers = { ...answers, ...v }; }, find, buttons, ...api };
}

test("AC1 2 件（案あり 1・なし 1）→ 行 2 つ・案ありだけ［案を使って操作にする］・script は出ない", async () => {
  const t = draw({ ok: true, drafts: [A, B] });
  await t.loadOpDrafts();
  expect(t.box.hidden).toBe(false);
  expect(t.box.textContent).toContain("下書き");
  expect(t.box.querySelectorAll("div").filter((d: any) => d.className === "draft").length).toBe(2);
  const use = t.buttons().filter((b: any) => b.textContent === "案を使って操作にする");
  expect(use.length).toBe(1);
  expect(use[0].className).toBe("btn primary");
  expect(t.box.textContent).toContain("案: 今日のメールを集める（読むだけ）");
  expect(t.box.textContent).not.toContain("SECRET-SCRIPT-BODY");
});

test("AC2 押すと draftPromote {draftId, useSuggestion:true} を 1 回だけ・2 度押しで 2 回呼ばない・済めば toast", async () => {
  const t = draw({ ok: true, drafts: [A] });
  await t.loadOpDrafts();
  const use = t.find("案を使って操作にする");
  use.click(); use.click();
  await Promise.resolve(); await Promise.resolve();
  expect(t.calls.filter(([op]) => op === "draftPromote")).toEqual([["draftPromote", { draftId: "d1", useSuggestion: true }]]);
  expect(use.disabled).toBe(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(t.toasts[0]![0]).toBe("操作にしました");
});

test("AC2b 失敗は返りの hint を toast・ボタンは戻る", async () => {
  const t = draw({ ok: true, drafts: [A] });
  t.answers({ draftPromote: { ok: false, hint: "この下書きに案はありません" } });
  await t.loadOpDrafts();
  const use = t.find("案を使って操作にする");
  use.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(t.toasts[0]).toEqual(["この下書きに案はありません", { tone: "warn" }]);
  expect(use.disabled).toBe(false);
});

test("AC3 ［捨てる］1 押しでは draftDrop を呼ばず［本当に捨てる］に変わり、2 押し目で呼ぶ", async () => {
  const t = draw({ ok: true, drafts: [B] });
  await t.loadOpDrafts();
  const drop = t.find("捨てる");
  expect(drop.className).toBe("btn quiet");
  drop.click();
  expect(t.calls.filter(([op]) => op === "draftDrop").length).toBe(0);
  expect(drop.textContent).toBe("本当に捨てる");
  expect(drop.className).toBe("btn danger");
  drop.click();
  await new Promise((r) => setTimeout(r, 0));
  expect(t.calls.filter(([op]) => op === "draftDrop")).toEqual([["draftDrop", { draftId: "d2" }]]);
});

test("AC4 0 件・古い常駐（ok でない）は小見出しごと出さない", async () => {
  for (const ans of [{ ok: true, drafts: [] }, { ok: false, hint: "知らない操作です" }]) {
    const t = draw(ans);
    await t.loadOpDrafts();
    expect(t.box.hidden).toBe(true);
    expect(t.box.textContent).not.toContain("下書き");
  }
});

test("AC5 口: panel.html の覚えた物の中に在り・settings の開閉と broadcast drafts が読み直す", () => {
  const pop = html.slice(html.indexOf('<kg-settings id="user-pop"'), html.indexOf("</kg-settings>"));
  expect(pop.indexOf('id="op-drafts"')).toBeGreaterThan(pop.indexOf("<summary>覚えた物</summary>"));
  expect(js).toContain('if (res.type === "drafts") { if (!$("settings").hidden) void loadOpDrafts(); return; }');
  expect(js).toMatch(/name === "settings"\) \{[^\n]*void loadOpDrafts\(\)/);
});
