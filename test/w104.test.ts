// W104: menu bar の menu は 5 行。1 行目に port を出さない。「設定を開く」は歯車と同じ開き方。
// 実機（menu を開く・設定が開く）は未測。読む file を literal で名指す: "bar/main.swift" "extension/panel.js"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

function menuFn(swift: string) {
  const i = swift.indexOf("func menuNeedsUpdate");
  const j = swift.indexOf("\n    func ", i + 1);
  return swift.slice(i, j);
}

test("W104 AC1: 1 行目はつながっています / Kangae が起きていません。port の表示は 0", () => {
  const swift = code(read("bar/main.swift"));
  expect(swift.includes("port \\(")).toBe(false);
  const fn = menuFn(swift);
  expect(fn).toContain("つながっています ・ \\(hot)");
  expect(fn).toContain('keyName == "なし" ? "hotkey なし"');
  expect(fn).toContain("Kangae が起きていません");
  expect(fn).toContain("daemonInfo() != nil");
});

test("W104 AC2: 主 menu の action 行は 5 つ。nextKey killOthers quitAll point は submenu だけ", () => {
  const fn = menuFn(code(read("bar/main.swift")));
  const lines = fn.split("\n");
  const main = lines.filter((l) => l.includes("menu.addItem(withTitle:"));
  const sub = lines.filter((l) => l.includes("sub.addItem(withTitle:"));
  const action = (l: string) => /action:\s*#selector\(/.test(l);
  const mainAct = main.filter(action);
  expect(mainAct.map((l) => l.match(/withTitle:\s*"([^"]+)"/)?.[1])).toEqual([
    "出す / 消す (\\(keyName))",
    "画面を囲んで聞く",
    "指して渡す",
    "設定を開く",
    "終わる",
  ]);
  const joined = mainAct.join("\n");
  expect(joined).toContain("#selector(toggle)");
  expect(joined).toContain("#selector(snip)");
  expect(joined).toContain("#selector(pointGive)");
  expect(joined).toContain("#selector(openSettings)");
  expect(joined).toContain("#selector(NSApplication.terminate(_:))");
  expect(joined).toContain('keyEquivalent: "q"');
  for (const sel of ["point", "nextKey", "killOthers", "quitAll"]) {
    expect(joined.includes(`#selector(${sel})`)).toBe(false);
    expect(sub.join("\n").includes(`#selector(${sel})`)).toBe(true);
  }
  expect(fn).toContain('NSMenuItem(title: "その他"');
  expect(main.join("\n")).toContain("🔴 余分な bar が");
  expect(sub.join("\n")).toContain("カーソルで指すだけ");
  expect(sub.join("\n")).toContain("hotkey が全部使われています（" + "~/" + ".kangae/bar.conf の hotkey= で指定）");
  expect(sub.join("\n")).toContain("余分な bar を全部終わらせる");
  expect(sub.join("\n")).toContain("全部終わる（bar も 常駐も）");
  const end = mainAct.findIndex((l) => l.includes("終わる"));
  const set = mainAct.findIndex((l) => l.includes("設定を開く"));
  expect(fn.indexOf("menu.addItem(.separator())", fn.indexOf("設定を開く"))).toBeLessThan(fn.indexOf('withTitle: "終わる"'));
  expect(set).toBeLessThan(end);
});

test("W104 AC3: kangaeOpenSettings は nav.root のあと歯車を開き、__kangaeSettings を起動時に 1 回見る", async () => {
  const js = code(read("extension/panel.js"));
  const startAt = js.indexOf("window.kangaeOpenSettings =");
  const endAt = js.indexOf('$("retry").onclick = start');
  expect(startAt).toBeGreaterThan(js.indexOf("window.kangaeOpenList"));
  expect(endAt).toBeGreaterThan(startAt);
  const block = js.slice(startAt, endAt);
  expect(block).toContain("nav.root()");
  expect(block).toContain('$("user-btn").onclick()');
  expect(block).toContain("window.__kangaeSettings");
  const swift = code(read("bar/main.swift"));
  const openAt = swift.indexOf("func openSettings");
  const open = swift.slice(openAt, swift.indexOf("\n    @objc func ", openAt + 1));
  expect(open).toContain("if !panel.isVisible { show() }");
  expect(open).not.toContain("hide()");
  expect(open).toContain('evaluateJavaScript("window.kangaeOpenSettings?.()"');
  expect(open).toContain("wantSettings = true");
  expect(swift).toContain('WKUserScript(source: "window.__kangaeSettings=1"');

  const seen: string[] = [];
  const nav = {
    root() { seen.push("root"); },
    push(s: string) { seen.push(s); },
  };
  const $ = (id: string) => {
    if (id === "user-btn") return { onclick() { nav.push("settings"); } }; // W113: 歯車は popover でなく nav の 1 段
    return {};
  };
  const run = new Function("nav", "$", "window", `
    let starting = false;
    async function start() {
      if (starting) return "re";
      starting = true;
      await Promise.resolve();
      starting = false;
      return "ok";
    }
    ${block}
    return start;
  `);
  const win = { __kangaeSettings: 1 } as { __kangaeSettings?: number };
  const start = run(nav, $, win) as (...a: unknown[]) => Promise<string>;
  expect(await start()).toBe("ok");
  expect(seen).toEqual(["root", "settings"]);
  expect(win.__kangaeSettings).toBe(0);
  seen.length = 0;
  expect(await start()).toBe("ok");
  expect(seen).toEqual([]);
});
