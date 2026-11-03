import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GEMINI_NO_WEB, geminiReadDirs, makeHandler, writeSandbox } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import type { Cli } from "../src/engine-choice.ts";

// 偽の鍵は人の home の下の temp 置き場に自作する（人の鍵は読まない）。sandbox-exec を実際に回す
const cat = (profile: string, f: string) => Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, "/bin/cat", f], { stderr: "pipe" });

test("W11e-3 gemini の読み: 人の home の鍵は OS が拒み、作業場所（home の下でも）・戻した実体の置き場は読める", () => {
  const top = mktmp("w11e3", homedir());
  try {
    const key = join(top, "fakekey"), work = join(top, "work"), tool = join(top, "nvm", "lib"), other = join(top, "nvm", "secret");
    mkdirSync(work); mkdirSync(tool, { recursive: true });
    for (const f of [key, join(work, "a.txt"), join(tool, "node"), other]) writeFileSync(f, "FAKE-SECRET");
    const sb = writeSandbox(work, [tool]);
    expect(cat(sb, join(work, "a.txt")).exitCode).toBe(0); // 作業場所は home の下でも読める
    expect(cat(sb, join(tool, "node")).exitCode).toBe(0); // node / gemini の実体が home の下にある人でも起動できる
    for (const f of [key, other]) {
      const o = cat(sb, f);
      expect(o.exitCode).not.toBe(0);
      expect(o.stderr.toString()).toContain("Operation not permitted");
      expect(o.stdout.toString()).not.toContain("FAKE");
    }
    expect(cat(writeSandbox(work), join(tool, "node")).exitCode).not.toBe(0); // 戻さなければ読めない = 戻す引数が効いている
  } finally { rmSync(top, { recursive: true, force: true }); }
});

test("W11e-3 gemini の実体か node が分からなければ null（読みを閉じたまま起こせない）・分かれば両方の置き場", () => {
  const d = mktmp("w11e3b");
  const g = join(d, "gemini"); closeSync(openSync(g, "w"));
  expect(geminiReadDirs(join(d, "none"), g)).toBeNull();
  expect(geminiReadDirs(g, null)).toBeNull();
  expect(geminiReadDirs(g, g)).toHaveLength(2);
});

function setup(clis: { cli: Cli; path: string }[], billing: any) {
  const calls: { cmd: string[] }[] = [];
  const isClaude = (cmd: string[]) => cmd.some((x) => x.endsWith("/claude"));
  const spawn = (cmd: string[]) => {
    calls.push({ cmd });
    const line = isClaude(cmd) ? JSON.stringify({ type: "result", is_error: true, result: "You've hit your limit · resets 3pm" }) : JSON.stringify({ type: "result", result: "ok" });
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(new TextEncoder().encode(line + "\n")); c.close(); } });
    return { stdout, exited: Promise.resolve(isClaude(cmd) ? 1 : 0), kill() {} };
  };
  const s = openStore(":memory:");
  const h = makeHandler(s, async () => [], undefined,
    { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => clis.map((c) => ({ ...c, env: {} })), spawn, browserUrl: async () => null, billing: async (f: any) => billing[f.cli] },
    { uiHome: mktmp("kangae-ui") });
  return { h, s, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 80));
const bin = (names: string[]) => { const d = mktmp("w11e3bin"); return names.map((n) => { const p = join(d, n); closeSync(openSync(p, "w")); return { cli: n as Cli, path: p }; }); };

test("W11e-3 codex は network を明示で閉じる・gemini は web を policy で外し読みの囲いに入る", async () => {
  const [cl, co, ge] = bin(["claude", "codex", "gemini"]) as any[];
  for (const [other, probe] of [[co, (c: string[]) => c.join(" ").includes("sandbox_workspace_write.network_access=false")], [ge, (c: string[]) => c.includes("--admin-policy") && c[0] === "/usr/bin/sandbox-exec" && c[2]!.includes("(deny file-read-data")]] as const) {
    const { h, s, calls } = setup([cl, other], { [other.cli]: { kind: "contract" } });
    const root = s.add(null, "user", "x", true);
    await h({ op: "send", rootId: root.id, text: "やって" });
    await settle();
    expect(calls.at(-1)!.cmd.some((x) => x === other.path), other.cli).toBe(true);
    expect(probe(calls.at(-1)!.cmd), other.cli).toBe(true);
  }
  expect(GEMINI_NO_WEB).toContain('"web_fetch"');
  expect(GEMINI_NO_WEB).toContain('decision = "deny"');
});

test("W11e-3 gemini の実体が分からない時は替え先にしない（claude のまま止めて理由を 1 行）", async () => {
  const [cl] = bin(["claude"]) as any[];
  const { h, s, calls } = setup([cl, { cli: "gemini" as Cli, path: "/nonexistent/gemini" }], { gemini: { kind: "contract" } });
  const root = s.add(null, "user", "x", true);
  await h({ op: "send", rootId: root.id, text: "やって" });
  await settle();
  expect(calls.every((c) => !c.cmd.some((x) => x.endsWith("/gemini")))).toBe(true);
  const run = ((await h({ op: "runs", nodeIds: [root.id] })) as any).runs.at(-1);
  expect(JSON.stringify(run.log)).toContain("gemini には替えません");
});
