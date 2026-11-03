// W45: type_text が、同 origin の iframe の中の編集面（Google Docs の docs-texteventtarget-iframe）に入る。実 Chrome の振る舞いは docs/verify/w45/probe-b.e2e.ts（変更前 = 赤 / 変更後 = ok）。ここは分岐が残っている事の守り
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("W45 type_text / set_value: element_token 無しで focus が iframe にあれば、その中の contenteditable へ・execCommand は編集面の document で・別 origin は触らない", () => {
  const src = readFileSync(join(import.meta.dir, "../extension/web.js"), "utf8");
  const at = src.indexOf('if (tool === "type_text" || tool === "set_value")');
  const body = src.slice(at, at + 1400);
  expect(body).toContain('e?.tagName === "IFRAME"');
  expect(body).toContain("contentDocument?.activeElement");
  expect(body).toContain("catch"); // 別 origin の iframe は contentDocument が投げる
  expect(body).toContain('e.ownerDocument.execCommand("insertText"');
  expect(body).not.toContain("clipboard"); // クリップボードは使わない（surface.md）
});
