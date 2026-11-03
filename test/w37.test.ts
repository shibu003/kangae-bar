// W37: agent は編集器（Zed など）を裏で開く道を使わない。上流 Zed は path を開くと自分の窓を前に出し、止める設定がない（W34）。
// open_app が編集器に来たら、card も出さず開かずに「file を直接編集して run で build」と返す。編集器以外は今までどおり card（人が許す）。
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCmd, cwdTooWide, editorExe } from "../src/cmds.ts";
import { isEditor, makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

let dir: string, n = 0;
let calls: string[];
const fake = (): Driver => ({ call: async (tool) => { calls.push(tool); if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } }; return { text: "ok", isError: false, data: null }; }, close() {} });
const mk = () => { const home = join(dir, `h${n++}`); mkdirSync(home); return makeLeases(home, { driver: fake, defaultMode: "ask", approvalMs: 60_000, windowMs: 50 }); };
const give = (L: ReturnType<typeof makeLeases>) => { const g = L.give({ pid: 10, windowId: 1, app: "Orca", title: "" }, "s:1"); if (!g.ok) throw new Error(); return tokenOf(g.lease); };
beforeEach(() => { dir = mktmp("w37"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const EDITORS: Record<string, unknown>[] = [...["Zed", "Zed Preview", "Visual Studio Code", "Cursor", "Xcode", "TextEdit", "Sublime Text", "IntelliJ IDEA", "Nova"].map((app) => ({ app })), ...["dev.zed.Zed", "dev.zed.Zed-Preview", "com.microsoft.VSCode", "com.apple.dt.Xcode", "com.apple.TextEdit"].map((bundle_id) => ({ bundle_id }))];

test("W37 編集器への open_app は、card も出さず開かず、「file を直接編集して run で build」と返す（名前・bundle_id・path つきでも）", async () => {
  const bad: string[] = []; // どの入力が通ってしまったかを名前で見せる
  for (const args of EDITORS) {
    for (const withPath of [false, true]) {
      const L = mk(), tok = give(L);
      const r = (await L.act(tok, "open_app", withPath ? { ...args, path: dir } : args)) as { ok: boolean; why?: string; hint?: string };
      if (r.ok || r.why !== "tool" || !String(r.hint).includes("直接編集") || !String(r.hint).includes("kangae run") || L.approvals().length) bad.push(`${JSON.stringify(args)} path=${withPath}: ${JSON.stringify(r).slice(0, 120)} cards=${L.approvals().length}`);
    }
  }
  expect(bad).toEqual([]);
  expect(calls.filter((c) => c === "launch_app")).toHaveLength(0); // 1 回も起こしていない
});

test("W37 対照: 編集器以外の open_app は今までどおり card が出る（人が許す）", async () => {
  const L = mk(), tok = give(L);
  const p = L.act(tok, "open_app", { app: "Preview", path: dir });
  for (const end = Date.now() + 10_000; Date.now() < end && !L.approvals().length;) await Bun.sleep(5);
  expect(L.approvals()[0]).toMatchObject({ tool: "open_app" });
  L.answer(L.approvals()[0]!.id, false);
  expect(await p).toMatchObject({ ok: false, why: "denied" });
});

test("W37 isEditor: 編集器でない app を巻き込まない", () => {
  for (const [a, b] of [["Preview", ""], ["Calculator", ""], ["Safari", ""], ["ER_Triage_GUI", ""], ["Codex", ""], ["", "com.apple.calculator"], ["", "com.todesktop.other"]] as const) expect(isEditor(a, b)).toBe(false);
  expect(isEditor("zed", "")).toBe(true); // 大文字小文字は問わない
});

// ---- 案 a（user 承認済み）: 登録した command の場所の中は agent が直接編集してよい ----
const turnTools = async (reg: (ui: string, top: string) => void) => {
  const top = realpathSync(mktmp("w37t")), ui = join(top, "ui"), base = realpathSync(mktmp("ws"));
  mkdirSync(ui);
  reg(ui, top);
  const argvs: string[][] = [];
  const spawn = (cmd: string[]) => { argvs.push(cmd); let done!: (c: number) => void; return { stdout: new ReadableStream<Uint8Array>({ start: () => {} }), exited: new Promise<number>((r) => (done = r)), kill: () => done(143) }; };
  const s = openStore(":memory:");
  const H: any = makeHandler(s, async () => [], undefined, { dir: base, bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => "http://127.0.0.1:9" }, { uiHome: ui, leaseDriver: () => null });
  const a = s.add(null, "user", "agentA", true);
  const r: any = await H({ op: "workspace", nodeId: a.id, agent: true, text: "go" });
  const t = argvs[0]![argvs[0]!.indexOf("--allowedTools") + 1]!;
  await H({ op: "stopRun", runId: r.run.id });
  rmSync(top, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true });
  return { t, top };
};

test("W37 案 a: 登録した command の場所だけが Edit / Write / Read に足される（app の場所・登録の無い場所は足さない）・場所を読める turn は WebSearch / WebFetch を外す", async () => {
  const { t, top } = await turnTools((ui, top) => {
    for (const d of ["proj", "guidir", "other"]) mkdirSync(join(top, d));
    expect(addCmd(ui, "build", join(top, "proj"), ["/bin/echo", "x"]).ok).toBe(true);
    const gui = join(top, "guidir", "g"); writeFileSync(gui, "#!/bin/sh\n"); chmodSync(gui, 0o755);
    expect(addCmd(ui, "gui", join(top, "guidir"), [gui], 600, 1, { app: true }).ok).toBe(true);
  });
  const p = join(top, "proj").slice(1);
  expect(t).toContain(`Edit(//${p}/**)`); expect(t).toContain(`Write(//${p}/**)`); expect(t).toContain(`Read(//${p}/**)`);
  expect(t).not.toContain(join(top, "guidir").slice(1)); // app の場所は足さない
  expect(t).not.toContain(join(top, "other").slice(1)); // 登録の無い場所は足さない
  expect(t).not.toContain("WebSearch"); expect(t).not.toContain("WebFetch");
});

test("W37 案 a 対照: 登録が無い turn は今までどおり（場所の Edit なし・WebSearch / WebFetch あり）", async () => {
  const { t } = await turnTools(() => {});
  expect(t.match(/Edit\(/g)?.length).toBe(1); // 作業場所だけ
  expect(t).toContain("WebSearch");
});

test("W37 案 a: 場所が広すぎる（home 全体・/Users・鍵の場所）登録は断られ、Edit の対象にならない", () => {
  expect(cwdTooWide(homedir())).toBe(true);
  expect(cwdTooWide("/Users")).toBe(true);
  expect(cwdTooWide(join(homedir(), ".ssh"))).toBe(true);
  expect(cwdTooWide(join(homedir(), ".kangae", "x"))).toBe(true); // rules-ok: path の判定だけで owner の file は読まない
  for (const bad of ["/Applications", "/opt/homebrew", "/usr/local", "/Volumes", "/Volumes/Disk", join(homedir(), ".claude"), join(homedir(), ".config", "x"), join(homedir(), "Library", "LaunchAgents"), join(homedir(), "Applications"), join(homedir(), "Library")]) expect([bad, cwdTooWide(bad)]).toEqual([bad, true]); // rules-ok: path の判定だけで owner の file は読まない
  for (const ok of [join(homedir(), "Downloads", "x"), join(homedir(), "src", "x"), "/Volumes/Disk/x", join(tmpdir(), "my-project")]) expect([ok, cwdTooWide(ok)]).toEqual([ok, false]);
  const ui = mktmp("w37u");
  const r = addCmd(ui, "build", homedir(), ["/bin/echo", "x"]);
  expect(r.ok).toBe(false); expect((r as any).hint).toContain("広すぎる");
  rmSync(ui, { recursive: true, force: true });
});

test("W37 (A)(C): 編集器は app として登録できない（名前・VS Code 系の構造）。普通の app は登録できる", () => {
  const top = realpathSync(mktmp("w37a")), ui = join(top, "ui"), proj = join(top, "proj");
  mkdirSync(ui); mkdirSync(proj);
  const exe = (p: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "#!/bin/sh\n"); chmodSync(p, 0o755); return p; };
  const zed = exe(join(top, "bin", "zed"));
  expect(addCmd(ui, "ed", proj, [zed], 600, 1, { app: true })).toMatchObject({ ok: false, hint: expect.stringContaining("編集器は app として登録できません") });
  const fork = exe(join(top, "Fake.app", "Contents", "MacOS", "fakeide")); // 名前の表に無い VS Code の fork
  expect(addCmd(ui, "fk", proj, [fork], 600, 1, { app: true }).ok).toBe(true); // 構造の印が無ければ登録できる
  mkdirSync(join(top, "Fake.app", "Contents", "Resources", "app"), { recursive: true }); writeFileSync(join(top, "Fake.app", "Contents", "Resources", "app", "product.json"), "{}");
  expect(editorExe(fork)).toBe(true);
  expect(addCmd(ui, "fk2", proj, [fork], 600, 1, { app: true })).toMatchObject({ ok: false });
  expect(addCmd(ui, "gui", proj, [exe(join(top, "bin", "er_gui"))], 600, 1, { app: true }).ok).toBe(true);
  const home = join(top, "home"); mkdirSync(join(home, "Applications", "NewFork.app", "Contents", "Resources", "app"), { recursive: true });
  expect(isEditor("NewFork", "", home)).toBe(false);
  writeFileSync(join(home, "Applications", "NewFork.app", "Contents", "Resources", "app", "product.json"), "{}");
  expect(isEditor("NewFork", "", home)).toBe(true); // open_app の名前でも構造で見る
  expect(isEditor("Antigravity", "")).toBe(true);
  rmSync(top, { recursive: true, force: true });
});
