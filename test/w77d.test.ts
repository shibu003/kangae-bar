// W77d（CEO 10-14「toast のように・見なくていい物は見せない」）: kg-toast = 自動で消える報せ（Toast）と 1 操作つき（Snackbar）。画面に 1 枚・modal は作らない・内部語を出さない。
// 本物のブラウザ・ポインタに触れない（最小の DOM の代役）。実機の見た目・位置は未測（要 operator）
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount } from "./domshim.ts";
const g = globalThis as any;
beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("W77d kg-toast: 出る → 自動で消える（既定は知らせ 4 秒・失敗と操作つきは 8 秒）・新しいのが来たら 1 枚に置き換わる", async () => {
  const t = mount("kg-toast") as any;
  expect(t.hidden).toBe(true);
  t.show("添付を送りました", { ms: 30 });
  expect(t.hidden).toBe(false);
  expect(t.textContent).toBe("添付を送りました");
  expect(t.className).toBe("toast ok");
  await sleep(60);
  expect(t.hidden).toBe(true);
  expect(t.textContent).toBe("");
  t.show("1 つ目", { ms: 30 }); t.show("2 つ目", { tone: "warn", ms: 200 });
  await sleep(60); // 1 つ目の時計は 2 つ目に引き継がれない
  expect(t.hidden).toBe(false);
  expect(t.textContent).toBe("2 つ目");
  expect(t.className).toBe("toast warn");
  const src = code(read("extension/kg.js"));
  expect(src).toContain('o.ms ?? (o.action || tone === "warn" ? 8000 : 4000)');
  t.hide();
});

test("W77d kg-toast: snackbar は 1 操作だけ・押すと kg-action {id} を 1 度だけ投げて閉じる", () => {
  const t = mount("kg-toast") as any; const got: string[] = [];
  t.addEventListener("kg-action", (e: any) => got.push(e.detail.id));
  t.show("送りました", { action: { id: "undo", label: "取り消す" }, ms: 1000 });
  const btns = t.querySelectorAll("button[data-act]");
  expect(btns.length).toBe(1);
  expect(btns[0].textContent).toBe("取り消す");
  btns[0].click();
  expect(got).toEqual(["undo"]);
  expect(t.hidden).toBe(true);
  t.show("操作なし", { ms: 1000 });
  expect(t.querySelectorAll("button[data-act]").length).toBe(0);
  t.hide();
});

test("W77d kg-toast: hide(tone) はその種類が出ている時だけ閉じる（入力し直したら失敗の報せだけ消し、知らせは残す）", () => {
  const t = mount("kg-toast") as any;
  t.show("知らせ", { tone: "ok", ms: 1000 });
  t.hide("warn"); expect(t.hidden).toBe(false);
  t.show("失敗", { tone: "warn", ms: 1000 });
  t.hide("warn"); expect(t.hidden).toBe(true);
});

test("W77d kg-toast: 文字は textContent だけ（頁の題・agent の名前が HTML にならない）・role=status・port / storage を持たない・modal を作らない", () => {
  const t = mount("kg-toast") as any;
  t.show("<img src=x onerror=alert(1)>", { ms: 1000 });
  expect(t.textContent).toBe("<img src=x onerror=alert(1)>");
  expect(t.children.length).toBe(1);
  expect(t.getAttribute("role")).toBe("status");
  t.hide();
  const kg = code(read("extension/kg.js")), toastSrc = kg.slice(kg.indexOf("class KgToast"), kg.indexOf("class KgApprove"));
  expect(toastSrc).not.toMatch(/innerHTML|\bcall\(|chrome\.|localStorage|dialog|showModal|alert\(|confirm\(/);
});

test("W77d panel: 失敗・知らせは toast に寄った（欄の下の赤い 1 行・undo の 1 行・mod の 1 行・folder の 1 行は無い）・渡す文に内部の語が無い", () => {
  const js = code(read("extension/panel.js")), html = read("extension/panel.html");
  expect(html).toContain('<kg-toast id="toast"></kg-toast>');
  expect(html).not.toMatch(/id="(empty|send)-err"/);
  expect(js).not.toMatch(/\bundoNote\b|\bmodNote\b|"undo-note"|"mod-note"|\.field-err/);
  expect(js).toContain('const toast = (text, o) => $("toast").show(text, o)');
  const fixed = [...js.matchAll(/toast\(\s*(?:x\.ok \? )?(`[^`]*`|"[^"]*")/g)].map((m) => m[1]!).join("\n") + [...js.matchAll(/"([^"\n]*)"(?=, \{ tone)/g)].map((m) => m[1]!).join("\n");
  expect(fixed.length).toBeGreaterThan(20);
  expect(fixed).not.toMatch(/\blease\b|世代|token|origin|\bgen\b|\bop\b|key=|cua|AX/);
  for (const [name, n] of [["showErr 経由", js.split("showErr(").length - 1], ["toast(", js.split("toast(").length - 1]] as const) expect(n, name).toBeGreaterThanOrEqual(name === "toast(" ? 5 : 6);
});
