// review21: W17c-b（--network / --read）を攻める。実際に sandbox-exec を回す（画面は出ない）
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_MAX, SANDBOX, addCmd, checkReads, loadCmds, sealOf, startCmd, type Cmd } from "../src/cmds.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000); // holes-30: sandbox / process を起こす test は混んだ機械（load 600）で 30 秒を超える＝既定を混み倍率×実測の余裕に

let top: string, proj: string, outDir: string, home: string, n = 0;
const run = async (c: Partial<Cmd>, script: string, lim: Parameters<typeof startCmd>[2] = {}) => {
  const out = join(outDir, `o${n++}.txt`);
  const r = startCmd({ name: "t", cwd: proj, argv: ["/bin/sh", "-c", script], timeoutSec: 30, at: 0, seal: "", ...c }, out, lim);
  const ran = await r.done;
  return { ran, text: readFileSync(out, "utf8"), out };
};
beforeEach(() => {
  top = realpathSync(mktmp("r21"));
  proj = join(top, "proj"); outDir = join(top, "out"); home = join(top, "home");
  for (const d of [proj, outDir, join(home, ".ssh"), join(home, ".kangae"), join(home, "Library/Keychains"), join(home, ".cargo"), join(home, "Library")]) mkdirSync(d, { recursive: true }); // rules-ok: temp の home の下（本物の home は読まない）
});
afterEach(() => { rmSync(top, { recursive: true, force: true }); SANDBOX.bin = "/usr/bin/sandbox-exec"; });

test("① --read: 鍵・token・keychain の場所とその親（~/.ssh ~/.kangae ~/Library …）は、末尾スラッシュ・symlink・大小文字・.. でも戻せない。道具の置き場（~/.cargo）は通る", () => { // rules-ok: temp の home の下（本物の home は読まない）
  for (const d of [".ssh", ".ssh/", ".kangae", "Library", "Library/Keychains", ".SSH", ".cargo/../.ssh", "."]) { // rules-ok: temp の home の下（本物の home は読まない）
    const r = checkReads([join(home, d)], home);
    expect(r.ok, d).toBe(false);
  }
  symlinkSync(join(home, ".ssh"), join(top, "lnk"));
  expect(checkReads([join(top, "lnk")], home).ok).toBe(false);
  expect(checkReads(["/usr/share"], home)).toMatchObject({ ok: true }); // 道具の置き場は通る（この試験の home は /var/folders の下＝それ自体が守りの下なので、~/.cargo の代わりに /usr/share）
});

test("① --read: 守っている場所・広すぎる場所（/ /Users home /System/Volumes の firmlink）を戻せない・8 個を超えられない（別の綴りで水増ししても同じ数）", () => {
  for (const d of ["/", "/Users", "/Volumes", "/private", "/private/tmp", "/tmp", "/var", "/var/folders", "/Library", "/Library/Keychains", "/private/var/log", "/System/Volumes/Data", "/System/Volumes/Data/private/tmp"]) expect(checkReads([d]).ok, d).toBe(false);
  const many = readdirSync("/usr/share", { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join("/usr/share", e.name)).slice(0, READ_MAX + 1); // 守りの下ではない実在の folder
  expect(many.length).toBe(READ_MAX + 1);
  expect(checkReads(many).ok).toBe(false);
  expect(checkReads(many.slice(0, READ_MAX)).ok).toBe(true);
  expect(checkReads(["/System/Volumes/Data/Users/Shared"])).toMatchObject({ ok: true, reads: ["/Users/Shared"] }); // firmlink 越しは /Users 側の綴りに直る（sandbox が効く綴り）
  expect(checkReads([...many.slice(0, 2), ...many.slice(0, 2).map((d) => d + "/")])).toMatchObject({ ok: true }); // 同じ場所の別綴りは 1 つに数える
});

test("② --network: 外へは繋がる（対照）が、常駐ではない unix socket（ssh-agent・docker 相当）と localhost の TCP には繋がらない", async () => {
  const hits: string[] = [];
  const usock = join(top, "agent.sock");
  const ul = Bun.listen({ unix: usock, socket: { open(s) { hits.push("unix"); s.end(); }, data() {} } });
  const tl = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { hits.push("tcp"); s.end(); }, data() {} } });
  try {
    const net = { network: true } as const, lim = { sock: join(top, "daemon.sock") };
    await run(net, `/usr/bin/nc -U '${usock}' </dev/null 2>&1`, lim);
    await run(net, `/usr/bin/nc 127.0.0.1 ${tl.port} </dev/null 2>&1`, lim);
    await Bun.sleep(100);
    expect(hits).toEqual([]);
    const outside = Bun.spawnSync(["/usr/bin/curl", "-s", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"]).stdout.toString();
    if (outside === "200") expect((await run(net, "/usr/bin/curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com", lim)).text.trim()).toBe("200"); // 通信を許した command は外へ出られる（DNS も通る）
    // 通信なしの登録は、外にも出られない
    expect((await run({}, "/usr/bin/curl -s -m 4 -o /dev/null -w '%{http_code}' https://example.com; echo rc=$?")).text).not.toContain("200");
  } finally { ul.stop(true); tl.stop(true); }
}, 60_000);

test("② --network でも env に token / 鍵は渡らず、HOME は走りごとの tmp（人の home の設定・cache を読まない）", async () => {
  const seed = { KANGAE_LEASE: "lease-xyz", BW_SESSION: "bw-xyz", NPM_TOKEN: "npm-xyz", AWS_SECRET_ACCESS_KEY: "aws-xyz", SSH_AUTH_SOCK: "/tmp/agent" };
  const was = Object.fromEntries(Object.keys(seed).map((k) => [k, process.env[k]]));
  Object.assign(process.env, seed);
  try {
    const r = await run({ network: true }, "/usr/bin/env", { sock: join(top, "d.sock") });
    for (const [k, v] of Object.entries(seed)) { expect(r.text).not.toContain(`${k}=`); expect(r.text).not.toContain(v); }
    expect(r.text).toMatch(new RegExp(`^HOME=${outDir}/tmp-`, "m"));
  } finally { for (const [k, v] of Object.entries(was)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
});

test("③ 登録の印: network / reads を片方だけ書き換えても（足す・消す・入れ替える）印が合わなくなる", () => {
  const base = { name: "b", cwd: "/x", argv: ["/bin/echo"], timeoutSec: 60 };
  const plain = sealOf(base), net = sealOf({ ...base, network: true }), rd = sealOf({ ...base, reads: ["/a"] }), both = sealOf({ ...base, network: true, reads: ["/a"] });
  expect(new Set([plain, net, rd, both]).size).toBe(4);
  expect(sealOf({ ...base, reads: ["/b"] })).not.toBe(rd);
  expect(sealOf({ ...base, network: true, reads: [] })).toBe(net); // 空の reads は付けないのと同じ
  expect(sealOf({ ...base, network: false })).toBe(plain);
});

test("③ 保存された登録の network / reads を後から書き換えると loadCmds の印が合わない（片方だけ・両方）", () => {
  const ui = join(top, "ui"); mkdirSync(ui);
  const r = addCmd(ui, "b", proj, ["/bin/echo", "x"], 60, 0, { network: true, reads: [join(home, ".cargo")].filter(() => false) });
  expect(r.ok).toBe(true);
  const f = join(ui, "commands.json"), j = JSON.parse(readFileSync(f, "utf8"));
  const ok = (m: (c: any) => void) => { const k = JSON.parse(JSON.stringify(j)); m(k.items[0]); writeFileSync(f, JSON.stringify(k)); const c = loadCmds(ui)[0]!; return c.seal === sealOf(c); };
  expect(ok(() => {})).toBe(true);
  expect(ok((c) => { delete c.network; })).toBe(false); // 通信を消す
  expect(ok((c) => { c.reads = ["/Users/Shared"]; })).toBe(false); // 読みを足す
  expect(ok((c) => { c.network = false; c.reads = ["/etc"]; })).toBe(false); // 入れ替える
});

test("⑤ HOME / TMPDIR の走りごとの tmp は、終わり・時間切れの後に残らず、会話ごとの置き場（out の隣）にあり、他の走りと別", async () => {
  const a = await run({}, 'echo "$HOME $TMPDIR"; sleep 0');
  const [h, t] = a.text.trim().split(" ");
  expect(h).toBe(t);
  expect(h!.startsWith(outDir + "/tmp-")).toBe(true);
  expect(existsSync(h!)).toBe(false); // 終わりに消えた
  const b = await run({}, 'echo "$HOME"; sleep 30', { timeoutMs: 800 });
  expect(b.ran.why).toBe("timeout");
  expect(readdirSync(outDir).filter((x) => x.startsWith("tmp-"))).toEqual([]);
  const c = await run({}, 'echo "$HOME"');
  expect(c.text.trim()).not.toBe(h);
});

import { makeLeases } from "../src/lease.ts";
test("② card: 通信を許した登録には「ネットワーク: あり」が必ず出る・許していない登録には「なし」・--read の場所も出る", async () => {
  const ui = join(top, "ui"), work = join(top, "work"), lease = join(top, "lease");
  for (const d of [ui, work, lease]) mkdirSync(d);
  const note = async (name: string, opts: { network?: boolean; reads?: string[] }) => {
    const r = addCmd(ui, name, proj, ["/bin/echo", "x"], 60, 0, opts);
    expect(r.ok).toBe(true);
    const L = makeLeases(lease, { driver: () => ({ call: async (t) => ({ text: "ok", isError: false, data: t === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }), close() {} }), defaultMode: "allow", approvalMs: 2000 });
    const g = L.give({ pid: 10, windowId: 1, app: "Zed", title: "" }, "s:1"); if (!g.ok) throw 0;
    const p = L.runCmd("s:1", name, { uiHome: ui, workDir: work });
    for (let i = 0; i < 100 && !L.approvals().length; i++) await Bun.sleep(5);
    const a = L.approvals()[0]!;
    L.answer(a.id, false);
    await p;
    return a.note ?? "";
  };
  expect(await note("plain", {})).toContain("ネットワーク: なし");
  const withNet = await note("net", { network: true });
  expect(withNet).toContain("ネットワーク: あり");
  expect(withNet).not.toContain("ネットワーク: なし");
  expect(await note("rd", { reads: ["/usr/share"] })).toContain("/usr/share");
});
