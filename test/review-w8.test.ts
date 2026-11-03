// W8 前半 review の攻撃 test（各 test は、対応する直しを外すと赤くなる）
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cdp, type Cookie, makeCarry } from "../src/carry.ts";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { parseSpec } from "../src/routines.ts";
import { pollUntil } from "../src/wait.ts";

// ---- carry: 承諾の後で取り戻されたら、context を作らない ----
const jar: Cookie[] = [{ name: "sid", value: "s3cr3t-VALUE-0001", domain: "app.example.com", path: "/", secure: true, httpOnly: true }];
test("carry: 承諾 → cookie 取得の間に end（取り戻し）→ context は残らない", async () => {
  const live = new Set<string>();
  let n = 0;
  const cdp: Cdp = { send: async (m: string, p: any = {}) => { if (m === "Target.createBrowserContext") { live.add(`c${++n}`); return { browserContextId: `c${n}` }; } if (m === "Target.disposeBrowserContext") live.delete(p.browserContextId); return {}; }, close() {} };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const web = { call: async (tool: string) => { if (tool === "cookie_get") await gate; return { text: "", isError: false, data: { cookies: tool === "cookie_get" ? jar : jar.map(({ name, domain, path }) => ({ name, domain, path })) } }; }, close() {} };
  const c = makeCarry({ web: () => web, browserUrl: async () => "http://x", connect: async () => cdp, approvalMs: 2000 });
  const p = c.ask("s:1", "app.example.com");
  await pollUntil(() => c.cards().length, 40_000, 5);
  c.answer(c.cards()[0]!.id, true);
  await Bun.sleep(10);
  await c.end("s:1"); // 取り戻し（cookie 取得の await 中）
  release();
  expect((await p).ok).toBe(false);
  expect(live.size).toBe(0);
  expect(c.has("s:1")).toBe(false);
});

test("carry: 同じ頼みの ask 2 本目は card を重ねない", async () => {
  const web = { call: async () => ({ text: "", isError: false, data: { cookies: jar.map(({ name, domain, path }) => ({ name, domain, path })) } }), close() {} };
  const c = makeCarry({ web: () => web, browserUrl: async () => "http://x", connect: async () => ({ send: async () => ({}), close() {} }), approvalMs: 100 });
  const [a, b] = await Promise.all([c.ask("s:1", "app.example.com"), c.ask("s:1", "app.example.com")]);
  expect([a.ok, b.ok]).toEqual([false, false]);
  expect([a, b].some((x) => !x.ok && x.hint.includes("まだ答えていません"))).toBe(true);
});

// ---- routine: 1 分刻みで quota を燃やす予約は作れない ----
test("routine: --every 1 は断る（agent が自分で予約できるので下限 5 分）", () => {
  expect(parseSpec({ every: "1" }).ok).toBe(false);
  expect(parseSpec({ every: "4" }).ok).toBe(false);
  expect(parseSpec({ every: "5" }).ok).toBe(true);
});

// ---- undo ----
let dir: string;
let ran: { tool: string; args: Record<string, unknown> }[];
let failAfter = Infinity;
let longValue = "";
const fake = (): Driver => ({
  call: async (tool, args) => {
    ran.push({ tool, args });
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } };
    if (tool === "get_window_state") return { text: "", isError: false, data: { snapshot_id: "s1", elements: [{ element_token: "t2", role: "AXTextArea", label: "本文", value: longValue || "元" }] } };
    if (tool === "press_key" && ran.filter((c) => c.tool === "press_key").length > failAfter) return { text: "ng", isError: true, data: null };
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
beforeEach(() => { dir = mktmp("rw8"); ran = []; failAfter = Infinity; longValue = ""; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
async function setup() {
  const L = makeLeases(dir, { driver: fake, defaultMode: "allow" });
  const g = L.give({ pid: 10, windowId: 1, app: "Mail", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  const tk = tokenOf(g.lease);
  await L.act(tk, "get_window_state", {});
  return { L, tk };
}
const keys = () => ran.filter((c) => c.tool === "press_key").length;

test("undo: 絵文字の連なりは 1 文字ぶんの backspace（code point で数えて前の文章を消さない）", async () => {
  const { L, tk } = await setup();
  await L.act(tk, "type_text", { element_token: "t2", text: "👨‍👩‍👧❤️" }); // 8 code points・2 grapheme
  await L.undo("s:1");
  expect(keys()).toBe(2);
});

test("undo: 途中で失敗したら消せた分を引く（もう一度押しても書いてない所を消さない）", async () => {
  const { L, tk } = await setup();
  await L.act(tk, "type_text", { element_token: "t2", text: "abcdef" });
  failAfter = 2; // 3 つ目の backspace から失敗（2 つ消せた）
  expect((await L.undo("s:1")).ok).toBe(false);
  failAfter = Infinity;
  const before = keys();
  expect((await L.undo("s:1")).ok).toBe(true);
  expect(keys() - before).toBe(4); // 6 - 2
});

test("undo: set_value の前の値が 120 字に切れている・読んだ後に変わっている時は戻さない（切れた値で上書きしない）", async () => {
  longValue = "あ".repeat(130);
  const a = await setup();
  await a.L.act(a.tk, "set_value", { element_token: "t2", value: "new" });
  expect(await a.L.undo("s:1")).toMatchObject({ ok: false });
  expect(ran.filter((c) => c.tool === "set_value").length).toBe(1);
  longValue = "";
  const b = await setup();
  await b.L.act(b.tk, "type_text", { element_token: "t2", text: "xyz" });
  await b.L.act(b.tk, "set_value", { element_token: "t2", value: "B" }); // 読んだ後に変わった要素
  expect(await b.L.undo("s:1")).toMatchObject({ ok: false });
});

// ---- resume: メモの後で会話が進んでいたら、古いメモを付けない ----
import { mkdtempSync as mk2 } from "node:fs";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
test("resume: 引き継ぎメモの後に会話が進んだら、古いメモを次の頼みに付けない", async () => {
  const s = openStore(":memory:");
  const root = s.add(null, "user", "注文", true);
  const calls: { cmd: string[] }[] = [];
  const spawn = (cmd: string[]) => { calls.push({ cmd }); let done!: (c: number) => void; return { stdout: new ReadableStream<Uint8Array>({ start() {} }), exited: new Promise<number>((r) => (done = r)), kill: () => done(143) }; };
  const h = makeHandler(s, async () => [], undefined, { dir: mk2(join(tmpdir(), "ws-")), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => null });
  await h({ op: "workspace", nodeId: root.id, agent: true, text: "注文して" });
  await Bun.sleep(30);
  await h({ op: "handover", rootId: root.id });
  s.add(root.id, "user", "別の頼みをしました", true); // メモの後に会話が進んだ
  await h({ op: "resume", rootId: root.id });
  expect(calls.at(-1)!.cmd[2]!).not.toContain("引き継ぎメモ（常駐が作った記録");
});
