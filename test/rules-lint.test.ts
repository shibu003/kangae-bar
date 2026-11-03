// rules-lint: 各規則が「違反の行で赤・正しい行で緑・足していない行は見ない」・表の各行が原文と正本と例を持つ
import { expect, test } from "bun:test";
import { addedLines, lint, RULES } from "../tools/rules-lint";

const L = (file: string, text: string) => ({ file, line: 1, text });
const ids = (file: string, text: string, staged: string[] = []) => lint([L(file, text)], staged).map((v) => v.rule.id);

// [規則, file, 違反の行, 正しい行]
const cases: [string, string, string, string][] = [
  ["headless", "test/x.e2e.ts", 'extraArgs: [`--remote-debugging-port=${p}`, "about:blank"],', 'extraArgs: ["--headless=new", `--remote-debugging-port=${p}`],'],
  ["headless", "tools/x.ts", 'Bun.spawn(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless", "about:blank"]);', 'Bun.spawn(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new"]);'],
  ["shared-kill", "src/x.ts", 'Bun.spawnSync(["pkill", "-f", "kangae"]);', 'Bun.spawnSync(["pkill", "-f", dir]);'],
  ["shared-kill", "test/x.ts", 'sh(`pkill -f kangae 2>/dev/null`);', 'sh(`pkill -f "${D}" 2>/dev/null`); Bun.spawnSync(["sh", "-c", `pkill -f -- "--user-data-dir=${p}"`]);'],
  ["shared-kill", "docs/verify/a/run.sh", "pgrep -f kangae | xargs kill", "kill \"$pid\""],
  ["shared-kill", "tools/x.sh", "killall Chromium", "kill -9 $PID"],
  ["front", "test/x.ts", 'osascript -e \'tell application "Chromium" to activate\'', "osascript -e 'get name of app 1'"],
  ["front", "tools/x.swift", "NSApp.activate(ignoringOtherApps: true)", "expect(plan.activate).toBe(2); const r = { activate: null };"],
  ["front", "test/x.ts", 'Bun.spawn(["open", "-a", CHROMIUM_APP]);', 'Bun.spawn(["open", "-g", "-a", CHROMIUM_APP]);'],
  ["front", "docs/verify/a/run.sh", "open -n -a Chromium", "open -g -n -a Chromium"],
  ["git-write", "test/x.test.ts", 'sh(["git", "config", "user.name", "t"]);', 'sh(["git", "commit", "-m", "x"]);'],
  ["git-write", "tools/x.sh", "git -C \"$d\" stash", "git -C \"$d\" status"],
  ["git-write", "docs/verify/a/run.sh", "git init", "git log -1"],
  ["real-machine", "docs/REPORT-x.md", "UC 10 本、実機で確かめた", "UC 10 本は試験で確かめた・実機は未測（要 operator）"],
  ["owner-home", "test/x.test.ts", 'const t = readFileSync(join(homedir(), ".kangae", "token"));', 'const t = readFileSync(join(dir, "token"));'],
  ["owner-home", "docs/verify/a/uc.ts", 'open("/Applications/Kangae Bar.app")', 'const barApp = join(repo, "bar/dist/Kangae Bar.app");'],
];

for (const [id, file, bad, good] of cases) {
  test(`${id}: ${file} の違反の行で赤・正しい行で緑`, () => {
    expect(ids(file, bad)).toContain(id);
    expect(ids(file, good)).not.toContain(id);
  });
}

test("すべての規則が少なくとも 1 本の赤の例を持つ（規則を消すと上の試験が赤）", () => {
  for (const r of RULES) expect(cases.some((c) => c[0] === r.id)).toBe(true);
});

test("表の各行が原文・正本・例を持ち、例は自分の規則で赤", () => {
  for (const r of RULES) {
    expect(r.says.length && r.source.length && r.example.length).toBeTruthy();
  }
  expect(ids("test/x.ts", RULES.find((r) => r.id === "headless")!.example)).toContain("headless");
  expect(ids("src/x.ts", RULES.find((r) => r.id === "shared-kill")!.example)).toContain("shared-kill");
  expect(ids("test/x.ts", RULES.find((r) => r.id === "front")!.example)).toContain("front");
  expect(ids("test/x.ts", RULES.find((r) => r.id === "git-write")!.example)).toContain("git-write");
  expect(ids("test/x.ts", RULES.find((r) => r.id === "owner-home")!.example)).toContain("owner-home");
});

test("実機: 同じ commit に docs/verify/ の写真が在れば緑", () => {
  expect(ids("docs/HANDOFF-x.md", "実機で確かめた", ["docs/verify/x/step1.png"])).toEqual([]);
  expect(ids("docs/HANDOFF-x.md", "実機で確かめた", ["docs/verify/x/run.txt"])).toEqual(["real-machine"]);
});

test("範囲の外: src の Chrome・コメント・md・rules-ok は見ない", () => {
  expect(ids("src/x.ts", 'extraArgs: ["about:blank"],')).toEqual([]);
  expect(ids("test/x.ts", 'expect(chromiumArgs({ ...base, extraArgs: ["--remote-debugging-port=9"] })).toContain("x");')).toEqual([]);
  expect(ids("test/x.ts", "// pkill -f は打たない（自分の PID だけ）")).toEqual([]);
  expect(ids("docs/SHELL-RUNNER.md", "pkill -f を打たない")).toEqual([]);
  expect(ids("test/x.ts", 'sh(["git", "init"]); // rules-ok: 使い捨ての tmpdir')).toEqual([]);
});

test("足していない行（消した行・文脈の行）は見ない", () => {
  const diff = [
    "diff --git a/test/x.ts b/test/x.ts",
    "--- a/test/x.ts",
    "+++ b/test/x.ts",
    "@@ -3,1 +3,1 @@",
    '-Bun.spawnSync(["pkill", "-f", "old"]);',
    "+const ok = 1;",
    "@@ -10,0 +11,2 @@",
    "+const a = 2;",
    '+Bun.spawnSync(["killall", "Chromium"]);',
    "diff --git a/old.ts b/old.ts",
    "--- a/old.ts",
    "+++ /dev/null",
  ].join("\n");
  const lines = addedLines(diff);
  expect(lines.map((l) => [l.file, l.line])).toEqual([["test/x.ts", 3], ["test/x.ts", 11], ["test/x.ts", 12]]);
  expect(lint(lines, []).map((v) => [v.rule.id, v.at.line])).toEqual([["shared-kill", 12]]);
});
