// W51: EXP-1 の A と B を「同時に」通す試験（実機の前の最後の網）。偽の driver・偽の拡張（web driver）・偽の Canvas と Docs の tab・偽の ER_Triage folder（W48）。
// 1 つの makeLeases の上で 2 つの会話（A = s:1・B = s:2）が同時に走り、全部の呼びを 1 本の表に記録して 6 つを見る:
//  (1) 前面を変える呼び 0 (2) 本物のカーソルを動かす呼び 0 (3) クリップボードの呼び 0 (4) A と B が互いの面に触らない (5) ops.jsonl に両方が owner 別に並ぶ (6) Bar の 5 件の表示が両方に出る
// 毎回 card は試験が許す。実機（実 Chrome・実 Zed・実 ImGui の窓）は実験役。
// A は W48b の道: 登録 build（実物の triage_core.hpp を clang++ で本当に build）→ agent は素の値だけを add_patients.csv に書き → er-triage-add（priority は規則が出す）→ launch --load。agent が priority を書く道を試みても data.csv は変わらない（W51b）
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addCmd } from "../src/cmds.ts";
import { keyOf, makeLeases, tokenOf, type Driver, type OpRecord } from "../src/lease.ts";
import { recentFor } from "../src/opsview.ts";
import { assignPriority, loadCsv, type P } from "./er-triage-oracle.ts";
setDefaultTimeout(300_000); // A は実 clang++ の build を含む
const FX = join(import.meta.dir, "fixtures", "er-triage");
const ADD_HEADER = "name,age,symptoms,painLevel,chestPain,breathingTrouble,heavyBleeding,unconsciousOrConfused,severePain";

type Call = { via: "cua" | "web"; tool: string; args: Record<string, any> };
let top: string, ui: string, work: string, proj: string, ops: string, calls: Call[], lastPid: number;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date(2026, 9, 14, 10, 0, 0);
const CANVAS = "https://school.instructure.com";
const planner = [
  { plannable_date: "2026-10-21T14:59:00Z", context_name: "CS101", plannable_type: "assignment", plannable: { title: "Lab 3", points_possible: 20 }, submissions: { submitted: false } },
  { plannable_date: "2026-10-20T03:00:00Z", context_name: "MATH200", plannable_type: "quiz", plannable: { title: "Quiz 5", points_possible: 10 } },
];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="; // 1x1
const ZED = { pid: 10, windowId: 1, app: "Zed", title: "ER_Triage_GUI" };

// 偽の cua（窓の driver）: 起こした app の窓が list_windows に出る。呼びは全部 calls に残す
const cua = (): Driver => ({
  call: async (tool, args) => {
    calls.push({ via: "cua", tool, args });
    if (tool === "list_windows") {
      if (args.pid != null) lastPid = Number(args.pid);
      return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1, app_name: "Zed", title: "ER_Triage_GUI" }, ...(lastPid ? [{ pid: lastPid, window_id: 5, app_name: "er_triage_gui", title: "ER Triage" }] : [])] } };
    }
    return { text: "ok", isError: false, data: tool === "get_window_state" ? { snapshot_id: "s", elements: [] } : null, ...(tool === "get_window_state" ? { img: { data: PNG, mime: "image/png" } } : {}) };
  },
  close() {},
});
// 偽の拡張（web の driver）: Canvas の tab 7・Docs の tab 8
const web = (): Driver => ({
  call: async (tool, args) => {
    calls.push({ via: "web", tool, args });
    if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: args.tabId === 7 ? "DC" : "DD" } };
    if (tool === "tab_info") return { text: "", isError: false, data: { url: args.tabId === 7 ? `${CANVAS}/` : "https://docs.google.com/document/d/abc/edit", docId: args.tabId === 7 ? "DC" : "DD" } };
    if (tool === "api_fetch") return { text: "", isError: false, data: { status: 200, url: args.url, headers: [], body: Buffer.from("while(1);" + JSON.stringify(planner)).toString("base64") } };
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});

beforeEach(() => {
  top = realpathSync(mktmp("w51"));
  ui = join(top, "ui"); work = join(top, "work"); proj = join(top, "ER_Triage_GUI"); ops = join(top, "ops.jsonl");
  for (const d of [ui, work, proj, join(top, "lease")]) mkdirSync(d);
  calls = []; lastPid = 0;
  writeFileSync(join(proj, "data.csv"), "uinfiuwnfun nweifnini  fjnienfi");
  // W48b の folder: 実物の triage_core.hpp と、CLI（er_triage_add）・app の stand-in（--load）の参照実装を src に置き、build.sh が clang++ で build する
  mkdirSync(join(proj, "src"));
  for (const f of ["triage_core.hpp", "er_triage_add.cpp", "app_stub.cpp"]) copyFileSync(join(FX, f), join(proj, "src", f));
  writeFileSync(join(proj, "build.sh"), `mkdir -p build
/usr/bin/clang++ -std=c++17 -Isrc -o build/er_triage_add src/er_triage_add.cpp || exit 1
/usr/bin/clang++ -std=c++17 -Isrc -o build/er_app src/app_stub.cpp || exit 1
`);
});
afterEach(() => rmSync(top, { recursive: true, force: true }));

const csvq = (v: string) => (/[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const addRows = (ps: P[]) => ps.map((p) => [csvq(p.name), p.age, csvq(p.symptoms), p.painLevel, +!!p.chestPain, +!!p.breathingTrouble, +!!p.heavyBleeding, +!!p.unconsciousOrConfused, +!!p.severePain].join(",")).join("\n");
const THREE: P[] = [
  { name: "山田 太郎", age: 80, symptoms: "転倒 腰痛", painLevel: 5 },
  { name: "Ann \"A\" Lee", age: 30, symptoms: "chest tightness", painLevel: 4, chestPain: true },
  { name: "佐藤", age: 25, symptoms: "のどの痛み", painLevel: 2 },
];
const reg = (name: string, argv: string[], app = false) => { const r = addCmd(ui, name, proj, argv, 600, 1, { app }); if (!r.ok) throw new Error(r.hint); };

test("W51 A と B を同時に通す: 前面 0・本物のカーソル 0・clipboard 0・互いの面に触らない・ops.jsonl に owner 別・Bar の 5 件が両方に出る", async () => {
  reg("build", ["/bin/sh", "build.sh"]); // 実行 file の登録は build の後（実行 file が在る時だけ通る＝人が cmd-add する順序）
  const errs = spyOn(console, "error").mockImplementation(() => {});
  const FRONT = "ASN:0x0-0x1001"; // 前面の app は終始同じ
  const L: ReturnType<typeof makeLeases> = makeLeases(join(top, "lease"), {
    driver: cua, web: web(), defaultMode: "ask", approvalMs: 8000, appWaitMs: 3000, appStepMs: 30, now: () => NOW.getTime(), front: () => FRONT,
    record: (e: OpRecord) => appendFileSync(ops, JSON.stringify(e) + "\n"),
  });
  // 毎回 card は試験が許す（run_cmd・launch_app・Docs への書き込み）
  const yes = setInterval(() => { for (const a of L.approvals()) L.answer(a.id, true); }, 8);
  const ctx = { uiHome: ui, workDir: work };
  try {
    const a = L.give(ZED, "s:1");
    const c = L.give({ tabId: 7, docId: "DC", app: "web", title: "Canvas", url: `${CANVAS}/` }, "s:2"), d = L.give({ tabId: 8, docId: "DD", app: "web", title: "週報", url: "https://docs.google.com/document/d/abc/edit" }, "s:2");
    if (!a.ok || !c.ok || !d.ok) throw new Error("give");
    const zed = tokenOf(a.lease), canvas = tokenOf(c.lease), docs = tokenOf(d.lease);

    const flowA = async () => {
      expect(await L.runCmd("s:1", "build", ctx)).toMatchObject({ ok: true });
      expect(existsSync(join(proj, "build/er_triage_add"))).toBe(true);
      reg("er-triage-add", [join(proj, "build/er_triage_add")]);
      reg("show", [join(proj, "build/er_app"), "--load", "data.csv"]);
      reg("gui", ["/bin/sh", "-c", `${join(proj, "build/er_app")} --load data.csv; sleep 60`], true); // launch の登録（起動引数 --load つき・窓が出るまで居る stand-in）
      // agent が priority を書こうとする（入力に priority の欄を足す）→ 断られ、data.csv は 1 byte も変わらない
      const before = readFileSync(join(proj, "data.csv"), "utf8");
      writeFileSync(join(proj, "add_patients.csv"), `${ADD_HEADER},priority\n${addRows([THREE[1]!])},Low\n`);
      expect((await L.runCmd("s:1", "er-triage-add", ctx) as any).text).toMatch(/exit [23]\b/);
      expect(readFileSync(join(proj, "data.csv"), "utf8")).toBe(before);
      // 素の値だけ → 規則が priority を出す
      writeFileSync(join(proj, "add_patients.csv"), `${ADD_HEADER}\n${addRows(THREE)}\n`);
      expect((await L.runCmd("s:1", "er-triage-add", ctx) as any).text).toContain("saved: 3 patients");
      const got = (loadCsv(readFileSync(join(proj, "data.csv"), "utf8")) as any).patients as { name: string; priority: string }[];
      expect(got).toHaveLength(3);
      for (const p of THREE) expect(got.find((x) => x.name === p.name)!.priority).toBe(assignPriority(p)); // 胸痛は High（agent が Low と書こうとしても）
      const shown = await L.runCmd("s:1", "show", ctx); // --load で起こした app に 3 人
      expect(shown).toMatchObject({ ok: true });
      expect((shown as any).text).toContain("waiting: 3");
      expect((shown as any).text).toContain('Ann "A" Lee / High');
      // agent が data.csv を直接直して priority を嘘にしても、--load の app は規則で出し直す（手書きの priority は効かない）
      const lied = readFileSync(join(proj, "data.csv"), "utf8").split("\n").map((l) => (l.includes("Ann") ? l.replace(",High,", ",Low,") : l)).join("\n");
      expect(lied).not.toBe(readFileSync(join(proj, "data.csv"), "utf8"));
      writeFileSync(join(proj, "data.csv"), lied);
      expect(((await L.runCmd("s:1", "show", ctx)) as any).text).toContain('Ann "A" Lee / High');
      const g = await L.launchApp("s:1", "gui", ctx);
      expect(g).toMatchObject({ ok: true });
      const win = L.facesOf("s:1").find((x) => (x.surface as any).pid !== 10)!;
      const img = await L.act(tokenOf(win), "window_image", {}); expect(img, JSON.stringify(img)).toMatchObject({ ok: true }); // 起こした窓の絵を読む（前面に出さない）
      expect((await L.act(tokenOf(win), "get_window_state", {})).ok).toBe(true);
    };
    const flowB = async () => {
      const r = await L.act(canvas, "web_op", { op: "canvas-week" });
      expect(r.ok).toBe(true);
      const j = JSON.parse((r as any).text);
      const summary = j.items.map((i: any) => `- ${i.due.slice(0, 10)} ${i.course} ${i.title}`).join(" / ");
      expect((await L.act(docs, "click", { x: 100, y: 200 })).ok).toBe(true);
      expect((await L.act(docs, "type_text", { text: summary })).ok).toBe(true);
    };
    await Promise.all([flowA(), flowB()]);
    await tick(30); // 記録は非同期

    // (1) 前面を変える呼び 0
    const FRONTING = ["activate", "activate_app", "raise_window", "bring_to_front", "focus_window", "focus_app", "set_front", "switch_tab", "activate_tab", "select_tab"];
    expect(calls.filter((x) => FRONTING.includes(x.tool))).toEqual([]);
    expect(calls.filter((x) => x.tool === "open_tab" && x.args.active === true)).toEqual([]);
    expect(errs.mock.calls.flat().join("\n")).not.toContain("前面が替わった"); // 起こす前後の前面が同じ
    // (2) 本物のカーソルを動かす呼び 0（agent の仮想カーソルの overlay も既定 off）
    const CURSOR = ["move_cursor", "set_agent_cursor_enabled", "mouse_move", "move_mouse", "warp_cursor", "set_cursor_position"];
    expect(calls.filter((x) => CURSOR.includes(x.tool))).toEqual([]);
    expect(calls.filter((x) => "delivery_mode" in x.args)).toEqual([]); // 前面入力の道は門に無い
    // (3) クリップボードの呼び 0
    expect(calls.filter((x) => /clip|paste|copy|cut/i.test(x.tool) || ["hotkey", "press_key"].includes(x.tool))).toEqual([]);
    // (4) 互いの面に触らない: cua の呼びは A の窓（Zed の pid 10・起こした app の pid）だけ・web の呼びは B の tab（7・8）だけ
    const appPid = L.facesOf("s:1").map((x) => (x.surface as any).pid as number);
    expect(calls.filter((x) => x.via === "web" && ![7, 8].includes(x.args.tabId)).filter((x) => x.args.tabId !== undefined)).toEqual([]);
    expect(calls.filter((x) => x.via === "cua" && x.args.pid !== undefined && !appPid.includes(Number(x.args.pid)))).toEqual([]);
    expect(calls.filter((x) => x.via === "cua" && x.args.tabId !== undefined)).toEqual([]);
    expect(calls.filter((x) => x.via === "web" && x.args.pid !== undefined)).toEqual([]);
    expect(L.facesOf("s:1").every((x) => !("tabId" in x.surface))).toBe(true);
    expect(L.facesOf("s:2").every((x) => "tabId" in x.surface)).toBe(true);
    // 相手の持ち主の名前で叩いても、相手の面は動かない（token の持ち主が合わない）・相手の面は貸せない
    const forged = (key: string, gen: number, owner: string) => `${key}|${gen}|${owner}`;
    expect((await L.act(forged(keyOf(a.lease.surface), a.lease.gen, "s:2"), "get_window_state", {})).ok).toBe(false);
    expect((await L.act(forged(keyOf(c.lease.surface), c.lease.gen, "s:1"), "get_window_state", {})).ok).toBe(false);
    expect(L.give({ tabId: 7, docId: "DC", app: "web", title: "Canvas", url: `${CANVAS}/` }, "s:1")).toMatchObject({ ok: false });
    expect(L.give(ZED, "s:2")).toMatchObject({ ok: false });
    // (5) ops.jsonl に両方の記録が owner 別に並ぶ（A の記録は A の面・B の記録は B の面）
    const recs = readFileSync(ops, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as OpRecord);
    const of = (o: string) => recs.filter((r) => r.owner === o);
    expect(of("s:1").length).toBeGreaterThanOrEqual(2);
    expect(of("s:2").length).toBeGreaterThanOrEqual(3);
    expect(of("s:1").every((r) => !r.face.startsWith("tab:"))).toBe(true);
    expect(of("s:2").every((r) => r.face.startsWith("tab:"))).toBe(true);
    expect(recs.every((r) => r.owner === "s:1" || r.owner === "s:2")).toBe(true);
    // (6) Bar の 5 件の表示が両方に出る（人の言葉・内部の語なし・Docs に入れた中身は 80 字までの値として出る＝伏せるのは secure だけ）
    const A = recentFor(ops, "s:1"), B = recentFor(ops, "s:2");
    expect(A.length).toBeGreaterThanOrEqual(2); expect(A.length).toBeLessThanOrEqual(5);
    expect(B.length).toBeGreaterThanOrEqual(3); expect(B.length).toBeLessThanOrEqual(5);
    expect(A.every((x) => x.line.startsWith("窓"))).toBe(true);
    expect(B.every((x) => x.line.startsWith("tab"))).toBe(true);
    expect(B.some((x) => x.line.includes("頁の操作をした") && x.line.endsWith("できた"))).toBe(true);
    for (const x of [...A, ...B]) expect(x.line).not.toMatch(/(?<![画場表帳方側地反書全前後正裏上下])面[のがをはに]|この面|世代|lease|refused:/); // 「画面」「場面」は人の言葉（W12-10 と同じ見分け）
  } finally { clearInterval(yes); L.stopAll(); errs.mockRestore(); await tick(50); }
});

test("W51 A と B の記録は混ざらない: B の Bar に A の操作は出ず、A の Bar に B の操作は出ない", async () => {
  const f = join(top, "ops2.jsonl");
  const rec = (owner: string, face: string, op: string): OpRecord => ({ at: Date.now(), face, app: face.startsWith("tab:") ? "web" : "Zed", gen: 1, op, value: "", result: "ok", owner, where: "x" });
  for (const r of [rec("s:1", "10:1", "window_image"), rec("s:2", "tab:7", "web_op"), rec("s:1", "10:1", "get_window_state")]) appendFileSync(f, JSON.stringify(r) + "\n");
  expect(recentFor(f, "s:1").map((x) => x.line)).toEqual(["窓「x」で画面を読んだ → できた", "窓「x」で窓の絵を読んだ → できた"]);
  expect(recentFor(f, "s:2").map((x) => x.line)).toEqual(["tab「x」で頁の操作をした → できた"]);
});
