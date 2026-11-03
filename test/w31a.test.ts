// W31a: 人が `cmd-add --app` で登録した GUI を、名前だけで待たずに起こす（kangae launch）。毎回 card・sandbox の下・窓が出れば面・寿命つき・二重に起こさない・前面の記録・W32（起動を許した turn の間は click をまとめて許す）。実際に sandbox-exec を回す。
// docs/BRIEF-w31.md §6 の AC 1〜9。読む file を literal で名指す: "src/lease.ts" "src/cmds.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCmd, loadCmds } from "../src/cmds.ts";
import { keyOf, makeLeases, tokenOf, type Driver } from "../src/lease.ts";

let top: string, ui: string, work: string, proj: string, listCalls: number, winAfter: number, noWindow: boolean, lastPid = 0;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (pid: number, ms = 4000) => { for (const end = Date.now() + ms; alive(pid) && Date.now() < end;) await tick(20); return !alive(pid); };
const driver = (): Driver => ({
  call: async (tool, args) => {
    if (tool === "list_windows") { if (args.pid != null) { listCalls++; lastPid = Number(args.pid); } const pid = args.pid != null ? Number(args.pid) : lastPid; return { text: "", isError: false, data: { windows: [...(!noWindow && listCalls > winAfter ? [{ pid, window_id: 5, title: "fake gui", app_name: "ER_Triage_GUI" }] : []), ...(args.pid == null ? [{ pid: 99, window_id: 3, title: "", app_name: "Other" }] : [])] } }; }
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
const mk = (o: { front?: () => string | null; appLifeMs?: number; mode?: "allow" | "ask"; approvalMs?: number; waitMs?: number } = {}) => makeLeases(join(top, "lease"), { driver, defaultMode: o.mode ?? "ask", approvalMs: o.approvalMs ?? 5000, appWaitMs: o.waitMs ?? 800, appStepMs: 30, front: o.front ?? (() => "ASN:same"), appLifeMs: o.appLifeMs });
const ctx = () => ({ uiHome: ui, workDir: work });
const GUI = (extra = "") => ["/bin/sh", "-c", `echo started >> '${proj}/starts'; ${extra} sleep 60`];
const reg = (name: string, argv: string[] = GUI(), app = true, cwd = proj) => { const r = addCmd(ui, name, cwd, argv, 600, 1, { app }); if (!r.ok) throw new Error(r.hint); return r.cmd; };
const card = async (L: ReturnType<typeof mk>) => { for (let i = 0; i < 300 && !L.approvals().length; i++) await tick(); return L.approvals()[0]!; };
const waitStarts = async (n: number) => { for (let i = 0; i < 150 && starts() < n; i++) await tick(20); return starts(); };
const starts = () => (existsSync(join(proj, "starts")) ? readFileSync(join(proj, "starts"), "utf8").split("\n").filter(Boolean).length : 0);
const launchOk = async (L: ReturnType<typeof mk>, owner = "s:1", name = "gui") => { const p = L.launchApp(owner, name, ctx()); const c = await card(L); L.answer(c.id, true); return p; };
// closeAll の後、kill された app の終わりで面が外れる（非同期）。dir を消す前に待つ
const settle = async (L: ReturnType<typeof mk>, owner = "s:1") => { for (let i = 0; i < 150 && L.facesOf(owner).length; i++) await tick(20); await tick(50); };
const pidOf = (L: ReturnType<typeof mk>, owner = "s:1") => (L.facesOf(owner)[0]!.surface as any).pid as number;

beforeEach(() => {
  top = realpathSync(mktmp("w31a"));
  ui = join(top, "ui"); work = join(top, "work"); proj = join(top, "proj");
  for (const d of [ui, work, proj, join(top, "lease")]) mkdirSync(d);
  listCalls = 0; winAfter = 0; noWindow = false;
});
afterEach(() => rmSync(top, { recursive: true, force: true }));

test("AC-1 承認なしに起こさない: 答えが来ない間は 0 件・断り / 時間切れで 0 件・許しても「この頼みの間」の card は無い（毎回 danger）", async () => {
  reg("gui");
  const L = mk();
  const p = L.launchApp("s:1", "gui", ctx());
  const c = await card(L);
  expect(c).toMatchObject({ tool: "launch_app", danger: true, owner: "s:1" });
  expect(c.what).toContain("app「gui」を起動します");
  expect(c.note).toContain("まとめて 1 回の承認");
  await tick(80);
  expect(starts()).toBe(0);
  L.answer(c.id, false);
  const r: any = await p;
  expect(r).toMatchObject({ ok: false, why: "denied" });
  expect(r.hint).toContain("app は起こしていません");
  expect(starts()).toBe(0);
  const T = mk({ approvalMs: 30 });
  expect(await T.launchApp("s:1", "gui", ctx())).toMatchObject({ ok: false, why: "timeout" });
  expect(starts()).toBe(0);
});

test("AC-2 名前しか選べない・種類を取り違えない: 未登録 / command の名前を launch で / app の名前を run で は断る（起こさない・走らせない）", async () => {
  reg("gui"); reg("build", ["/bin/echo", "x"], false);
  const L = mk();
  const un: any = await L.launchApp("s:1", "nope", ctx());
  expect(un.ok).toBe(false); expect(un.hint).toContain("登録済みの app: gui"); expect(un.hint).toContain("--app");
  const cm: any = await L.launchApp("s:1", "build", ctx());
  expect(cm.hint).toContain("kangae run build");
  const ap: any = await L.runCmd("s:1", "gui", ctx());
  expect(ap.hint).toContain("kangae launch gui");
  expect(L.approvals()).toHaveLength(0);
  expect(starts()).toBe(0);
});

test("AC-3 登録は人だけ・uiHome の中の実行 file / 実行できない file は断る（W37・user 承認済み: 作業場所の中は seatbelt が守るので断らない）", async () => {
  const noexec = join(top, "plain.txt"); writeFileSync(noexec, "x");
  const r = addCmd(ui, "bad", proj, [noexec], 600, 1, { app: true });
  expect(r.ok).toBe(false); expect((r as any).hint).toContain("実行できる file ではありません");
  const inside = join(ui, "evil.sh"); writeFileSync(inside, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  reg("evil", [inside], true, proj);
  const L = mk();
  const out: any = await L.launchApp("s:1", "evil", ctx());
  expect(out.ok).toBe(false); expect(out.hint).toContain("Kangae の置き場");
  expect(L.approvals()).toHaveLength(0);
  reg("insidecwd", GUI(), true, ui);
  expect(((await L.launchApp("s:1", "insidecwd", ctx())) as any).hint).toContain("Kangae の置き場");
  expect(starts()).toBe(0);
  const cli = Bun.spawnSync(["bun", "src/main.ts", "cmd-add", "g", "--app", "--cwd", proj, "--", "/bin/sh"], { env: { ...process.env, KANGAE_HOME: join(top, "h3"), KANGAE_OWNER: "s:1" } });
  expect(cli.exitCode).toBe(1); // agent の env からは登録できない
}, 60_000);

test("AC-4 印: 登録の行を書き換えると起こさない・承認を待つ間に書き換えても起こさない", async () => {
  reg("gui");
  const f = join(ui, "commands.json");
  const tamper = (name: string, argv: string[]) => { const j = JSON.parse(readFileSync(f, "utf8")); j.items.find((c: any) => c.name === name).argv = argv; writeFileSync(f, JSON.stringify(j)); };
  const L = mk();
  const p = L.launchApp("s:1", "gui", ctx());
  const c = await card(L);
  tamper("gui", ["/bin/sh", "-c", `echo evil >> '${proj}/starts'; sleep 5`]);
  L.answer(c.id, true);
  const r: any = await p;
  expect(r.ok).toBe(false); expect(r.hint).toContain("承認を待つ間に替わりました");
  expect(starts()).toBe(0);
  const first: any = await mk().launchApp("s:1", "gui", ctx());
  expect(first.ok).toBe(false); expect(first.hint).toContain("書き換えられています");
});

test("AC-5 sandbox の下で起こる: cwd には書け、cwd の外（home の下の別 folder・/private/tmp）には書けない・通信できない", async () => {
  mkdirSync(join(process.env.HOME!, ".w31a-outside-" + process.pid), { recursive: true });
  const outside = join(process.env.HOME!, ".w31a-outside-" + process.pid);
  try {
    reg("gui", GUI(`echo in > '${proj}/inside.txt'; echo out > '${outside}/x' 2>/dev/null; echo tmp > /private/tmp/w31a-no 2>/dev/null; /usr/bin/nc -z -w 1 127.0.0.1 9 2>/dev/null && echo net > '${proj}/net.txt';`));
    const L = mk();
    const r: any = await launchOk(L);
    expect(r.ok).toBe(true);
    for (let i = 0; i < 100 && !existsSync(join(proj, "inside.txt")); i++) await tick(20);
    expect(existsSync(join(proj, "inside.txt"))).toBe(true);
    await tick(300);
    expect(existsSync(join(outside, "x"))).toBe(false);
    expect(existsSync("/private/tmp/w31a-no")).toBe(false);
    expect(existsSync(join(proj, "net.txt"))).toBe(false);
    L.closeAll(); await settle(L);
  } finally { rmSync(outside, { recursive: true, force: true }); rmSync("/private/tmp/w31a-no", { force: true }); }
});

test("AC-6 窓が出れば、起こした pid の窓が面になる（遅れて出ても待つ）・返事に面の名前。窓が出なければ起こしたものを止め、面は増えない", async () => {
  reg("gui");
  winAfter = 2; // 3 回目の確認で窓が出る
  const L = mk();
  const r: any = await launchOk(L);
  expect(r.ok).toBe(true);
  const pid = pidOf(L);
  expect(alive(pid)).toBe(true);
  expect(L.facesOf("s:1")[0]!.surface).toMatchObject({ pid, windowId: 5, app: "ER_Triage_GUI" });
  expect(r.text).toContain("act --on window");
  expect(r.text).toContain("まとめて許されています");
  L.closeAll(); await settle(L);
  expect(await waitDead(pid)).toBe(true);
  // 窓が出ない
  noWindow = true;
  rmSync(join(proj, "starts"), { force: true });
  reg("nowin", GUI(`echo $$ > '${proj}/pid-nowin';`));
  const N = mk({ waitMs: 1500 });
  const bad: any = await launchOk(N, "s:2", "nowin");
  expect(bad.ok).toBe(false); expect(bad.hint).toContain("窓が出ませんでした");
  expect(N.facesOf("s:2")).toEqual([]);
  expect(existsSync(join(proj, "pid-nowin"))).toBe(true); // 起こした process の pid（sh）
  expect(await waitDead(Number(readFileSync(join(proj, "pid-nowin"), "utf8").trim()))).toBe(true); // 窓が出なかったので止めた
});

test("AC-7 寿命: turn の終わり / 面の取り戻し / 全停止 / 常駐の終了 / 自分で終わった / 最大寿命 で、起こした process group が子まで死に、面も外れる", async () => {
  for (const how of ["endTurn", "takeback", "stopAll", "closeAll", "exit", "life"] as const) {
    rmSync(join(proj, "starts"), { force: true });
    const pidf = join(proj, `child-${how}`);
    reg("gui", how === "exit" ? ["/bin/sh", "-c", "sleep 1"] : ["/bin/sh", "-c", `sleep 60 & echo $! > ${pidf}; wait`]);
    const L = mk({ appLifeMs: how === "life" ? 700 : undefined });
    const r: any = await launchOk(L);
    expect(r.ok).toBe(true);
    const pid = pidOf(L);
    let child = 0;
    if (how !== "exit") { for (let i = 0; i < 100 && !existsSync(pidf); i++) await tick(20); child = Number(readFileSync(pidf, "utf8").trim()); expect(alive(child)).toBe(true); }
    if (how === "endTurn") L.endTurn("s:1"); else if (how === "takeback") L.takeback(keyOf({ pid, windowId: 5, app: "x", title: "" })); else if (how === "stopAll") L.stopAll(); else if (how === "closeAll") L.closeAll();
    expect(await waitDead(pid, 6000)).toBe(true);
    if (child) expect(await waitDead(child, 4000)).toBe(true);
    for (let i = 0; i < 100 && L.facesOf("s:1").length; i++) await tick(20);
    expect(L.facesOf("s:1")).toEqual([]);
    L.closeAll();
  }
}, 120_000);

test("AC-8 二重に起こさない: 同じ持ち主の 2 回目は既存の面を返し、spawn は 1 回だけ・card も出ない", async () => {
  reg("gui");
  const L = mk();
  expect((await launchOk(L) as any).ok).toBe(true);
  const again: any = await L.launchApp("s:1", "gui", ctx());
  expect(again.ok).toBe(true);
  expect(again.text).toContain("既に起きています");
  expect(L.approvals()).toHaveLength(0);
  expect(await waitStarts(1)).toBe(1);
  await tick(150);
  expect(starts()).toBe(1);
  expect(L.facesOf("s:1")).toHaveLength(1);
  L.closeAll(); await settle(L);
});

test("AC-9 前面: 起こす前後の前面の app を比べ、替わったら返事で知らせ log に残す・同じなら黙る", async () => {
  reg("gui");
  let n = 0;
  const A = mk({ front: () => (++n === 1 ? "ASN:orca" : "ASN:gui") });
  const moved: any = await launchOk(A);
  expect(moved.ok).toBe(true);
  expect(moved.text).toContain("前面の app が替わりました");
  expect(moved.text).toContain("ASN:orca → ASN:gui");
  A.closeAll(); await settle(A);
  const B = mk({ front: () => "ASN:orca" });
  const same: any = await launchOk(B, "s:2");
  expect(same.text.includes("前面の app が替わりました")).toBe(false);
  B.closeAll(); await settle(B, "s:2");
});

test("W32 起動を許した turn の間だけ、その app の窓への click（押す先が分からない）はまとめて許す・送信 / Enter / 他の面は従来どおり聞く・turn の終わりで戻る", async () => {
  reg("gui");
  const L = mk();
  await launchOk(L);
  const tok = tokenOf(L.facesOf("s:1")[0]!);
  const c1: any = await L.act(tok, "click", { x: 10, y: 10 });
  expect(c1.ok).toBe(true); // 押す先が分からない click: card 無し
  expect(L.approvals()).toHaveLength(0);
  expect((await L.act(tok, "type_text", { text: "田中" })).ok).toBe(true);
  expect(L.approvals()).toHaveLength(0);
  const enter = L.act(tok, "type_text", { text: "田中\n" }); // 改行は送信になりうる＝聞く
  expect((await card(L)).danger).toBe(true);
  L.answer(L.approvals()[0]!.id, false); await enter;
  const key = L.act(tok, "press_key", { key: "return" });
  expect((await card(L)).danger).toBe(true);
  L.answer(L.approvals()[0]!.id, false); await key;
  // 普通の面（open_app などの窓）は従来どおり: 押す先が分からない click は聞く
  const other = L.give({ pid: 99, windowId: 3, app: "Other", title: "" }, "s:2");
  if (!other.ok) throw new Error();
  const oc = L.act(tokenOf(other.lease), "click", { x: 1, y: 1 });
  expect((await card(L)).danger).toBe(true);
  L.answer(L.approvals()[0]!.id, false); await oc;
  L.endTurn("s:1");
  expect(L.facesOf("s:1")).toEqual([]); // app も面も終わる
  L.closeAll(); await settle(L, "s:2");
});

test("AC-10 登録に app の型が印として入る（run 型と取り違えない）・cmd-list / cmdList に出る", () => {
  const a = reg("gui"), b = reg("tool", ["/bin/echo", "x"], false);
  expect(a.seal).not.toBe(b.seal);
  expect(loadCmds(ui).find((c) => c.name === "gui")!.app).toBe(true);
  const f = join(ui, "commands.json"), j = JSON.parse(readFileSync(f, "utf8"));
  j.items.find((c: any) => c.name === "tool").app = true; // run 型を app に書き換えても印が合わない
  writeFileSync(f, JSON.stringify(j));
  const t = loadCmds(ui).find((c) => c.name === "tool")!;
  const { sealOf } = require("../src/cmds.ts");
  expect(t.seal === sealOf(t)).toBe(false);
});

test("CLI / 案内: cmd-add --app が app 型で登録され cmd-list に（app）と出る・launch は引数を足せない・登録に app が有る時だけ tools に launch:* と案内が出る", async () => {
  const h = join(top, "h"); mkdirSync(h);
  const cli = (...a: string[]) => { const r = Bun.spawnSync(["bun", "src/main.ts", ...a], { env: { ...process.env, KANGAE_HOME: h, KANGAE_OWNER: "" } }); return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }; };
  const add = cli("cmd-add", "gui", "--app", "--cwd", proj, "--", "/bin/sh", "-c", "sleep 1");
  expect(add.code).toBe(0); expect(add.out).toContain("app（GUI");
  expect(cli("cmd-list").out).toContain("gui（app）");
  expect(loadCmds(h).find((c) => c.name === "gui")!.app).toBe(true);
  const extra = Bun.spawnSync(["bun", "src/main.ts", "launch", "gui", "extra"], { env: { ...process.env, KANGAE_HOME: h, KANGAE_OWNER: "s:1" } });
  expect(extra.exitCode).toBe(2);
  expect(extra.stderr.toString()).toContain("kangae launch");
  // tools と案内（fake の claude）
  const { makeHandler } = await import("../src/main.ts");
  const { openStore } = await import("../src/store.ts");
  const run = async (home: string) => {
    const calls: string[][] = [];
    const spawn = (cmd: string[]) => { calls.push(cmd); let done!: (c: number) => void; return { stdout: new ReadableStream<Uint8Array>({ start: () => {} }), exited: new Promise<number>((r) => (done = r)), kill: () => done(143) }; };
    mkdirSync(home, { recursive: true });
    const s = openStore(":memory:");
    const H: any = makeHandler(s, async () => [], undefined, { dir: join(top, "nodes-" + calls.length), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => "http://127.0.0.1:9" }, { uiHome: home });
    const n = s.add(null, "user", "agentA", true);
    const r: any = await H({ op: "workspace", nodeId: n.id, agent: true, text: "go" });
    await H({ op: "stopRun", runId: r.run.id });
    return { tools: calls[0]![calls[0]!.indexOf("--allowedTools") + 1]!, text: calls[0]!.join("\n") };
  };
  const none = await run(join(top, "ui-none"));
  expect(none.tools.includes("launch:*")).toBe(false);
  addCmd(join(top, "ui-app"), "gui", proj, ["/bin/sh", "-c", "sleep 1"], 600, 1, { app: true });
  const withApp = await run(join(top, "ui-app"));
  expect(withApp.tools).toContain("/x/kangae launch:*");
  expect(withApp.tools.includes("run:*")).toBe(false); // app だけなら run:* は出さない
  expect(withApp.text).toContain("人が登録した app（GUI）: gui");
  expect(withApp.text).toContain("launch <名前>");
}, 120_000);
