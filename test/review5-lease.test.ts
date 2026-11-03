import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";

// review5 の攻撃: W11c-3 の「送る直前の窓の再確認」が throw した時、取った資源を放すか
let dir: string;
beforeEach(() => { dir = mktmp("r5"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const A = { pid: 10, windowId: 1, app: "ScratchPad", title: "" };

test("直前の list_windows が throw しても資源（menu。clipboard は W46-A で門が断る）を握りっぱなしにしない", async () => {
  let n = 0;
  const d = (): Driver => ({
    call: async (tool) => {
      if (tool === "list_windows") { if (++n === 2) throw new Error("driver died"); return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } }; }
      return { text: "ok", isError: false, data: null };
    },
    close() {},
  });
  const L = makeLeases(dir, { driver: d, defaultMode: "allow", resourceMs: 50 });
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  await L.act(tokenOf(g.lease), "hotkey", { keys: ["cmd", "s"] }).catch(() => {}); // 2 回目の list_windows で落ちる
  const r = await L.act(tokenOf(g.lease), "hotkey", { keys: ["cmd", "s"] });
  expect(r).toMatchObject({ ok: true }); // busy なら資源が漏れている
});

// 門（lease.ts）と本物の拡張（web.js・偽 chrome の上）をつないで、取り戻した後に渡し直した新しい操作権の act を floors が断らないか
import { installChrome, load } from "./fake-chrome";
test("web: 取り戻し → 渡し直しの新しい gen は拡張の floors に断られない・取り戻し前の gen は断られる", async () => {
  const c = installChrome();
  const { webRun } = await load("web");
  await c.settle();
  const seen: { tool: string; gen?: number; minGen?: number }[] = [];
  const web: Driver = { call: async (tool, args) => { seen.push({ tool, gen: args.gen as number, minGen: args.minGen as number }); const r: any = await webRun(tool, args as any); return { text: r.text ?? "", isError: !!r.error, data: r.data ?? (tool === "tab_state" ? { exists: true, docId: "d" } : null) }; }, close() {} };
  const L = makeLeases(dir, { web, defaultMode: "allow" });
  const S = { tabId: 1, docId: "d", app: "web", title: "t" };
  const g1 = L.give(S, "s:1", false);
  if (!g1.ok) throw new Error();
  g1.lease.hold = false;
  expect(await L.act(tokenOf(g1.lease), "type_text", { text: "a" })).toMatchObject({ ok: true });
  const old = tokenOf(g1.lease);
  L.takeback("tab:1");
  await new Promise((r) => setTimeout(r, 30));
  const g2 = L.give(S, "s:1", false);
  if (!g2.ok) throw new Error();
  g2.lease.hold = false;
  expect(await L.act(tokenOf(g2.lease), "type_text", { text: "a" })).toMatchObject({ ok: true }); // 新しい gen は通る
  expect(await L.act(old, "type_text", { text: "a" })).toMatchObject({ ok: false, why: "gen" });
  // 門を素通りして拡張へ直に古い gen を送っても拡張が断る（実行の直前の守り）
  const before = c.pages();
  const r: any = await webRun("type_text", { tabId: 1, docId: "d", text: "a", gen: g1.lease.gen });
  expect(r.error).toBe(true);
  expect(c.pages()).toBe(before);
});

// holes-12 の攻撃: owner の場所への symlink・大文字小文字違いの綴りでも「owner を指す」と判る（偽の home の上で。本物の home は触らない）
import { mkdirSync, mkdtempSync as mk2, symlinkSync } from "node:fs";
test("pointsAtOwner: symlink と綴りの違いを通さない", async () => {
  const { pointsAtOwner } = await import("../src/paths.ts");
  const H = mk2(join(tmpdir(), "r5home-"));
  const O = join(H, "Library/Application Support" + "/Kangae");
  mkdirSync(O, { recursive: true });
  const link = join(H, "innocent");
  symlinkSync(O, link);
  expect(pointsAtOwner(O, H)).toBe(true);
  expect(pointsAtOwner(link, H)).toBe(true); // symlink 経由
  expect(pointsAtOwner(join(link, "profile"), H)).toBe(true);
  expect(pointsAtOwner(join(H, "library/application support" + "/kangae"), H)).toBe(true); // APFS は大文字小文字を区別しない
  expect(pointsAtOwner(join(H, "elsewhere"), H)).toBe(false);
  rmSync(H, { recursive: true, force: true });
});

// W11b-3 × W11d: 人が見ているので離れるのを待っている act は、同じ文書の資源を握らない（別 tab の act を止めない）。待ちが終われば資源を取る
test("W11d の待ち中の act は文書の順番を握らない・別 tab は通る", async () => {
  const sent: number[] = [];
  const web: Driver = { call: async (tool, args) => { if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: `d${args.tabId}` } }; if (tool === "type_text") sent.push(args.tabId as number); return { text: "ok", isError: false, data: null }; }, close() {} };
  const L = makeLeases(dir, { web, defaultMode: "allow", resourceMs: 100 });
  const url = "https://docs.example.com/document/1a2b3c4d5e6f";
  const gA = L.give({ tabId: 1, docId: "d1", app: "web", title: "a", url }, "s:1", true); // 人が見ている＝hold
  const gB = L.give({ tabId: 2, docId: "d2", app: "web", title: "b", url }, "s:2", false);
  if (!gA.ok || !gB.ok) throw new Error();
  expect(gA.lease.hold).toBe(true);
  const pA = L.act(tokenOf(gA.lease), "type_text", { text: "a" }); // 離れるまで待つ
  await new Promise((r) => setTimeout(r, 30));
  expect(await L.act(tokenOf(gB.lease), "type_text", { text: "b" })).toMatchObject({ ok: true });
  expect(sent).toEqual([2]);
  L.takeback("tab:1");
  expect(await pA).toMatchObject({ ok: false, why: "gen" });
  expect(sent).toEqual([2]);
});
