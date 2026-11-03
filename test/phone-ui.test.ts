// R4: スマホの画面を触る所だけにした。偽の document で部品を組み、消した物が無い・残す物が在る事を見る（実機のブラウザは別）
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STR, apprView, rowView } from "../extension/phone-ui.js";

// 最小の偽 document: 要素 = { tag, className, textContent, children, attrs, style }
type N = { tag: string; className: string; textContent: string; children: (N | string)[]; attrs: Record<string, string>; style: Record<string, string>; disabled: boolean; type: string; onclick: ((e: unknown) => void) | null; append(...k: (N | string)[]): void; setAttribute(k: string, v: string): void; removeAttribute(k: string): void };
const node = (tag: string): N => ({ tag, className: "", textContent: "", children: [], attrs: {}, style: {}, disabled: false, type: "", onclick: null, append(...k) { this.children.push(...k); }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
const doc = { createElement: node } as any; // DOM の型は tsconfig の lib に無い
const walk = (n: N | string): N[] => (typeof n === "string" ? [] : [n, ...n.children.flatMap(walk)]);
const textOf = (n: N | string): string => (typeof n === "string" ? n : n.textContent + n.children.map(textOf).join(""));

const dir = join(import.meta.dir, "../extension");
const html = readFileSync(join(dir, "phone.html"), "utf8");
const js = readFileSync(join(dir, "phone.js"), "utf8");
const ui = readFileSync(join(dir, "phone-ui.js"), "utf8");
const visible = html.replace(/<title>[\s\S]*?<\/title>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, "");

test("R4 消した見出しと説明が DOM に無い: 頭の題・節の見出し・説明の文は静的な頁にも、組み立てた一覧にも、文字の表にも無い", () => {
  expect(visible).toBe(""); // 頁そのものに見える文字は 1 字も無い（<title> はタブの名前で画面には出ない。題・見出し・説明は無く、文字は全部、状態に応じて JS が入れる）
  expect(html).not.toMatch(/<h[12]\b|<header[^>]*head/); // 頭の帯・見出しの要素が無い
  const removed = ["担当 agent", "つながりました", "を許しますか", "Mac の Kangae で「スマホで操作」を押すと", "スマホのカメラで読むと、ここに戻ります", "Mac が寝ているか、Mac の Kangae が止まっています", "この担当を、Mac の同じ会話で続きから動かします", "Kangae の画面が閉じています", "裏で開いても、画面は前に出しません", "会話を始めると、ここに並びます", "前の会話を読む。", "送っています", "送りました"];
  const code = (src: string) => src.replace(/\/\/.*$/gm, ""); // コメントは画面に出ない
  for (const t of removed) { expect(html.includes(t), `html: ${t}`).toBe(false); expect(code(js).includes(t), `phone.js: ${t}`).toBe(false); expect(code(ui).includes(t), `phone-ui.js: ${t}`).toBe(false); }
  // 7 件の一覧: 行の要素は li 7 つ・見出し要素 0・各行の文字は avatar の頭文字 / 担当名 / 状態の語 / 最後の 1 文 / 再開 だけ
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `agent ${"ABCDEFG"[i]}`, state: ["turn", "work", "neutral", "work", "fail", "neutral", "work"][i], label: ["あなたの番です", "動いています", "止まりました", "動いています", "失敗", "終わりました", "動いています"][i], last: i === 0 ? "Zed を開いてもいいですか" : "", stopped: i === 2 }));
  const lis = rows.map((r) => rowView(doc, r, { onOpen: () => {}, onResume: () => {} }) as unknown as N);
  expect(lis.length).toBe(7);
  const all = lis.flatMap(walk);
  expect(all.filter((n) => /^h[1-6]$/.test(n.tag))).toEqual([]);
  expect(lis.map((li) => textOf(li)).join("|")).toBe("aagent Aあなたの番ですZed を開いてもいいですか|aagent B動いています|aagent C止まりました再開|aagent D動いています|aagent E失敗|aagent F終わりました|aagent G動いています"); // 先頭の a は avatar の頭文字
  expect(all.filter((n) => n.tag === "button").map((b) => textOf(b)).filter((t) => t.endsWith("再開"))).toEqual(["再開"]); // 再開は止まった行にだけ（button の中に button を入れない）
  expect(all.filter((n) => n.tag === "button" && n.children.some((c) => typeof c !== "string" && c.tag === "button"))).toEqual([]);
  // 7 件が 390px 幅の画面（約 640px の高さ）で scroll なしで入る: 行の高さ × 7 + 頭の帯 0
  const row = Number(/--row:\s*(\d+)px/.exec(html)![1]);
  expect(row * 7).toBeLessThanOrEqual(640);
  expect(Number(/--hit:\s*(\d+)px/.exec(html)![1])).toBe(44); // 押す物は 44px
});

test("R4 承認の 2 つのボタンと つながらない時の 1 行は残る: always・この頼みの間は出さず、取り返しがつかない物は Mac で答える 1 行", () => {
  const a = { id: "a1", ver: 5, text: "文字を入れる「hello」", app: "ScratchPad", danger: false };
  const c = apprView(doc, a, { onAnswer: () => {} }) as unknown as N;
  const buttons = walk(c).filter((n) => n.tag === "button");
  expect(buttons.map(textOf)).toEqual(["許す（今回だけ）", "断る"]); // 2 つだけ
  expect(textOf(c)).toContain("文字を入れる「hello」"); // 承認の中身は残る
  expect(textOf(c)).not.toMatch(/always|いつも|この頼みの間/i);
  expect(buttons.every((b) => b.type === "button")).toBe(true);
  // 取り返しがつかない物: ボタンは 0・Mac で答える理由の 1 行
  const d = apprView(doc, { ...a, danger: true }, { onAnswer: () => {} }) as unknown as N;
  expect(walk(d).filter((n) => n.tag === "button")).toEqual([]);
  expect(textOf(d)).toContain("Mac で答えてください");
  // つながらない時の 1 行は、状態の表・会話の帯・toast の 3 か所すべてで同じ文
  expect(STR.unreach).toBe("この Mac につながりません。Mac が起きているか確かめてください");
  expect(STR.state.lost).toBe(STR.unreach);
  expect((js.match(/STR\.unreach/g) ?? []).length).toBeGreaterThanOrEqual(5);
  expect(html).toContain('id="cline"'); // 会話の上の帯（開いたまま切れた時）
  expect(html).toContain('id="act"'); // もう一度つなぐ
});
