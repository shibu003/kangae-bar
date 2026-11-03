// holes-8: 試験の常駐は親が死んだら自分で止まる。製品の起動では付かない
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { watchParent } from "../src/main";
import { pollUntil } from "../src/wait.ts";
import { childEnv } from "./spawn-daemon.ts";

test("親が居なくなると止まる", async () => {
  let alive = true, stopped = 0;
  const t = watchParent({ KANGAE_PARENT_PID: "4242" }, () => stopped++, 5, () => alive)!;
  await Bun.sleep(30); expect(stopped).toBe(0);
  alive = false; await Bun.sleep(30); expect(stopped).toBeGreaterThan(0);
  clearInterval(t);
});

test("親を渡さない（製品の起動）と見張りは付かない", () => {
  for (const v of [undefined, "", "abc", "0", "1", "-5"]) expect(watchParent({ KANGAE_PARENT_PID: v }, () => {})).toBeNull();
});

test("製品の起こし口（bar・LaunchAgent・relay）は KANGAE_PARENT_PID を書かない", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  expect(src.match(/KANGAE_PARENT_PID/g)!.length).toBe(2); // watchParent の読みだけ（書き込みは test/spawn-daemon.ts にしか無い）
  expect(readFileSync(new URL("./spawn-daemon.ts", import.meta.url), "utf8")).toContain("KANGAE_PARENT_PID: String(process.pid)");
});

test("実物: 親 sh が死ぬと常駐が数秒で消える", async () => {
  const dir = mktmp("kangae-h8");
  const parent = Bun.spawn(["sh", "-c", `KANGAE_PARENT_PID=$$ KANGAE_HOME=${dir} KANGAE_SOCK=${dir}/s.sock KANGAE_BAR=${dir}/bar.json ${process.execPath} ${import.meta.dir}/../src/main.ts --daemon & echo $! ; sleep 1; exit 0`], { stdout: "pipe", env: childEnv() as Record<string, string> }); // env を渡さない Bun.spawn は起動時の環境を継ぎ、preload が temp にした値が子に届かない（holes-18）
  const pid = Number((await new Response(parent.stdout).text()).trim());
  await parent.exited;
  const up = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const gone = !!(await pollUntil(() => !up(pid), 40_000, 250));
  if (!gone) process.kill(pid, "SIGKILL");
  expect(gone).toBe(true);
}, 60_000);

// holes-10: dm.e2e の ENOENT = bar.json が socket の listen より先に書かれる隙間。親の pid は試験の本体（短命の中間 process ではない）
test("spawnDaemon が渡す親は試験の本体 pid", async () => {
  const { spawnDaemon } = await import("./spawn-daemon");
  const p = spawnDaemon(["sh", "-c", 'echo $KANGAE_PARENT_PID'], { stdout: "pipe" });
  expect((await new Response(p.stdout).text()).trim()).toBe(String(process.pid));
});

test("dm.e2e は bar と socket の両方を waitDaemon で待つ（bar だけだと listen の前に繋ぐ）", () => {
  const src = readFileSync(new URL("./dm.e2e.ts", import.meta.url), "utf8");
  expect(src).toContain("waitDaemon(proc, { bar, sock })");
});

// holes-13: 固定 10 秒の ENOENT をやめ、実の締切で待つ。越えたら生死と stderr が 1 行に入る
test("waitDaemon: 揃えば返る・越えたら常駐の生死と stderr つきで throw", async () => {
  const { spawnDaemon, waitDaemon } = await import("./spawn-daemon");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const d = mktmp("h13");
  const bar = join(d, "bar.json");
  const ok = spawnDaemon(["sh", "-c", `sleep 0.3; echo {} > '${bar}'; sleep 5`], {});
  await waitDaemon(ok, { bar, ms: 5000 });
  ok.kill();
  const dead = spawnDaemon(["sh", "-c", "echo boom-xyz >&2; exit 3"], {});
  const err = await waitDaemon(dead, { bar: join(d, "none.json"), ms: 1000 }).then(() => "", (e) => String(e));
  expect(err).toContain("exit 3");
  expect(err).toContain("boom-xyz");
});

// holes-10b: bar.json は socket を listen してから書く（見えた時には繋げる）
test("startDaemon は listen の時点でまだ bar.json を書いていない", async () => {
  const { startDaemon } = await import("../src/main");
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const d = mktmp("h10b");
  const bar = join(d, "bar.json");
  const prev = process.env.KANGAE_BAR;
  process.env.KANGAE_BAR = bar;
  const orig = Bun.listen;
  let seen = null as boolean | null;
  (Bun as any).listen = (o: any) => { seen = existsSync(bar); return (orig as (o: unknown) => unknown).call(Bun, o); };
  try {
    const s = await startDaemon(join(d, "s.sock"));
    expect(seen).toBe(false);
    expect(existsSync(bar)).toBe(true);
    s?.stop(true);
  } finally {
    (Bun as any).listen = orig;
    prev === undefined ? delete process.env.KANGAE_BAR : (process.env.KANGAE_BAR = prev);
  }
});
