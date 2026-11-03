// W115: DESIGN.md §6「ボタン4種」を panel.css の 1 か所に（primary / quiet / destructive / icon・hover / active / focus-visible / disabled）。
// 実機の見た目は未測。読む file: "extension/panel.css"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "extension/panel.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " ")), body: m[2]!.replace(/\s+/g, " ") }));
const body = (sel: string) => rules.filter((r) => r.sels.includes(sel)).map((r) => r.body).join(";");

test("W115 AC1: 4 種の rule（destructive の hover / active・icon の 44px と hover・focus-visible・disabled）が在る", () => {
  expect(body(".btn.destructive:hover:not(:disabled)")).toContain("background:var(--destructive-hover)");
  expect(body(".btn.destructive:active:not(:disabled)")).toContain("background:var(--destructive-active)");
  expect(body(".btn.icon")).toMatch(/width:var\(--hit\);\s*height:var\(--hit\)/);
  expect(body(".btn.icon")).toContain("color:var(--muted-fg)");
  expect(body(".btn.icon:hover:not(:disabled)")).toMatch(/background:var\(--hover\);\s*color:var\(--fg\)/);
  expect(body(".btn.icon:active:not(:disabled)")).toMatch(/background:var\(--active\);\s*color:var\(--fg\)/);
  expect(body(".btn:focus-visible")).toContain("outline:var(--focus-w) solid var(--focus); outline-offset:var(--focus-offset)");
  expect(body(".btn.primary:hover:not(:disabled)")).toContain("var(--primary-hover)");
  expect(body(".btn:hover:not(:disabled)")).toContain("var(--hover)");
});

test("W115 AC2: button:disabled は opacity:.55 でなく disabled token・hover / active は :not(:disabled) で無い", () => {
  const d = body("button:disabled");
  expect(d).not.toContain("opacity:.55");
  for (const s of ["background:var(--disabled-bg)", "color:var(--disabled-fg)", "opacity:var(--disabled-opacity)", "cursor:not-allowed"]) expect(d).toContain(s);
  for (const sel of [".btn", ".btn.primary", ".btn.destructive", ".btn.icon"]) {
    for (const st of ["hover", "active"]) expect(rules.some((r) => r.sels.includes(`${sel}:${st}:not(:disabled)`)), `${sel}:${st}`).toBe(true);
  }
});

test("W115 AC3: .btn.p / .btn.danger は primary / destructive と同じ rule の別名・個別の囲みは quiet に揃う", () => {
  expect(rules.some((r) => r.sels.includes(".btn.primary") && r.sels.includes(".btn.p"))).toBe(true);
  expect(rules.some((r) => r.sels.includes(".btn.destructive") && r.sels.includes(".btn.danger"))).toBe(true);
  const base = rules.find((r) => r.sels.includes("#add-tab") && r.sels.includes(".btn"))!;
  expect(base.sels).toEqual(expect.arrayContaining(["#rename", "#retry", "#open-tab", "#to-desktop", "#clear-ui"]));
  expect(base.body).toContain("background:transparent");
  expect(base.body).toContain("border-radius:var(--r-md)");
  expect(body("#add-tab")).not.toContain("border-radius:var(--r-sm)"); // 独自の枠の rule は無い
  expect(css).not.toMatch(/#add-tab:hover[^{]*\{[^}]*border-color/);
});
