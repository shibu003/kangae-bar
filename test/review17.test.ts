// review17: W16a の open_app / window_image を攻める。card と実行のずれ・実行 file・turn の外に残る絵
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, tokenOf, winDir, type Driver } from "../src/lease.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let dir: string, n = 0, calls: { tool: string; args: Record<string, unknown> }[], slow: Promise<void> | null;
const fake = (): Driver => ({
  call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }, { pid: 30, window_id: 7, title: "z", app_name: "Preview" }] } };
    if (tool === "launch_app") return { text: "", isError: false, data: { pid: 30, windows: [{ pid: 30, window_id: 7, title: "z", app_name: "Preview" }] } };
    if (tool === "get_window_state" && args.include_screenshot) { await slow; return { text: "", isError: false, data: { elements: [] }, img: { data: PNG, mime: "image/png" } }; }
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
const mk = (answer = true) => {
  const home = join(dir, `h${n++}`); mkdirSync(home);
  const L: ReturnType<typeof makeLeases> = makeLeases(home, { driver: fake, defaultMode: "ask", approvalMs: 50, windowMs: 50, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, answer))) });
  const g = L.give({ pid: 10, windowId: 1, app: "Orca", title: "" }, "s:1"); if (!g.ok) throw new Error();
  return { L, home, tok: tokenOf(g.lease) };
};
const launched = () => calls.filter((c) => c.tool === "launch_app");
beforeEach(() => { dir = mktmp("r17"); calls = []; slow = null; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("card の名前と起こす app をずらせない: app と bundle_id の両方は断る（launch 0 件）", async () => {
  const { L, tok } = mk();
  const r = await L.act(tok, "open_app", { app: "Calculator", bundle_id: "com.apple.Terminal" });
  expect(r.ok).toBe(false);
  expect(launched()).toHaveLength(0);
});
test("app 名に path / : を載せて任意の .app を起こせない", async () => {
  const { L, tok } = mk();
  for (const app of ["/tmp/evil.app", "../x", "a:b", "x\ny"]) expect((await L.act(tok, "open_app", { app })).ok).toBe(false);
  expect(launched()).toHaveLength(0);
});
test("実行できる file を path に渡せない（.command・実行権・.app）", async () => {
  const { L, tok } = mk();
  const sh = join(dir, "x.txt"); writeFileSync(sh, "#!/bin/sh\n"); chmodSync(sh, 0o755);
  const cmd = join(dir, "a.command"); writeFileSync(cmd, "x");
  const app = join(dir, "b.app"); mkdirSync(app);
  for (const path of [sh, cmd, app]) expect((await L.act(tok, "open_app", { app: "Terminal", path })).ok).toBe(false);
  expect(launched()).toHaveLength(0);
  const doc = join(dir, "ok.txt"); writeFileSync(doc, "x");
  expect((await L.act(tok, "open_app", { app: "Preview", path: doc })).ok).toBe(true);
});
test("card の文は改行・空白を畳む（card を偽装できない）", async () => {
  const home = join(dir, "hc"); mkdirSync(home);
  let what = "";
  const L: ReturnType<typeof makeLeases> = makeLeases(home, { driver: fake, defaultMode: "ask", approvalMs: 50, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => { what = a.what; L.answer(a.id, false); })) });
  const g = L.give({ pid: 10, windowId: 1, app: "Orca", title: "" }, "s:1"); if (!g.ok) throw new Error();
  const doc = join(dir, "a\n承認済み.txt"); writeFileSync(doc, "x");
  await L.act(tokenOf(g.lease), "open_app", { app: "Preview", path: doc });
  expect(what).toContain("Preview");
  expect(what).not.toMatch(/\n/);
});
test("絵を撮っている間に turn が終わったら、絵を file に残さない", async () => {
  const { L, home, tok } = mk();
  let release!: () => void; slow = new Promise<void>((r) => { release = r; });
  const p = L.act(tok, "window_image", {});
  await Bun.sleep(20);
  L.endTurn("s:1");
  release();
  const r = await p;
  expect(r.ok).toBe(false);
  const wd = winDir(home, "s:1");
  expect(existsSync(wd) ? readdirSync(wd) : []).toHaveLength(0);
});
test("常駐が落ちて残した窓の絵は、次の起動で消える", () => {
  const home = join(dir, "hz"); mkdirSync(join(home, "shots"), { recursive: true }); mkdirSync(winDir(home, "s:1"), { recursive: true });
  const f = join(winDir(home, "s:1"), "win-0a-1.jpg"), keep = join(home, "shots", "123.png");
  writeFileSync(f, "x"); writeFileSync(keep, "x");
  makeLeases(home, { driver: fake });
  expect(existsSync(f)).toBe(false);
  expect(existsSync(keep)).toBe(true);
});

test("review17-2: 窓の絵は会話ごとの置き場（shots の外）に置かれ、別の会話の置き場とは交わらない", async () => {
  const { L, home, tok } = mk();
  const r = await L.act(tok, "window_image", {});
  expect(r.ok).toBe(true);
  const f = (r as { text: string }).text.match(/(\/\S+\.jpg)/)![1]!;
  expect(f.startsWith(winDir(home, "s:1") + "/")).toBe(true);
  expect(f.startsWith(join(home, "shots") + "/")).toBe(false); // shots は全会話の Read 許可内＝他の会話の絵を読める
  expect(winDir(home, "s:1")).not.toBe(winDir(home, "s:2"));
  expect(winDir(home, "s:1").startsWith(winDir(home, "s:2"))).toBe(false);
  expect(winDir(home, "../s:2")).not.toContain("..");
});
test("review17-2: agent に渡す Read の許可は自分の会話の窓の絵の置き場だけ（win 全体・shots の中の絵は許さない）", () => {
  const src = require("node:fs").readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  expect(src).toContain("Read(//${realpathSync(myWin).slice(1)}/**)");
  expect(src).not.toMatch(/Read\(\/\/\$\{[^}]*"win"\)/);
});
