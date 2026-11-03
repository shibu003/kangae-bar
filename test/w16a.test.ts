// W16a: agent が app を裏で開いて面にする（open_app）・窓の絵を読む（window_image）。承認なしに起こさない・承認後は background の launch_app だけ・面として渡る
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, pickLease, tokenOf, type Driver, type Mode } from "../src/lease.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let dir: string, home: string, n = 0;
let calls: { tool: string; args: Record<string, unknown> }[];
let wins: { pid: number; window_id: number; title?: string; app_name?: string }[];
const fake = (): Driver => ({
  call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }, ...wins] } };
    if (tool === "launch_app") return { text: "", isError: false, data: { pid: 30, windows: wins } };
    if (tool === "get_window_state" && args.include_screenshot) return { text: "", isError: false, data: { elements: [] }, img: { data: PNG, mime: "image/png" } };
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
const mk = (o: { defaultMode?: Mode; approvalMs?: number; answer?: boolean; front?: () => string | null } = {}) => {
  const L: ReturnType<typeof makeLeases> = makeLeases((home = join(dir, `h${n++}`), mkdirSync(home), home), { driver: fake, defaultMode: o.defaultMode ?? "ask", approvalMs: o.approvalMs ?? 30, windowMs: 50, ...(o.front ? { front: o.front } : {}), onChange: () => { if (o.answer !== undefined) queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, o.answer!))); } });
  return L;
};
const A = { pid: 10, windowId: 1, app: "Orca", title: "" };
const launched = () => calls.filter((c) => c.tool === "launch_app");
const give = (L: ReturnType<typeof makeLeases>, owner = "s:1") => { const g = L.give(A, owner); if (!g.ok) throw new Error(); return tokenOf(g.lease); };

beforeEach(() => { dir = mktmp("w16a"); mkdirSync(join(dir, "web")); calls = []; wins = [{ pid: 30, window_id: 7, title: "ER_Triage_GUI — Preview", app_name: "Preview" }]; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// holes-30: card を見る test は承認の締切を大きくして「card が出るまで」を条件で待つ（締切 30ms で sleep(5) 後に数えると、load が高い時に締切が先に来て card が消え、赤になった）。時間切れで断る test は別（結果だけ見る）
const cardOf = async (L: ReturnType<typeof mk>) => { for (const end = Date.now() + 10_000; Date.now() < end && !L.approvals().length;) await Bun.sleep(5); return L.approvals()[0]!; };
for (const m of ["ask", "allow"] as const) {
  test(`承認なしに起こさない（表が「${m}」でも）: 答えが来ない間は launch_app 0 件・card が出る・断れば起こさない`, async () => {
    const L = mk({ defaultMode: m, approvalMs: 60_000 });
    const tok = give(L);
    const p = L.act(tok, "open_app", { app: "Preview", path: dir });
    const a = await cardOf(L);
    expect(a).toMatchObject({ tool: "open_app", danger: true });
    expect(a.what).toContain("Preview を裏で開きます");
    expect(launched()).toHaveLength(0); // card が出ている間（答えが来ない間）は 0 件
    L.answer(a.id, false);
    expect(await p).toMatchObject({ ok: false, why: "denied" });
    expect(launched()).toHaveLength(0);
  });
  test(`承認なしに起こさない（表が「${m}」でも）: 答えが来なければ時間切れで断り・起こさない`, async () => {
    const L = mk({ defaultMode: m, approvalMs: 30 });
    expect(await L.act(give(L), "open_app", { app: "Preview", path: dir })).toMatchObject({ ok: false, why: "timeout" });
    expect(launched()).toHaveLength(0);
  });
}

test("人が断ったら起こさない・面も増えない", async () => {
  const L = mk({ answer: false });
  const tok = give(L);
  expect(await L.act(tok, "open_app", { app: "Preview" })).toMatchObject({ ok: false, why: "denied" });
  expect(launched()).toHaveLength(0);
  expect(L.facesOf("s:1")).toHaveLength(1);
});

test("承認後: launch_app は bundle/名前と path だけ（前面・別 instance の欄は届かない）・出た窓がその会話の面になり、その token で操作できる", async () => {
  const L = mk({ answer: true });
  const tok = give(L);
  const r = await L.act(tok, "open_app", { app: "Preview", path: dir, creates_new_application_instance: true, delivery_mode: "foreground", webkit_inspector_port: 1, session: "x" });
  expect(r.ok).toBe(true);
  expect(launched()).toEqual([{ tool: "launch_app", args: { name: "Preview" } }]); // W43: path は urls に渡さない（文書を開く Apple Event が app を前に出す）
  const faces = L.facesOf("s:1");
  expect(faces).toHaveLength(2);
  const z = faces.find((l) => "pid" in l.surface && l.surface.pid === 30)!;
  expect(z.surface).toMatchObject({ pid: 30, windowId: 7, app: "Preview" });
  expect(r.ok && r.text).toContain(tokenOf(z));
  const used = pickLease({ KANGAE_LEASES: JSON.stringify({ window: tok }) }, tokenOf(z));
  expect(used).toEqual({ ok: true, token: tokenOf(z) });
  calls.length = 0;
  expect((await L.act(tokenOf(z), "get_window_state", {})).ok).toBe(true);
  expect(calls.find((c) => c.tool === "get_window_state")!.args).toMatchObject({ pid: 30, window_id: 7 });
});

test("bundle_id が先・path が無い・URL や無い path は開かない", async () => {
  const L = mk({ answer: true });
  const tok = give(L);
  await L.act(tok, "open_app", { bundle_id: "com.apple.Preview" }); // review17: app と同時指定は card とずれるので断る（test/review17.test.ts）
  expect(launched()[0]!.args).toEqual({ bundle_id: "com.apple.Preview" });
  const L2 = mk({ answer: true });
  const t2 = give(L2, "s:2");
  expect(await L2.act(t2, "open_app", {})).toMatchObject({ ok: false, why: "tool" });
  expect(await L2.act(t2, "open_app", { app: "Preview", path: "https://evil.example" })).toMatchObject({ ok: false, why: "tool" });
  expect(await L2.act(t2, "open_app", { app: "Preview", path: join(dir, "nothing") })).toMatchObject({ ok: false, why: "tool" });
  expect(launched()).toHaveLength(1);
});

test("面を 2 枚持っていれば聞かずに断る・読むだけの面/mod は開けない・他の会話の窓は渡さない", async () => {
  const L = mk({ answer: true });
  const tok = give(L);
  L.give({ pid: 20, windowId: 2, app: "Edit", title: "" }, "s:1");
  expect(await L.act(tok, "open_app", { app: "Preview" })).toMatchObject({ ok: false, why: "busy" });
  expect(launched()).toHaveLength(0);
  const L2 = mk({ answer: true, defaultMode: "off" });
  expect(await L2.act(give(L2), "open_app", { app: "Preview" })).toMatchObject({ ok: false, why: "off" });
  const L3 = mk({ answer: true });
  const t3 = give(L3);
  L3.setCap("s:1", "read");
  expect(await L3.act(t3, "open_app", { app: "Preview" })).toMatchObject({ ok: false, why: "mod" });
  const L4 = mk({ answer: true });
  L4.give({ pid: 30, windowId: 7, app: "Preview", title: "" }, "s:9"); // 他の会話が持つ窓
  expect(await L4.act(give(L4), "open_app", { app: "Preview" })).toMatchObject({ ok: false, why: "surface" });
  expect(L4.facesOf("s:9")).toHaveLength(1);
});

test("承認の待ち中に操作権を取り戻されたら起こさない", async () => {
  const L = mk({ approvalMs: 60_000 });
  const tok = give(L);
  const p = L.act(tok, "open_app", { app: "Preview" });
  await cardOf(L); // card が出てから取り戻す（500ms の締切と sleep(5) の競争にしない）
  L.stopAll();
  expect(await p).toMatchObject({ ok: false });
  expect(launched()).toHaveLength(0);
});

test("window_image: 窓の絵が file で返り（Read で見る）・turn の終わりに消える・web の tab は断る", async () => {
  const L = mk();
  const tok = give(L);
  const r = await L.act(tok, "window_image", {});
  expect(r.ok).toBe(true);
  expect(calls.find((c) => c.tool === "get_window_state")!.args).toMatchObject({ include_screenshot: true, pid: 10, window_id: 1 });
  const f = (r.ok && r.text.match(/: (\S+\.jpg)/)?.[1]) as string;
  expect(f.startsWith(join(home, "win"))).toBe(true); // review17-2: 会話ごとの置き場（shots は全会話が読める）
  expect(existsSync(f)).toBe(true);
  L.endTurn("s:1");
  expect(existsSync(f)).toBe(false);
  const webD: Driver = { call: async (tool) => ({ text: "", isError: false, data: tool === "tab_state" ? { exists: true, docId: "d" } : null }), close() {} };
  const web = makeLeases(join(dir, "web"), { web: webD, driver: fake, defaultMode: "allow" });
  const g = web.give({ tabId: 5, docId: "d", app: "web", title: "t" }, "s:3");
  if (!g.ok) throw new Error();
  expect(await web.act(tokenOf(g.lease), "window_image", {})).toMatchObject({ ok: false, why: "tool" });
});

// W12-4: 承認 card の文を初めて使う人の目で（「agent が Terminal で agent が Preview を… ところです」と二重にならない・押す操作でないのに「押す前に確かめて」を出さない・断ると何も起きない事）
test("W12-4 open_app の card: 文は 1 つの主語・「押す前に」を出さない・断ると何も開かない事を note に", () => {
  const js = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(js).toContain('a.tool === "run_cmd" || a.tool === "open_app" || a.tool === "launch_app" ? `agent が ${a.what}（');
  expect(js).toContain('if (!a.open && !["open_app", "run_cmd", "launch_app", "api_tab", "op_read", "op_write", "api_anything"].includes(a.tool)) c.append(el("div", "m"'); // 押す操作でない card は「押す前に」を出さない
  const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../src/lease.ts"), "utf8");
  expect(src).toContain('what: `${label} を裏で開きます');
  expect(src).not.toContain('what: `agent が ${label} を裏で開きます');
  expect(src).toContain("断ると何も開きません");
});

// W12-5: 報告の窓。名前を付けた agent は、会話の見出しも一覧と同じ名前（「claude」では、どの報告か分からない）・失敗の知らせを一覧で「終わりました」と読ませない
test("W12-5 報告の窓: 見出しは agent の名前・失敗の知らせは「うまく終われませんでした」", () => {
  const js = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(js).toContain("const name = roots.find((r) => r.id === rootId)?.agent?.name || lastRun?.role");
  expect(js).toContain('bad ? ["turn", "うまく終われませんでした"]');
  expect(js).toContain('const bad = /^[✗⛔]/.test(r.agent?.answer ?? "")');
});
test("W12-5 失敗の知らせ: 見出しも「終わりました」にならず・一覧で状態の語と同じ文を重ねない", () => {
  const js = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(js).toContain('/^[✗⛔]/.test(roots.find((r) => r.id === rootId)?.agent?.answer ?? "")');
  expect(js).toContain('(bad && ans.startsWith("✗"))'); // W77c: kg-row の lastHidden
});
test("W12-5 見出しの失敗の文は 460px の幅で切れない短さ（写真: docs/verify/w12e）", () => {
  const js = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(js).toContain('"失敗です。下の欄からもう一度"');
  expect(js).not.toContain("失敗しました。もう一度送ってください");
});

// W43: 返事の「前面」は起動の前後を測った事実。替わった時は嘘の「変えていません」を書かない・取れない時は確かめていないと言う
test("W43 open_app の返事: 前面が替わった時は事実を返す・同じなら確かめた旨・取れない時は確かめていない旨・path は urls に渡さず返事で断る", async () => {
  let k = 0;
  const L1 = mk({ answer: true, front: () => (++k % 2 ? "ASN:orca" : "ASN:zed") });
  const r1: any = await L1.act(give(L1), "open_app", { app: "Preview", path: dir });
  expect(r1.text).toContain("前面の app が替わりました");
  expect(r1.text).toContain("ASN:orca → ASN:zed");
  expect(r1.text).not.toContain("前面は変えていません");
  expect(r1.text).toContain("path は開いていません");
  const L2 = mk({ answer: true, front: () => "ASN:orca" });
  const r2: any = await L2.act(give(L2), "open_app", { app: "Preview" });
  expect(r2.text).toContain("前面は起動の直後に確かめて、変わっていません");
  const L3 = mk({ answer: true, front: () => null });
  const r3: any = await L3.act(give(L3), "open_app", { app: "Preview" });
  expect(r3.text).toContain("前面は確かめられませんでした");
});
