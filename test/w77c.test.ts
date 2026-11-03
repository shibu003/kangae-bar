// W77c（CEO 10-14「ユーザーが見なくていい物は見せない」・要件 37「agent ごとに受け持つ面の icon。閉じている間は icon だけで描画 0・押した時だけ縮小絵」）:
// kg-row（agent 一覧の 1 行）と kg-settings（歯車の中・節は既定で閉じ 1 つ開くと他は閉じる）。本物のブラウザ・ポインタに触れない（最小の DOM の代役）。実機の見た目は未測（要 operator）
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount, Plain, El } from "./domshim.ts";
const g = globalThis as any;
beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const noComments = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const base = { name: "経理の担当", glyph: "経", state: ["work", "動いています"], fail: false, last: "請求書を 3 件まとめました", lastHidden: true, time: "10:02", dot: false, surfaces: [] as any[] };
const row = (d: Record<string, unknown> = {}) => { const k = mount("kg-row") as any; k.data = { ...base, ...d }; return k; };
const find = (n: El, cls: string): El | undefined => (n.className.split(" ").includes(cls) ? n : n.children.map((c) => find(c, cls)).find(Boolean));

test("W77c kg-row: 既存の .root の中身と同じ class の構造（担当名・状態・最後の 1 行・時刻・未読の点）で描く", () => {
  const k = row({ state: ["turn", "あなたの番です"], lastHidden: false, dot: true });
  expect(find(k, "root-text")!.textContent).toBe("経理の担当");
  expect(find(k, "av")!.textContent).toBe("経");
  expect(find(k, "pv-last")!.textContent).toBe("請求書を 3 件まとめました");
  expect(find(k, "pv-last")!.hidden).toBe(false);
  expect(find(k, "mark")!.textContent).toBe("あなたの番です");
  expect(find(k, "mark")!.hidden).toBe(false);
  expect(find(k, "time")!.textContent).toBe("10:02");
  expect(find(k, "badge")!.hidden).toBe(false);
  expect(find(k, "prov")).toBeUndefined(); // W111: provider 名は一覧に出さない
});

test("W77c kg-row: 状態が無い行は mark（3 行目）を作らず最後の文を出す・失敗は fail の印・未読が無ければ点は出ない・描き直しで同じ element を使い回す（押している最中に差し替えない）", () => {
  const k = row({ state: null, lastHidden: false });
  expect(find(k, "mark")).toBeUndefined(); // W111: 隠すのではなく要素が無い
  expect(find(k, "badge")!.hidden).toBe(true);
  const before = find(k, "root-text");
  k.data = { ...base, state: ["turn", "失敗"], fail: true, lastHidden: false };
  expect(find(k, "mark")!.className).toBe("mark fail");
  expect(find(k, "root-text")).toBe(before);
});

test("W77c kg-row: 面は icon（種類と app 名だけ）で、閉じている間は縮小絵を描かない・icon を押した時だけ kg-peek {key}・行そのものの click にはならない", () => {
  const k = row({ surfaces: [{ key: "tab:7", kind: "tab", app: "tab" }, { key: "app:Zed", kind: "app", app: "Zed" }] });
  const surfs = find(k, "surfs")!;
  expect(surfs.hidden).toBe(false);
  expect(surfs.children.map((c: any) => c.innerHTML.includes("<svg") && !/[🌐🖥]/u.test(c.innerHTML))).toEqual([true, true]); // W119: 面の印は線画の SVG（emoji ではない）。textContent は空
  expect(surfs.children.map((c: any) => c.title)).toEqual(["tab", "Zed"]); // 頁の題・URL は載らない
  expect(find(k, "peek")).toBeUndefined(); // 描画 0
  const got: string[] = []; let rowClicked = false;
  k.addEventListener("kg-peek", (e: any) => got.push(e.detail.key));
  k.parent!.addEventListener("click", () => (rowClicked = true));
  surfs.children[1]!.click();
  expect(got).toEqual(["app:Zed"]);
  expect(rowClicked).toBe(false);
  const first = surfs.children[0];
  k.data = { ...base, surfaces: [{ key: "tab:7", kind: "tab", app: "tab" }, { key: "app:Zed", kind: "app", app: "Zed" }] };
  expect(find(k, "surfs")!.children[0]).toBe(first); // 同じ面なら作り直さない
  k.data = { ...base, surfaces: [] };
  expect(find(k, "surfs")!.hidden).toBe(true);
});

test("W77c kg-settings: 節は既定で閉じ、1 つ開くと他は閉じる・open は hidden の逆", () => {
  const s = mount("kg-settings") as any;
  const a = new Plain("details"), b = new Plain("details");
  s.append(a, b);
  expect(s.open).toBe(true); s.open = false; expect(s.hidden).toBe(true); s.open = true; expect(s.hidden).toBe(false);
  a.open = true; a.dispatchEvent({ type: "toggle", target: a });
  b.open = true; b.dispatchEvent({ type: "toggle", target: b });
  expect([a.open, b.open]).toEqual([false, true]);
});

test("W77c panel: 設定は 2 つの節（会話・画面の操作）・名前だけの 3 つの頁の入口は歯車の中に出さない・一覧の行は kg-row を通る・内部語が部品に無い", () => {
  const html = read("extension/panel.html"), js = noComments(read("extension/panel.js")), kg = noComments(read("extension/kg.js"));
  const pop = html.match(/<kg-settings id="user-pop"[\s\S]*?<\/kg-settings>/)![0];
  expect(pop.match(/<details>/g)!.length).toBe(2);
  expect(pop).toContain("<summary>会話</summary>");
  expect(pop).toContain("<summary>画面の操作</summary>");
  expect(pop).not.toMatch(/data-pane|GitHub|plugin|phone/);
  expect(pop).toContain('id="viewer-app"'); expect(pop).toContain('id="cursor-overlay"'); expect(pop).toContain('id="named-only"');
  expect(js).toContain('document.createElement("kg-row")');
  expect(js).not.toMatch(/mk\("span", "root-text"\)/); // 行の中身の組み立ては部品の 1 か所
  expect(js).toContain('customElements.get("kg-row").icons = ICON');
  expect(kg).not.toMatch(/\blease\b|世代|token|origin|\bgen\b/);
  expect(kg).not.toMatch(/\bcall\(|chrome\.|localStorage/);
  expect(js).toMatch(/kg-peek[^\n]*rowPeek/); // 押した面だけ縮小絵
  expect(js).toContain('document.querySelectorAll(".lease, .auth-card, .row-peek")');
});
