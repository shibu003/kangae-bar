// review15 の攻撃: W8g-5（拡張の口の確かめ）と ruleslint。本物の Chrome・金庫・人の profile には触らない（偽の browser = この試験の bun とその ad-hoc の複製）
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT_ORIGIN, makeHandler } from "../src/main.ts";
import { browserHost, fileSigner, lastSwitch, runningSigner } from "../src/peer.ts";
import { openStore } from "../src/store.ts";
import { lint } from "../tools/rules-lint";

const bun = process.execPath;

// 偽の browser（exe で mid を走らせる）が host を起こし、host が socket に繋ぐ
async function connectVia(exe: string, midArgs: string[], allow: (fd: number) => ReturnType<typeof browserHost>) {
  const d = mktmp("r15");
  const sock = join(d, "s.sock");
  const got = new Promise<Awaited<ReturnType<typeof browserHost>>>((res) => {
    const srv = Bun.listen({ unix: sock, socket: { open(s) { res(allow((s as unknown as { fd: number }).fd)); srv.stop(true); }, data() {} } });
  });
  const host = join(d, "host.ts"), mid = join(d, "mid.ts");
  writeFileSync(host, `await Bun.connect({ unix: ${JSON.stringify(sock)}, socket: { data() {} } }); await Bun.sleep(30000);`);
  writeFileSync(mid, `const p = Bun.spawn([${JSON.stringify(bun)}, ${JSON.stringify(host)}, ${JSON.stringify(EXT_ORIGIN)}]); await p.exited;`);
  const p = Bun.spawn([exe, mid, ...midArgs], { stdout: "ignore", stderr: "ignore" });
  try { return await got; } finally { p.kill(); }
}

// --- 1. 自動更新: 比べるのは cdhash（版ごとに変わる）ではなく署名の主（Team ID / Identifier）
test("署名の主: 走っている bun と置いてある bun が同じ主（Team の付いた署名）", async () => {
  const me = runningSigner(process.pid);
  expect(me).toMatch(/^[A-Z0-9]{10}\/\S+$/);
  expect(await fileSigner(bun)).toBe(me!);
});

test("Team の無い署名（ad-hoc の複製）の browser は、決まった browser の一覧に在っても断る", async () => {
  const d = mktmp("r15-adhoc"), x = join(d, "bun");
  copyFileSync(bun, x);
  expect((await Bun.spawn(["/usr/bin/codesign", "-fs", "-", x], { stderr: "ignore" }).exited)).toBe(0);
  expect(await fileSigner(x)).toBeNull();
  const r = await connectVia(x, [], (fd) => browserHost(fd, { browsers: [x], profiles: [], origin: EXT_ORIGIN }));
  expect(r.ok).toBe(false);
  expect(r.why).toContain("決まった browser ではない");
}, 300_000); // 複製した binary の初回の起動は OS の検査で数秒〜（load 570 の機械で 60 秒を超えた実測＝締切は実の時間に）

// --- 2. profile: Chromium と同じ読み（後勝ち・- 1 つ・-- の後は switch でない・値の無い switch）
test("lastSwitch は Chromium の読み方", () => {
  expect(lastSwitch(["chrome", "--user-data-dir=/a", "--user-data-dir=/b"], "user-data-dir")).toBe("/b");
  expect(lastSwitch(["chrome", "-user-data-dir=/evil"], "user-data-dir")).toBe("/evil");
  expect(lastSwitch(["chrome", "--user-data-dir=/a", "--user-data-dir"], "user-data-dir")).toBe("");
  expect(lastSwitch(["chrome", "--", "--user-data-dir=/a"], "user-data-dir")).toBeUndefined();
  expect(lastSwitch(["/x/--user-data-dir=/a"], "user-data-dir")).toBeUndefined(); // argv[0] は実行 file
});

test("製品の profile を先に書き、後ろの別の profile（-- 2 つ目 / - 1 つ）で起こした browser は断る", async () => {
  const mine = mktmp("r15-prof"), evil = mktmp("r15-evil");
  const allow = (fd: number) => browserHost(fd, { browsers: [bun], profiles: [mine], origin: EXT_ORIGIN });
  for (const tail of [[`--user-data-dir=${evil}`], [`-user-data-dir=${evil}`]]) {
    const r = await connectVia(bun, [`--user-data-dir=${mine}`, ...tail], allow);
    expect(r.ok).toBe(false);
    expect(r.why).toContain("profile が製品の物ではない");
  }
  // - 1 つだけで別の profile（以前は「profile 無し＝人の Chrome」と読んで通した）
  const one = await connectVia(bun, [`-user-data-dir=${evil}`], allow);
  expect(one.ok).toBe(false);
  // 対照: 製品の profile だけなら通る
  expect(await connectVia(bun, [`--user-data-dir=${mine}`], allow)).toEqual({ ok: true, why: "" });
});

// --- 3. W7j × W8g-5: 確かめている間（codesign は混むと数秒）に切れた口を webPeers に残さない
test("webHello を確かめている間に切れた口は、確かめが通っても繋がった事にしない", async () => {
  let pass!: (v: boolean) => void;
  const h = makeHandler(openStore(":memory:"), async () => [], undefined, undefined, { isExtension: () => new Promise<boolean>((r) => (pass = r)) });
  const ext = {};
  const hello = h({ op: "webHello" }, ext);
  await Bun.sleep(0);
  h.dropOwner(ext); // Chrome を閉じた
  pass(true);
  expect(await hello).toMatchObject({ ok: false });
  expect(h.hasWebPeer()).toBe(false);
  // 対照: 切れなければ繋がる
  const ext2 = {};
  const p2 = h({ op: "webHello" }, ext2);
  await Bun.sleep(0);
  pass(true);
  expect(await p2).toMatchObject({ ok: true });
  expect(h.hasWebPeer()).toBe(true);
});

// --- 4. ruleslint の抜け道
const ids = (file: string, text: string) => lint([{ file, line: 1, text }], []).map((v) => v.rule.id);
test("ruleslint: 行頭の /* */ の後ろの code・行の後ろの expect(・git の option の後の init/config・join で分けた Kangae は抜けられない", () => {
  expect(ids("test/x.ts", '/* 片付け */ Bun.spawnSync(["pkill", "-f", "kangae"]);')).toContain("shared-kill"); // rules-ok: 抜け道の攻撃の例
  expect(ids("test/x.ts", 'Bun.spawn(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "about:blank"]); expect(1).toBe(1);')).toContain("headless");
  expect(ids("tools/x.sh", "git -c user.name=t config --global x y")).toContain("git-write"); // rules-ok: 抜け道の攻撃の例
  expect(ids("tools/x.sh", 'git --git-dir="$d/.git" init')).toContain("git-write"); // rules-ok: 抜け道の攻撃の例
  expect(ids("test/x.ts", 'join(homedir(), "Library", "Application Support", "Kangae", "token")')).toContain("owner-home"); // rules-ok: 抜け道の攻撃の例
  // 対照（誤検知しない）
  expect(ids("test/x.ts", "/* 片付けは自分の PID だけ */")).toEqual([]);
  expect(ids("test/x.ts", " * pkill -f kangae は打たない")).toEqual([]); // rules-ok: 誤検知しない対照の例
  expect(ids("tools/x.sh", 'git -C "$d" status')).toEqual([]);
  expect(ids("test/x.ts", 'expect(chromiumArgs({ extraArgs: ["x"] })).toContain("x");')).toEqual([]);
});
