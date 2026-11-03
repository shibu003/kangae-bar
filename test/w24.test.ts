// W24: bar 同梱の kangae の path は空白入り（…/Kangae Bar.app/…）で、claude -p の許可に当たらない（実測 docs/verify/w24/probe.md）。agent に渡す path は空白なしの ~/.kangae/bin/kangae に揃える。読む file を literal で名指す: "src/cmds.ts" "src/main.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBin } from "../src/cmds.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

let top: string, home: string, bundled: string;
beforeEach(() => {
  top = realpathSync(mktmp("w24"));
  home = join(top, "home"); mkdirSync(home);
  const dir = join(top, "Kangae Bar.app", "Contents", "Resources", "bin"); mkdirSync(dir, { recursive: true });
  bundled = join(dir, "kangae"); writeFileSync(bundled, "#!/bin/sh\n"); chmodSync(bundled, 0o755);
});
afterEach(() => rmSync(top, { recursive: true, force: true }));

test("W24-1 bar 同梱（空白入り）の kangae は、空白なしの ~/.kangae/bin/kangae（同じ実体を指す symlink）に替わる。無ければ置く", () => { // rules-ok: この試験が作る temp の home（owner の home ではない）
  const link = join(home, ".kangae", "bin", "kangae"); // rules-ok: この試験が作る temp の home（owner の home ではない）
  expect(existsSync(link)).toBe(false);
  const b = agentBin(bundled, true, "/$bunfs/x", home);
  expect(b).toBe(link);
  expect(/\s/.test(b)).toBe(false);
  expect(realpathSync(link)).toBe(realpathSync(bundled));
  expect(agentBin(bundled, true, "/$bunfs/x", home)).toBe(link); // 2 回目も同じ
});

test("W24-2 他人の物は乗っ取らない: 向き先が別の実体の symlink がある・同梱の名前でない空白入りの exe は、従来の path のまま", () => {
  const other = join(top, "other-kangae"); writeFileSync(other, "#!/bin/sh\n"); chmodSync(other, 0o755);
  mkdirSync(join(home, ".kangae", "bin"), { recursive: true }); // rules-ok: この試験が作る temp の home（owner の home ではない）
  symlinkSync(other, join(home, ".kangae", "bin", "kangae")); // rules-ok: この試験が作る temp の home（owner の home ではない）
  expect(agentBin(bundled, true, "/$bunfs/x", home)).toBe(bundled); // 別の実体を指す link は使わない（生きている symlink は直さない）
  const home2 = join(top, "home2"); mkdirSync(home2);
  const odd = join(top, "my tools"); mkdirSync(odd); const exe = join(odd, "kangae"); writeFileSync(exe, "#!/bin/sh\n"); chmodSync(exe, 0o755);
  expect(agentBin(exe, true, "/$bunfs/x", home2)).toBe(exe); // 同梱の形でない＝link を作らない
  expect(existsSync(join(home2, ".kangae"))).toBe(false); // rules-ok: この試験が作る temp の home（owner の home ではない）
});

test("W24-3 空白が無ければ今までと同じ・開発（bun main.ts）は 2 語のまま", () => {
  expect(agentBin("/usr/local/bin/kangae", true, "/$bunfs/x", home)).toBe("/usr/local/bin/kangae");
  expect(agentBin("/x/bun", false, "/x/src/main.ts", home)).toBe("/x/bun /x/src/main.ts");
  expect(existsSync(join(home, ".kangae"))).toBe(false); // rules-ok: この試験が作る temp の home（owner の home ではない）
});

test("W24-4 常駐の workspace.bin は agentBin から（空白入りの bar 同梱でも agent に渡る path が 1 つに揃う）", () => {
  const src = readFileSync("src/main.ts", "utf8");
  expect(src.includes("get bin() { return agentBin(process.execPath, compiled, Bun.main); }")).toBe(true);
});

test("W24-5 空白入りの bin から agentBin で替えた path が、claude の許す行・頼み・AGENTS.md の全部で同じになり、空白入りの path はどこにも残らない", async () => {
  const bin = agentBin(bundled, true, "/$bunfs/x", home);
  const calls: string[][] = [];
  const spawn = (cmd: string[]) => { calls.push(cmd); let done!: (c: number) => void; return { stdout: new ReadableStream<Uint8Array>({ start: () => {} }), exited: new Promise<number>((r) => (done = r)), kill: () => done(143) }; };
  const base = mktmp("ws"), ui = join(top, "ui"); mkdirSync(ui);
  const s = openStore(":memory:");
  const H: any = makeHandler(s, async () => [], undefined,
    { dir: base, bin, open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => "http://127.0.0.1:9" },
    { uiHome: ui });
  const n = s.add(null, "user", "agentA は Zed で build", true);
  const r: any = await H({ op: "workspace", nodeId: n.id, agent: true, text: "go" });
  expect(r.ok).toBe(true);
  const argv = calls[0]!, tools = argv[argv.indexOf("--allowedTools") + 1]!;
  expect(tools).toContain(`Bash(${bin} note:*)`);
  expect(tools).toContain(`Bash(${bin} act:*)`);
  const files: string[] = []; const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === "AGENTS.md") files.push(readFileSync(p, "utf8")); } }; walk(base);
  expect(files[0]!).toContain(`${bin} note`);
  for (const text of [argv.join("\n"), files[0]!]) { expect(text.includes("Kangae Bar.app")).toBe(false); expect(text.includes(bin)).toBe(true); }
  await H({ op: "stopRun", runId: r.run.id });
});
