// W105: 会話の「…」は名前 1 つ・デスクトップは折る。provider は候補が 2 つ以上の時だけ。動いている間の返事欄。
// 実機は未測。読む file を literal で名指す: "extension/panel.html" "extension/panel.js"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

function sliceFn(src: string, name: string) {
  const start = src.indexOf(`function ${name}(`);
  const open = src.indexOf("{", start);
  let d = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") { d--; if (d === 0) return src.slice(start, j + 1); }
  }
  throw new Error(name);
}

function arms(js: string) {
  const body = `${sliceFn(js, "providerLineHidden")}\n${sliceFn(js, "replyPlaceholder")}`;
  return new Function(`${body}\nconst EXAMPLE = "返事を書く";\nreturn { providerLineHidden, replyPlaceholder };`)() as {
    providerLineHidden: (isNew: boolean, n: number) => boolean;
    replyPlaceholder: (mode: string | false, moving: boolean) => string;
  };
}

test("W105 AC1: role-name と agent-name と、畳んだ 2 つのボタン文が panel に 0", () => {
  const html = read("extension/panel.html");
  const js = code(read("extension/panel.js"));
  for (const s of ["role-name", "担当名を付ける", "agent に名前を付ける"]) {
    expect(html.includes(s), s).toBe(false);
    expect(js.includes(s), s).toBe(false);
  }
  expect(html.includes("agent-name")).toBe(false);
  // W92 の設定が聞くイベント名 kg-agent-name だけ残す。menu の id としては 0
  expect(js.split("kg-agent-name").join("").includes("agent-name")).toBe(false);
  expect(js.includes("kg-agent-name")).toBe(true);
  expect(html).toContain('id="rename">名前を変える');
  expect(js).toContain('call("agentName", { rootId, name: text })');
  expect(js).toContain('call("role", { rootId, role: text })');
});

test("W105 AC2: option 1 つで provider 欄は hidden、2 つで見える。文言はどの AI で / この Mac", () => {
  const html = read("extension/panel.html");
  const js = code(read("extension/panel.js"));
  const { providerLineHidden } = arms(js);
  expect(providerLineHidden(true, 0)).toBe(true);
  expect(providerLineHidden(true, 1)).toBe(true);
  expect(providerLineHidden(true, 2)).toBe(false);
  expect(providerLineHidden(false, 3)).toBe(true);
  const field = js.slice(js.indexOf("function renderField"), js.indexOf("function tabLabel"));
  const load = js.slice(js.indexOf("async function loadProviders"), js.indexOf("function startNew"));
  expect(field).toContain('providerLineHidden(naming === "new", $("provider").querySelectorAll("option").length)');
  expect(load).toContain("renderField()");
  expect(load).toContain('group.label = "この Mac に入っている物"');
  expect(load).toContain('new Option("この Mac", "local")');
  expect(html).toContain(">どの AI で");
  expect(js.includes("Detected on your system")).toBe(false);
});

test("W105 AC3: 動いている間の placeholder は書いておく。止まっていれば返事を書く。名前の入力中は担当名", () => {
  const js = code(read("extension/panel.js"));
  const { replyPlaceholder } = arms(js);
  expect(replyPlaceholder(false, true)).toBe("書いておく（動き終わったら送ります）");
  expect(replyPlaceholder(false, false)).toBe("返事を書く");
  expect(replyPlaceholder("rename", true)).toBe("担当名");
  expect(replyPlaceholder("new", true)).toBe("会話の名前");
  const field = js.slice(js.indexOf("function renderField"), js.indexOf("function tabLabel"));
  expect(field).toContain("replyPlaceholder(naming, moving)");
  expect(field).toContain("liveHere().some((x) => x.nodeId === rootId)");
  const head = js.slice(js.indexOf("function renderHead"), js.indexOf("function renderNext"));
  expect(head).toContain("renderField()");
});

test("W105 デスクトップの 3 本は閉じた details の中。開くまで summary だけ", () => {
  const html = read("extension/panel.html");
  const at = html.indexOf('<details id="desk-fold">');
  const fold = html.slice(at, html.indexOf("</details>", at) + "</details>".length);
  expect(fold.startsWith('<details id="desk-fold">')).toBe(true);
  expect(fold.includes("<summary>デスクトップ</summary>")).toBe(true);
  for (const id of ["to-desktop", "term-to-desktop", "tab-to-desktop"]) expect(fold.includes(`id="${id}"`), id).toBe(true);
  expect(html.includes('id="open-tab"')).toBe(true);
  expect(fold.includes('id="open-tab"')).toBe(false);
});
