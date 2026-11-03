// W108: 押す操作は別頁ではなく panel の 1 画面。○＜（kg-back）で一覧へ戻る。
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

function files(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".git") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, acc);
    else if (/\.(html|js|css|json|ts|swift|md)$/.test(n)) acc.push(p);
  }
  return acc;
}

test("W108 AC1: press.html が無く、extension / src / bar にその名前が 0", () => {
  expect(existsSync(join(root, "extension/press.html"))).toBe(false);
  const hits = ["extension", "src", "bar"].flatMap((d) => files(join(root, d))).filter((f) => readFileSync(f, "utf8").includes("press.html"));
  expect(hits).toEqual([]);
});

test("W108 AC2: panel に #press があり、nav が press を開いて mountPress で読み直す", () => {
  const html = read("extension/panel.html");
  const js = read("extension/panel.js");
  expect(html).toContain('<section id="press"');
  expect(html).toContain('id="note"');
  expect(html).toContain('id="list"');
  expect(html).toContain('id="take-path"');
  expect(html).toContain('id="take-go"');
  expect(html).toContain('<script src="press.js"></script>');
  expect(js).toContain('nav.show("press")');
  expect(js).toContain('globalThis.mountPress($("press"))');
  expect(read("extension/press.js")).toContain("globalThis.mountPress = mountPress");
  expect(read("extension/press.js")).toContain('call("press"');
});

test("W108 AC4: ← 戻る は無く、press 画面に kg-back がある", () => {
  const html = read("extension/panel.html");
  const a = html.indexOf('<section id="press"');
  const b = html.indexOf('<section id="chat"');
  const sec = html.slice(a, b);
  expect(sec).toContain('<kg-back id="press-back"');
  expect(html).not.toContain("← 戻る");
  expect(read("extension/press.js")).not.toContain("← 戻る");
  expect(read("extension/panel.js")).toContain('"press-back"');
});
