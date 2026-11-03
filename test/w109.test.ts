// W109（docs/BRIEF-w109.md）: 囲んだ行は「画面を囲んで聞きました」。次の一手は 3 つまで、文は切らず折る。進んでいますは既定で畳み、開くと新しい 4 本と「ほか N 件」。
// 本物のブラウザ・ポインタに触れない。実機の見た目は未測（要 operator）。
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount, El } from "./domshim.ts";
beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const cssRules = (css: string) => {
  const out: { sel: string; body: string }[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) for (const sel of m[1]!.split(",")) out.push({ sel: sel.trim(), body: m[2]! });
  return out;
};
const byClass = (n: El, cls: string): El | undefined => (n.className.split(" ").includes(cls) ? n : n.children.map((c) => byClass(c, cls)).find(Boolean));
const src = code(read("extension/panel.js"));
const fillSrc = src.slice(src.indexOf("const nameOf"), src.indexOf("function markSeen"));

function rowLast(r: any, memo: unknown[] = []) {
  const b: any = mount("kg-row"); // W111: fillRootButton の第 1 引数は行（kg-row）。本文 button は b.body
  const fn = new Function(
    "plain", "roots", "set", "rootId", "agentColor", "rowPeek", "peekCache", "peekLast", "paintList", "peekTick", "document",
    "rootShowsWord", "rootShowsFail", "approveMemo", "seenRows", "leaseRows", "providers", "timeLabel", "runs", "approvalRows",
    fillSrc + "\nreturn fillRootButton;",
  )(
    (s: string, n = 60) => String(s ?? "").slice(0, n), [],
    (el: any, key: string, value: unknown) => { if (el[key] !== value) el[key] = value; },
    null, new Map(), new Set(), {}, {}, () => {}, () => {}, (globalThis as any).document,
    () => false, () => false, memo, {}, [], {}, () => "10:02", [], [],
  ) as (b: any, r: any) => void;
  fn(b, { id: 1, text: "会話", createdAt: 0, ...r });
  return byClass(b, "pv-last")!.textContent;
}

test("W109 一覧: 📎 と 指した物: の最後の 1 行は「画面を囲んで聞きました」。普通の文・指した物です・[[spawned: はそのまま。金庫が優先", () => {
  expect(rowLast({ last: { mine: true, text: "📎 画面を囲んだ\n窓の中の長い説明", id: 3, at: 1 } })).toBe("画面を囲んで聞きました");
  expect(rowLast({ last: { mine: false, text: "指した物: Image・Orca / Orca 窓の題が続く", id: 4, at: 1 } })).toBe("画面を囲んで聞きました");
  expect(rowLast({ agent: { answer: "📎 画面を囲んだ 答え" } })).toBe("画面を囲んで聞きました");
  expect(rowLast({ last: { mine: true, text: "請求を見ました", id: 5, at: 1 } })).toBe("あなた: 請求を見ました");
  expect(rowLast({ last: { mine: true, text: "指した物です", id: 6, at: 1 } })).toBe("あなた: 指した物です");
  expect(rowLast({ last: { mine: true, text: "[[spawned:abc]]", id: 7, at: 1 } })).toBe("あなた: [[spawned:abc]]");
  expect(rowLast({ last: { mine: true, text: "📎 画面を囲んだ", id: 8, at: 1 } }, [[], [], [{ vault: true, owner: "s:1" }]])).toBe("パスワードを入れますか");
});

test("W109 次の一手: 候補 5 つは先頭 3 つ。長い文は切らない。動いている間は出さない", () => {
  const block = src.slice(src.indexOf("function renderNext"), src.indexOf("function rulesCard"));
  const box: any = { hidden: true, children: [] as any[], replaceChildren(...n: any[]) { this.children = n; } };
  let nexts: { id: string; text: string }[] = [];
  let working = false;
  const run = new Function("$", "document", "getNexts", "liveHere", "once", "sendChat", `
    let nexts = [];
    let rootId = 1;
    const busy = false;
    const failMem = null;
    ` + block + `
    return { render(last, turn) { nexts = getNexts(); return renderNext(last, turn); } };
  `)(
    () => box, (globalThis as any).document, () => nexts,
    () => (working ? [{ nodeId: 1 }] : []), (f: () => void) => f(), () => {},
  ) as { render: (last: any, turn: any) => void };
  const long = "あ".repeat(80) + "終わり";
  nexts = [{ id: "1", text: long }, { id: "2", text: "二つ" }, { id: "3", text: "三つ" }, { id: "4", text: "四つ" }, { id: "5", text: "五つ" }];
  run.render({ text: "🤖 答え" }, null);
  expect(box.children.map((c: any) => c.textContent)).toEqual([long, "二つ", "三つ"]);
  expect(box.children.every((c: any) => c.className === "next-btn")).toBe(true);
  working = true;
  run.render({ text: "🤖 答え" }, null);
  expect(box.children).toEqual([]);
});

test("W109 css: 次の一手は white-space:normal と overflow-wrap:anywhere。色の直書きは足さない", () => {
  const body = cssRules(read("extension/panel.css")).filter((r) => r.sel === "#next .next-btn").map((r) => r.body).join(";");
  expect(body).toMatch(/white-space:\s*normal/);
  expect(body).toContain("overflow-wrap:anywhere");
  expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
});

function stepsOf(card: El) {
  const list = card.children.find((c) => c.className === "steps");
  return list ? list.children.map((c: El) => c.textContent) : null;
}

test("W109 kg-progress: 既定は open 無し。6 本は新しい 4 本とほか 2 件。4 本はほか無し。空なら考え中。HTML は字のまま", () => {
  const k = mount("kg-progress") as any;
  k.steps = ["s1", "s2", "s3", "s4", "s5", "s6"];
  expect(k.hasAttribute("open")).toBe(false);
  expect(stepsOf(k)).toBeNull();
  expect(k.querySelectorAll("button")[0].textContent).toBe("ひらく");
  k.open = true;
  expect(k.hasAttribute("open")).toBe(true);
  expect(stepsOf(k)).toEqual(["s3", "s4", "s5", "s6", "ほか 2 件"]);
  k.steps = ["<img src=x>", "b", "c", "d"];
  expect(stepsOf(k)).toEqual(["<img src=x>", "b", "c", "d"]);
  expect(k.querySelectorAll("img").length).toBe(0);
  k.steps = [];
  expect(stepsOf(k)).toEqual(["考え中…"]);
  k.querySelectorAll("button")[0].click();
  expect(k.hasAttribute("open")).toBe(false);
  expect(stepsOf(k)).toBeNull();
  expect(k.querySelectorAll("button")[0].textContent).toBe("ひらく");
});

test("W109 renderProgress: 既定で閉じ、いまの頼みの 6 本は 4 本とほか 2 件。開くと progressOpen に入る", () => {
  const block = src.slice(src.indexOf("function stepText"), src.indexOf("function renderNeed"));
  const box: any = {
    hidden: true, _sig: "", _p: null, children: [] as any[],
    replaceChildren(...n: any[]) { this.children = n; for (const x of n) x.parentElement = this; },
  };
  const run = new Function("$", "document", "customElements", `
    const progressOpen = new Set();
    let rootId = 7;
    ` + block + `
    return { renderProgress, progressOpen };
  `)(() => box, (globalThis as any).document, (globalThis as any).customElements) as { renderProgress: (w: any) => void; progressOpen: Set<number> };
  run.renderProgress({ id: "run", nodeId: 7, log: ["old", "👤 頼み", "a", "b", "🔧 rg", "d", "e", "f"] });
  const card = box._p;
  expect(card.hasAttribute("open")).toBe(false);
  expect(stepsOf(card)).toBeNull();
  expect(run.progressOpen.size).toBe(0);
  card.querySelectorAll("button")[0].click();
  expect(card.hasAttribute("open")).toBe(true);
  expect(stepsOf(card)).toEqual(["rg を使っています", "d", "e", "f", "ほか 2 件"]);
  expect(run.progressOpen.has(7)).toBe(true);
  run.renderProgress(null);
  expect(box.hidden).toBe(true);
});
