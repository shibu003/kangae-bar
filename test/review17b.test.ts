// review17: W16b の open_tab を攻める。承認を通らない道・url の形・card の警告・取り戻し
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, openUrlOf, tokenOf, type Driver } from "../src/lease.ts";

let dir: string, calls: { tool: string; args: Record<string, unknown> }[];
const NEW = { tabId: 9, docId: "nd", title: "t", url: "https://a.example/x" };
const web = (): Driver => ({
  call: async (tool, args) => { calls.push({ tool, args }); return { text: "", isError: false, data: tool === "open_tab" ? NEW : tool === "tab_state" ? { exists: true, docId: "d" } : null }; },
  close() {},
});
const FACE = { tabId: 1, docId: "d", app: "web", title: "C", url: "https://canvas.example/" };
const opens = () => calls.filter((c) => c.tool === "open_tab");
const mk = (mode: "ask" | "allow" = "ask", ans?: { yes: boolean; turn?: boolean }) => {
  const L: ReturnType<typeof makeLeases> = makeLeases(dir, { web: web(), defaultMode: mode, approvalMs: 40, onChange: () => ans && queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, ans.yes, ans.turn))) });
  const g = L.give(FACE, "s:1"); if (!g.ok) throw 0;
  return { L, tok: tokenOf(g.lease) };
};
beforeEach(() => { dir = mktmp("r17b"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("表が「許す」でも・「この頼みの間」を選ばれても、open_tab は 2 回目も毎回聞く", async () => {
  const { L, tok } = mk("allow", { yes: true, turn: true });
  let asked = 0;
  const Lc = L as typeof L;
  const orig = Lc.answer; // 1 回目は「この頼みの間」で許した。2 回目も card が出る（= 許しが残っていない）
  Lc.answer = (id, y, t) => { asked++; return orig(id, y, t); };
  expect((await L.act(tok, "open_tab", { url: "https://a.example/x" })).ok).toBe(true);
  const k = L.list().find((x) => "tabId" in x.surface && x.surface.tabId === 9)!.key;
  L.takeback(k); // 面を空けて 2 回目
  expect((await L.act(tok, "open_tab", { url: "https://a.example/y" })).ok).toBe(true);
  expect(asked).toBe(2);
  expect(opens()).toHaveLength(2);
});
test("答えが来ない間に取り戻されたら、tab を作らない", async () => {
  const L = makeLeases(dir, { web: web(), defaultMode: "ask", approvalMs: 500 });
  const g = L.give(FACE, "s:1"); if (!g.ok) throw 0;
  const p = L.act(tokenOf(g.lease), "open_tab", { url: "https://a.example/x" });
  await Bun.sleep(10);
  L.stopAll();
  expect((await p).ok).toBe(false);
  expect(opens()).toHaveLength(0);
});
test("url の形: 読んだ値を query / # / ログイン情報 / 別 scheme / 長さで出せない", () => {
  for (const u of ["https://a.example/?q=1", "https://a.example?", "https://a.example/#x", "https://a.example/#", "https://u:p@a.example/", "https://u@a.example/", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "chrome://extensions", "ftp://a.example/", "//a.example/", "/relative", "https://a.example/" + "a".repeat(300)])
    expect(openUrlOf(u).ok).toBe(false);
  expect(openUrlOf("https://a.example/%3Fq%3D1").ok).toBe(true); // path の中の %3F は query ではない（残る形は card で人が見る）
});
for (const [name, url, re] of [
  ["ログアウト等の path", "https://shop.example/logout", /ログアウト|設定|共有|取り返し|副作用/],
  ["この PC の宛先 localhost", "http://localhost:6768/admin", /この PC|社内|宛先/],
  ["IP アドレス直指定", "http://192.168.0.1/reset", /この PC|社内|宛先|IP/],
] as const)
  test(`card の note に警告が出る: ${name}`, async () => {
    const L = makeLeases(dir, { web: web(), defaultMode: "ask", approvalMs: 40 });
    const g = L.give(FACE, "s:1"); if (!g.ok) throw 0;
    const p = L.act(tokenOf(g.lease), "open_tab", { url });
    await Bun.sleep(5);
    const note = L.approvals()[0]?.note ?? "";
    await p;
    const u = new URL(url);
    expect(note).toContain(`${u.origin}【頁: ${u.pathname}】`); // W46: card は origin と path を分けて出す（全 URL が読める形・警告は同じ）
    expect(note).toMatch(re);
  });
test("警告が要らない普通の頁には警告を足さない", async () => {
  const L = makeLeases(dir, { web: web(), defaultMode: "ask", approvalMs: 40 });
  const g = L.give(FACE, "s:1"); if (!g.ok) throw 0;
  const p = L.act(tokenOf(g.lease), "open_tab", { url: "https://docs.google.com/document/create" });
  await Bun.sleep(5);
  const note = L.approvals()[0]?.note ?? "";
  await p;
  expect(note).not.toMatch(/この PC|ログアウト/);
});
