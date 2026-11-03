// W102（docs/BRIEF-w102.md）: notice の 1 行・読むだけの thread・吹き出しの話し手。本物のブラウザには触れない。実機は未測。
// 読む file を literal で名指す: "extension/kg.js" "extension/panel.js" "extension/panel.html" "extension/panel.css" "test/internal-words.ts" "docs/design/DESIGN.md"
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount } from "./domshim.ts";
import { mentionsInternal } from "./internal-words.ts";
beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const grab = (name: string) => {
  const js = code(read("extension/panel.js"));
  const start = js.indexOf(`function ${name}(`);
  const end = js.indexOf("\nfunction ", start + 1);
  return new Function(`${js.slice(start, end)}; return ${name};`)() as (t: string) => { from: string; roomId: string; text: string } | string | null;
};

test("W102 AC1: kg-notice は message from を textContent で描き、先頭 40 字に切り、click / Enter で kg-open-thread {roomId}", () => {
  const n = mount("kg-notice", { from: "B", text: "x".repeat(50), "room-id": "room-1" }) as any;
  expect(n.getAttribute("role")).toBe("button");
  expect(n.textContent).toBe(`message from B ・ ${"x".repeat(40)}`);
  expect(n.textContent).not.toContain("room-1");
  expect(n.innerHTML).toBe("");
  const got: { roomId: string }[] = [];
  n.addEventListener("kg-open-thread", (e: any) => got.push(e.detail));
  n.click();
  let prevented = false;
  for (const l of n.listeners.get("keydown") ?? []) l.f({ key: "Enter", preventDefault: () => { prevented = true; } });
  expect(got).toEqual([{ roomId: "room-1" }, { roomId: "room-1" }]);
  expect(prevented).toBe(true);
  n.from = "<b>A</b>";
  expect(n.textContent).toContain("message from <b>A</b> ・ ");
  expect(n.innerHTML).toBe("");
});

test("W102 AC2: kg-thread は吹き出しの数・from → to・members・空。innerHTML は無い", () => {
  const t = mount("kg-thread") as any;
  t.data = { room: { members: [] }, rows: [] };
  expect(t.textContent).toContain("まだやり取りはありません");
  const role = "あ".repeat(40);
  t.data = {
    room: { members: [{ name: "経理", role }, { name: "広報", role: "短く" }] },
    rows: [
      { at: 1_700_000_000_000, from: "経理", to: "広報", text: "こんにちは <b>" },
      { at: 1_700_000_060_000, from: "広報", to: "経理", text: "了解" },
    ],
  };
  expect(t.textContent).toContain(`経理（${"あ".repeat(30)}）・広報（短く）`);
  expect(t.textContent).not.toContain("まだやり取りはありません");
  const boxes = t.querySelectorAll("div").filter((n: any) => String(n.className).split(" ").includes("they"));
  expect(boxes.length).toBe(2);
  expect(boxes.every((n: any) => !String(n.className).split(" ").includes("me"))).toBe(true);
  expect(boxes[0].textContent).toContain("経理 → 広報");
  expect(boxes[0].textContent).toContain("こんにちは <b>");
  expect(boxes[1].textContent).toContain("広報 → 経理");
  const times = t.querySelectorAll("time");
  expect(times.length).toBe(2);
  expect(times.every((n: any) => /^\d{2}:\d{2}$/.test(n.textContent))).toBe(true);
  expect(t.innerHTML).toBe("");
  const kg = code(read("extension/kg.js"));
  const notice = kg.slice(kg.indexOf("class KgNotice"), kg.indexOf('customElements.define("kg-notice"'));
  const thread = kg.slice(kg.indexOf("class KgThread"), kg.indexOf('customElements.define("kg-thread"'));
  expect(notice).not.toContain("innerHTML");
  expect(thread).not.toContain("innerHTML");
  expect(thread).not.toContain("chat-row me");
});

test("W102 AC3: relay の印は from / roomId / 本文に分かれ、崩れた印と spawned は別", () => {
  const relayMark = grab("relayMark") as (t: string) => { from: string; roomId: string; text: string } | null;
  const spawnedParent = grab("spawnedParent") as (t: string) => string | null;
  expect(relayMark("[[relay: 経理 | room-1]] こんにちは")).toEqual({ from: "経理", roomId: "room-1", text: "こんにちは" });
  expect(relayMark("[[relay: 経理]] こんにちは")).toBeNull();
  expect(relayMark("[[relay:  | room-1]] x")).toBeNull();
  expect(relayMark("[[relay: 経理 | ]] x")).toBeNull();
  expect(relayMark("ただの文")).toBeNull();
  expect(spawnedParent("[[spawned: 親A | room-9]] 役: 書く人")).toBe("親A");
  expect(spawnedParent("[[spawned: 親A]] 役: 書く人")).toBeNull();
  const js = code(read("extension/panel.js"));
  const render = js.slice(js.indexOf("function renderChat"), js.indexOf("function turnCard"));
  expect(render).toContain("relayMark(row.text)");
  expect(render).toContain('document.createElement("kg-notice")');
  expect(render).toContain("e.notice.text = relay.text");
  expect(render).not.toContain("[[relay:");
  expect(render).toContain("spawnedHere ? `${spawnedHere} が立てました` : row.text");
  const fill = js.slice(js.indexOf("function fillRootButton"), js.indexOf("function markSeen"));
  expect(fill).toContain("spawned ? `${spawned} が立てました`");
  expect(fill).toContain("spawnedParent(");
});

test("W102 AC4: thread は nav の 1 段・一覧には出ない・roomLog が ok でなければ toast して戻る", () => {
  const html = read("extension/panel.html");
  const js = code(read("extension/panel.js"));
  const css = read("extension/panel.css");
  expect(html.indexOf('id="chat"')).toBeLessThan(html.indexOf('id="thread"'));
  const sec = html.slice(html.indexOf('<section id="thread"'), html.indexOf("</section>", html.indexOf('<section id="thread"')) + "</section>".length);
  expect(sec).toContain('id="thread" hidden');
  expect(sec).toContain('id="thread-back"');
  expect(sec).toContain("<h1>agent 同士の chat</h1>");
  expect(sec).toContain('<kg-thread id="thread-log">');
  expect(sec).not.toContain("send-form");
  expect(js).toContain('nav.push("thread")');
  expect(js).toContain('nav.show("thread")');
  expect(js).toContain('call("roomLog", { roomId })');
  expect(js).toContain('toast("まだ使えません")');
  expect(js).toContain("nav.back()");
  expect(js).toContain('s === "thread"');
  const paint = js.slice(js.indexOf("function paintList("), js.indexOf("async function renderRoots"));
  expect(paint).not.toContain("thread");
  expect(paint).not.toContain("roomLog");
  expect(paint).not.toContain("kg-notice");
  expect(css).toContain("#app.list-open #thread { display:none; }");
  const block = css.slice(css.indexOf("/* W102"));
  expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(block).not.toMatch(/\d+px/);
  expect(block).toContain("var(--fs-meta)");
  expect(block).toContain("var(--fs-body)");
  expect(block).toContain("var(--sp-5)");
  expect(block).toContain("var(--muted-fg)");
});

test("W102 AC5: message from は除外。句の外の禁止語は残る", () => {
  expect(mentionsInternal("message from B")).toBe(false);
  expect(mentionsInternal("message from session")).toBe(true);
});
