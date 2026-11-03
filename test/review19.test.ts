// review19: panel に出る「agent の名前・会話の見出し」の安全。HTML として描かない・card を偽装できない・同名/見分けが付かない名前を持てない
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeAgents, nameOk, skeleton } from "../src/agents.ts";
import { plain } from "../extension/groups.js";

const panel = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");

test("panel.js の el()（innerHTML）に、名前・見出し・note を直接渡さない", () => {
  expect(panel).not.toMatch(/el\("[a-z]+", "[a-z ]+", `「\$\{/); // 承認 card の「「名前」の agent の頼みです」
  expect(panel).not.toMatch(/el\("div", "hint", a\.note\)/);
  expect(panel).toContain("plain(who.agent?.name ?? who.text)");
  // innerHTML に入れてよいのは ICON と固定の svg だけ
  for (const m of panel.matchAll(/\.innerHTML = ([^;]+);/g)) expect(m[1]).toMatch(/ICON|\bworking\b|^html$/);
});
test("plain: HTML は textContent に渡る前提で字のまま・制御/RTL/ゼロ幅/改行は落ち・長さは切れ・双方向は隔離される", () => {
  const p = plain("<img src=x onerror=alert(1)>");
  expect(p).toContain("<img src=x onerror=alert(1)>"); // 字のまま（描かれ方は textContent）
  const evil = plain("A\u202Eevil\u200B\n\u2028B\u2066");
  expect(evil).not.toMatch(/[\u202E\u200B\n\u2028\u2066]/);
  expect(evil).toBe("\u2068A evil B\u2069");
  expect(Array.from(plain("あ".repeat(500), 30)).length).toBeLessThanOrEqual(30 + 3);
  expect(plain("x".repeat(500))).toContain("…");
});
test("nameOk: 制御文字・書式文字・結合文字の積み上げ・見えない名前は断る。ふつうの名前は通る", () => {
  for (const bad of ["a\u202Eb", "a\u200Bb", "a\u2028b", "a\u0007b", "é̂̃̄̅x", "\u200B", "..", " ", "a/b", "a\nb"]) expect(nameOk(bad), JSON.stringify(bad)).toBe(false);
  for (const ok of ["経理", "build bot", "Zed 担当", "🤖 helper", "agent-1", "<img src=x onerror=1>"]) expect(nameOk(ok), ok).toBe(true); // HTML の字は名前として許す（描く側が textContent）
});
test("agents.name: 見分けが付かない名前（大小・全角半角・空白・合成の違い）は別の agent が持てない", () => {
  const home = mktmp("r19");
  const A = makeAgents(home);
  expect(A.name(1, "Alice").ok).toBe(true);
  for (const dup of ["alice", "ＡＬＩＣＥ", "Ali ce", "A-lice", "Alice"]) expect(A.name(2, dup), dup).toMatchObject({ ok: false });
  expect(A.name(1, "ALICE")).toMatchObject({ ok: true }); // 自分の改名は通る
  expect(A.name(2, "Bob").ok).toBe(true);
  expect(skeleton("Ｂob")).toBe(skeleton("bob"));
  
});
