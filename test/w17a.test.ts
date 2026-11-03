// W17a: 人が登録した command だけを agent が走らせる口（docs/BRIEF-w17.md §5 の AC 1〜11）。読む file を literal で名指す: "src/cmds.ts" "src/lease.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCmd, loadCmds, startCmd } from "../src/cmds.ts";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000); // holes-30: sandbox / process を起こす test は混んだ機械（load 600）で 30 秒を超える＝既定を混み倍率×実測の余裕に

let top: string, ui: string, work: string, proj: string;
const A = { pid: 10, windowId: 1, app: "Zed", title: "" };
const driver = (): Driver => ({ call: async (tool) => ({ text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }), close() {} });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const mk = (o: { approvalMs?: number; mode?: "allow" | "ask" } = {}) => makeLeases(join(top, "lease"), { driver, defaultMode: o.mode ?? "allow", approvalMs: o.approvalMs ?? 3000 });
const face = (L: ReturnType<typeof mk>, owner = "s:1") => { const g = L.give(A, owner); if (!g.ok) throw new Error(); return g.lease; };
const ctx = () => ({ uiHome: ui, workDir: work });
const reg = (name: string, argv: string[], cwd = proj, sec?: number) => { const r = addCmd(ui, name, cwd, argv, sec); if (!r.ok) throw new Error(r.hint); return r.cmd; };
const ask = async (L: ReturnType<typeof mk>, yes: boolean | null) => { for (let i = 0; i < 200 && !L.approvals().length; i++) await tick(); const a = L.approvals()[0]!; if (yes !== null) L.answer(a.id, yes, true); return a; };
const waitFor = async (f: () => boolean, ms = 4000) => { for (const end = Date.now() + ms; !f() && Date.now() < end;) await tick(20); return f(); };

beforeEach(() => {
  top = realpathSync(mktmp("w17a"));
  ui = join(top, "ui"); work = join(top, "work"); proj = join(top, "proj");
  for (const d of [ui, work, proj, join(top, "lease")]) mkdirSync(d);
});
afterEach(() => rmSync(top, { recursive: true, force: true }));

test("AC-1 承認なしに走らない: 答えが来ない間は 0 件・断り / 時間切れで 0 件・「この頼みの間」と答えても次の呼びで再び聞く（表が「許す」でも）", async () => {
  const marker = join(proj, "ran");
  reg("build", ["/usr/bin/touch", marker]);
  const L = mk();
  face(L);
  const p = L.runCmd("s:1", "build", ctx());
  const a = await ask(L, null);
  expect(a).toMatchObject({ tool: "run_cmd", danger: true, what: "登録した「build」を実行します" });
  expect(a.note).toContain(proj);
  expect(a.note).toContain("/usr/bin/touch");
  expect(a.note).toContain("\n実行する行: ");
  expect(a.note).toContain("書けるのは「場所」の中だけ・ネットワーク: なし"); // W17c: sandbox で守る事を card に出す
  await tick(30);
  expect(existsSync(marker)).toBe(false);
  L.answer(a.id, false);
  const r = await p;
  expect(r).toMatchObject({ ok: false, why: "denied" });
  expect((r as any).hint).toContain("登録した物は走っていません");
  expect(existsSync(marker)).toBe(false);
  const T = mk({ approvalMs: 30 });
  face(T);
  const t = await T.runCmd("s:1", "build", ctx());
  expect(t).toMatchObject({ ok: false, why: "timeout" });
  expect(existsSync(marker)).toBe(false);
  // 「この頼みの間」と答えても 1 件だけ・次はまた聞く
  const P = mk();
  face(P);
  const q1 = P.runCmd("s:1", "build", ctx());
  await ask(P, true);
  expect(await q1).toMatchObject({ ok: true });
  const q2 = P.runCmd("s:1", "build", ctx());
  await tick(30);
  expect(P.approvals()).toHaveLength(1);
  P.answer(P.approvals()[0]!.id, false);
  await q2;
});

test("AC-2 名前しか選べない: 登録の無い名前・名前に混ぜた文字は走らない・登録の argv は shell を通らず文字のまま渡る・CLI は引数を足せない", async () => {
  reg("echo", ["/bin/echo", "x;touch pwned && $(touch pwned2)"]);
  const L = mk();
  face(L);
  for (const bad of ["echo; touch pwned", "echo extra", "ECHO", "../echo", "", "no-such"]) {
    const r = await L.runCmd("s:1", bad, ctx());
    expect(r).toMatchObject({ ok: false });
    expect((r as any).hint).toContain("登録されていません");
    expect((r as any).hint).toContain("kangae cmd-add");
  }
  expect(L.approvals()).toHaveLength(0);
  const p = L.runCmd("s:1", "echo", ctx());
  await ask(L, true);
  const r = await p;
  expect(r).toMatchObject({ ok: true, isError: false });
  expect((r as any).text).toContain("x;touch pwned && $(touch pwned2)");
  expect(existsSync(join(proj, "pwned"))).toBe(false);
  expect(existsSync(join(proj, "pwned2"))).toBe(false);
  const cli = Bun.spawnSync(["bun", "src/main.ts", "run", "echo", "extra"], { env: { ...process.env, KANGAE_HOME: join(top, "h") } });
  expect(cli.exitCode).toBe(2);
  expect(cli.stderr.toString()).toContain("引数は足せません");
});

test("AC-3 登録は agent に出来ない: KANGAE_OWNER ありの cmd-add は拒否・tools に cmd-add は無い・登録 0 件か面なしなら run も無い", async () => {
  const h = join(top, "h");
  mkdirSync(h);
  const args = ["bun", "src/main.ts", "cmd-add", "build", "--cwd", proj, "--", "/bin/echo", "hi"];
  const asAgent = Bun.spawnSync(args, { env: { ...process.env, KANGAE_HOME: h, KANGAE_OWNER: "s:1" } });
  expect(asAgent.exitCode).toBe(1);
  expect(existsSync(join(h, "commands.json"))).toBe(false);
  const asHuman = Bun.spawnSync(args, { env: { ...process.env, KANGAE_HOME: h, KANGAE_OWNER: "" } });
  expect(asHuman.exitCode).toBe(0);
  expect(loadCmds(h).map((c) => c.name)).toEqual(["build"]);
  // tools の allowlist
  const calls: string[][] = [];
  const spawn = (cmd: string[]) => { calls.push(cmd); let done!: (c: number) => void; return { stdout: new ReadableStream<Uint8Array>({ start: () => {} }), exited: new Promise<number>((r) => (done = r)), kill: () => done(143) }; };
  const s = openStore(":memory:");
  const H = makeHandler(s, async () => [], undefined,
    { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => "http://127.0.0.1:9" },
    { uiHome: ui, leaseDriver: () => driver() });
  const a = s.add(null, "user", "調べる", true);
  const tools = (i: number) => calls[i]![calls[i]!.indexOf("--allowedTools") + 1]!;
  const r0: any = await H({ op: "workspace", nodeId: a.id, agent: true, text: "go" });
  expect(tools(0)).not.toContain("run:*"); // 登録 0 件
  await H({ op: "stopRun", runId: r0.run.id });
  reg("build", ["/bin/echo", "SECRET-ARGV-WORD"]);
  await H({ op: "resume", rootId: a.id });
  expect(tools(1)).toContain("run:*"); // W23: 登録が在れば面が無い turn にも案内する（走らせるには面が要る＝先に act open_app。常駐が断る）
  await H({ op: "stopRun", runId: (await H({ op: "resume", rootId: a.id }) as any).run?.id });
  expect(((await H({ op: "leaseGive", rootId: a.id, pid: 10, windowId: 1, app: "Zed", title: "" })) as any).ok).toBe(true);
  await H({ op: "resume", rootId: a.id });
  const last = calls.length - 1;
  expect(tools(last)).toContain("kangae run:*".replace("kangae", "/x/kangae"));
  expect(tools(last)).not.toContain("cmd-add");
  expect(calls[last]!.join(" ")).toContain("人が登録した command: build");
  expect(calls[last]!.join(" ")).not.toContain("SECRET-ARGV-WORD"); // 名前だけで argv は載せない
}, 60_000);

test("AC-4 印: 登録の argv を書き換えると走らない", async () => {
  const marker = join(proj, "ran");
  reg("build", ["/bin/echo", "ok"]);
  const f = join(ui, "commands.json");
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.items[0].argv = ["/usr/bin/touch", marker];
  writeFileSync(f, JSON.stringify(j));
  const L = mk();
  face(L);
  const r = await L.runCmd("s:1", "build", ctx());
  expect(r).toMatchObject({ ok: false });
  expect((r as any).hint).toContain("書き換えられています");
  expect(L.approvals()).toHaveLength(0);
  expect(existsSync(marker)).toBe(false);
});

test("AC-4b 承認を待つ間に登録が書き換えられたら、人が見た行と違う物は走らない", async () => {
  const marker = join(proj, "ran");
  reg("build", ["/bin/echo", "ok"]);
  const L = mk();
  face(L);
  const p = L.runCmd("s:1", "build", ctx());
  const a = await ask(L, null);
  const f = join(ui, "commands.json"), j = JSON.parse(readFileSync(f, "utf8"));
  j.items[0].argv = ["/usr/bin/touch", marker];
  writeFileSync(f, JSON.stringify(j));
  L.answer(a.id, true);
  const r: any = await p;
  expect(r).toMatchObject({ ok: false });
  expect(r.hint).toContain("承認を待つ間に替わりました");
  expect(existsSync(marker)).toBe(false);
});

test("AC-5 場所が uiHome の中（またはそれを含む）なら走らない（symlink 越しも）。card も出ない／作業場所と重なる場所は断られない（W37・user 承認済み: 登録した場所は agent が直接編集してよい）", async () => {
  const L = mk();
  face(L);
  mkdirSync(join(work, "sub")); mkdirSync(join(ui, "sub"));
  symlinkSync(ui, join(top, "uilink"));
  for (const cwd of [ui, join(ui, "sub"), join(top, "uilink"), top]) { // top は uiHome を含む
    reg("build", ["/bin/echo", "x"], cwd);
    const r = await L.runCmd("s:1", "build", ctx());
    expect(r).toMatchObject({ ok: false });
    expect((r as any).hint).toContain("Kangae の置き場");
  }
  expect(L.approvals()).toHaveLength(0);
  symlinkSync(work, join(top, "link"));
  for (const cwd of [work, join(work, "sub"), join(top, "link")]) { // 対照: 作業場所と重なっても card が出る
    reg("build", ["/bin/echo", "x"], cwd);
    const p = L.runCmd("s:1", "build", ctx());
    await ask(L, false);
    expect(await p).toMatchObject({ ok: false, why: "denied" });
  }
  expect(L.approvals()).toHaveLength(0);
});

test("AC-6 env: KANGAE_* や token を渡さない（固定の最小だけ）", async () => {
  process.env.KANGAE_SECRET_TEST = "leak-me"; process.env.OPENAI_API_KEY = "sk-leak";
  try {
    reg("env", ["/usr/bin/env"]);
    const L = mk();
    face(L);
    const p = L.runCmd("s:1", "env", ctx());
    await ask(L, true);
    const r: any = await p;
    expect(r.ok).toBe(true);
    const full = readFileSync(/全文（Read で読めます）: (.*)$/.exec(r.text)![1]!, "utf8");
    expect(full).toContain("PATH=/usr/bin:/bin");
    expect(full).not.toContain("leak-me");
    expect(full).not.toContain("sk-leak");
    expect(full).not.toContain("KANGAE_");
  } finally { delete process.env.KANGAE_SECRET_TEST; delete process.env.OPENAI_API_KEY; }
});

test("AC-7 返事: exit code・末尾 20 行・全文 file は shots の中・turn の終わりに消える。失敗は isError。時間と出力の上限で止まる", async () => {
  reg("many", ["/bin/sh", "-c", "i=1; while [ $i -le 50 ]; do echo line$i; i=$((i+1)); done; exit 3"]);
  const L = mk();
  face(L);
  const p = L.runCmd("s:1", "many", ctx());
  await ask(L, true);
  const r: any = await p;
  expect(r).toMatchObject({ ok: true, isError: true });
  expect(r.text).toContain("exit 3");
  expect(r.text).toContain("line50");
  expect(r.text).not.toContain("line20\n");
  const file = /全文（Read で読めます）: (.*)$/.exec(r.text)![1]!;
  expect(file.startsWith(join(realpathSync(ui), "win"))).toBe(true); // review18: 出力は会話ごとの置き場（shots は全会話が Read できる）
  expect(readFileSync(file, "utf8")).toContain("line1\n");
  L.endTurn("s:1");
  expect(existsSync(file)).toBe(false);
  // 上限（startCmd を直に）
  const c = (argv: string[]) => ({ name: "t", cwd: proj, argv, timeoutSec: 600, at: 0, seal: "" });
  const slow = await startCmd(c(["/bin/sleep", "30"]), join(top, "o1"), { timeoutMs: 200 }).done;
  expect(slow).toMatchObject({ why: "timeout", code: null });
  const big = await startCmd(c(["/usr/bin/yes"]), join(top, "o2"), { maxBytes: 50_000 }).done;
  expect(big.why).toBe("big");
});

test("AC-8 面が取り戻される / turn が終わる / 全停止: 走っている間に起きたら process group ごと止まる（子の sleep まで）", async () => {
  for (const how of ["takeback", "endTurn", "stopAll"] as const) {
    const pidf = join(proj, `pid-${how}`);
    reg("hang", ["/bin/sh", "-c", `sleep 60 & echo $! > ${pidf}; wait`]);
    const L = mk();
    const l = face(L);
    const p = L.runCmd("s:1", "hang", ctx());
    await ask(L, true);
    expect(await waitFor(() => existsSync(pidf) && readFileSync(pidf, "utf8").trim() !== "")).toBe(true);
    const child = Number(readFileSync(pidf, "utf8").trim());
    expect(() => process.kill(child, 0)).not.toThrow(); // 走っている
    if (how === "takeback") L.takeback(`${A.pid}:${A.windowId}`); else if (how === "endTurn") L.endTurn("s:1"); else L.stopAll();
    const r: any = await p;
    expect(r).toMatchObject({ ok: false, why: "gen" });
    expect(r.hint).toContain("止めました");
    expect(await waitFor(() => { try { process.kill(child, 0); return false; } catch { return true; } })).toBe(true);
    void l;
  }
});

test("AC-9 断りの文はそれぞれ違い、人がする事が 1 行ある: 未登録 / 面なし / 走らせ中", async () => {
  reg("slow", ["/bin/sleep", "5"]);
  const L = mk();
  const none: any = await L.runCmd("s:9", "slow", ctx());
  expect(none.hint).toContain("面");
  face(L);
  const un: any = await L.runCmd("s:1", "nope", ctx());
  expect(un.hint).toContain("kangae cmd-add");
  expect(un.hint).toContain("登録済み: slow");
  const p = L.runCmd("s:1", "slow", ctx());
  await ask(L, true);
  await tick(50);
  const busy: any = await L.runCmd("s:1", "slow", ctx());
  expect(busy.hint).toContain("別の command が走っています");
  L.takeback(`${A.pid}:${A.windowId}`);
  await p;
});

test("AC-11 窓も前面も触らない: spawn は argv をそのまま・detached・stdin 無し。open / osascript / shell を呼ばない（source の確認）", () => {
  const src = readFileSync("src/cmds.ts", "utf8");
  expect(src).toContain('stdin: "ignore"');
  expect(src).toContain("detached: true");
  expect(src.includes("...c.argv")).toBe(true); // argv は登録のまま（sandbox の頭の後ろ）
  expect(src.split("Bun.spawnSync(").length - 1).toBe(3); // 同期で回すのは sandbox の自己検査（起動と守りの確認）2 か所と、走りの後始末の ps 1 か所だけ
  for (const w of ["osascript", '"open"', "/bin/sh", "sh -c", "shell: true", "execSync"]) expect(src.includes(w)).toBe(false);
  expect(readdirSync(top).length).toBeGreaterThan(0);
});

test("AC-12 初めて使う人の文言: 空の一覧・登録の成功・error・拒否のどれにも次の一手が 1 行あり、専門語（argv・seal・process）を出さない", () => {
  const h = join(top, "h12");
  mkdirSync(h);
  const cli = (...a: string[]) => { const r = Bun.spawnSync(["bun", "src/main.ts", ...a], { env: { ...process.env, KANGAE_HOME: h, KANGAE_OWNER: "" } }); return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }; };
  const jargon = /argv|seal|process|印|stdin|spawn/;
  const empty = cli("cmd-list");
  expect(empty.out).toContain("まだ何も登録していません");
  expect(empty.out).toContain("kangae cmd-add build --cwd");
  const noDir = cli("cmd-add", "build", "--cwd", join(top, "nope"), "--", "/bin/echo");
  expect(noDir.code).toBe(1);
  expect(noDir.err).toContain("--cwd ~/my-project");
  const usage = cli("cmd-add", "build");
  expect(usage.code).toBe(2);
  expect(usage.err).toContain("例:");
  const ok = cli("cmd-add", "build", "--cwd", proj, "--", "/bin/echo", "hi");
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("承認の card が出ます");
  expect(ok.out).toContain("kangae cmd-rm build");
  expect(cli("cmd-list").out).toContain("実行する行: /bin/echo hi");
  const rm = cli("cmd-rm", "zzz");
  expect(rm.code).toBe(1);
  expect(rm.err).toContain("kangae cmd-list");
  expect(cli("cmd-add", "Bad Name", "--cwd", proj, "--", "/bin/echo").err).toContain("英小文字");
  for (const t of [empty.out, noDir.err, usage.err, ok.out, rm.err]) expect(t).not.toMatch(jargon);
}, 120_000); // CLI を 8 回起こす＝混雑（load 300）で 35 秒かかった実測。締切は実の時間に合わせる
