// W116（DESIGN §6「添付 / kg-chip と kg-view」）: chip は種類を問わず同じ形・見える文字は basename だけ（全文は title / aria-label）・外すは送りかけだけ・viewer は contain と読み幅の token。
// 本物のブラウザに触れない（最小の DOM の代役と css 本文の検査）。実機の見た目は未測（要 operator）
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount, El, Plain } from "./domshim.ts";

beforeAll(installDom);
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const buttons = (e: El) => e.querySelectorAll("button") as Plain[]; // button は Plain（title を持つ）
const css = read("extension/panel.css").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (sel: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.split(",").some((s) => s.trim() === sel)).map((m) => m[2]!).join(";");

test("W116 AC1 chip: path が来ても見える文字は basename だけ・title と aria-label に全文・種類を問わず同じ形（印 + 名前 + 大きさ）", () => {
  for (const view of ["image", "text", "pdf", "video", "file"]) {
    const c = mount("kg-chip", { view, name: "/Users/you/docs/メモ.md", meta: "2 KB" }) as any;
    const b = buttons(c);
    expect(b.length).toBe(1);
    expect(c.textContent).not.toContain("/");
    expect(c.textContent).toBe("メモ.md2 KB");
    expect(b[0]!.title).toBe("/Users/you/docs/メモ.md");
    expect(b[0]!.getAttribute("aria-label")).toBe("/Users/you/docs/メモ.md");
    expect(c.querySelectorAll("span").map((s: El) => s.className)).toEqual(["att-ico", "att-name", "att-size"]);
  }
  expect((mount("kg-chip", { view: "file", name: "C:\\Users\\you\\a.pdf" }) as any).textContent).toBe("a.pdf");
  expect((mount("kg-chip", { view: "file", name: "<b>資料</b>" }) as any).textContent).toBe("<b>資料</b>"); // HTML 風の文字の `</b>` は区切りではない
  expect((mount("kg-chip", { view: "file", name: "/" }) as any).textContent).not.toContain("/");
});

test("W116 AC2 外す: 送りかけ（removable）だけ右端の別 button・aria-label=外す・送った後（attEl）は removable を付けない", () => {
  const sending = mount("kg-chip", { view: "image", name: "a", removable: "" }) as any;
  const b = buttons(sending);
  expect(b.map((x) => x.className)).toEqual(["att-file att-open", "att-x"]);
  expect(b[1]!.getAttribute("aria-label")).toBe("外す");
  const got: string[] = []; sending.addEventListener("kg-remove", () => got.push("rm")); b[1]!.click();
  expect(got).toEqual(["rm"]);
  const sent = mount("kg-chip", { view: "image", name: "a", saveable: "" }) as any;
  expect(buttons(sent).map((x) => x.className)).toEqual(["att-file att-open", "att-save"]);
  expect(read("extension/panel.js")).toContain('if (onRemove) chip.setAttribute("removable", ""); else chip.setAttribute("saveable", "");');
});

test("W116 AC3 viewer: 画像は contain・max 幅 100%・md / txt は --w-read（720px）以内・戻る（閉じる）は左上・名前は basename・重ねる表示を作らない", () => {
  expect(rule(".att-view-body img")).toMatch(/object-fit:\s*contain/);
  expect(rule(".att-view-body img")).toMatch(/max-width:\s*100%/);
  expect(rule(".att-view-body")).toMatch(/max-width:\s*var\(--w-read\)/);
  expect(read("extension/panel.css")).toMatch(/--w-read:\s*720px/);
  expect(rule(".att-view-body h3")).toMatch(/var\(--fs-heading\)/);
  expect(rule(".att-view-body p")).toMatch(/margin:\s*0 0 var\(--sp-2\)/);
  const v = mount("kg-view") as any;
  v.show({ kind: "text", name: "/tmp/x/読む.md", text: "# 題\n本文" });
  const head = v.children[0]!;
  expect(head.children[0].className).toBe("att-x"); // 左上
  expect(head.children[1].textContent).toBe("読む.md");
  expect(head.children[1].title).toBe("/tmp/x/読む.md");
  expect(css).not.toMatch(/\.att-(view|chip|file|img)[^{]*\{[^}]*position:\s*fixed/);
});

test("W116 chip の箱は token だけ（min 44・border 1px・card・padding 8/12・gap 8）・直書きの px を置かない", () => {
  const box = rule(".att-chip");
  expect(box).toMatch(/min-height:\s*var\(--hit\)/);
  expect(box).toMatch(/border:\s*var\(--line-w\) solid var\(--border\)/);
  expect(box).toMatch(/background:\s*var\(--card\)/);
  expect(box).toMatch(/gap:\s*var\(--sp-2\)/);
  expect(rule(".att-file")).toMatch(/padding:\s*var\(--sp-2\) var\(--sp-3\)/);
  expect(rule(".att-x")).toMatch(/min-width:\s*var\(--hit\)/);
  expect(rule(".att-x")).toMatch(/min-height:\s*var\(--hit\)/);
  expect(rule(".att-ico")).toMatch(/width:\s*var\(--ic-2\)/);
  expect(css).not.toMatch(/\.att-img/);
});
