import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";

// W11c: 取り戻しの 3 つの状態（図 §54）。停止要求中 → 操作権を回収済み →（送った物があれば）結果を確認中 → 確認済み / 結果不明
let dir: string;
let release: ((v: { unknown?: boolean }) => void) | null;
const fake = (): Driver => ({
  call: async (tool) => {
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } };
    if (tool === "type_text") { const v = await new Promise<{ unknown?: boolean }>((r) => (release = r)); return { text: "", isError: !!v.unknown, data: null, unknown: v.unknown }; }
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
const A = { pid: 10, windowId: 1, app: "ScratchPad", title: "" };
const mk = () => makeLeases(dir, { driver: fake, defaultMode: "allow" });
const phases = (L: ReturnType<typeof mk>) => L.recoveries()[0]!.steps.map((s) => s.phase);
const tick = () => new Promise((r) => setTimeout(r, 5));
beforeEach(() => { dir = mktmp("w11c"); release = null; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("送った物が無い: 停止要求中 → 回収済み で終わり、結果を確認中は飛ばす", async () => {
  const L = mk();
  L.give(A, "s:1");
  L.takeback("10:1");
  expect(L.recoveries()[0]!.phase).toBe("stopping");
  await tick();
  expect(phases(L)).toEqual(["stopping", "reclaimed"]);
  expect(L.recoveries()[0]!.sent).toBe(0);
});

for (const [name, v, last] of [["返事が来れば確認済み", {}, "confirmed"], ["時間切れなら結果不明", { unknown: true }, "unknown"]] as const) {
  test(`送った直後に取り戻す: 停止要求中 → 回収済み → 結果を確認中 → ${name}`, async () => {
    const L = mk();
    const g = L.give(A, "s:1");
    if (!g.ok) throw new Error();
    const p = L.act(tokenOf(g.lease), "type_text", { text: "a" });
    await tick(); // driver に送られて返事待ち
    L.takeback("10:1");
    await tick();
    expect(phases(L)).toEqual(["stopping", "reclaimed", "verifying"]);
    expect(L.recoveries()[0]!.phase).toBe("verifying");
    release!(v);
    await p;
    expect(phases(L)).toEqual(["stopping", "reclaimed", "verifying", last]);
    expect(L.recoveries()[0]!.sent).toBe(1);
  });
}

test("承認待ちだけなら実行 0 件・送っていないので結果を確認中は出ない", async () => {
  const L = makeLeases(dir, { driver: fake, defaultMode: "ask" });
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const p = L.act(tokenOf(g.lease), "type_text", { text: "a" });
  await tick();
  expect(L.approvals().length).toBe(1);
  L.takeback("10:1");
  expect(await p).toMatchObject({ ok: false, why: "gen" });
  await tick();
  expect(release).toBeNull(); // driver には届いていない
  expect(phases(L)).toEqual(["stopping", "reclaimed"]);
});

test("読む act は数えない・渡し直すと履歴は消える", async () => {
  const L = mk();
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  await L.act(tokenOf(g.lease), "get_window_state", {});
  L.takeback("10:1");
  await tick();
  expect(L.recoveries()[0]!.sent).toBe(0);
  L.give(A, "s:1");
  expect(L.recoveries()).toEqual([]);
});

// W11c-2: 停止要求中は agent が止まったと分かるまで続く（microtask 1 つ分ではない）・照合の読みは 1 回だけで書き換えない
test("停止要求中は onRevoke が返るまで見え続け、止まったら 回収済み", async () => {
  let done!: () => void;
  const L = makeLeases(dir, { driver: fake, defaultMode: "allow", onRevoke: () => new Promise<void>((r) => (done = r)) });
  L.give(A, "s:1");
  L.takeback("10:1");
  await tick();
  await tick();
  expect(L.recoveries()[0]!.phase).toBe("stopping");
  done();
  await tick();
  expect(phases(L)).toEqual(["stopping", "reclaimed"]);
});

test("照合: 取り戻し後に読むのは get_window_state 1 回だけ（書き換えない）・木が変わっていれば確認済み、同じなら返事待ちのまま", async () => {
  for (const mode of ["target", "other", "none"] as const) { // target = 的に跡 / other = 人が別の要素を変えた（的は同じ）/ none = 変化なし
    const changed = mode === "target";
    const calls: string[] = [];
    let n = 0;
    const d = (): Driver => ({
      call: async (tool) => {
        calls.push(tool);
        if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } };
        if (tool === "get_window_state") { const late = ++n > 1; return { text: "", isError: false, data: { elements: [{ element_token: "e1", role: "AXTextArea", label: "t", value: changed && late ? "a" : "" }, { element_token: "e2", role: "AXTextField", label: "別", value: mode === "other" && late ? "人が入れた" : "" }] } }; }
        if (tool === "type_text") { await new Promise<{ unknown?: boolean }>((r) => (release = r)); return { text: "", isError: false, data: null }; }
        return { text: "ok", isError: false, data: null };
      },
      close() {},
    });
    const L = makeLeases(dir, { driver: d, defaultMode: "allow" });
    const g = L.give(A, "s:1");
    if (!g.ok) throw new Error();
    await L.act(tokenOf(g.lease), "get_window_state", {});
    const p = L.act(tokenOf(g.lease), "type_text", { text: "a", element_token: "e1" });
    await tick();
    const before = calls.filter((c) => c === "get_window_state").length;
    L.takeback("10:1");
    await tick();
    expect(calls.filter((c) => c === "get_window_state").length - before).toBe(1);
    expect(calls.filter((c) => c === "type_text").length).toBe(1);
    expect(L.recoveries()[0]!.phase).toBe(changed ? "confirmed" : "verifying");
    release!({});
    await p;
    L.give(A, "s:1"); // 次の周回のため履歴を消す
    L.takeback("10:1");
  }
});

// W11c-3（図 §54）: 順番待ちの後・送る直前の窓の確認の最中に取り戻されたら、実行側が 0 件で断り、履歴に「実行前に止めた」
test("送る直前の確認の最中に取り戻す: driver に届かず・履歴に prevented", async () => {
  let n = 0, unblock!: () => void;
  const sentTools: string[] = [];
  const d = (): Driver => ({
    call: async (tool) => {
      if (tool === "list_windows") { if (++n === 2) await new Promise<void>((r) => (unblock = r)); return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } }; }
      sentTools.push(tool);
      return { text: "ok", isError: false, data: null };
    },
    close() {},
  });
  const L = makeLeases(dir, { driver: d, defaultMode: "allow" });
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  const p = L.act(tokenOf(g.lease), "hotkey", { keys: ["cmd", "s"] }); // app の menu の資源（menu:pid）= 待ちが挟まる経路（cmd+c は W46-A で門が先に断るので使えない）
  await tick();
  L.takeback("10:1");
  unblock();
  expect(await p).toMatchObject({ ok: false, why: "gen" });
  await tick();
  expect(sentTools).toEqual([]);
  expect(phases(L)).toContain("prevented");
});

test("待ちが無い書き込みは窓の再確認を足さない（list_windows は門の 1 回だけ）", async () => {
  let n = 0;
  const d = (): Driver => ({ call: async (tool) => { if (tool === "list_windows") n++; return { text: "ok", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } }; }, close() {} });
  const L = makeLeases(dir, { driver: d, defaultMode: "allow" });
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  n = 0;
  await L.act(tokenOf(g.lease), "type_text", { text: "a" });
  expect(n).toBe(1);
});

// W12-3: 一望の取り戻しの行に「実行前に止めた N 件」が出る（panel.js の RECOV と recoveryRow を本物のまま取り出して評価する）
test("一望の行に「実行前に止めた」が出る・prevented の step が無ければ出ない・undefined を出さない", async () => {
  const { readFileSync } = await import("node:fs");
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  const src = js.slice(js.indexOf("const RECOV ="), js.indexOf("async function loadLeases"));
  const mkEl = () => ({ dataset: {} as Record<string, string>, kids: [] as { textContent: string }[], append(...a: { textContent: string }[]) { this.kids.push(...a); } });
  const el = () => mkEl();
  const row = (steps: string[]) => new Function("el", "Object", `${src}; return recoveryRow(${JSON.stringify({ key: "k", app: "Calc", title: "電卓", phase: "reclaimed", sent: 0, steps: steps.map((phase, i) => ({ phase, at: 1000 * i })) })});`)(el, Object) as ReturnType<typeof mkEl>;
  const two = row(["stopping", "prevented", "prevented", "reclaimed"]);
  expect(two.dataset.prevented).toBe("2");
  expect(two.kids[0]!.textContent).toContain("実行前に止めた操作 2 件・その操作は実行されていません");
  expect(two.kids[0]!.textContent).not.toContain("undefined");
  const none = row(["stopping", "reclaimed"]);
  expect(none.dataset.prevented).toBe("0");
  expect(none.kids[0]!.textContent).not.toContain("実行前に止めた操作");
});
