// W11e: 読み取りの範囲と、拡張の送信元（vision §11-E）。穴ごとに「範囲外は拒否・外すと赤」
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromExtensionPage, humanTouch, renderFrom } from "../extension/tabs.js";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { makeCarry } from "../src/carry.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { pollUntil } from "../src/wait.ts";

// 穴3: 拡張の口の送信元。頁に差し込んだ script の sender.origin は頁の origin（chrome-extension:// ではない）
const ID = "abcdefghijklmnopabcdefghijklmnop";
test("穴3 onConnect: 拡張自身の画面だけ通す・頁の script / 他の拡張 / id 不明は断る", () => {
  expect(fromExtensionPage({ id: ID, origin: `chrome-extension://${ID}`, url: `chrome-extension://${ID}/panel.html` }, ID)).toBe(true);
  expect(fromExtensionPage({ id: ID, origin: "https://evil.example", tab: { id: 1 }, frameId: 3 }, ID)).toBe(false); // 頁に差した script
  expect(fromExtensionPage({ id: "other", origin: "chrome-extension://other" }, ID)).toBe(false); // 他の拡張
  expect(fromExtensionPage({ id: ID }, ID)).toBe(false); // origin 無し
  expect(fromExtensionPage(undefined, ID)).toBe(false);
  expect(fromExtensionPage({ id: undefined, origin: "chrome-extension://undefined" }, undefined)).toBe(false);
});
test("穴3b human: tab の最上位 frame だけ・別 frame / tab 無しは断る", () => {
  expect(humanTouch({ tab: { id: 5 }, frameId: 0 })).toBe(true);
  expect(humanTouch({ tab: { id: 5 }, frameId: 7 })).toBe(false);
  expect(humanTouch({ frameId: 0 })).toBe(false);
});
test("穴3b rendered: tab を持たず、頼んだ origin の枠からだけ", () => {
  expect(renderFrom({ origin: "https://a.example" }, "https://a.example")).toBe(true);
  expect(renderFrom({ origin: "https://evil.example" }, "https://a.example")).toBe(false); // 別 site の枠
  expect(renderFrom({ origin: "https://a.example", tab: { id: 2 } }, "https://a.example")).toBe(false); // 人の tab の頁
});

// 穴1: act の引数は許す欄だけ driver へ（撮影・範囲を変える欄は届かない）
let dir: string;
let calls: { tool: string; args: Record<string, unknown> }[];
beforeEach(() => { dir = mktmp("w11e"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test("穴1 get_window_state: include_screenshot:true・未知の欄・別の面は driver へ届かない（撮影は常に false）", async () => {
  const fake = (): Driver => ({ call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }; }, close() {} });
  const L = makeLeases(dir, { driver: fake, defaultMode: "allow" });
  const g = L.give({ pid: 10, windowId: 1, app: "Calc", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  await L.act(tokenOf(g.lease), "get_window_state", { include_screenshot: true, capture_mode: "screen", display: 1, pid: 99, window_id: 2, max_elements: 5 });
  const a = calls.find((c) => c.tool === "get_window_state")!.args;
  expect(a).toEqual({ include_screenshot: false, max_elements: 5, max_depth: 40, timeout_ms: 4000, pid: 10, window_id: 1 });
});

// 穴2: carry-read は移動の先も運んだ site の中だけ
test("穴2 carry-read: 運んだ site の頁が別 site へ移された時は中身を返さない・同じ site の中なら返す", async () => {
  const mk = (redirectTo?: string) => {
    const sent: string[] = [];
    const cdp = { send: async (m: string, p: any = {}) => { sent.push(m); if (m === "Target.createBrowserContext") return { browserContextId: "c1" }; if (m === "Target.createTarget") return { targetId: "t" }; if (m === "Target.attachToTarget") return { sessionId: "s" };
      if (m === "Runtime.evaluate") return { result: { value: String(p.expression).includes("readyState") ? "complete" : JSON.stringify({ u: redirectTo ?? "https://app.example.com/me", t: "題", b: "本文" }) } }; return {}; }, close() {} };
    return makeCarry({ web: () => ({ call: async (t: string) => ({ text: "", isError: false, data: { cookies: t === "cookie_get" ? [{ name: "sid", value: "v", domain: "app.example.com", path: "/", secure: true }] : [{ name: "sid", domain: "app.example.com", path: "/" }] } }), close() {} }), browserUrl: async () => "http://127.0.0.1:1", connect: async () => cdp as any, approvalMs: 2000 });
  };
  for (const [to, ok] of [[undefined, true], ["https://evil.example/x", false], ["https://app.example.com.evil.example/", false]] as const) {
    const c = mk(to);
    const p = c.ask("s:1", "app.example.com");
    await pollUntil(() => c.cards().length, 40_000, 5);
    c.answer(c.cards()[0]!.id, true);
    await p;
    const r = await c.read("s:1", "https://app.example.com/me");
    expect(r.ok).toBe(ok);
    if (!r.ok) expect((r as any).hint).not.toContain("本文");
  }
});

// 穴4: webResult は webHello した口からだけ
test("穴4 webResult: webHello していない口の偽の返事は待っている call に届かない", async () => {
  const s = openStore(":memory:");
  const sent: any[] = [];
  const h = makeHandler(s, async () => [], undefined, undefined, { awaitWebPeer: true, isExtension: () => true, webPeerMs: 2000, broadcast: (m) => sent.push(m) });
  const root = s.add(null, "user", "課題", true);
  const ext = {}, fake = {};
  await h({ op: "webHello" }, ext);
  const give = h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" });
  await new Promise((r) => setTimeout(r, 50));
  const w = sent.find((m) => m.type === "web")!;
  await h({ op: "webResult", callId: w.id, text: "", data: { docId: "evil", title: "偽", url: "https://evil.example/" } }, fake);
  await h({ op: "webResult", callId: w.id, text: "", data: { docId: "d1", title: "頁", url: "https://ex.example/" } }, ext);
  const r: any = await give;
  expect(r.ok).toBe(true);
  expect(JSON.stringify(r)).not.toContain("evil");
});

// 配線: sw.js の onConnect の先頭と human の口、web.js の rendered の口が純関数を通る（外すと赤）
import { readFileSync } from "node:fs";
test("配線: sw.js onConnect / human と web.js rendered が送信元の確認を通っている", () => {
  const sw = readFileSync(join(import.meta.dir, "../extension/sw.js"), "utf8"), web = readFileSync(join(import.meta.dir, "../extension/web.js"), "utf8");
  expect(sw).toMatch(/onConnect\.addListener\(\(port\) => \{\n\s*if \(!fromExtensionPage\(port\.sender, chrome\.runtime\.id\)\) \{ port\.disconnect\(\); return; \}/);
  expect(sw).toMatch(/op === "human" && humanTouch\(sender\)/);
  expect(web).toMatch(/renderFrom\(sender, w\.origin\)/);
});
