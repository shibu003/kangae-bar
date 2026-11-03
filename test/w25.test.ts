// W25: 面の無い agent A の `act open_app` が、実物の CLI から常駐へ届き、承認 card が出る（EXP-1 再走: CLI が owner を送らず「操作権がありません」で終わり、card が 1 枚も出なかった）。読む file を literal で名指す: "src/main.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDaemon, waitDaemon } from "./spawn-daemon";
import { humanAsk } from "./human-ask.ts";

let D: string, sock: string, bar: string, daemon: ReturnType<typeof spawnDaemon>, env: Record<string, string>;
const ask = (m: Record<string, unknown>): Promise<any> => new Promise((resolve) => {
  const id = crypto.randomUUID(); let buf = "";
  Bun.connect({ unix: sock, socket: { data(s, c) { buf += new TextDecoder().decode(c); for (const l of buf.split("\n")) { try { const j = JSON.parse(l); if (j.id === id) { s.end(); resolve(j); } } catch {} } }, error() {} } }).then((s) => s.write(JSON.stringify({ id, ...m }) + "\n"));
});
const cli = (owner: string, ...a: string[]) => Bun.spawn(["bun", "src/main.ts", ...a], { env: { ...env, KANGAE_OWNER: owner }, stdout: "pipe", stderr: "pipe" });
const card = async () => { for (let i = 0; i < 150; i++) { const a = ((await ask({ op: "leaseList" })) as any).approvals?.[0]; if (a) return a; await Bun.sleep(100); } return null; };

beforeEach(async () => {
  D = mktmp("w25");
  const home = join(D, "home"); mkdirSync(home);
  sock = join(D, "m.sock"); bar = join(D, "bar.json");
  env = { ...(process.env as Record<string, string>), KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_BAR: bar, KANGAE_NODES_DIR: join(D, "nodes") };
  delete env.KANGAE_LEASES; delete env.KANGAE_LEASE; // 面の無い turn の env（KANGAE_LEASES は面を持つ turn だけ）
  daemon = spawnDaemon(["bun", "src/main.ts", "--daemon"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  await waitDaemon(daemon, { bar });
});
afterEach(() => { try { daemon.kill(); } catch {} rmSync(D, { recursive: true, force: true }); });

test("W25-1 実物の CLI → 常駐: 面の無い会話の `act open_app` は常駐に届き、owner つきの card が出る（A / B の名前で見分けられる）・断ると何も開かない", async () => {
  const a = (await ask({ op: "add", text: "agentA の仕事" })).node, b = (await ask({ op: "add", text: "agentB の仕事" })).node;
  await ask({ op: "agentName", rootId: a.id, name: "agentA" }); await ask({ op: "agentName", rootId: b.id, name: "agentB" });
  const p = cli(`s:${a.id}`, "act", "open_app", JSON.stringify({ app: "Preview" }));
  const c = await card();
  expect(c).toMatchObject({ tool: "open_app", owner: `s:${a.id}`, danger: true });
  expect(c.what).toContain("Preview を裏で開きます");
  expect(((await ask({ op: "leaseList" })) as any).leases).toEqual([]); // 許す前は面も窓も増えない
  void humanAsk(bar)({ op: "approvalAnswer", id: c.id, yes: false }); // 人の口（/ws）から断る（sec1: 承認は人が押す物＝unix socket の agent の口では断られる）。返事は待たない（CLI の終わりで答えが届いた事を見る）
  const code = await p.exited;
  const err = await new Response(p.stderr).text();
  expect(code).toBe(1);
  expect(err).toContain("拒否(denied)");
  expect(((await ask({ op: "leaseList" })) as any).leases).toEqual([]); // 断ったので何も開いていない
}, 120_000);

test("W25-2 面の無い会話の click など open_app 以外は、CLI が常駐へ送らず「面を持っていません」と次の一手（web = act open_tab・app = 人が窓を渡す / launch）を言う（W40 で open_tab・launch が足された）", async () => {
  const a = (await ask({ op: "add", text: "agentA" })).node;
  const p = cli(`s:${a.id}`, "act", "click", "{}");
  expect(await p.exited).toBe(1);
  const err = await new Response(p.stderr).text();
  expect(err).toContain("拒否(face)");
  expect(err).toContain("act open_tab");
  expect(err).toContain("launch");
  expect(((await ask({ op: "leaseList" })) as any).approvals).toEqual([]);
}, 120_000);

test("W25-3 CLI の条件: 面なし（token が空）を「面あり」と読まない・owner を常駐へ送る", () => {
  const src = readFileSync("src/main.ts", "utf8");
  expect(src.includes('const hasTok = pick.ok && pick.token !== "";')).toBe(true);
  expect(src.includes("...(hasTok && pick.ok ? { lease: pick.token } : { owner: process.env.KANGAE_OWNER, on })")).toBe(true);
});

test("W25-4 card の題に長い path が入っても横にあふれない（panel.css）", () => {
  expect(readFileSync("extension/panel.css", "utf8").includes("#approve .approval { overflow-wrap:anywhere; }")).toBe(true);
});
