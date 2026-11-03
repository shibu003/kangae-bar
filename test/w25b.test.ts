// W25b: 実機の bar（compiled・symlink 経由）で agent の CLI が動かない件の切り分けと予防。compiled の kangae は cwd の .env と bunfig.toml を自動で読む（bun build --compile の既定）＝agent が書ける作業場所の file で CLI の env が替わる／起動が cwd 以上の path の file に引っかかる。配る形の build は両方切る。
// 読む file を literal で名指す: "scripts/dist-bar.sh" "scripts/release.sh" "src/main.ts"
import { mktmp } from "./tmp.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDaemon, waitDaemon } from "./spawn-daemon";
import { humanAsk } from "./human-ask.ts";

let top: string, flagged: string, plain: string, link: string;
const FLAGS = ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"];
const build = (out: string, flags: string[]) => { const r = Bun.spawnSync(["bun", "build", "--compile", ...flags, "src/main.ts", "--outfile", out], { stdout: "ignore", stderr: "pipe" }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };

beforeAll(() => {
  top = realpathSync(mktmp("w25b"));
  const dir = join(top, "Kangae Bar.app", "Contents", "Resources", "bin"); mkdirSync(dir, { recursive: true });
  flagged = join(dir, "kangae"); build(flagged, FLAGS);
  plain = join(top, "plain-kangae"); build(plain, []);
  mkdirSync(join(top, "link")); link = join(top, "link", "kangae"); symlinkSync(flagged, link);
}, 120_000);
afterAll(() => rmSync(top, { recursive: true, force: true }));

test("W25b-1 配る形の build（dist-bar.sh・release.sh）は cwd の .env と bunfig.toml を読まない", () => {
  for (const f of ["scripts/dist-bar.sh", "scripts/release.sh"]) {
    const line = readFileSync(f, "utf8").split("\n").find((l) => l.includes("bun build --compile"))!;
    for (const fl of FLAGS) expect(line.includes(fl)).toBe(true);
  }
});

test("W25b-2 compiled の CLI は cwd の .env で env を替えられない（対照: 既定の build は替わる）", () => {
  const empty = join(top, "empty-home"), withCmd = join(top, "cmd-home"), cwd = join(top, "cwd");
  for (const d of [empty, withCmd, cwd]) mkdirSync(d);
  writeFileSync(join(withCmd, "commands.json"), JSON.stringify({ items: [{ name: "planted", cwd: top, argv: ["/bin/echo"], timeoutSec: 60, at: 0, seal: "x" }] }));
  writeFileSync(join(cwd, ".env"), `KANGAE_HOME=${withCmd}\n`);
  const env = { PATH: "/usr/bin:/bin", HOME: empty, TMPDIR: top + "/" }; // KANGAE_HOME は渡さない（.env は既にある env を上書きしない＝無い物だけ入る）
  const run = (bin: string) => Bun.spawnSync([bin, "cmd-list"], { cwd, env, stdout: "pipe", stderr: "pipe" }).stdout.toString();
  expect(run(link)).not.toContain("planted"); // .env を読まない
  expect(run(plain)).toContain("planted"); // 対照: 既定の build は .env の KANGAE_HOME を読む＝この test は赤くできる
});

test("W25b-3 compiled の CLI（空白入りの bar 同梱 path・symlink 経由）→ 常駐: 面の無い会話の act open_app が card まで届く", async () => {
  const D = mktmp("w25b"), home = join(D, "home"); mkdirSync(home);
  const sock = join(D, "m.sock"), bar = join(D, "bar.json");
  const base: Record<string, string> = { ...(process.env as Record<string, string>), KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_BAR: bar, KANGAE_NODES_DIR: join(D, "nodes") };
  delete base.KANGAE_LEASES; delete base.KANGAE_LEASE;
  const daemon = spawnDaemon(["bun", "src/main.ts", "--daemon"], { env: base, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  const ask = (m: Record<string, unknown>): Promise<any> => new Promise((resolve) => { const id = crypto.randomUUID(); let buf = ""; Bun.connect({ unix: sock, socket: { data(s, c) { buf += new TextDecoder().decode(c); for (const l of buf.split("\n")) { try { const j = JSON.parse(l); if (j.id === id) { s.end(); resolve(j); } } catch {} } }, error() {} } }).then((s) => s.write(JSON.stringify({ id, ...m }) + "\n")); });
  try {
    await waitDaemon(daemon, { bar });
    const n = (await ask({ op: "add", text: "agentA" })).node;
    const cwd = join(D, "work"); mkdirSync(cwd);
    const cli = Bun.spawn([link, "act", "open_app", JSON.stringify({ app: "Preview", path: D })], { cwd, env: { ...base, KANGAE_OWNER: `s:${n.id}` }, stdout: "pipe", stderr: "pipe" });
    let card: any;
    for (let i = 0; i < 200 && !card; i++) { card = ((await ask({ op: "leaseList" })) as any).approvals?.[0]; if (!card) await Bun.sleep(100); }
    expect(card).toMatchObject({ tool: "open_app", owner: `s:${n.id}`, danger: true });
    void humanAsk(bar)({ op: "approvalAnswer", id: card.id, yes: false }); // sec1: 承認は人が押す物＝人の口（/ws）から断る
    expect(await cli.exited).toBe(1);
    expect(await new Response(cli.stderr).text()).toContain("拒否(denied)");
  } finally { try { daemon.kill(); } catch {} rmSync(D, { recursive: true, force: true }); }
}, 120_000);
