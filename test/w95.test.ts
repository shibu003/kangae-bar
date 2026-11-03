// W95（docs/BRIEF-w95.md）: #chat に落とした http(s) の URL で tab を探して渡す。file は今までどおり添付。
// 本物の Chrome の icon を side panel に落とす実機は未測（要 operator）。読む file を literal で名指す: "extension/panel.js" "extension/panel.css"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

function droppedFrom(src: string) {
  const m = /function droppedHttpUrl\(raw\) \{[\s\S]*?\n\}/.exec(src);
  expect(m).not.toBeNull();
  return new Function(`${m![0]}; return droppedHttpUrl;`)() as (raw: string) => string;
}

test("W95 URL: text/uri-list の http(s) だけ受け、javascript: / file: / data: は空（何も呼ばない側の入口）", () => {
  const src = code(read("extension/panel.js"));
  const fn = droppedFrom(src);
  expect(fn("https://ex.test/a")).toBe("https://ex.test/a");
  expect(fn("http://ex.test/b")).toBe("http://ex.test/b");
  expect(fn("  HTTPS://ex.test/c \nhttp://other")).toBe("https://ex.test/c");
  expect(fn("# comment\nhttps://ex.test/z")).toBe("https://ex.test/z");
  expect(fn("javascript:alert(1)")).toBe("");
  expect(fn("JAVASCRIPT:alert(1)")).toBe("");
  expect(fn("javascript:alert(1)\nhttps://ex.test/a")).toBe("");
  expect(fn("file:///tmp/x")).toBe("");
  expect(fn("data:text/html,hi")).toBe("");
  expect(fn("")).toBe("");
  expect(fn("notaurl")).toBe("");
  const body = /function droppedHttpUrl\(raw\) \{[\s\S]*?\n\}/.exec(src)![0];
  expect(body).toMatch(/\/\^https\?:\\\/\\\//); // この正規表現を実装から外すと赤
  const drop = src.slice(src.indexOf("function dropDo"), src.indexOf("function copySel")); // H1: 会話と一覧の行が共用する入口
  expect(drop.indexOf("addFiles")).toBeGreaterThan(-1);
  expect(drop.indexOf("addFiles")).toBeLessThan(drop.indexOf("droppedHttpUrl")); // file が先。URL は file の return の後
  expect(drop).toContain("if (!url) return;"); // 断った URL は giveDroppedUrl を呼ばない
});

test("W95 渡す: tab を # より前の完全一致で探し（H1: 全部の窓から・2 つ以上なら選ぶ）、無ければ active:false で開いてから leaseGive", () => {
  const src = code(read("extension/panel.js"));
  const fn = src.slice(src.indexOf("async function giveDroppedUrl"), src.indexOf("async function giveDroppedApp"));
  const q = fn.indexOf("chrome.tabs.query({})");
  const created = fn.indexOf("active: false");
  const give = fn.indexOf('call("leaseGive"');
  expect(q).toBeGreaterThan(-1);
  expect(fn).toContain('.split("#")[0] === q'); // match pattern を通さない（* や port を含む URL が他の tab に当たらない）
  expect(created).toBeGreaterThan(q);
  expect(give).toBeGreaterThan(created);
  expect(fn).toContain("chrome.tabs.create({ url, active: false,");
  expect(fn).toContain('toast("会話を開いてから落としてください")');
  expect(fn).toContain('call("urlTabs"'); // Bar: 拡張は常駐が知っている（動きは test/h1.test.ts）
});

test("W95 枠: dragover で dropping、dragleave と drop で外す。css の rule と帯の文が在る", () => {
  const js = code(read("extension/panel.js"));
  const css = read("extension/panel.css");
  const over = js.slice(js.indexOf("function dropOver"), js.indexOf("function dropLeave"));
  const leave = js.slice(js.indexOf("function dropLeave"), js.indexOf("function dropDo"));
  const drop = js.slice(js.indexOf("function dropDo"), js.indexOf("function copySel"));
  expect(over).toContain('classList.add("dropping")');
  expect(leave).toContain('classList.remove("dropping")');
  expect(drop).toContain('classList.remove("dropping")');
  expect(over).toContain("`添付します（.app は ${assigneeName(id)} に渡します）` : `ここに落とすと ${assigneeName(id)} に渡します`");
  expect(over).toContain("textContent");
  // 枠は破線・--primary の色・内側（負の offset = 面の中に収まり overflow で切れない）。幅と offset は token
  const rule = /#chat\.dropping\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(rule).toMatch(/outline:\s*var\(--focus-w\) dashed var\(--primary\)/);
  expect(rule).toMatch(/outline-offset:\s*calc\(-1 \* var\(--sp-1\)\)/);
  expect(css).toMatch(/--sp-1:\s*4px;/);
  expect(css).toContain("#chat .drop-band");
  expect(css).toMatch(/#roots > li\.dropping\s*\{[^}]*dashed var\(--primary\)/); // H1: 一覧の行も同じ枠
});
