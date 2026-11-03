// W74: Bar の窓の作り直し（試験。窓をドラッグ・縁で resize・見た目は実機＝実験役が computer use）
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const swift = read("bar/main.swift"), js = read("extension/panel.js"), css = read("extension/panel.css"), html = read("extension/panel.html");

test("W74b 信号機（× − 緑の拡大）は 3 つとも見せる・縁で広げられる・逃がしは 3 つの右端", () => {
  expect(swift).not.toMatch(/standardWindowButton\([^)]*\)\??\.isHidden = true/);
  expect(swift).toMatch(/styleMask:[^\n]*\.titled[^\n]*\.resizable[^\n]*\.fullSizeContentView/);
  expect(swift).toContain("[NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap");
  expect(swift).toContain("panel.maxSize = NSSize(width: 100_000, height: 100_000)");
  expect(swift).toMatch(/x\.action = #selector\(quitBar\)/);
  expect(swift).toMatch(/m\.action = #selector\(stow\)/);
});

test("W74 窓を動かす帯: WKWebView の上 16pt の押下だけ performDrag・下は web に渡す", () => {
  expect(swift).toMatch(/final class DragWeb: WKWebView/);
  expect(swift).toMatch(/bounds\.height - dragBand \{ window\?\.performDrag\(with: e\) \} else \{ super\.mouseDown\(with: e\) \}/);
  expect(swift).toContain("let w = DragWeb(frame:");
  expect(swift).toContain("let dragBand: CGFloat = 16");
  expect(css).toMatch(/html\[data-bar\] #app \{ padding-top:var\(--drag-h\); \}/); // 押す物は帯に入らない。帯の高さは DESIGN §2 の --drag-h（W123: 画面ごと 1 か所で下げる）
});

test("W74b 吹き出し: 自分は右端・agent は左端・幅と余白は token・入力欄も端まで", () => {
  expect(css).toMatch(/--w-bubble:\s*min\(88%, 640px\)/); // W110: DESIGN §2
  expect(css).toMatch(/--pad-x:\s*var\(--sp-3\)/);
  expect(css).toMatch(/\.chat-row\.me \{ align-self:flex-end;/);
  expect(css).toMatch(/\.chat-row\.they \{[^}]*align-self:flex-start; max-width:var\(--w-bubble\);/);
  expect(css).toMatch(/\.chat-row\.they \.chat-text \{[^}]*background:var\(--card\);[^}]*border-radius/); // agent も吹き出し
  expect(css).not.toContain("calc((100% - var(--w-read)) / 2)"); // 中央 720px の細い柱にしない
  expect(css).toMatch(/#send-form \{[^}]*margin:0 var\(--gutter\) calc\(var\(--sp-4\) \+ env\(safe-area-inset-bottom\)\);/); // W112: 端から 16（DESIGN §4 入力欄の外枠）。以前は --pad-x の 12
  expect(css).not.toMatch(/#send-form \{[^}]*max-width:var\(--w-read\)/);
});

test("W74b chat の上に command の一覧を出さない（#cmds{display:flex} に負けていた）", () => {
  expect(css).toContain("#app:not(.list-open) #cmds { display:none; }");
});

test("W74 開いたら会話が前面: 会話が 2 つ以上でも一覧を自動で開かない・左上から一覧へ行く道は残る（W90: ☰ → ○＜ kg-back）", () => {
  expect(js).not.toMatch(/roots\.length >= 2 && tabSession == null\) \$\("hd-list"\)\.click\(\)/);
  expect(js).toContain('$(id).addEventListener("kg-back"');
});

test("W74 一覧の行は空に見えない（担当名 → 会話名 → 名前のない会話）・0 件は一言・担当名でも探せる", () => {
  expect(js).toMatch(/const rootLabel = \(r\) => plain\(r\.agent\?\.name \?\? r\.role \?\? r\.text, 60\)\.trim\(\) \|\| "名前のない会話"/);
  expect(js).toContain("name: rootLabel(r)"); // W77c: 行の担当名は kg-row に name で渡す
  expect(js).toContain('$("roots-empty").hidden = seq.length > 0 || !!q || listFilter === "turn"'); // W98: 絞っている間は上の 1 行
  expect(html).toContain('id="roots-empty" hidden>まだ担当がいません');
  expect(js).toMatch(/const match = \(r\) => \(!turnOnly \|\| yourTurn\(r\)\) && \(!q \|\| \[rootLabel\(r\), plain\(r\.text, 80\)\]/); // W98: 「あなたの番です」の絞り
  // W60b2 の名前つき一覧は残す
  expect(js).toContain("W60b2: 担当名");
});

test("W74c Bar の中の字は選べて ⌘C が効く: 編集 menu（copy・selectAll・paste・cut）を持ち、panel は user-select:text・押す物の字だけ none", () => {
  expect(swift).toContain("NSApp.mainMenu = main");
  for (const sel of ["NSText.cut(_:)", "NSText.copy(_:)", "NSText.paste(_:)", "NSText.selectAll(_:)"]) expect(swift).toContain(`#selector(${sel})`);
  expect(swift).toMatch(/\("コピー", #selector\(NSText\.copy\(_:\)\), "c"\)/);
  expect(css).toMatch(/html\[data-bar\] body \{ -webkit-user-select:text; user-select:text; \}/);
  expect(css).toMatch(/html\[data-bar\] button, html\[data-bar\] summary \{ -webkit-user-select:none; user-select:none; \}/);
  const none = css.split("\n").filter((l) => /user-select:none/.test(l)).join("\n");
  expect(none).not.toMatch(/#chat|#rows|\.chat-row|\.chat-text|body/); // 本文側に none を置かない（押す物だけ）
});
