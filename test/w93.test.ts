// W93: 一覧の空の節を出さない・歯車の絵を歯車に・死んだ「tab を渡す」button を消す
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync("extension/panel.html", "utf8");
const js = readFileSync("extension/panel.js", "utf8");
const css = readFileSync("extension/panel.css", "utf8");
const GEAR = "M8.43 3.69L8.61 1.72"; // W119: 20 viewBox の 8 歯
const OCTOCAT = "M8 0a8 8 0 0 0-2.53 15.59";

test("W93 loadLeases は 0 件で #leases を hidden にし、空の文は panel.js に無い", () => {
  expect(js).not.toContain("渡している物はありません");
  const fn = js.slice(js.indexOf("async function loadLeases()"), js.indexOf("function modePick("));
  expect(fn).toContain("if (!r.leases.length && !recs.length) { box.hidden = true; box.replaceChildren(); return; }");
  expect(fn).toContain("box.hidden = false;");
});

test("W93 user-btn の svg に octocat の path が無く、歯車の path が在る", () => {
  const btn = /<button type="button" id="user-btn"[\s\S]*?<\/button>/.exec(html)![0];
  expect(btn).not.toContain(OCTOCAT);
  expect(btn).toContain(GEAR);
  expect(btn).toContain('fill="none"');
  expect(btn).toContain('stroke="currentColor"');
  expect(btn).toContain('viewBox="0 0 20 20"');
  expect(btn).toContain('class="ic"');
  expect(btn).toContain('aria-label="設定"');
  expect(btn).toContain('title="設定"');
});

test("W93 give-tab は html / js / css から消え、出さない rule と ＋今のタブは残る", () => {
  expect(html).not.toContain('id="give-tab"');
  expect(js).not.toContain("give-tab");
  expect(css).not.toContain("#give-tab");
  expect(css).toContain("#screen-engine { display:none; }"); // W97: #cmds / #mods はこの rule から外した
  expect(html).toContain('id="add-tab"');
  expect(js).toContain('$("add-tab").onclick');
});
