// W77e（CEO 10-14「見なくていいものは見せなくていい」）: panel・新しいタブの desk に人が読む文字に、内部の語（面・世代・lease・token・op・origin・session・mod…）が無い。
// 表は test/internal-words.ts（W53 の card と共有・初期値は docs/design-ui-inventory.md §5）。描いた後の DOM ではなく source の文字列で測る（operator の grep 指定）:
// js は TypeScript の構文木で文字列と template の固定部分を拾い（${} の中の式は人に出ない）、日本語を含む物と、人に見える口（textContent・title・placeholder・label・txt()・toast()・new Option）へ入る物を「見える」とする。
// html は script / style / コメントを除いた text と title・placeholder・alt。aria-label と id は数えない（§5）。console・Error・<code>（打つ command の見本）は人の文ではない
import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { INTERNAL, mentionsInternal } from "./internal-words.ts";
setDefaultTimeout(60_000); // typescript の読み込みと 5 file の構文木で数秒（混んでいると 5 秒の既定を越える）

const ext = join(import.meta.dir, "../extension");
const JP = /[぀-ヿ一-鿿]/;
const SINK = new Set(["textContent", "title", "placeholder", "label", "innerText"]);
const CALL_ARG: Record<string, number> = { txt: 2, toast: 0, readOp: 1, Option: 0 };
type Seen = { at: string; text: string };

export function jsTexts(file: string, src = readFileSync(join(ext, file), "utf8")): Seen[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: Seen[] = [];
  const name = (e: ts.Expression) => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "");
  // 文字列から、それを包む式（三項・+・??・||・template）を上へ辿り、その式が入る先を見る
  const dest = (n: ts.Node): { visible: boolean; skip: boolean } => {
    let c: ts.Node = n;
    while (c.parent && (ts.isConditionalExpression(c.parent) || ts.isParenthesizedExpression(c.parent) || ts.isTemplateSpan(c.parent) || ts.isTemplateExpression(c.parent) || (ts.isBinaryExpression(c.parent) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(c.parent.operatorToken.kind)))) c = c.parent;
    const p = c.parent;
    if (!p) return { visible: false, skip: false };
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(c as ts.Expression)) {
      const f = ts.isPropertyAccessExpression(p.expression) && ts.isIdentifier(p.expression.expression) && p.expression.expression.text === "console" ? "console" : name(p.expression);
      if (f === "console" || f === "Error" || ((f === "txt" || f === "el") && p.arguments[0] && ts.isStringLiteral(p.arguments[0]) && p.arguments[0].text === "code")) return { visible: false, skip: true };
      return { visible: CALL_ARG[f] === p.arguments.indexOf(c as ts.Expression), skip: false };
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === c && ts.isPropertyAccessExpression(p.left)) return { visible: SINK.has(p.left.name.text), skip: false };
    if (ts.isPropertyAssignment(p) && p.initializer === c) return { visible: SINK.has(p.name.getText(sf)), skip: false };
    if (ts.isThrowStatement(p)) return { visible: false, skip: true };
    return { visible: false, skip: false };
  };
  const push = (n: ts.Node, text: string, whole: ts.Node) => {
    const d = dest(whole);
    if (text && !d.skip && (d.visible || JP.test(text))) out.push({ at: `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`, text });
  };
  const walk = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) push(n, n.text, n);
    else if (ts.isTemplateExpression(n)) { push(n.head, n.head.text, n); for (const s of n.templateSpans) push(s.literal, s.literal.text, n); }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

export function htmlTexts(file: string, src = readFileSync(join(ext, file), "utf8")): Seen[] {
  const s = src.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")); // 行番号を保つ
  const line = (i: number) => `${file}:${s.slice(0, i).split("\n").length}`;
  return [
    ...[...s.matchAll(/>([^<]+)</g)].filter((m) => m[1]!.trim()).map((m) => ({ at: line(m.index!), text: m[1]!.trim() })),
    ...[...s.matchAll(/\s(?:title|placeholder|alt)="([^"]*)"/g)].map((m) => ({ at: line(m.index!), text: m[1]! })),
  ];
}

const seen = () => [...["panel.js", "kg.js", "newtab.js"].flatMap((f) => jsTexts(f)), ...["panel.html", "newtab.html"].flatMap((f) => htmlTexts(f))];

test("W77e panel・desk の見える文字に内部の語が 0（「面」単独も 0・「画面」「前面」は数えない）", () => {
  const all = seen();
  expect(all.length).toBeGreaterThan(250); // 対照: 抜き出しが空なら緑になってしまう（今 300 前後）
  const bad = all.filter((s) => mentionsInternal(s.text)).map((s) => `${s.at} ${s.text.slice(0, 80)}`);
  expect(bad).toEqual([]);
});

test("W77e 抜き出しの対照: 日本語の文・見える口の英語・template の固定部分は拾い、${} の式・console・Error・<code>・aria-label・id は拾わない", () => {
  const js = jsTexts("x.js", [
    'a.textContent = "tasks";', 'b.title = ok ? "provider" : "x";', 'txt("div", "m", "local");', 'toast(`mod の数 ${n}`);', 'g.label = "Detected on your system";', "new Option(\"local agent\", \"local\");",
    'call("leaseList");', 'console.log("lease の数");', 'throw new Error("token が無い");', 'txt("code", "cmd-line", "kangae cmd-add --cwd ~/project");', "x.textContent = `画面の操作: ${run.screen.engine}`;",
  ].join("\n"));
  expect(js.map((s) => s.text)).toEqual(["tasks", "provider", "x", "local", "mod の数 ", "Detected on your system", "local agent", "画面の操作: "]);
  const html = htmlTexts("x.html", '<button id="session" aria-label="session" title="探す">project を立てる</button><input placeholder="会話の名前"><script>const a = "lease";</script><!-- token -->');
  expect(html.map((s) => s.text)).toEqual(["project を立てる", "探す", "会話の名前"]);
});

test("W77e 表の対照: 「面」は単独だけ・普通の語（画面・前面・場面・面倒）と製品の語（agent・tab・always allow）は通す", () => {
  for (const bad of ["この面を", "面の題", "session の名前", "mod にする", "出所: 人", "project を立てる", "tasks", "search", "provider", "local agent", "Detected on your system", "kangae-token", "lease を返す", "世代"]) expect(bad, bad).toMatch(INTERNAL);
  for (const ok of ["画面の操作", "前面が http のタブ", "場面", "面倒", "agent を立てる", "tab を渡す", "always allow", "allow", "deny", "会話の名前"]) expect(ok, ok).not.toMatch(INTERNAL);
});
