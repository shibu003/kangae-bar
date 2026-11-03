// W98: 右上の印は 2 件以上で「あなたの番です」の一覧、1 件でその会話。鍵 icon は無く、金庫の card は会話に常に出す。
// 本物の Bar・ポインタには触れない。実機（印を押す・Bar が開く）は未測。読む file を literal で名指す: "bar/Badge.swift" "bar/main.swift" "extension/panel.js" "extension/panel.html"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(f, "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

test("W98 Badge: onClick は rootIds.count >= 2 で一覧（open nil）、1 件ならその会話", () => {
  const swift = code(read("bar/Badge.swift"));
  const on = swift.slice(swift.indexOf("view.onClick"), swift.indexOf("func set("));
  expect(on).toContain("rootIds.count >= 2");
  expect(on).toContain("open(nil)");
  expect(on).toContain("open(self.rootIds.first)");
  expect(on.indexOf("rootIds.count >= 2")).toBeLessThan(on.indexOf("open(nil)"));
  expect(on.indexOf("open(nil)")).toBeLessThan(on.indexOf("open(self.rootIds.first)"));
  expect(swift).toContain("window.kangaeOpenList?.('turn')");
  expect(code(read("bar/main.swift"))).toContain("window.__kangaeList='turn'");
});

test("W98 panel: listFilter が turn の時は「あなたの番です」だけ。解除の 1 行は source のまま動く", () => {
  const js = code(read("extension/panel.js"));
  expect(js).toContain("let listFilter");
  const paint = js.slice(js.indexOf("function paintList"), js.indexOf("async function renderRoots"));
  expect(paint).toContain('listFilter === "turn"');
  expect(paint).toContain('rowState(r)?.[1] === "あなたの番です"');
  expect(paint).toContain("(!turnOnly || yourTurn(r))");
  const rowSrc = js.slice(js.indexOf("function rowState"), js.indexOf("function markSeen"));
  const rowState = new Function("rootShowsWord", "rootShowsFail", "runs", "approvalRows", `${rowSrc}\nreturn rowState;`)(() => false, () => false, [], []);
  expect(rowState({ id: 1, last: { turn: true } })?.[1]).toBe("あなたの番です");
  expect(rowState({ id: 2, last: { mine: false } })?.[1]).toBe("終わりました");
  expect(rowState({ id: 3, last: { mine: true } })).toBeNull();
  const picked = ['const turnOnly = listFilter === "turn"', "const yourTurn =", "const match ="].map((s) => {
    const line = paint.split("\n").find((l) => l.includes(s));
    expect(line, s).toBeTruthy();
    return line!;
  });
  const match = new Function("rowState", "listFilter", "findQ", "rootLabel", "plain", `const q = findQ.trim().toLowerCase();\n${picked.join("\n")}\nreturn match;`)(rowState, "turn", "", (r: { name?: string }) => r.name ?? "", (t: string) => t);
  expect(match({ id: 1, last: { turn: true }, text: "a", name: "a" })).toBe(true);
  expect(match({ id: 2, last: { mine: false }, text: "b", name: "b" })).toBe(false);
  const fnSrc = js.slice(js.indexOf("function paintTurnLine"), js.indexOf("window.kangaeOpenList"));
  expect(fnSrc).toContain("あなたの番です（${n}）・すべて見る");
  expect(fnSrc).toContain('listFilter = ""');
  expect(fnSrc).not.toContain("innerHTML");
  const roots: { kid?: { textContent: string; onclick: () => void } } = {};
  const ids: Record<string, unknown> = { roots, "turn-line": null };
  const $ = (id: string) => ids[id] ?? null;
  (roots as { before?: (n: typeof roots.kid) => void }).before = (n) => { roots.kid = n ?? undefined; };
  const document = { createElement: () => ({ type: "", id: "", hidden: false, textContent: "", onclick: null as null | (() => void) }) };
  const got = new Function("$", "document", "window", `let listFilter = "turn"; let paints = 0; const paintList = () => { paints++; };\n${fnSrc}\npaintTurnLine(2); const line = $("roots").kid; const text = line.textContent; line.onclick(); return { text, listFilter, paints };`)($, document, {});
  expect(got).toEqual({ text: "あなたの番です（2）・すべて見る", listFilter: "", paints: 1 });
});

test("W98 鍵 icon は無い。renderApprove は金庫の card を常に出す。行の最後はパスワードを入れますか", () => {
  const html = read("extension/panel.html");
  const js = code(read("extension/panel.js"));
  expect(html).not.toContain('id="notify"');
  expect(js).not.toContain("notifyOpen");
  expect(js).not.toContain("notify-count");
  const render = js.slice(js.indexOf("function renderApprove"), js.indexOf("function showStopAll"));
  expect(render).toContain("const shownCarries = carries");
  expect(render).not.toContain("!a.vault");
  expect(render).toContain("if (a.vault) return vaultCard(a)");
  const fill = js.slice(js.indexOf("function fillRootButton"), js.indexOf("function rowState"));
  expect(fill).toContain('vaultHere ? "パスワードを入れますか"');
  expect(fill).toContain("unread || vaultHere");
});
