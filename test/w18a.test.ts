// W18a: 狭い窓の左上は ☰（ハンバーガー）で、押すと agent の一覧が開く（user 2026-10-09「小さい窓は左上にハンバーガーをおいて、そこを押すとagent一覧を見れるように」）。読む file を literal で名指す: "extension/panel.html" "extension/panel.js" "extension/panel.css"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// W90（CEO 10-14）で ☰ は ○＜（kg-back・1 押しで前の画面・2 度押しで一覧）に替わった。「左上の 1 つで一覧へ行ける」は同じ
test("W18a→W90 会話の左上は ○＜（kg-back）・aria-label は「前の画面へ（2 度押しで一覧）」", () => {
  const btn = /<kg-back[^>]*id="hd-list"[^>]*>/.exec(readFileSync("extension/panel.html", "utf8"))![0];
  expect(btn).toContain('aria-label="前の画面へ（2 度押しで一覧）"');
  expect(btn).not.toContain("‹");
});

test("W18a 一覧（#sessions）が開くと会話が隠れる。幅に関係なく左上の 1 つは残り、一覧と会話は並ばない", () => {
  const html = readFileSync("extension/panel.html", "utf8");
  const js = readFileSync("extension/panel.js", "utf8");
  const css = readFileSync("extension/panel.css", "utf8");
  expect(js).toContain('$("app").classList.add("list-open");'); // nav.show が一覧を出す
  expect(js).toContain('if (choice === "always" && a.app) { await call("leaseMode"'); // 承認の always allow（W77b: 3 語は extension/kg.js の kg-approve・W90: toast を足した）
  expect(css).toContain("#app:not(.list-open) #sessions");
  expect(css).toContain("#app.list-open #chat { display:none; }");
  expect(css).toContain("#screen-engine { display:none; }"); // W97: #cmds / #mods は歯車の節へ移し、この rule から外した
  expect(css).not.toMatch(/#hd-list \{ display:\s*none/);
  for (const id of ["user-btn", "plus", "attach", "provider"]) expect(html).toContain(`id="${id}"`); // W98: 鍵 icon（notify）は無い。W103: todo と探す icon（find）は無い
});
