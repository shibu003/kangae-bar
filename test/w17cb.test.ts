// W17c-b: 登録に --network（既定なし）と --read <dir>（読みだけ戻す）を足す。印に入る・card に出る・測って通らない道具は登録の時に「未対応」と言う（docs/BRIEF-w17c.md §3・probe は docs/verify/w17cb/probe.md）。読む file を literal で名指す: "src/cmds.ts" "src/lease.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { addCmd, checkReads, loadCmds, sealOf, startCmd, unsupported, type Cmd } from "../src/cmds.ts";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000); // holes-30: sandbox / process を起こす test は混んだ機械（load 600）で 30 秒を超える＝既定を混み倍率×実測の余裕に

let top: string, ui: string, proj: string, outDir: string, homeDir: string;
const A = { pid: 10, windowId: 1, app: "Zed", title: "" };
const driver = (): Driver => ({ call: async (tool) => ({ text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }), close() {} });
const cmd = (argv: string[], o: Partial<Cmd> = {}): Cmd => ({ name: "t", cwd: proj, argv, timeoutSec: 600, at: 0, seal: "", ...o });
let n = 0;
const run = async (c: Cmd, lim: Parameters<typeof startCmd>[2] = {}) => { const out = join(outDir, `o${n++}.txt`); const ran = await startCmd(c, out, lim).done; return { ran, text: readFileSync(out, "utf8") }; };
const sh = (script: string, o: Partial<Cmd> = {}, lim = {}) => run(cmd(["/bin/sh", "-c", script], o), lim);

beforeEach(() => {
  top = realpathSync(mktmp("w17cb"));
  ui = join(top, "ui"); proj = join(top, "proj"); outDir = join(top, "out");
  for (const d of [ui, proj, outDir]) mkdirSync(d);
  homeDir = join(homedir(), `.w17cb-${process.pid}-${Date.now()}`);
  mkdirSync(homeDir);
});
afterEach(() => { rmSync(top, { recursive: true, force: true }); rmSync(homeDir, { recursive: true, force: true }); });

test("W17cb-1 --read: 在る folder の realpath だけ・ホーム全体 / /Users / / は広すぎて断る・重複は 1 つ・9 個以上は断る", () => {
  const a = join(homeDir, "tools"); mkdirSync(a);
  expect(checkReads([a, a])).toEqual({ ok: true, reads: [a] });
  for (const bad of [homedir(), "/Users", "/Volumes", "/"]) { const r = checkReads([bad]); expect(r.ok).toBe(false); expect((r as any).hint).toContain("広すぎます"); }
  expect((checkReads([join(homeDir, "nope")]) as any).hint).toContain("見つかりません");
  expect((checkReads(Array.from({ length: 9 }, () => a)).ok)).toBe(true); // 重複は畳まれる
  const many = Array.from({ length: 9 }, (_, i) => { const d = join(homeDir, `d${i}`); mkdirSync(d); return d; });
  expect(checkReads(many).ok).toBe(false);
});

test("W17cb-2 印: 付けない登録の印は今までと同じ・--network / --read を付けると印が変わり、commands.json を書き換えて足しても走らない", () => {
  const plain = addCmd(ui, "p", proj, ["/bin/echo", "x"], 600, 1);
  if (!plain.ok) throw new Error(plain.hint);
  expect(plain.cmd.seal).toBe(sealOf({ name: "p", cwd: proj, argv: ["/bin/echo", "x"], timeoutSec: 600 }));
  expect("network" in plain.cmd).toBe(false);
  const net = addCmd(ui, "n", proj, ["/bin/echo", "x"], 600, 1, { network: true });
  const rd = addCmd(ui, "r", proj, ["/bin/echo", "x"], 600, 1, { reads: [homeDir] });
  if (!net.ok || !rd.ok) throw new Error("add");
  expect(new Set([plain.cmd.seal, net.cmd.seal, rd.cmd.seal]).size).toBe(3);
  // commands.json を直接書き換えて network を足す（印は据え置き）→ 印が合わない
  const f = join(ui, "commands.json"), j = JSON.parse(readFileSync(f, "utf8"));
  j.items.find((c: any) => c.name === "p").network = true;
  writeFileSync(f, JSON.stringify(j));
  const p = loadCmds(ui).find((c) => c.name === "p")!;
  expect(p.seal === sealOf(p)).toBe(false);
});

test("W17cb-3 登録の時に「未対応」と次の一手を言う: swift build / xcodebuild / cargo（--offline と --read なし）/ npm install（--network なし）/ yarn。保存もされない", () => {
  const add = (argv: string[], o: { network?: boolean; reads?: string[] } = {}) => addCmd(ui, "x", proj, argv, 600, 1, o);
  const swift = add(["/usr/bin/swift", "build"]); expect(swift.ok).toBe(false); expect((swift as any).hint).toContain("swiftc");
  expect((add(["/usr/bin/xcodebuild", "-project", "a"]) as any).hint).toContain("未対応");
  const home = realpathSync(homedir());
  const cargo = "/usr/local/opt/rustup/bin/cargo";
  if (existsSync(cargo)) {
    expect((add([cargo, "build"]) as any).hint).toContain("--offline");
    expect((add([cargo, "build", "--offline"]) as any).hint).toContain("--read ~/.rustup --read ~/.cargo");
  }
  expect((unsupported(["/usr/local/bin/npm", "install"], { network: false, reads: [] }) as string)).toContain("--network");
  expect(unsupported(["/usr/local/bin/npm", "install"], { network: true, reads: [] })).toBeNull();
  expect(unsupported(["/usr/local/bin/npm", "run", "build"], { network: false, reads: [] })).toBeNull(); // 依存なしの script は通った（probe）
  expect(unsupported(["/usr/local/bin/pnpm", "i"], { network: false, reads: [] })).toContain("--network");
  expect(unsupported(["/usr/local/bin/yarn", "install"], { network: true, reads: [] })).toContain("未測");
  expect(unsupported(["/usr/bin/swiftc", "a.swift"], { network: false, reads: [] })).toBeNull(); // 1 ファイルの swiftc は通った（probe）
  expect(unsupported(["/usr/bin/cmake", "--build", "b"], { network: false, reads: [] })).toBeNull();
  expect(unsupported(["/x/cargo", "build", "--offline"], { network: false, reads: [join(home, ".rustup"), join(home, ".cargo")] })).toBeNull();
  expect(loadCmds(ui)).toEqual([]);
});

test("W17cb-4 --read: 戻した folder だけ読める（戻さない folder は読めない）・書きは広げない（戻した folder にも書けない）", async () => {
  const tools = join(homeDir, "tools"), other = join(homeDir, "other");
  mkdirSync(tools); mkdirSync(other);
  writeFileSync(join(tools, "t.txt"), "TOOL"); writeFileSync(join(other, "o.txt"), "OTHER");
  const r = await sh(`cat '${tools}/t.txt' 2>&1; cat '${other}/o.txt' 2>&1; echo x > '${tools}/w' 2>&1`, { reads: [realpathSync(tools)] });
  expect(r.text.includes("TOOL")).toBe(true);
  expect(r.text.includes("OTHER")).toBe(false);
  expect(existsSync(join(tools, "w"))).toBe(false);
  expect(r.text.includes("Operation not permitted")).toBe(true);
});

test("W17cb-5 --network: 常駐の unix socket も localhost の TCP も塞いだまま（外への 443 / 80 だけ開く＝test/review21.test.ts）・socket の場所が分からない時は走らせない", async () => {
  const sock = join(top, "d.sock");
  const srv = Bun.listen({ unix: sock, socket: { data(s) { s.write("pong"); }, open() {} } });
  const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(s) { s.write("pong"); }, open() {} } });
  try {
    const c = { network: true };
    const t = await sh(`echo hi | /usr/bin/nc -w 2 127.0.0.1 ${tcp.port} 2>&1`, c, { sock });
    expect(t.text.includes("pong")).toBe(false); // review21: localhost の TCP（人の PC の他の service）には出ない。外への通信は 443 / 80 / 53 だけ
    const u = await sh(`echo hi | /usr/bin/nc -U -w 2 '${sock}' 2>&1`, c, { sock });
    expect(u.text.includes("pong")).toBe(false);
    expect(() => startCmd(cmd(["/usr/bin/true"], c), join(outDir, "never.txt"))).toThrow("socket");
    expect(existsSync(join(outDir, "never.txt"))).toBe(false);
  } finally { srv.stop(true); tcp.stop(true); }
});

test("W17cb-6 HOME は走りごとの tmp: 道具の cache・設定が人の home に出来ない（TMPDIR と同じ・書ける）", async () => {
  const r = await sh('echo "$HOME|$TMPDIR"; mkdir -p "$HOME/.cache/x" && echo ok > "$HOME/.cache/x/f" && cat "$HOME/.cache/x/f"');
  const [h, t] = r.text.split("\n")[0]!.split("|");
  expect(h).toBe(t);
  expect(h!.startsWith(outDir)).toBe(true);
  expect(r.text.includes("ok")).toBe(true);
  expect(existsSync(join(homedir(), ".cache/x/f"))).toBe(false);
});

test("W17cb-7 道具の置き場を --read した時だけ RUSTUP_HOME / CARGO_HOME がその場所を指す", async () => {
  const home = realpathSync(homedir()), ru = join(home, ".rustup"), ca = join(home, ".cargo");
  if (!existsSync(ru) || !existsSync(ca)) return; // rustup が無い機械では飛ばす
  const on = await run(cmd(["/usr/bin/env"], { reads: [ca, ru] }));
  expect(on.text.includes(`RUSTUP_HOME=${ru}`)).toBe(true);
  expect(on.text.includes(`CARGO_HOME=${ca}`)).toBe(true);
  const off = await run(cmd(["/usr/bin/env"]));
  expect(off.text.includes("RUSTUP_HOME")).toBe(false);
});

test("W17cb-8 card に出る: ネットワーク あり/なし・読めるフォルダ。印が変わると承認を待つ間の書き換えは走らない", async () => {
  const L = makeLeases(join(top, "lease"), { driver, defaultMode: "allow", approvalMs: 3000 });
  mkdirSync(join(top, "lease"), { recursive: true });
  const g = L.give(A, "s:1"); if (!g.ok) throw new Error();
  void tokenOf;
  const tools = join(homeDir, "tools"); mkdirSync(tools);
  const r1 = addCmd(ui, "net", proj, ["/bin/echo", "hi"], 600, 1, { network: true, reads: [tools] });
  const r0 = addCmd(ui, "plain", proj, ["/bin/echo", "hi"], 600, 1);
  if (!r1.ok || !r0.ok) throw new Error("add");
  const ctx = { uiHome: ui, workDir: join(top, "work"), sock: join(top, "d.sock") };
  mkdirSync(ctx.workDir);
  const p0 = L.runCmd("s:1", "plain", ctx);
  for (let i = 0; i < 200 && !L.approvals().length; i++) await Bun.sleep(5);
  expect(L.approvals()[0]!.note).toContain("ネットワーク: なし");
  expect(L.approvals()[0]!.note).toContain("読めません");
  L.answer(L.approvals()[0]!.id, false); await p0;
  const p1 = L.runCmd("s:1", "net", ctx);
  for (let i = 0; i < 200 && !L.approvals().length; i++) await Bun.sleep(5);
  const note = L.approvals()[0]!.note!;
  expect(note).toContain("ネットワーク: あり");
  expect(note).toContain(`読めるのは「場所」と ${realpathSync(tools)}`);
  // 承認を待つ間に network を落とす（印は据え置き）→ 走らせない
  const f = join(ui, "commands.json"), j = JSON.parse(readFileSync(f, "utf8"));
  j.items.find((c: any) => c.name === "net").network = false;
  writeFileSync(f, JSON.stringify(j));
  L.answer(L.approvals()[0]!.id, true);
  const out: any = await p1;
  expect(out.ok).toBe(false);
});

test("W17cb-9 CLI: --network / --read を付けて登録でき、cmd-list に出る・未対応は exit 1 で次の一手・--read の広すぎるのは断る", () => {
  const h = join(top, "h"); mkdirSync(h);
  const cli = (...a: string[]) => { const r = Bun.spawnSync(["bun", "src/main.ts", ...a], { env: { ...process.env, KANGAE_HOME: h, KANGAE_OWNER: "" } }); return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }; };
  const tools = join(homeDir, "tools"); mkdirSync(tools);
  const ok = cli("cmd-add", "fetch", "--cwd", proj, "--network", "--read", tools, "--", "/bin/echo", "hi");
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("ネットワーク: あり");
  expect(ok.out).toContain(realpathSync(tools));
  const list = cli("cmd-list").out;
  expect(list).toContain("ネットワーク: あり");
  expect(list).toContain("読みを許す所:");
  const plain = cli("cmd-add", "plain", "--cwd", proj, "--", "/bin/echo", "hi");
  expect(plain.out).toContain("ネットワーク: なし");
  const sw = cli("cmd-add", "sw", "--cwd", proj, "--", "/usr/bin/swift", "build");
  expect(sw.code).toBe(1);
  expect(sw.err).toContain("swiftc");
  const wide = cli("cmd-add", "wide", "--cwd", proj, "--read", homedir(), "--", "/bin/echo");
  expect(wide.code).toBe(1);
  expect(wide.err).toContain("広すぎます");
  expect(loadCmds(h).map((c) => c.name).sort()).toEqual(["fetch", "plain"]);
}, 120_000);

test("W17cb-10 review20 の守りは --read / --network でも残る: --read しても System.keychain・/private/tmp は読めない・守っている場所と重なる --read は断る・network でも他の process へ signal を送れない", async () => {
  const tools = join(homeDir, "tools"); mkdirSync(tools); writeFileSync(join(tools, "t.txt"), "TOOL");
  const kc = "/Library/Keychains/System.keychain";
  const r = await sh(`cat '${tools}/t.txt' 2>&1; head -c 4 '${kc}' 2>&1; ls /private/tmp 2>&1 | head -1`, { reads: [realpathSync(tools)] });
  expect(r.text.includes("TOOL")).toBe(true); // --read した所は読める
  if (existsSync(kc)) expect(r.text.includes("Operation not permitted")).toBe(true);
  expect(r.text.split("Operation not permitted").length - 1).toBeGreaterThanOrEqual(existsSync(kc) ? 2 : 1); // keychain と /private/tmp
  for (const bad of ["/Library", "/Library/Keychains", "/private/var", "/private/tmp", "/private/var/log", "/private/var/folders"]) {
    const c = checkReads([bad]);
    expect(c.ok).toBe(false);
  }
  // network でも signal は送れない
  const victim = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    await sh(`kill -9 ${victim.pid} 2>&1`, { network: true }, { sock: join(top, "d.sock") });
    await Bun.sleep(100);
    expect(() => process.kill(victim.pid, 0)).not.toThrow();
  } finally { victim.kill(9); }
});
