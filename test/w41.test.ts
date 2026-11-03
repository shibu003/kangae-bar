// W41: desktop op 段 2（AppleScript・Terminal の read 1 つと write 1 つ）。正本 docs/BRIEF-w41.md / docs/design-desktop-ops.md。読む file: "src/mods.ts" "src/lease.ts" "src/main.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases } from "../src/lease.ts";
import { APP_OPS, scriptGate, type AppOp } from "../src/mods.ts";

setDefaultTimeout(120_000); // 複数 file を 1 回で回すと preload の締切は最初の 1 file にしか効かず、card を待つ test が 5 秒で落ちる（W53 で本線でも同じ赤を確認）
let dir: string, scripts: string[], up: boolean;
const osa = async (s: string) => { scripts.push(s); if (/ is running$/.test(s)) return { ok: true, text: String(up) }; return { ok: true, text: "total 0\nfile.txt" }; };
const mk = (o: Parameters<typeof makeLeases>[1] = {}) => makeLeases(dir, { defaultMode: "ask", approvalMs: 5000, osa, ...o });
const ran = () => scripts.filter((s) => !/ is running$/.test(s));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const card = async (L: ReturnType<typeof makeLeases>) => { for (let i = 0; i < 300 && !L.approvals().length; i++) await tick(); return L.approvals()[0]!; };
beforeEach(() => { dir = mktmp("w41"); scripts = []; up = true; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("W41-1 read も毎回 card（review26: 前の窓は人が貸した面ではない）: 許すまで script は 0・許すと起動済みの Terminal の前の tab の内容が JSON で返り、script に activate 系の語が無い", async () => {
  const L = mk();
  const p = L.opRun("s:1", "Terminal", "read-front-tab", {});
  const c = await card(L);
  expect(c.tool).toBe("op_read");
  expect(ran()).toEqual([]); // 許す前は読んでいない
  L.answer(c.id, true);
  const r = await p;
  expect(r).toMatchObject({ ok: true });
  expect(JSON.parse((r as any).text)).toMatchObject({ app: "Terminal", op: "read-front-tab", result: "total 0\nfile.txt" });
  expect(ran()).toEqual(['tell application id "com.apple.Terminal" to get contents of selected tab of front window']);
});

test("W41-2 未起動の app は断る（Dock に出さない）: read も write も script を 1 本も打たず、card も出ない", async () => {
  up = false;
  const L = mk();
  expect(await L.opRun("s:1", "Terminal", "read-front-tab", {})).toMatchObject({ ok: false, why: "surface" });
  expect(await L.opRun("s:1", "Terminal", "run-in-front-tab", { cmd: "ls" })).toMatchObject({ ok: false, why: "surface" });
  expect(ran()).toEqual([]);
  expect(L.approvals()).toEqual([]);
});

test("W41-3 activate / launch / open を含む script は断る（gate 単体と、表に紛れ込んだ op の両方）", async () => {
  for (const w of ["activate", "launch", "reopen", "open", "run", "quit", "do shell script", "frontmost"]) expect(scriptGate(`tell application id "x" to ${w}`)).not.toBeNull();
  expect(scriptGate('tell application id "x" to get name\nactivate')).not.toBeNull();
  expect(scriptGate('tell application id "x" to do script "please open and run" in selected tab of front window')).toBeNull(); // literal の中の語は agent の文字
  const evil: AppOp = { app: "Terminal", bundle: "com.apple.Terminal", name: "evil", permission: "read", slots: [], what: "x", build: () => 'tell application id "com.apple.Terminal" to activate' }; // rules-ok: 前に出す語を含む script を断る検査用の入力（実行しない）
  const L = mk({ ops: [evil] });
  expect(await L.opRun("s:1", "Terminal", "evil", {})).toMatchObject({ ok: false, why: "tool" });
  expect(ran()).toEqual([]);
});

test("W41-4 write は毎回 card（script 全文つき）・許す前は実行 0・許すと 1 回だけ実行。断る・時間切れ前の全停止では実行 0", async () => {
  const L = mk();
  const p = L.opRun("s:1", "Terminal", "run-in-front-tab", { cmd: 'ls "a b"' });
  const a = await card(L);
  expect(a).toMatchObject({ tool: "op_write", owner: "s:1", danger: true });
  expect(a.note).toContain('do script "ls \\"a b\\"" in selected tab of front window');
  await tick(30);
  expect(ran()).toEqual([]);
  L.answer(a.id, true);
  expect(await p).toMatchObject({ ok: true });
  expect(ran()).toEqual(['tell application id "com.apple.Terminal" to do script "ls \\"a b\\"" in selected tab of front window']);
  for (const how of ["no", "stopAll"] as const) {
    scripts = [];
    const q = L.opRun("s:1", "Terminal", "run-in-front-tab", { cmd: "ls" });
    const b = await card(L);
    if (how === "no") L.answer(b.id, false); else L.stopAll();
    expect(await q).toMatchObject({ ok: false });
    expect(ran()).toEqual([]);
  }
  expect(L.facesOf("s:1")).toEqual([]); // 仮の聞く側は面にならない
});

test("W41-5 agent が渡せるのは名前と欄の値だけ: 知らない app / op / 欄・欄の欠け・改行・長すぎ・引用符の注入は実行 0（引用符は literal の中に閉じる）", async () => {
  const L = mk();
  for (const [a, o, kv] of [["Finder", "x", {}], ["Terminal", "nope", {}], ["Terminal", "read-front-tab", { pid: "1" }], ["Terminal", "run-in-front-tab", {}], ["Terminal", "run-in-front-tab", { cmd: "a\nb" }], ["Terminal", "run-in-front-tab", { cmd: "x".repeat(501) }]] as const) {
    expect(await L.opRun("s:1", a, o, kv)).toMatchObject({ ok: false, why: "tool" });
  }
  expect(ran()).toEqual([]);
  expect(L.approvals()).toEqual([]);
  const p = L.opRun("s:1", "terminal", "run-in-front-tab", { cmd: '" & (do shell script "id") & "' });
  const a = await card(L);
  L.answer(a.id, true);
  await p;
  expect(ran()).toEqual(['tell application id "com.apple.Terminal" to do script "\\" & (do shell script \\"id\\") & \\"" in selected tab of front window']); // 全部が 1 つの literal
  expect(scriptGate(ran()[0]!)).toBeNull();
});

test("W41-6 Terminal の op は read 1・write 1 だけ・daemon / CLI / 案内の口が在る", () => {
  expect(APP_OPS.filter((o) => o.app === "Terminal").map((o) => `${o.app}/${o.name}/${o.permission}`)).toEqual(["Terminal/read-front-tab/read", "Terminal/run-in-front-tab/write"]);
  const main = readFileSync("src/main.ts", "utf8");
  expect(main.includes('case "op": {')).toBe(true);
  expect(main.includes('process.argv[2] === "op"')).toBe(true);
  expect(main.includes("Bash(${ws.bin} op:*)")).toBe(true);
});
