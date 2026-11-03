// review10: holes-21 の stop が本物の常駐の見張りを外していないこと・tools/suite.ts の件数の読み（色・印字の偽装）
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, spawnDaemon, waitDaemon } from "./spawn-daemon.ts";

const root = join(import.meta.dir, "..");
const suite = async (src: string, env: Record<string, string> = {}) => {
  const dir = mktmp("r10s");
  await Bun.write(join(dir, "a.test.ts"), src);
  const p = Bun.spawn(["bun", join(root, "tools/suite.ts"), join(dir, "a.test.ts")], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const rc = await p.exited;
  rmSync(dir, { recursive: true, force: true });
  return rc;
};
const ok = `import {test} from "bun:test"; test("x",()=>{});`;

test("suite: FORCE_COLOR の色つき出力でも緑は緑", async () => { expect(await suite(ok, { FORCE_COLOR: "1" })).toBe(0); });
test("suite: 試験が「3 pass / 0 fail」を印字して exit 0 しても赤", async () => {
  expect(await suite(`import {test} from "bun:test"; test("x",()=>{}); test("y",()=>{ console.log("\\n 3 pass\\n 0 fail\\n"); process.exit(0); });`)).toBe(1);
});
test("suite: expect を呼ぶ試験の緑（fail と Ran の間に「N expect() calls」が入る本物の bun の出力）も緑（review11）", async () => { expect(await suite(`import {test,expect} from "bun:test"; test("x",()=>{expect(1).toBe(1)});`)).toBe(0); });
test("suite: 失敗は失敗のまま", async () => { expect(await suite(`import {test,expect} from "bun:test"; test("x",()=>{expect(1).toBe(2)});`)).toBe(1); });

const boot = async () => {
  const d = mktmp("r10d");
  const sock = join(d, "s.sock"), bar = join(d, "bar.json");
  mkdirSync(join(d, "home"), { recursive: true });
  return { d, sock, bar, env: (extra: Record<string, string> = {}) => childEnv({ KANGAE_HOME: join(d, "home"), KANGAE_NODES_DIR: join(d, "nodes"), KANGAE_SOCK: sock, KANGAE_BAR: bar, ...extra }) as Record<string, string> };
};

test("本物の常駐（--daemon）は socket の file が消えたら自分で終わる", async () => {
  const b = await boot();
  const p = spawnDaemon(["bun", join(root, "src/main.ts"), "--daemon"], { env: b.env(), stdin: "ignore", stdout: "ignore" });
  await waitDaemon(p, { bar: b.bar, sock: b.sock });
  rmSync(b.sock);
  const rc = await Promise.race([p.exited, Bun.sleep(35_000).then(() => "残った")]);
  if (rc === "残った") p.kill();
  expect(rc).toBe(0);
  rmSync(b.d, { recursive: true, force: true });
}, 60_000);

test("本物の常駐は SIGTERM で exit 0 する", async () => {
  const b = await boot();
  const p = spawnDaemon(["bun", join(root, "src/main.ts"), "--daemon"], { env: b.env(), stdin: "ignore", stdout: "ignore" });
  await waitDaemon(p, { bar: b.bar, sock: b.sock });
  p.kill("SIGTERM");
  const rc = await Promise.race([p.exited, Bun.sleep(10_000).then(() => "残った")]);
  if (rc === "残った") p.kill("SIGKILL");
  expect(rc).toBe(0);
  rmSync(b.d, { recursive: true, force: true });
}, 60_000);

test("stop は自分が足した signal handler だけ外す（stop 2 回でも・他の handler は残る）", async () => {
  const d = mktmp("r10e");
  const code = `
    process.env.KANGAE_BAR = ${JSON.stringify(join(d, "bar.json"))};
    process.env.KANGAE_HOME = ${JSON.stringify(d)};
    const { startDaemon } = await import(${JSON.stringify(join(root, "src/main.ts"))});
    const other = () => {}; process.on("SIGTERM", other);
    const n0 = process.listenerCount("SIGTERM");
    const s = await startDaemon(${JSON.stringify(join(d, "s.sock"))});
    const n1 = process.listenerCount("SIGTERM");
    s.stop(true); s.stop(false);
    console.log(JSON.stringify([n1 - n0, process.listenerCount("SIGTERM") - n0, process.listeners("SIGTERM").includes(other)]));
    process.exit(0);
  `;
  const p = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "pipe", env: { ...process.env, KANGAE_PARENT_PID: "" } });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  rmSync(d, { recursive: true, force: true });
  expect(JSON.parse(out.split("\n").pop()!)).toEqual([1, 0, true]);
}, 30_000);
