// W111: 一覧の行は avatar と本文の別 button（兄弟）・状態が無い行は 3 行目を作らない・DESIGN.md §4 / §6 の値は token。実機の見た目は未測（要 operator）。
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount, El } from "./domshim.ts";
beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const base = { name: "経理の担当", glyph: "経", state: null, fail: false, last: "請求書を 3 件まとめました", lastHidden: false, time: "10:02", dot: true, surfaces: [] as any[] };
const row = (d: Record<string, unknown> = {}) => { const k = mount("kg-row") as any; k.data = { ...base, ...d }; return k as El & { data: unknown }; };
const buttons = (n: El): El[] => n.querySelectorAll("button");
const find = (n: El, cls: string): El | undefined => (n.className.split(" ").includes(cls) ? n : n.children.map((c) => find(c, cls)).find(Boolean));

test("W111 AC1: 行の button は 2 つ（avatar と本文）で、どちらも行の直下の兄弟・button の中に button は 0", () => {
  const k = row({ surfaces: [{ key: "tab:7", kind: "tab", app: "tab" }] }); // 面の icon が在っても button は増えず、本文の中にも入らない
  const bs = buttons(k);
  expect(bs.map((b) => b.className)).toEqual(["av-btn", "root"]);
  expect(bs.every((b) => b.parent === k)).toBe(true);
  expect(bs.flatMap((b) => buttons(b)).length).toBe(0);
  expect(find(bs[1]!, "surfs")).toBeUndefined(); // 面の icon は本文 button の外
  expect(find(bs[0]!, "av")!.textContent).toBe("経");
  expect(bs.every((b: any) => b.type === "button")).toBe(true);
});

test("W111 AC2: avatar の click は kg-open-settings だけ（行の click に届かない）・本文の click は行に届く（= 会話）・Tab は別々の button", () => {
  const k = row();
  const [av, body] = buttons(k) as [El, El];
  const got: string[] = []; let rowClicks = 0;
  k.addEventListener("kg-open-settings", () => got.push("settings"));
  k.addEventListener("click", () => rowClicks++);
  av.click();
  expect(got).toEqual(["settings"]);
  expect(rowClicks).toBe(0);
  body.click();
  expect(rowClicks).toBe(1);
  expect(got).toEqual(["settings"]);
  expect((av as any).attrs.get("aria-label")).toBe("経理の担当の設定");
});

test("W111 AC3: 状態が無い行に 3 行目（mark）の要素が無い・状態が付くと出て、消えるとまた無い（同じ element を使い回す）", () => {
  const k = row({ state: null });
  expect(find(k, "mark")).toBeUndefined();
  k.data = { ...base, state: ["turn", "あなたの番です"], tone: "turn" };
  const m = find(k, "mark")!;
  expect(m.className).toBe("mark turn");
  expect(m.textContent).toBe("あなたの番です");
  k.data = { ...base, state: ["work", "動いています"], tone: "" };
  expect(find(k, "mark")).toBe(m);
  k.data = { ...base, state: null };
  expect(find(k, "mark")).toBeUndefined();
  expect(find(k, "prov")).toBeUndefined();
});

test("W111 AC4: panel.css の行は token だけ（左線なし・色 / px の直書きなし）・kg-row の寸法と状態の背景", () => {
  const css = stripComments(read("extension/panel.css"));
  const body = (sel: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.split(",").some((x) => x.trim() === sel)).map((m) => m[2]).join(";");
  expect(css).not.toMatch(/border-left\s*:[^;{}]*var\(\s*--ag/);
  const row = body("kg-row");
  expect(row).toMatch(/min-height:\s*var\(--h-row\)/);
  expect(row).toMatch(/padding:\s*var\(--row-pad-y\)\s+var\(--row-pad-x\)/);
  expect(row).toMatch(/gap:\s*var\(--row-gap\)/);
  expect(row).toMatch(/margin:\s*0 0 var\(--row-margin\)/);
  expect(body("kg-row[on]")).toMatch(/background:\s*var\(--muted\)/);
  expect(body("kg-row:hover")).toMatch(/background:\s*var\(--hover\)/);
  expect(body("kg-row:active")).toMatch(/background:\s*var\(--active\)/);
  expect(body("kg-row .av-btn")).toMatch(/width:\s*var\(--hit\);\s*height:\s*var\(--hit\)/);
  expect(body("kg-row .av.li")).toMatch(/width:\s*var\(--av-list\)/);
  expect(body(".root.you .root-text")).toMatch(/font-weight:\s*var\(--fw-strong\)/);
  expect(body(".root-text")).toMatch(/font-weight:\s*var\(--fw-medium\)/);
  expect(body(".root .badge")).toMatch(/width:\s*var\(--badge-dot\)/);
  expect(body(".root .badge")).toMatch(/background:\s*var\(--fg\)/);
  expect(body(".root .mark .ic")).toMatch(/width:\s*var\(--ic-1\)/);
  expect(body(".root .mark")).not.toMatch(/color\s*:/); // 状態の色は W110 の .mark.turn / .fail / .work だけ
});

test("W111 panel: 行は kg-row（li の直下）・会話は行の click・設定は kg-open-settings・provider 名は渡さない", () => {
  const js = read("extension/panel.js");
  const fill = js.slice(js.indexOf("function fillRootButton"), js.indexOf("function rowState"));
  expect(js).toContain('document.createElement("kg-row")');
  expect(js).toContain('li.querySelector(":scope > kg-row")');
  expect(js).toMatch(/row\.onclick = \(\) => once\(async \(\) => \{ await selectRoot\(r\.id\); closeList\(\); \}\)/);
  expect(js).toContain('$("roots").addEventListener("kg-open-settings"');
  expect(fill).not.toMatch(/prov:/);
  expect(fill).toContain('row.toggleAttribute("on"');
});
