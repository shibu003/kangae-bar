// W97（docs/BRIEF-w97.md）: 登録した物と覚えた手順は歯車の「覚えた物」。summary は名前（手順は on/off も）。中身は開いた時だけ。0 件は「まだありません」。
// 本物のブラウザには触れない（domshim で描画）。実機の見た目は未測（要 operator）。
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount, Plain } from "./domshim.ts";

beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const html = read("extension/panel.html");
const css = read("extension/panel.css");
const js = read("extension/panel.js");
const main = read("src/main.ts");

test("AC1 #cmds と #mods は kg-settings の「覚えた物」の中に在り、#app の直下には無い", () => {
  const app = html.indexOf('<div id="app"');
  const popAt = html.indexOf('<kg-settings id="user-pop"');
  const before = html.slice(app, popAt);
  expect(before).not.toContain('id="cmds"');
  expect(before).not.toContain('id="mods"');
  const pop = html.slice(popAt, html.indexOf("</kg-settings>", popAt));
  const sum = pop.indexOf("<summary>覚えた物</summary>");
  const cmds = pop.indexOf('id="cmds"');
  const mods = pop.indexOf('id="mods"');
  expect(sum).toBeGreaterThan(-1);
  expect(cmds).toBeGreaterThan(sum);
  expect(mods).toBeGreaterThan(cmds);
  expect(pop.indexOf("</details>", mods)).toBeGreaterThan(mods);
});

test("AC2 display:none の rule に #cmds / #mods が無く、#screen-engine は在る", () => {
  expect(css).toContain("#screen-engine { display:none; }");
  expect(css).not.toContain("#screen-engine, #cmds, #mods");
  expect(/^#cmds \{[^}]*\}/m.exec(css)![0]).toContain("display:flex");
  expect(/^#mods \{[^}]*\}/m.exec(css)![0]).toContain("display:flex");
});

function draw() {
  const g = globalThis as any;
  const boxes: Record<string, any> = {};
  const mk = (tag: string, cls: string) => Object.assign(g.document.createElement(tag), { className: cls });
  const txt = (tag: string, cls: string, text: string) => { const x = mk(tag, cls); x.textContent = text; return x; };
  const $ = (id: string) => {
    if (!boxes[id]) {
      const el = g.document.createElement(id === "learned-empty" ? "p" : "section");
      el.hidden = id !== "learned-empty";
      if (id === "learned-empty") el.textContent = "まだありません";
      boxes[id] = el;
    }
    return boxes[id];
  };
  const answers: Record<string, any> = {};
  const readOp = async (_b: unknown, _w: unknown, _a: unknown, op: string) => answers[op] ?? null;
  const src = js.slice(js.indexOf("function paintLearnedEmpty()"), js.indexOf("async function reloadRoots()"));
  const api = new Function("mk", "txt", "$", "readOp", "call", "toast", "refreshRuns", "loadLeases", "front", "rootId", `${src}\nreturn { loadCmds, loadMods };`)(
    mk, txt, $, readOp, async () => ({ ok: true }), () => {}, async () => {}, () => {}, { app: "Notes", pid: 1 }, 7,
  );
  return { boxes, set: (op: string, v: unknown) => { answers[op] = v; }, ...api };
}

const sumOf = (det: any) => det.children.find((c: any) => c.tagName === "SUMMARY");

test("AC3 1 件は details。summary は名前（手順は kg-toggle も）で、場所の path は中だけ", async () => {
  const place = "/tmp/proj/place";
  const d = draw();
  d.set("cmdList", { ok: true, items: [
    { name: "build", cwd: place, line: "cmake --build build", network: false, reads: [], app: false, ok: true, at: Date.UTC(2026, 0, 2) },
    { name: "ship", cwd: place + "/out", line: "echo ok", network: true, reads: [], app: true, ok: true, at: Date.UTC(2026, 0, 3) },
  ] });
  d.set("mods", { ok: true, offer: null, mods: [
    { ok: true, on: true, front: false, key: "k1", label: "保存", name: "save", app: "Notes", permission: "read", origin: "人が置いた", seen: 1, runs: place + "/run" },
    { ok: true, on: false, front: false, key: "k2", label: "送る", name: "send", app: "Notes", permission: "write", origin: "手順から作った", seen: 2, runs: "" },
  ] });
  await d.loadCmds();
  await d.loadMods();
  const cmds = d.boxes.cmds.querySelectorAll("details");
  expect(cmds.length).toBe(2);
  expect(sumOf(cmds[0]).textContent).toContain("build");
  expect(sumOf(cmds[0]).textContent).not.toContain(place);
  expect(cmds[0].textContent).toContain(place);
  expect(cmds[0].open).toBe(false);
  expect(sumOf(cmds[1]).textContent).toContain("ship");
  expect(sumOf(cmds[1]).textContent).not.toContain(place);
  const mods = d.boxes.mods.querySelectorAll("details");
  expect(mods.length).toBe(2);
  expect(sumOf(mods[0]).textContent).toContain("保存");
  expect(sumOf(mods[0]).textContent).not.toContain(place);
  expect(mods[0].textContent).toContain("作った人");
  expect(mods[0].textContent).toContain(place);
  const sw = sumOf(mods[0]).children.find((c: any) => c.constructor?.name === "KgToggle");
  expect(sw?.hasAttribute("on")).toBe(true);
  const sw2 = sumOf(mods[1]).children.find((c: any) => c.constructor?.name === "KgToggle");
  expect(sw2?.hasAttribute("on")).toBe(false);
  expect(d.boxes["learned-empty"].hidden).toBe(true);
});

test("AC3 節の details を開いたあと、中の 1 件を開いても節は閉じない", () => {
  const s = mount("kg-settings") as any;
  const sec = new Plain("details");
  const row = new Plain("details");
  sec.append(row);
  s.append(sec);
  sec.open = true;
  sec.dispatchEvent({ type: "toggle", target: sec });
  row.open = true;
  row.dispatchEvent({ type: "toggle", target: row });
  expect(sec.open).toBe(true);
  expect(row.open).toBe(true);
});

test("AC4 0 件なら #cmds と #mods は hidden で、「まだありません」の 1 行だけ", async () => {
  expect(html).toContain('<p id="learned-empty">まだありません</p>');
  const sec = html.slice(html.indexOf('<details id="learned-sec">'), html.indexOf("</details>", html.indexOf('<details id="learned-sec">')) + "</details>".length);
  expect(sec).toContain("まだありません");
  expect(sec).not.toContain("まだ何も登録していません");
  const d = draw();
  d.set("cmdList", { ok: true, items: [] });
  d.set("mods", { ok: true, mods: [], offer: null });
  await d.loadCmds();
  await d.loadMods();
  expect(d.boxes.cmds.hidden).toBe(true);
  expect(d.boxes.mods.hidden).toBe(true);
  expect(d.boxes.cmds.children.length).toBe(0);
  expect(d.boxes.mods.children.length).toBe(0);
  expect(d.boxes["learned-empty"].hidden).toBe(false);
  expect(d.boxes["learned-empty"].textContent).toBe("まだありません");
});

test("AC5 会話の行は「歯車の「覚えた物」」で、「一覧の「手順として覚える」」は無い", () => {
  expect(main).toContain("歯車の「覚えた物」で");
  expect(main).not.toContain("一覧の「手順として覚える」");
  expect(js).not.toContain("一覧の「手順として覚える」");
});
