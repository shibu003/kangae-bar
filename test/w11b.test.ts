import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED, docKeyOf, makeLeases, resourceOf, tokenOf, type Driver } from "../src/lease.ts";

// W11b: 資源ごとの排他。窓の中の書き込みは並行・app 共通の menu は app 単位・clipboard は機械全体で 1 本・待ちは時間切れで断る / 取り戻すと消える
let dir: string, log: string[], hold: Map<string, () => void>;
const MENU = { element_token: "m1" };
// click / hotkey は gate: keys 毎に止める。driver は call の "start/end" を log に積み、release されるまで終わらない
const drv = (): Driver => ({
  call: async (tool, args) => {
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }, { pid: 10, window_id: 2 }, { pid: 20, window_id: 3 }] } };
    if (tool === "get_window_state") return { text: "", isError: false, data: { snapshot_id: "s", elements: [{ element_token: "m1", role: "AXMenuItem", label: "Save" }, { element_token: "f1", role: "AXTextField", label: "name" }] } };
    const id = `${args.pid}:${args.window_id}:${tool}${args.element_token ?? (Array.isArray(args.keys) ? args.keys.join("+") : "")}`;
    log.push(`start ${id}`);
    await new Promise<void>((r) => hold.set(id, r)); // 試験が release するまで続く
    log.push(`end ${id}`);
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
const mk = (o: Parameters<typeof makeLeases>[1] = {}) => makeLeases(dir, { driver: drv, defaultMode: "allow", resourceMs: 150, ...o });
const W1 = { pid: 10, windowId: 1, app: "Pad", title: "a" }, W2 = { pid: 10, windowId: 2, app: "Pad", title: "b" }, X = { pid: 20, windowId: 3, app: "Other", title: "c" };
const tick = () => Bun.sleep(20);
const rel = (id: string) => hold.get(id)?.();
const setup = async (L: ReturnType<typeof mk>, s: typeof W1, owner: string) => { const g = L.give(s, owner); if (!g.ok) throw new Error(); await L.act(tokenOf(g.lease), "get_window_state", {}); return tokenOf(g.lease); };

beforeEach(() => { dir = mktmp("w11b"); log = []; hold = new Map(); });
afterEach(() => { for (const f of hold.values()) f(); rmSync(dir, { recursive: true, force: true }); });

test("資源の分類: menu 要素の click と cmd+その他は menu:<pid>・cmd+c/x/v は門が先に断る（W46-A）ので資源にならない・窓の要素の書き込みは資源なし・前面入力の tool は門に無い", () => {
  const w = { pid: 10, windowId: 1, app: "Pad", title: "" };
  expect(resourceOf("click", {}, w, { role: "AXMenuItem" })).toBe("menu:10");
  expect(resourceOf("click", {}, w, { role: "AXMenuBarItem" })).toBe("menu:10");
  expect(resourceOf("click", {}, w, { role: "AXTextField" })).toBeUndefined();
  expect(resourceOf("set_value", {}, w, { role: "AXTextField" })).toBeUndefined();
  expect(resourceOf("type_text", {}, w)).toBeUndefined();
  expect(resourceOf("hotkey", { keys: ["cmd", "s"] }, w)).toBe("menu:10");
  expect(resourceOf("hotkey", { keys: ["shift", "tab"] }, w)).toBeUndefined();
  expect(resourceOf("hotkey", { keys: ["cmd", "s"] }, { tabId: 1, docId: "d", app: "web", title: "" })).toBeUndefined(); // tab に app の menu は無い
  expect(ALLOWED.some((t) => /foreground|front|clipboard|menu/i.test(t))).toBe(false); // 前面入力・専用の clipboard / menu tool は経路が無い＝拒否のまま
});

test("UC-b1: 同じ app の別々の窓への書き込みは並行（両方 start してから end）", async () => {
  const L = mk();
  const a = await setup(L, W1, "s:A"), b = await setup(L, W2, "s:B");
  const pa = L.act(a, "set_value", { element_token: "f1", value: "x" }), pb = L.act(b, "set_value", { element_token: "f1", value: "y" });
  await tick();
  expect(log).toEqual(["start 10:1:set_valuef1", "start 10:2:set_valuef1"]);
  rel("10:1:set_valuef1"); rel("10:2:set_valuef1");
  expect(await pa).toMatchObject({ ok: true });
  expect(await pb).toMatchObject({ ok: true });
});

test("UC-b2: A の menu の間、B の menu だけ待って A の後に通る（別 app の menu は待たない・窓の書き込みも待たない）", async () => {
  const L = mk({ resourceMs: 2000 });
  const a = await setup(L, W1, "s:A"), b = await setup(L, W2, "s:B"), x = await setup(L, X, "s:C");
  const pa = L.act(a, "click", MENU);
  await tick();
  const pb = L.act(b, "click", MENU);
  const px = L.act(x, "click", MENU); // 別 app の menu
  const pw = L.act(b, "set_value", { element_token: "f1", value: "z" }); // 同じ app の窓の書き込みは並行
  await tick();
  expect([...log].sort()).toEqual(["start 10:1:clickm1", "start 10:2:set_valuef1", "start 20:3:clickm1"]); // B の menu はまだ
  rel("10:1:clickm1");
  expect(await pa).toMatchObject({ ok: true });
  await tick();
  expect(log.slice(-2)).toEqual(["end 10:1:clickm1", "start 10:2:clickm1"]); // A が終わってから B（順番）
  rel("10:2:clickm1"); rel("20:3:clickm1"); rel("10:2:set_valuef1");
  expect(await pb).toMatchObject({ ok: true });
  expect(await px).toMatchObject({ ok: true });
  expect(await pw).toMatchObject({ ok: true });
});

test("UC-b3（W46-A で置き換え）: cmd+c / cmd+x / cmd+v は別 app・別の会話でも門が断り、driver に届かない（クリップボードは面と面の経路にしない）", async () => {
  const L = mk({ resourceMs: 2000 });
  const a = await setup(L, W1, "s:A"), x = await setup(L, X, "s:C");
  for (const keys of [["cmd", "c"], ["cmd", "x"], ["ctrl", "V"], ["shift", "insert"]]) {
    for (const t of [a, x]) expect(await L.act(t, "hotkey", { keys })).toMatchObject({ ok: false, why: "tool", hint: expect.stringContaining("クリップボード") });
  }
  expect(log).toEqual([]);
});

test("待ちの時間切れは断る（busy・実行 0 件・理由に「menu は別の会話が使っています」）・空いた後は通る", async () => {
  const L = mk({ resourceMs: 100 });
  const a = await setup(L, W1, "s:A"), b = await setup(L, W2, "s:B");
  const pa = L.act(a, "click", MENU);
  await tick();
  const r = await L.act(b, "click", MENU);
  expect(r).toMatchObject({ ok: false, why: "busy" });
  expect((r as any).hint).toContain("Pad の menu は別の会話が使っています（数秒で空きます）");
  expect(log).toEqual(["start 10:1:clickm1"]);
  rel("10:1:clickm1"); await pa;
  const pb = L.act(b, "click", MENU); await tick(); rel("10:2:clickm1");
  expect(await pb).toMatchObject({ ok: true });
});

test("待っている間に取り戻されたら待ちも消える（時間切れを待たず gen・実行 0 件）・全停止も同じ", async () => {
  const L = mk({ resourceMs: 5000 });
  const a = await setup(L, W1, "s:A"), b = await setup(L, W2, "s:B");
  const pa = L.act(a, "click", MENU);
  await tick();
  const t0 = Date.now();
  const pb = L.act(b, "click", MENU);
  await tick();
  L.takeback("10:2");
  expect(await pb).toMatchObject({ ok: false, why: "gen" });
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(log).toEqual(["start 10:1:clickm1"]);
  const g = L.give(W2, "s:B"); if (!g.ok) throw new Error();
  const pc = L.act(tokenOf(g.lease), "click", MENU); // 渡し直し
  await tick();
  L.stopAll();
  expect(await pc).toMatchObject({ ok: false, why: "gen" });
  rel("10:1:clickm1"); await pa;
});

test("前面入力: 前面に出す指定(delivery_mode)は門が捨てる・資源にも数えない", async () => {
  const L = mk();
  const a = await setup(L, W1, "s:A");
  const p = L.act(a, "set_value", { element_token: "f1", value: "x", delivery_mode: "foreground" });
  await tick();
  expect(log).toEqual(["start 10:1:set_valuef1"]);
  rel("10:1:set_valuef1"); await p;
});

// W11b-3: 同じ文書（別 tab）の書き換えだけ順番待ち
const webDrv: Driver = {
  call: async (tool, args) => {
    if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: `d${args.tabId}` } };
    if (tool === "get_window_state") return { text: "", isError: false, data: { snapshot_id: "s", elements: [{ element_token: "f1", role: "AXTextField", label: "body" }] } };
    if (tool === "gate_on") return { text: "", isError: false, data: null };
    const id = `t${args.tabId}:${tool}`;
    log.push(`start ${id}`);
    await new Promise<void>((r) => hold.set(id, r));
    log.push(`end ${id}`);
    return { text: "ok", isError: false, data: null };
  },
  close() {},
};
const tab = (n: number, url?: string) => ({ tabId: n, docId: `d${n}`, app: "web", title: `t${n}`, url });
const DOC = "https://docs.example.com/d/1AbCdEfGh23/edit";
const wsetup = async (L: ReturnType<typeof mk>, s: ReturnType<typeof tab>, owner: string) => { const g = L.give(s, owner); if (!g.ok) throw new Error(); await L.act(tokenOf(g.lease), "get_window_state", {}); return tokenOf(g.lease); };

test("W11b-3 文書の同一: id らしき物がある時だけ分かる・分からない時は undefined", () => {
  expect(docKeyOf(DOC)).toBe("doc:https://docs.example.com/d/1AbCdEfGh23/edit");
  expect(docKeyOf(`${DOC}#heading=1`)).toBe(docKeyOf(DOC)); // hash は同じ文書
  expect(docKeyOf("https://x.example/edit?id=42&z=1")).toBe("doc:https://x.example/edit?id=42");
  expect(docKeyOf("https://x.example/")).toBeUndefined();
  expect(docKeyOf("https://x.example/inbox/settings")).toBeUndefined(); // id らしき区間が無い
  expect(docKeyOf("chrome://newtab/")).toBeUndefined();
  expect(docKeyOf(undefined)).toBeUndefined();
  expect(resourceOf("set_value", {}, tab(1, DOC))).toBe(docKeyOf(DOC));
  expect(resourceOf("get_window_state", {}, tab(1, DOC))).toBeUndefined(); // 読むは並行
});

test("W11b-3 UC: 同じ文書を開く 2 つの tab は書き換えが順番待ち・読むは並行・別の文書と分からない文書は並行", async () => {
  const L = mk({ web: webDrv, resourceMs: 2000 });
  const a = await wsetup(L, tab(1, DOC), "s:A"), b = await wsetup(L, tab(2, DOC), "s:B"), c = await wsetup(L, tab(3, "https://docs.example.com/d/9ZyXwVuTs41/edit"), "s:C"), u = await wsetup(L, tab(4), "s:D");
  const pa = L.act(a, "set_value", { element_token: "f1", value: "x" });
  await tick();
  const pb = L.act(b, "set_value", { element_token: "f1", value: "y" });
  const pr = L.act(b, "get_window_state", {}); // 読むは待たない
  const pc = L.act(c, "set_value", { element_token: "f1", value: "z" });
  const pu = L.act(u, "set_value", { element_token: "f1", value: "w" });
  await tick();
  expect([...log].sort()).toEqual(["start t1:set_value", "start t3:set_value", "start t4:set_value"]); // B の書き換えだけまだ
  expect(await pr).toMatchObject({ ok: true });
  rel("t1:set_value");
  expect(await pa).toMatchObject({ ok: true });
  await tick();
  expect(log.slice(-2)).toEqual(["end t1:set_value", "start t2:set_value"]);
  rel("t2:set_value"); rel("t3:set_value"); rel("t4:set_value");
  expect(await pb).toMatchObject({ ok: true });
  expect(await pc).toMatchObject({ ok: true });
  expect(await pu).toMatchObject({ ok: true });
});

test("W11b-3: 時間切れは「この文書は別の会話が書いています」で断る・取り戻すと待ちも消える", async () => {
  const L = mk({ web: webDrv, resourceMs: 100 });
  const a = await wsetup(L, tab(1, DOC), "s:A"), b = await wsetup(L, tab(2, DOC), "s:B");
  const pa = L.act(a, "set_value", { element_token: "f1", value: "x" });
  await tick();
  const r = await L.act(b, "set_value", { element_token: "f1", value: "y" });
  expect(r).toMatchObject({ ok: false, why: "busy" });
  expect((r as any).hint).toContain("この文書は別の会話が書いています（数秒で空きます）");
  expect(log).toEqual(["start t1:set_value"]);
  rel("t1:set_value"); await pa;
  const L2 = mk({ web: webDrv, resourceMs: 5000 });
  const a2 = await wsetup(L2, tab(1, DOC), "s:A"), b2 = await wsetup(L2, tab(2, DOC), "s:B");
  const p1 = L2.act(a2, "set_value", { element_token: "f1", value: "x" });
  await tick();
  const p2 = L2.act(b2, "set_value", { element_token: "f1", value: "y" });
  await tick();
  L2.takeback("tab:2");
  expect(await p2).toMatchObject({ ok: false, why: "gen" });
  rel("t1:set_value"); await p1;
});
