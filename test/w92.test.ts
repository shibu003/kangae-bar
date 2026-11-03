// W92（CEO 10-14 §10.3）: agent の icon → その agent の設定（名前 1 つ・きまり・消すは 2 段・口の無い物は表示だけ）。本物のブラウザには触れない（最小の DOM の代役）。実機の見た目は未測（要 operator）
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount } from "./domshim.ts";
beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const mk = () => { const s = mount("kg-agent-settings") as any; const ev: any[] = []; for (const t of ["kg-agent-name", "kg-agent-rule", "kg-agent-remove"]) s.addEventListener(t, (e: any) => ev.push([t, e.detail])); s.data = { key: 1, glyph: "A", name: "Alice", prov: "claude" }; return { s, ev, e: s._e }; };

test("W92 名前を変える・きまりを伝える: 空は送らず、前後の空白は落とす（口へ渡すのは 1 つの名前 / 1 つの文だけ）", () => {
  const { ev, e } = mk();
  e.name.value = "  "; e.save.click(); e.rule.value = ""; e.tell.click();
  expect(ev).toEqual([]);
  e.name.value = " Bob "; e.save.click();
  e.rule.value = "  いつも日本語で  "; e.tell.click();
  expect(ev).toEqual([["kg-agent-name", { name: "Bob" }], ["kg-agent-rule", { text: "いつも日本語で" }]]);
  expect(e.rule.value).toBe(""); // 伝えたら欄は空
});

test("W92 消すは 2 段: 1 度目は何も消さず「本当に消す」に変わるだけ・2 度目で 1 回だけ・別の agent に替わったら 1 度目を引き継がない", () => {
  const { s, ev, e } = mk();
  e.del.click();
  expect(ev).toEqual([]);
  expect(e.del.textContent).toBe("本当に消す");
  s.data = { key: 2, glyph: "B", name: "Bob" }; // 別の agent
  expect(e.del.textContent).toBe("この agent を消す");
  e.del.click();
  expect(ev).toEqual([]); // 前の agent の 1 度目で消えない
  e.del.click();
  expect(ev).toEqual([["kg-agent-remove", {}]]);
  expect(e.del.textContent).toBe("この agent を消す");
  e.del.click(); // 消した直後にもう 1 度押しても 1 度目から
  expect(ev.length).toBe(1);
  s.disarm();
});

test("W92 口の無い物（icon を変える・どの AI・共に働く agent）は表示だけ: 触れる欄 / ボタンを持たず「繋がるまで」と 1 行・名前は textContent で字になる", () => {
  const { s, e } = mk();
  expect(e.ai.textContent).toBe("どの AI で: claude（繋がるまで変えられません）");
  expect(e.mate.textContent).toContain("繋がるまで触れません");
  expect(s.querySelectorAll("button").map((b: any) => b.dataset.act).sort()).toEqual(["name", "remove", "rule"]); // 押せるのは 3 つだけ
  s.data = { key: 1, glyph: "<", name: "<img src=x onerror=1>‮", prov: "" };
  expect(e.name.value).toBe("<img src=x onerror=1>‮");
  expect(e.av.textContent).toBe("<");
  expect(e.ai.hidden).toBe(true); // 候補が無ければ出さない
  expect(s.textContent).not.toMatch(/lease|token|origin|\bop\b|runId|nodeId/);
});

test("W92 配線: 行の icon と header の icon から開き、既存の口（agentName / rename / instruct / remove）だけを使い、消す前に面を人へ戻す", () => {
  const js = read("extension/panel.js"), kg = read("extension/kg.js"), html = read("extension/panel.html");
  expect(html).toContain('<kg-agent-settings id="agent-settings">');
  expect(kg).toContain('e.avBtn.addEventListener("click"'); // W111: avatar は別の button（行の中の兄弟）
  expect(kg).toContain('"kg-open-settings"');
  expect(js).toContain('$("roots").addEventListener("kg-open-settings"');
  expect(js).toContain('$("hd-av").addEventListener("click"');
  for (const op of ["agentName", "rename", "instruct", "remove", "leaseTakeback"]) expect(js).toContain(`call("${op}"`);
  expect(js.indexOf('call("leaseTakeback"')).toBeLessThan(js.indexOf('call("remove"')); // 先に面を人へ戻す
  expect(js).toContain('openPane("agent")');
});
