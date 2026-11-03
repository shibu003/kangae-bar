// W27: launch_app の時間切れ（冷えた Preview の起動は 8GB の Mac で十数秒〜）。launch の締切だけ長くし、時間切れでも窓の一覧で「起きたか」を確かめて起きていれば面として渡す（二重に開かせない）・書く操作に「もう一度試して」と言わない。読む file を literal で名指す: "src/lease.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_MS, makeLeases, type Driver } from "../src/lease.ts";

let top: string, calls: { tool: string; args: Record<string, unknown>; ms?: number }[];
let launch: () => ReturnType<Driver["call"]>;
let windows: () => any[];
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const driver = (): Driver => ({
  call: async (tool, args, o) => {
    calls.push({ tool, args, ms: o?.ms });
    if (tool === "launch_app") return launch();
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: windows() } };
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
const TIMEOUT = async () => ({ text: "app の起動に時間がかかっています（画面の応答が遅い）。開いたか確かめます", isError: true, data: null, unknown: true, timedOut: true });
const launches = () => calls.filter((c) => c.tool === "launch_app");
const mk = () => makeLeases(join(top, "lease"), { driver, defaultMode: "allow", approvalMs: 5000, windowMs: 100, verifyMs: 600, verifyStepMs: 50 });
const open = async (L: ReturnType<typeof mk>, args: Record<string, unknown>) => {
  const p = L.openAppFree("s:1", args);
  for (let i = 0; i < 300 && !L.approvals().length; i++) await tick();
  L.answer(L.approvals()[0]!.id, true);
  return p;
};

beforeEach(() => { top = realpathSync(mktmp("w27")); mkdirSync(join(top, "lease")); calls = []; launch = TIMEOUT; windows = () => []; });
afterEach(() => rmSync(top, { recursive: true, force: true }));

test("W27-1 launch_app の締切だけ長い（LAUNCH_MS・読み取りの呼びは既定のまま）", async () => {
  expect(LAUNCH_MS).toBeGreaterThanOrEqual(60_000);
  launch = async () => ({ text: "", isError: false, data: { pid: 30, windows: [{ pid: 30, window_id: 7, title: "x — Preview", app_name: "Preview" }] } });
  const L = makeLeases(join(top, "lease"), { driver, defaultMode: "allow", approvalMs: 5000, windowMs: 100 });
  const r = await open(L, { app: "Preview" });
  expect(r).toMatchObject({ ok: true });
  expect(launches()[0]!.ms).toBe(LAUNCH_MS);
  expect(calls.filter((c) => c.tool !== "launch_app").every((c) => c.ms === undefined)).toBe(true);
});

test("W27-2 時間切れの後に窓が出ていれば、面として渡す（launch は 1 回だけ・二重に開かない）。窓が遅れて出ても待って渡す", async () => {
  let n = 0;
  windows = () => (++n < 3 ? [] : [{ pid: 41, window_id: 9, title: "ER_Triage_GUI — Preview", app_name: "Preview" }]); // 3 回目の確認で窓が出る
  const L = mk();
  const r = await open(L, { app: "Preview" });
  expect(r).toMatchObject({ ok: true });
  expect(launches()).toHaveLength(1);
  const faces = L.facesOf("s:1");
  expect(faces).toHaveLength(1);
  expect(faces[0]!.surface).toMatchObject({ pid: 41, windowId: 9, app: "Preview" });
});

test("W27-3 時間切れの後も窓が出ない: 失敗の文は起動の遅れを言い、「もう一度試して」と言わず、繰り返すと二重に開く事を言う・面は増えない", async () => {
  const L = mk();
  const r: any = await open(L, { app: "Preview" });
  expect(r.ok).toBe(false);
  expect(r.hint).toContain("起動に時間がかかっていて");
  expect(r.hint).toContain("二重に開く");
  expect(r.hint.includes("もう一度試して")).toBe(false);
  expect(launches()).toHaveLength(1);
  expect(L.facesOf("s:1")).toEqual([]);
});

test("W27-4 他の会話が持つ窓・別の app の窓は渡さない（時間切れの確かめで取り違えない）", async () => {
  const L = mk();
  const other = L.give({ pid: 41, windowId: 9, app: "Preview", title: "他の会話の Preview" }, "s:2");
  expect(other.ok).toBe(true);
  windows = () => [{ pid: 41, window_id: 9, title: "他の会話の Preview", app_name: "Preview" }, { pid: 50, window_id: 1, title: "x", app_name: "TextEdit" }];
  const r: any = await open(L, { app: "Preview" });
  expect(r.ok).toBe(false); // 持ち主の違う Preview と別の app の窓だけ＝自分の窓は無い
  expect(r.hint).toContain("起動に時間がかかっていて"); // 他の会話の Preview を「起きた」と見なさない（確かめの時点で除く）
  expect(L.facesOf("s:1")).toEqual([]);
  expect(L.facesOf("s:2")).toHaveLength(1);
  // 同じ app の窓が他の会話の物と空いている物の 2 枚: 空いている方を渡す（持ち主の違う窓を選んで失敗しない）
  windows = () => [{ pid: 41, window_id: 9, title: "他の会話の Preview", app_name: "Preview" }, { pid: 41, window_id: 10, title: "空いている Preview", app_name: "Preview" }];
  const r2: any = await open(L, { app: "Preview" });
  expect(r2.ok).toBe(true);
  expect(L.facesOf("s:1")[0]!.surface).toMatchObject({ pid: 41, windowId: 10 });
});

test("W27-5 bundle_id で頼んだ時は bundle_id が同じ窓を渡す。締切以外の失敗（driver が理由を返した）は従来どおり「開けませんでした」で、窓を探しに行かない", async () => {
  windows = () => [{ pid: 60, window_id: 2, title: "Calc", app_name: "Calculator", bundle_id: "com.apple.calculator" }];
  const L = mk();
  const ok: any = await open(L, { bundle_id: "com.apple.calculator" });
  expect(ok.ok).toBe(true);
  expect(L.facesOf("s:1")[0]!.surface).toMatchObject({ pid: 60 });
  calls = [];
  launch = async () => ({ text: "app が見つかりません", isError: true, data: null });
  const L2 = mk();
  const bad: any = await open(L2, { app: "NoSuchApp" });
  expect(bad.ok).toBe(false);
  expect(bad.hint).toContain("開けませんでした");
  expect(calls.filter((c) => c.tool === "list_windows")).toEqual([]);
});

test("W27-6 cua の driver: launch_app の時間切れの文は別（起動の遅れ・開いたか確かめる）で「もう一度試して」を含まない。他の呼びの文は今まで通り", () => {
  const src = readFileSync("src/lease.ts", "utf8");
  const i = src.indexOf('tool === "launch_app" ? "app の起動に時間がかかっています');
  expect(i).toBeGreaterThan(0);
  const launchText = src.slice(i, src.indexOf(" : ", i));
  expect(launchText.includes("もう一度試して")).toBe(false);
  expect(src.includes('"画面の応答が遅いので諦めました（読むだけの操作なら、もう一度試して構いません）"')).toBe(true);
  expect(src.includes("o?.ms")).toBe(true); // rpc の締切を呼びごとに替えられる
});
