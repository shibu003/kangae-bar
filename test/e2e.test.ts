// compile した binary を、Chromium と同じやり方（第 1 引数に拡張の origin）で native host として起こす通し
import { mktmp } from "./tmp.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT_ORIGIN } from "../src/main.ts";
import { pollUntil } from "../src/wait.ts";
import { childEnv } from "./spawn-daemon.ts";
import { armExe } from "./exe";

const root = join(import.meta.dir, "..");
const bin = join(root, "dist/kangae");
const dir = mktmp("kangae-e2e");
const sock = join(dir, "s.sock");
const argsLog = join(dir, "claude-args.txt");
let env: Record<string, string>;

beforeAll(async () => {
  const build = Bun.spawnSync(["bun", "build", "--compile", "--target=bun-darwin-x64", "src/main.ts", "--outfile", "dist/kangae"], { cwd: root });
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  // 偽の claude と、PATH をそこへ向ける偽の login shell
  const fakebin = join(dir, "bin");
  mkdirSync(fakebin);
  writeFileSync(
    join(fakebin, "claude"),
    `#!/bin/sh\necho "$@" > "${argsLog}"\ncase "$1" in auth) exit 0;; esac\nprintf '%s\\n' '{"type":"result","result":"まず睡眠を守る。\\n\\n次の一手:\\n1. 睡眠を記録する\\n2. 削れる予定を探す\\n3. 週末に試す"}'\n`,
  );
  armExe(join(fakebin, "claude"));
  const shell = join(dir, "shell.sh");
  writeFileSync(shell, `#!/bin/sh\nprintf '%s' "${fakebin}:/usr/bin:/bin"\n`);
  armExe(shell);
  env = { ...(childEnv() as Record<string, string>), SHELL: shell, KANGAE_HOME: join(dir, "home"), KANGAE_SOCK: sock, KANGAE_NODES_DIR: join(dir, "nodes") };
}, 120_000);

afterAll(() => {
  const pids = Bun.spawnSync(["lsof", "-t", sock]).stdout.toString().split("\n").filter(Boolean);
  for (const p of pids) if (Number(p) !== process.pid) try { process.kill(Number(p)); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function frame(o: unknown) {
  const b = Buffer.from(JSON.stringify(o));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length);
  return Buffer.concat([h, b]);
}

async function readFrame(reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> }, state: { buf: Buffer }) {
  for (;;) {
    if (state.buf.length >= 4 && state.buf.length >= 4 + state.buf.readUInt32LE(0)) {
      const n = state.buf.readUInt32LE(0);
      const out = JSON.parse(state.buf.subarray(4, 4 + n).toString());
      state.buf = state.buf.subarray(4 + n);
      return out;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("host closed");
    state.buf = Buffer.concat([state.buf, value!]);
  }
}

const T0 = Date.now();
const call = async (host: ReturnType<typeof Bun.spawn>, reader: any, st: { buf: Buffer }, o: object) => {
  const t = Date.now();
  try { return await call0(host, reader, st, o); } finally { console.error(`[e2e +${t - T0}ms ${Date.now() - t}ms] ${(o as any).op} ${(o as any).id}`); }
};
const call0 = async (host: ReturnType<typeof Bun.spawn>, reader: any, st: { buf: Buffer }, o: object) => {
  (host.stdin as any).write(frame(o));
  (host.stdin as any).flush();
  return readFrame(reader, st);
};

test("通し: 一言 → host → 常駐 → claude → 返事と次の一手 3 つ → 1 つ押すと深掘りされ、また 3 つ出る", async () => {
  const host = Bun.spawn([bin, EXT_ORIGIN], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = host.stdout.getReader();
  const st = { buf: Buffer.alloc(0) };
  const root = await call(host, reader, st, { id: "0", op: "add", text: "副業" });
  const id = root.node.id;
  const sent = await call(host, reader, st, { id: "1", op: "send", rootId: id, text: "副業したいけど時間がない" });
  expect(sent.ok).toBe(true);
  const next = async (n: number) => {
    let i = 0; // 回数ではなく締切: 混んで 1 回が遅くなっても、待つ総時間は変わらない
    const c = await pollUntil(async () => { const r = await call(host, reader, st, { id: `c${n}-${i++}`, op: "chat", rootId: id }); return r.next.length ? r : null; }, 150_000, 250); // 実測: load 70 で 4 秒・load 280 で 47 秒（子 process の起動が機械の混みに比例）
    if (!c) throw new Error("次の一手が出なかった");
    return c;
  };
  const c1 = await next(1);
  expect(c1.rows.map((r: any) => r.text)).toEqual(["副業したいけど時間がない", "🤖 claude: まず睡眠を守る。"]);
  expect(c1.next.map((n: any) => n.text)).toEqual(["睡眠を記録する", "削れる予定を探す", "週末に試す"]);
  const args = await Bun.file(argsLog).text();
  expect(args).toContain("-p");
  expect(args).toContain("次の一手:");

  const sent2 = await call(host, reader, st, { id: "2", op: "send", rootId: id, text: c1.next[0].text, nodeId: c1.next[0].id });
  expect(sent2.ok).toBe(true);
  const c2 = await next(2);
  expect(c2.rows.map((r: any) => r.text).slice(0, 3)).toEqual(["副業したいけど時間がない", "🤖 claude: まず睡眠を守る。", "睡眠を記録する"]);
  expect(c2.next).toHaveLength(3);
  // agent からの書き戻し: 同じ binary を CLI として呼ぶと、同じ常駐に届いて節の下に一言が足される
  const note = Bun.spawnSync([bin, "note", String(id), "睡眠は", "7 時間守る"], { env });
  expect(note.exitCode).toBe(0);
  expect(note.stdout.toString()).toContain("書き戻しました");
  const ctx = Bun.spawnSync([bin, "context", String(id)], { env });
  expect(ctx.stdout.toString()).toContain("一言: 🤖 メモ: 睡眠は 7 時間守る");
  expect(ctx.stdout.toString()).toContain(`${bin} note ${id}`);
  expect(Bun.spawnSync([bin, "note", "999999", "x"], { env }).exitCode).toBe(1);
  // agent から todo: 足す → 済にする → 見る
  expect(Bun.spawnSync([bin, "todo", String(id), "add", "睡眠を", "記録する"], { env }).exitCode).toBe(0);
  expect(Bun.spawnSync([bin, "todo", String(id), "done", "1"], { env }).stdout.toString()).toContain("1. [x] 睡眠を 記録する");
  expect(Bun.spawnSync([bin, "todo", String(id)], { env }).stdout.toString()).toContain("1. [x] 睡眠を 記録する");
  expect(Bun.spawnSync([bin, "todo", String(id), "done", "5"], { env }).exitCode).toBe(1);
  host.kill();
}, 600_000); // 子 process を十数回起こす列。実測 load 70 で 15 秒・load 280 で add だけ 115 秒＝締切は混みの 19 倍を見込む（締切を割った赤は製品の赤ではない）

test("origin が自分の拡張と違う引数では中継役にならない（常駐の起動でもない）", async () => {
  const p = Bun.spawn([bin, "chrome-extension://someoneelse/"], { env: { ...env, KANGAE_SOCK: join(dir, "other.sock") }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  // 「すぐ終わる」を 20 秒の固定 sleep で測らない（load 280 で起動だけで 20 秒を超えた）。終わるのを待ち、常駐になったら（socket が現れたら）それが赤
  const other = join(dir, "other.sock");
  const code = await Promise.race([p.exited, pollUntil(async () => (existsSync(other) ? "became-daemon" : null), 120_000, 100).then((r) => r ?? "still-running")]);
  expect(code).toBe(0);
  expect(existsSync(other)).toBe(false);
  const pids = Bun.spawnSync(["lsof", "-t", join(dir, "other.sock")]).stdout.toString().split("\n").filter(Boolean);
  for (const q of pids) try { process.kill(Number(q)); } catch {}
  p.kill();
}, 150_000); // 常駐になれば socket が現れる＝「中継役にも常駐にもならず終わる」は終わりを待って、socket が無い事で測る

test("常駐に繋がらない時、中継役は回数でなく締切（KANGAE_CONNECT_MS）で諦める", async () => {
  const p = Bun.spawn([bin, EXT_ORIGIN], { env: { ...env, KANGAE_SOCK: "/nonexistent/dir/s.sock", KANGAE_CONNECT_MS: "1" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  expect(await p.exited).toBe(1);
  const m = (await new Response(p.stderr).text()).match(/裏の常駐に繋がりません（(\d+)ms 待った）/);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBeLessThan(3000); // 回数 40 の旧実装は 150ms の睡眠だけで 6 秒以上待つ（機械の混み具合に依らない）
}, 120_000); // 起動だけで load 400 の下では 20 秒かかる
