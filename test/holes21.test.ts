import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// holes-21: 試験の process の中で起こした常駐の「socket が消えたら exit(0)」が bun test ごと黙って終わらせた
test("startDaemon を同じ process で起こして stop(true) したら、socket が消えても process は終わらない", async () => {
  const d = mktmp("h21");
  const code = `
    process.env.KANGAE_BAR = ${JSON.stringify(join(d, "bar.json"))};
    process.env.KANGAE_HOME = ${JSON.stringify(d)};
    const { startDaemon } = await import(${JSON.stringify(join(import.meta.dir, "../src/main.ts"))});
    const realSI = globalThis.setInterval;
    globalThis.setInterval = (f, ms, ...a) => realSI(f, ms > 1000 ? 100 : ms, ...a); // 10 秒の見張りを 100ms に縮める
    const s = await startDaemon(${JSON.stringify(join(d, "s.sock"))});
    s.stop(true);
    await new Promise((r) => setTimeout(r, 1000));
    console.log("SURVIVED");
    process.exit(7);
  `;
  const p = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "pipe", env: { ...process.env, KANGAE_PARENT_PID: "" } });
  const out = await new Response(p.stdout).text();
  const rc = await p.exited;
  rmSync(d, { recursive: true, force: true });
  expect(out).toContain("SURVIVED");
  expect(rc).toBe(7);
}, 20000);

test("suite 門: N pass / N fail の行が無い出力は赤", async () => {
  const dir = mktmp("h21s");
  await Bun.write(join(dir, "a.test.ts"), `import {test} from "bun:test"; test("x",()=>{}); test("y",()=>{ process.exit(0); });`);
  const root = join(import.meta.dir, "..");
  const bad = Bun.spawn(["bun", join(root, "tools/suite.ts"), join(dir, "a.test.ts")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await bad.exited;
  expect(await bad.exited).toBe(1);
  await Bun.write(join(dir, "b.test.ts"), `import {test} from "bun:test"; test("x",()=>{});`);
  const ok = Bun.spawn(["bun", join(root, "tools/suite.ts"), join(dir, "b.test.ts")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(await ok.exited).toBe(0);
  rmSync(dir, { recursive: true, force: true });
}, 30000);
