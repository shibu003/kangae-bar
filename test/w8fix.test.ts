// w8fix: W8 前半 review の残り（R1 routine の承認・R2 内部 URL・R3 undo と act の順番・R4 hostBinary）。各 test は対応する直しを外すと赤くなる
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostBinaryOf } from "../src/first-run.ts";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { APPROVAL_MS, isInternalUrl, makeRoutines, parseSpec, type Spec } from "../src/routines.ts";

let dir: string;
beforeEach(() => { dir = mktmp("w8fix"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---- routine ----
let t0: number;
const mkR = (fired: string[], fetched: string[], over: { body?: () => string; redirect?: string } = {}) => {
  t0 = Date.UTC(2026, 9, 8, 0, 0);
  const clock = { t: t0 };
  const R = makeRoutines(dir, {
    now: () => clock.t, tz: "UTC",
    fire: (r) => { fired.push(r.id); return true; },
    fetch: (async (u: string) => { fetched.push(u); return over.redirect && u !== over.redirect ? new Response(null, { status: 302, headers: { location: over.redirect } }) : new Response(over.body?.() ?? "x"); }) as unknown as typeof fetch,
    setTimer: () => 0, clearTimer: () => {},
  });
  return { R, clock };
};
const every: Spec = { kind: "every", minutes: 5 };

test("R1: agent が足した routine は承認前に鳴らない・承諾すると鳴る・人が足した物は承認なしで鳴る", async () => {
  const fired: string[] = [];
  const { R, clock } = mkR(fired, []);
  const a = R.add("A", every, "朝の用", "agent"), h = R.add("A", every, "人の用", "human");
  if (!a.ok || !h.ok) throw new Error();
  clock.t += 6 * 60_000;
  await R.tick();
  expect(fired).toEqual([h.r.id]);
  expect(R.pending().map((c) => c.id)).toEqual([a.r.id]);
  expect(R.answer(a.r.id, true)).toBe(true);
  clock.t += 6 * 60_000;
  await R.tick();
  expect(fired).toContain(a.r.id);
});

test("R1: 時間切れ = 断る（消える）・断る / 止める / 取り戻し(declineAgent) も消える", async () => {
  const fired: string[] = [];
  const { R, clock } = mkR(fired, []);
  const a = R.add("A", every, "x", "agent"), b = R.add("A", every, "y", "agent"), c = R.add("B", every, "z", "agent"), d = R.add("A", every, "w", "agent");
  if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error();
  expect(R.answer(a.r.id, false)).toBe(true);
  R.setEnabled(b.r.id, false); // 止める = 断る
  R.declineAgent("B"); // 取り戻し
  expect(R.all().map((r) => r.id)).toEqual([d.r.id]);
  clock.t += APPROVAL_MS + 1;
  await R.tick();
  expect(R.all().length).toBe(0);
  expect(R.answer(d.r.id, true)).toBe(false); // 時間切れの後は承諾できない
  expect(fired).toEqual([]);
});

// ---- R2 ----
test("R2: 内部の host は判定される（loopback・private・link-local・.local・IPv6・10 進表記）/ 外は通す", () => {
  for (const u of ["http://localhost:3000/", "http://127.0.0.1/", "http://10.1.2.3/", "http://172.16.0.1/", "http://172.31.255.1/", "http://192.168.1.1/", "http://169.254.169.254/", "http://nas.local/", "http://[::1]/", "http://[fd00::1]/", "http://2130706433/", "http://[::ffff:127.0.0.1]/"]) expect(isInternalUrl(u)).toBe(true);
  for (const u of ["https://example.com/", "http://172.32.0.1/", "http://11.0.0.1/", "http://8.8.8.8/"]) expect(isInternalUrl(u)).toBe(false);
});

test("R2: agent が足した内部 URL の watch は、承諾の前は fetch 0・承諾の後だけ fetch する", async () => {
  const fetched: string[] = [];
  const { R, clock } = mkR([], fetched);
  const w = parseSpec({ watch: "http://localhost:8080/admin" });
  if (!w.ok) throw new Error();
  const a = R.add("A", w.spec, "", "agent");
  if (!a.ok) throw new Error();
  expect(R.pending()[0]!.internal).toBe(true);
  clock.t += 6 * 60_000;
  await R.tick();
  expect(fetched).toEqual([]);
  R.answer(a.r.id, true);
  clock.t += 31 * 60_000;
  await R.tick();
  expect(fetched).toEqual(["http://localhost:8080/admin"]);
});

test("R2: 人が足した内部 URL は fetch する・外の URL から内部へ飛ばされたら承諾が無い限り辿らない", async () => {
  const f1: string[] = [];
  const A = mkR([], f1);
  const w = parseSpec({ watch: "http://192.168.1.5/" });
  if (!w.ok) throw new Error();
  A.R.add("A", w.spec, "", "human");
  A.clock.t += 31 * 60_000;
  await A.R.tick();
  expect(f1).toEqual(["http://192.168.1.5/"]);

  const f2: string[] = [];
  const B = mkR([], f2, { redirect: "http://127.0.0.1/secret" });
  const pub = parseSpec({ watch: "https://example.com/p" });
  if (!pub.ok) throw new Error();
  B.R.add("A", pub.spec, "", "human"); // 人が足した「外の URL」でも、内部への転送は承諾ではない
  B.clock.t += 31 * 60_000;
  await B.R.tick();
  expect(f2).toEqual(["https://example.com/p"]);
});

// ---- R3: undo と act ----
const ELS = [{ element_token: "t2", role: "AXTextArea", label: "本文", value: "前" }];
let ran: string[];
let gate: Promise<void> | null;
const fake = (): Driver => ({
  call: async (tool, args) => {
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } };
    if (tool === "get_window_state") return { text: "", isError: false, data: { snapshot_id: "s", elements: ELS } };
    ran.push(`start:${tool}`);
    if (tool === "set_value" && args.value === "遅い" && gate) await gate;
    if (tool === "set_value") ELS[0]!.value = String(args.value);
    ran.push(`end:${tool}:${args.value ?? ""}`);
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
async function setup() {
  ELS[0]!.value = "前"; ran = []; gate = null;
  const L = makeLeases(dir, { driver: fake, defaultMode: "allow" });
  const g = L.give({ pid: 10, windowId: 1, app: "Mail", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  const tk = tokenOf(g.lease);
  await L.act(tk, "get_window_state", {});
  return { L, tk };
}

test("R3: act の実行中に undo を押しても混ざらない（act が終わってから undo が始まる）", async () => {
  const { L, tk } = await setup();
  await L.act(tk, "set_value", { element_token: "t2", value: "A" });
  await L.act(tk, "get_window_state", {}); // 読み直し（前の値を覚えさせる）
  let open!: () => void;
  gate = new Promise((r) => (open = r));
  ran = [];
  const slow = L.act(tk, "set_value", { element_token: "t2", value: "遅い" });
  const undo = L.undo("s:1");
  await Bun.sleep(20);
  expect(ran).toEqual(["start:set_value"]); // undo はまだ何も始めていない
  open();
  await slow; await undo;
  const i = ran.indexOf("end:set_value:遅い"), j = ran.indexOf("start:set_value", i);
  expect(i).toBeGreaterThan(0);
  expect(j).toBeGreaterThan(i); // undo の set_value は act の終わりの後
});

test("R3: 戻す前に面を読み直し、書いた値と違えば「戻せません: 面が変わった」で何も書かない", async () => {
  const { L, tk } = await setup();
  await L.act(tk, "set_value", { element_token: "t2", value: "B" });
  ELS[0]!.value = "人が書き換えた"; // その間に面が変わった
  ran = [];
  expect(await L.undo("s:1")).toEqual({ ok: false, hint: "戻せません: 面が変わった" });
  expect(ran.some((x) => x.startsWith("start:set_value"))).toBe(false);
  ELS[0]!.value = "B"; // 変わっていなければ戻る
  expect((await L.undo("s:1")).ok).toBe(true);
  expect(ELS[0]!.value).toBe("前");
});

// ---- R4 ----
test("R4: hostBinary は .app の中の compiled kangae だけ・source / dist の binary は書かない", () => {
  const bar = "/Users/u/Applications/Kangae Bar.app/Contents/Resources/bin/kangae";
  expect(hostBinaryOf(bar, true)).toBe(bar);
  expect(hostBinaryOf("/opt/homebrew/bin/bun", false)).toBeNull(); // bun src/main.ts
  expect(hostBinaryOf("/repo/dist/kangae", true)).toBeNull();
  expect(hostBinaryOf(bar, false)).toBeNull();
});
