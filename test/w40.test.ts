// W40: 面を 1 枚も持たない会話の最初の一手を open_tab にする（openTabFree・openAppFree と同じ型）。正本 docs/BRIEF-w40.md / docs/surface.md。読む file: "src/main.ts" "src/lease.ts" "extension/web.js" "extension/panel.js"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, type Driver } from "../src/lease.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

let dir: string, calls: { tool: string; args: Record<string, unknown> }[];
const NEW = { tabId: 9, docId: "nd", title: "課題", url: "https://canvas.example/courses/1" };
const web = (): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "", isError: false, data: tool === "open_tab" ? NEW : null }; }, close() {} });
const mk = (o: Parameters<typeof makeLeases>[1] = {}) => makeLeases(dir, { web: web(), defaultMode: "ask", approvalMs: 5000, ...o });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const card = async (L: ReturnType<typeof makeLeases>) => { for (let i = 0; i < 300 && !L.approvals().length; i++) await tick(); return L.approvals()[0]!; };
const opens = () => calls.filter((c) => c.tool === "open_tab");
beforeEach(() => { dir = mktmp("w40"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("W40-1 面なし open_tab → card（open_tab・danger・origin）→ 許すと面になる。許す前は tab を作らない・near は送らない（人のタブを基準にしない）", async () => {
  const L = mk();
  const p = L.openTabFree("s:1", { url: "https://canvas.example/courses/1" });
  const a = await card(L);
  expect(a).toMatchObject({ tool: "open_tab", owner: "s:1", danger: true, open: "https://canvas.example" });
  await tick(30);
  expect(opens()).toHaveLength(0);
  L.answer(a.id, true);
  expect(await p).toMatchObject({ ok: true });
  expect(opens()).toEqual([{ tool: "open_tab", args: { url: "https://canvas.example/courses/1" } }]);
  const faces = L.facesOf("s:1");
  expect(faces).toHaveLength(1);
  expect(faces[0]!.surface).toMatchObject({ tabId: 9, app: "web" });
  expect(L.list().some((l) => "pid" in l.surface && l.surface.pid === 0)).toBe(false); // 仮の聞く側は表に残らない
});

test("W40-2 断る・turn の終わり・全停止: tab は開かず面も増えない。面が MAX_FACES・URL 不正・拡張なしは聞く前に断る", async () => {
  for (const how of ["no", "endTurn", "stopAll"] as const) {
    calls = [];
    const L = mk();
    const p = L.openTabFree("s:1", { url: "https://canvas.example/" });
    const a = await card(L);
    if (how === "no") L.answer(a.id, false); else if (how === "endTurn") L.endTurn("s:1"); else L.stopAll();
    expect(await p).toMatchObject({ ok: false });
    expect(opens()).toHaveLength(0);
    expect(L.facesOf("s:1")).toEqual([]);
  }
  const L = mk();
  L.give({ pid: 1, windowId: 1, app: "A", title: "" }, "s:1"); L.give({ pid: 2, windowId: 2, app: "B", title: "" }, "s:1");
  expect(await L.openTabFree("s:1", { url: "https://canvas.example/" })).toMatchObject({ ok: false, why: "tool" });
  expect(await L.openTabFree("s:3", { url: "https://canvas.example/?q=1" })).toMatchObject({ ok: false, why: "tool" });
  expect(await mk({ web: undefined }).openTabFree("s:4", { url: "https://canvas.example/" })).toMatchObject({ ok: false, why: "driver" });
  expect(L.approvals()).toEqual([]);
  expect(opens()).toHaveLength(0);
});

test("W40-3 daemon op: 面なしの open_tab は card を出して通り、click など他の操作は面が無いので断る", async () => {
  const s = openStore(":memory:");
  const H: any = makeHandler(s, async () => [], undefined, { dir, bin: "/x/kangae", open: async () => true, clis: async () => [], spawn: (() => { throw new Error("no"); }) as any, browserUrl: async () => "" }, { uiHome: dir, webDriver: web(), leaseDriver: () => ({ call: async () => ({ text: "", isError: false, data: null }), close() {} }) });
  const a = s.add(null, "user", "agentA", true);
  const owner = `s:${a.id}`;
  expect((await H({ op: "act", owner, tool: "click", args: {} })).ok).toBe(false);
  const p = H({ op: "act", owner, tool: "open_tab", args: { url: "https://canvas.example/courses/1" } });
  let c: any;
  for (let i = 0; i < 300 && !c; i++) { c = ((await H({ op: "leaseList" })) as any).approvals?.[0]; if (!c) await tick(); }
  expect(c).toMatchObject({ tool: "open_tab", owner });
  expect(opens()).toHaveLength(0);
  await H({ op: "approvalAnswer", id: c.id, yes: true });
  expect((await p).ok).toBe(true);
  const ls: any[] = ((await H({ op: "leaseList" })) as any).leases;
  expect(ls.map((l) => [l.owner, l.surface.tabId])).toEqual([[owner, 9]]);
});

test("W40-4 CLI・案内・panel・拡張: 面なしの act open_tab は CLI で断られない／案内が web の仕事は open_tab を先に勧める／card の題／拡張は active:false", () => {
  const main = readFileSync("src/main.ts", "utf8");
  expect(main.includes('(av[0] === "open_app" || av[0] === "open_tab") && process.env.KANGAE_OWNER')).toBe(true);
  expect(main.includes("web の頁を見る・操作する仕事は、まず")).toBe(true);
  expect(readFileSync("extension/panel.js", "utf8").includes("まだ何も開いていない会話の頼みです")).toBe(true);
  expect(readFileSync("extension/web.js", "utf8")).toMatch(/tabs\.create\(\{ url: u\.href, active: false/); // 人が選んでいるタブは変わらない
});
