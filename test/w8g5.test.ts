// W8g-5: webHello してよい口を OS に聞く（src/peer.ts）・gemini の seatbelt は常駐の socket に繋がせない。本物の Chrome・金庫には触らない（偽の browser = この試験の bun）
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ownerDirs } from "../src/paths.ts";
import { join } from "node:path";
import { EXT_ORIGIN, extensionPeer, writeSandbox } from "../src/main.ts";
import { browserHost, proc } from "../src/peer.ts";

// 試験の bun を「browser」に見立てる: 親（mid）が子（host）を起こし、子が socket に繋ぐ。mid の argv に --user-data-dir を付けられる
async function connectVia(midArgs: string[], hostArgs: string[], allow: (fd: number) => ReturnType<typeof browserHost>) {
  const d = mktmp("w8g5");
  const sock = join(d, "s.sock");
  const got = new Promise<Awaited<ReturnType<typeof browserHost>>>((res) => {
    const srv = Bun.listen({ unix: sock, socket: { open(s) { res(allow((s as unknown as { fd: number }).fd)); srv.stop(true); }, data() {} } });
  });
  const host = join(d, "host.ts");
  writeFileSync(host, `await Bun.connect({ unix: ${JSON.stringify(sock)}, socket: { data() {} } }); await Bun.sleep(5000);`);
  const mid = join(d, "mid.ts");
  writeFileSync(mid, `const p = Bun.spawn([process.execPath, ${JSON.stringify(host)}, ...${JSON.stringify(hostArgs)}]); await p.exited;`);
  const p = Bun.spawn([process.execPath, mid, ...midArgs], { stdout: "ignore", stderr: "ignore" });
  try { return await got; } finally { p.kill(); }
}
const bun = process.execPath;

test("proc: 実行 file・親・argv（空白を含む引数もそのまま）を OS から読む", () => {
  const p = Bun.spawn([bun, "-e", "await Bun.sleep(5000)", "a b", "--user-data-dir=/x y"]);
  try {
    const me = proc(p.pid)!;
    expect(me.ppid).toBe(process.pid);
    expect(me.path).toBe(bun);
    expect(me.argv.slice(-3)).toEqual(["await Bun.sleep(5000)", "a b", "--user-data-dir=/x y"]);
  } finally { p.kill(); }
});

test("本物の形（決まった browser が profile 無しで host を起こした）は通る", async () => {
  expect(await connectVia([], [EXT_ORIGIN], (fd) => browserHost(fd, { browsers: [bun], profiles: [], origin: EXT_ORIGIN }))).toEqual({ ok: true, why: "" });
});

test("親が決まった browser でなければ断る（gemini が kangae chrome-extension://… を自分で起こした形）", async () => {
  const r = await connectVia([], [EXT_ORIGIN], (fd) => browserHost(fd, { browsers: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"], profiles: [], origin: EXT_ORIGIN }));
  expect(r.ok).toBe(false);
  expect(r.why).toContain("決まった browser ではない");
});

test("argv に拡張の origin が無い口（socket に直に繋いだ process）は断る", async () => {
  const r = await connectVia([], ["x"], (fd) => browserHost(fd, { browsers: [bun], profiles: [], origin: EXT_ORIGIN }));
  expect(r.ok).toBe(false);
  expect(r.why).toContain("host として起こされていない");
});

test("本物の browser でも別の profile（--user-data-dir）で起こした物は断る・製品の profile なら通る", async () => {
  const evil = mktmp("w8g5-evil"), mine = mktmp("w8g5-prof");
  const no = await connectVia([`--user-data-dir=${evil}`], [EXT_ORIGIN], (fd) => browserHost(fd, { browsers: [bun], profiles: [mine], origin: EXT_ORIGIN }));
  expect(no.ok).toBe(false);
  expect(no.why).toContain("profile が製品の物ではない");
  const yes = await connectVia([`--user-data-dir=${mine.replace(/^\/private/, "")}`], [EXT_ORIGIN], (fd) => browserHost(fd, { browsers: [bun], profiles: [mine], origin: EXT_ORIGIN }));
  expect(yes).toEqual({ ok: true, why: "" });
});

test("/ws の口（fd の無い owner）は断る・試験の env は compile した製品と本物の home の常駐では効かない", async () => {
  const tmpHome = mktmp("w8g5-home");
  const realHome = ownerDirs()[0]!; // owner の常駐の保存場所（比べるだけ・読み書きしない）
  expect(await extensionPeer({}, {}, false, tmpHome)).not.toBe(true);
  expect(await extensionPeer({}, { KANGAE_TEST_TRUST_EXT: "1" }, false, tmpHome)).toBe(true);
  expect(await extensionPeer({}, { KANGAE_TEST_TRUST_EXT: "1" }, true, tmpHome)).not.toBe(true);
  expect(await extensionPeer({}, { KANGAE_TEST_TRUST_EXT: "1" }, false, realHome)).not.toBe(true);
});

test("常駐: この試験の bun が起こした host（偽の browser）は extensionPeer が断る", async () => {
  const r = await connectVia([], [EXT_ORIGIN], async (fd) => { const v = await extensionPeer({ fd }, {}, true); return { ok: v === true, why: v === true ? "" : `${v.app} ${v.why}` }; });
  expect(r.ok).toBe(false);
  expect(r.why).toContain("決まった browser ではありません"); // 人に見せる 1 行（path は含まない）
  expect(r.why).not.toContain("/");
});

// W13 の carry の但し書き「同じユーザーのソフトが拡張やこの app のファイルを書き換えた時までは防げません」の境界を固定する。
// 判定が profile の中身（拡張の file）まで見るようになったら赤＝但し書きの文を直す合図
test("防げない物（W13 の但し書き）: 判定は browser の code と profile の場所だけ＝製品の profile の中の file を書き換えても通る", async () => {
  const mine = mktmp("w8g5-prof");
  writeFileSync(join(mine, "manifest.json"), "{ 書き換えた拡張 }");
  expect(await connectVia([`--user-data-dir=${mine}`], [EXT_ORIGIN], (fd) => browserHost(fd, { browsers: [bun], profiles: [mine], origin: EXT_ORIGIN }))).toEqual({ ok: true, why: "" });
});

// gemini の seatbelt（実際に sandbox-exec で回す）: 常駐の socket には繋げず消せない・他の socket には繋げる（塞いだのが socket の道だけである事の対照）
test("gemini の seatbelt: 常駐の socket に繋げない・消せない（外すと繋がって赤）", async () => {
  const d = mktmp("w8g5-sb"), work = mktmp("w8g5-wk");
  const daemon = join(d, "kangae.sock"), other = join(d, "other.sock");
  const heard: string[] = [];
  const srv = [daemon, other].map((p) => Bun.listen({ unix: p, socket: { data(_s, c) { heard.push(`${p}:${c.toString().trim()}`); }, open() {} } }));
  const nc = (sb: string, p: string) => Bun.spawn(["/usr/bin/sandbox-exec", "-p", sb, "/bin/sh", "-c", `echo hi | /usr/bin/nc -U -w 1 '${p}'`], { stdout: "ignore", stderr: "ignore" }).exited;
  const sb = writeSandbox(work, [], daemon);
  await nc(sb, daemon);
  await nc(sb, other);
  await Bun.sleep(200);
  expect(heard).toEqual([`${other}:hi`]);
  const rm = await Bun.spawn(["/usr/bin/sandbox-exec", "-p", sb, "/bin/rm", "-f", daemon], { stderr: "ignore" }).exited;
  expect(rm).not.toBe(0);
  for (const s of srv) s.stop(true);
});
