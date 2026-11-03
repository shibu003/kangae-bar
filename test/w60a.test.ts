// W60a: 書く瞬間に人が入る（hold は「任された時」と「待つ間」しか見ない）。書く直前の最後の 1 手を、tab は頁の中（hasFocus と人の最後の入力時刻・同じ JS の 1 手の中）、窓は前面の pid と HID の最後の入力で見て、
// 入っていたら送らない（少し待って送り直す・人は待たされない）。送っている間に人が入力したら結果不明にして読み直させる
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { frontPidIn, hidIdleIn, makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { installChrome, load } from "./fake-chrome";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let dir: string, sent: { tool: string; args: Record<string, unknown> }[];
beforeEach(() => { dir = mktmp("w60a"); mkdirSync(join(dir, "l")); sent = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete (globalThis as any).document; delete (globalThis as any).__kangae; });

// 偽の拡張: 最初の n 回は「人が操作中」と返す
const web = (humanFor: number): Driver => { let n = 0; return { call: async (tool, args) => {
  if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: "D" } };
  if (tool === "tab_info") return { text: "", isError: false, data: { docId: "D", url: "https://app.example/" } };
  sent.push({ tool, args });
  if (["click", "type_text"].includes(tool) && n++ < humanFor) return { text: "人が今この tab を操作しています", isError: true, data: { human: true } };
  return { text: "ok", isError: false, data: null };
}, close() {} }; };
const tabLease = (humanFor: number) => { const L: ReturnType<typeof makeLeases> = makeLeases(join(dir, "l"), { web: web(humanFor), driver: () => web(humanFor), defaultMode: "allow", humanPollMs: 5, approvalMs: 3000, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) }); const g = L.give({ tabId: 5, docId: "D", app: "web", title: "t", url: "https://app.example/" }, "s:1"); if (!g.ok) throw new Error(); return { L, t: tokenOf(g.lease) }; };

test("W60a tab: 書く瞬間に人が操作中なら送らず、少し待って送り直す（2 回断られても 3 回目で届く）・guard は門が付ける（agent は外せない）", async () => {
  const { L, t } = tabLease(2);
  const r = await L.act(t, "click", { element_token: "e1", guard: false } as any);
  expect(r.ok).toBe(true);
  const clicks = sent.filter((x) => x.tool === "click");
  expect(clicks).toHaveLength(3);
  for (const c of clicks) expect(c.args.guard).toBe(true); // agent が guard:false を渡しても落ちる
});

test("W60a tab: ずっと人が操作中なら、4 回送り直した後に「まだ送っていません」で止める（何も変わっていない・結果不明にしない）", async () => {
  const { L, t } = tabLease(99);
  const r = await L.act(t, "click", { element_token: "e1" });
  expect(r).toMatchObject({ ok: false, why: "waiting" });
  expect((r as any).hint).toContain("何も変えていません");
  expect(sent.filter((x) => x.tool === "click")).toHaveLength(4);
  const { L: L2, t: t2 } = tabLease(0); // 人が居なければ 1 回で届く
  expect((await L2.act(t2, "type_text", { text: "x" })).ok).toBe(true);
});

test("W60a tab 読むだけの操作には guard を付けない・人の「1 手戻す」にも付けない", async () => {
  const { L, t } = tabLease(0);
  await L.act(t, "get_window_state", {});
  expect(sent.find((x) => x.tool === "get_window_state")!.args.guard).toBeUndefined();
});

// ---- 窓（cua）----
const cua = (): Driver => ({ call: async (tool, args) => { sent.push({ tool, args }); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }; }, close() {} });
const winLease = (o: { front: () => Promise<number | null>; idle: () => Promise<number | null> }) => { const L: ReturnType<typeof makeLeases> = makeLeases(join(dir, "l"), { driver: cua, defaultMode: "allow", frontPid: o.front, hidIdle: o.idle, humanPollMs: 5, approvalMs: 3000, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) }); const g = L.give({ pid: 10, windowId: 1, app: "Zed", title: "x" }, "s:1"); if (!g.ok) throw new Error(); return { L, t: tokenOf(g.lease) }; };

test("W60a 窓: その窓の app が前面で人が今入力している間は送らない・離れた（前面が替わった / 入力が止まった）ら送る", async () => {
  let idles = [0.2, 0.3, 9]; // 2 回は入力中・3 回目で止まる
  const { L, t } = winLease({ front: async () => 10, idle: async () => idles.length > 1 ? idles.shift()! : idles[0]! });
  expect((await L.act(t, "click", { x: 1, y: 2 })).ok).toBe(true);
  expect(sent.filter((x) => x.tool === "click")).toHaveLength(1);
  const other = winLease({ front: async () => 99, idle: async () => 0.1 }); // 人は別の app にいる（裏で動く本来の形）: 止めない
  expect((await other.L.act(other.t, "click", { x: 1, y: 2 })).ok).toBe(true);
});

test("W60a 窓: ずっと入力中なら 4 回見て止める（cua には 1 つも送っていない）", async () => {
  const { L, t } = winLease({ front: async () => 10, idle: async () => 0.1 });
  const r = await L.act(t, "click", { x: 1, y: 2 });
  expect(r).toMatchObject({ ok: false, why: "waiting" });
  expect(sent.filter((x) => x.tool === "click")).toHaveLength(0);
});

test("W60a 窓: 送っている間に人が入力した（送り終えた後に入力の隙間が送り始めより短い）なら結果不明にして、読み直すまで次を送らない", async () => {
  let calls = 0;
  const { L, t } = winLease({ front: async () => 10, idle: async () => (++calls <= 1 ? 30 : 0.0) }); // 送る前は静か・送った後は入力が今
  const r = await L.act(t, "click", { x: 1, y: 2 });
  expect(r).toMatchObject({ ok: false, why: "result" });
  const next = await L.act(t, "click", { x: 3, y: 4 });
  expect((next as any).hint).toContain("結果不明");
  expect(sent.filter((x) => x.tool === "click")).toHaveLength(1);
});

test("W60a 窓: 前面 pid / HID の読みが取れない時は止めない（見えない＝送る）・lsappinfo / ioreg の出力の読み方", async () => {
  const { L, t } = winLease({ front: async () => null, idle: async () => null });
  expect((await L.act(t, "click", { x: 1, y: 2 })).ok).toBe(true);
  expect(frontPidIn('59) "Mail" ASN:0x0-1: \n    pid = 11 type="Foreground"\n60) "Zed" ASN:0x0-2: (in front) \n    bundleID="x"\n    pid = 10 type="Foreground" flavor=3\n61) "Y" ASN:0x0-3: \n    pid = 12')).toBe(10);
  expect(frontPidIn('1) "A" ASN:0x0-1: \n    pid = 5')).toBeNull();
  expect(hidIdleIn('    | |   "HIDIdleTime" = 984324401\n')).toBeCloseTo(0.984, 3);
  expect(hidIdleIn("nothing")).toBeNull();
});

// ---- 頁の中（書く瞬間・同じ JS の 1 手）----
installChrome();
const { namedOp } = await load("web");
test("W60a 頁の中: focus があり人の最後の入力が 1.5 秒以内なら、名前つき操作は押さない（guard つきの時だけ）・入力が古い / focus が無いなら押す", () => {
  let clicked = 0;
  const b = { tagName: "BUTTON", innerText: "保存", value: "", getAttribute: () => null, getClientRects: () => [1], click() { clicked++; } };
  (globalThis as any).document = { querySelectorAll: () => [b], hasFocus: () => true };
  (globalThis as any).__kangae = { doc: "D", seen: Date.now() - 200 };
  const r: any = namedOp("press_button", { docId: "D", name: "保存", guard: true });
  expect(r.error).toBe(true); expect(r.data.human).toBe(true); expect(clicked).toBe(0);
  expect((namedOp("press_button", { docId: "D", name: "保存" }) as any).error).toBeUndefined(); // guard なし（試験の直呼び）は今までどおり
  (globalThis as any).__kangae.seen = Date.now() - 5000;
  expect((namedOp("press_button", { docId: "D", name: "保存", guard: true }) as any).error).toBeUndefined();
  (globalThis as any).__kangae.seen = Date.now() - 200; (globalThis as any).document.hasFocus = () => false;
  expect((namedOp("press_button", { docId: "D", name: "保存", guard: true }) as any).error).toBeUndefined(); // この頁に focus が無い（人は別の所）
});

test("W60a 頁の中: page() の click / type_text も同じ guard（人の入力は isTrusted だけ・agent の合成 event では時刻が進まない）", () => {
  const js = readFileSync(join(import.meta.dir, "../extension/web.js"), "utf8");
  const body = js.slice(js.indexOf("function page(tool, a)"), js.indexOf("export function namedOp"));
  const run = (seen: number, focus: boolean, tool: string) => {
    let clicked = 0; const listeners: Record<string, (e: any) => void> = {};
    const el = { isConnected: true, click() { clicked++; } };
    const g: any = globalThis; const keep = { document: g.document, addEventListener: g.addEventListener, chrome: g.chrome, __kangae: g.__kangae };
    g.document = { hasFocus: () => focus, title: "t", querySelectorAll: () => [] }; g.addEventListener = (t: string, f: any) => { listeners[t] = f; }; g.chrome = { runtime: { sendMessage: () => Promise.resolve() } };
    g.__kangae = { doc: "1:abc", els: new Map([["e1", el]]), n: 0, seen, listening: true };
    try { const page = new Function(`${body}; return page;`)(); const r = page(tool, { docId: "1:abc", element_token: "e1", guard: true }); return { r, clicked, listeners }; }
    finally { Object.assign(g, keep); }
  };
  const busy = run(Date.now() - 100, true, "click");
  expect(busy.r).toMatchObject({ error: true, data: { human: true } }); expect(busy.clicked).toBe(0);
  expect(run(Date.now() - 100, false, "click").clicked).toBe(1);
  expect(run(Date.now() - 9000, true, "click").clicked).toBe(1);
  expect(run(Date.now() - 100, true, "get_window_state").r.error).toBeUndefined(); // 読むだけは止めない
});
