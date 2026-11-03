import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headlessArgs, headlessHold, headlessUrl, probeBrowser } from "../src/headless.ts";
import { pollUntil } from "../src/wait.ts";
import { armExe } from "./exe";

test("headless: --headless=new・自前の profile で起こし、port は DevToolsActivePort から読む。2 回目は起こし直さない", async () => {
  const dir = mktmp("hl");
  const fake = join(dir, "fake-chrome");
  // 本物の Chromium の代わり: 引数を記録し、port 0 で /json/version を返して profile/DevToolsActivePort を書く
  writeFileSync(fake, `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const profile = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice(16);
appendFileSync(${JSON.stringify(join(dir, "argv.log"))}, process.argv.slice(2).join(" ") + "\\n");
const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ Browser: "fake" }) });
writeFileSync(profile + "/DevToolsActivePort", s.port + "\\n/devtools/browser/x\\n");
setTimeout(() => process.exit(0), 30000); // 試験が終わっても残らない
`);
  armExe(fake);
  const home = join(dir, "home");
  const url = await headlessUrl(home, { KANGAE_HEADLESS_CHROME: fake });
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(await headlessUrl(home, { KANGAE_HEADLESS_CHROME: fake })).toBe(url);
  const argv = readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n");
  expect(argv.length).toBe(1);
  expect(argv[0]).toBe(headlessArgs(join(home, "agent-browser")).join(" "));
  expect(argv[0]).toContain("--headless=new");
  expect(argv[0]).toContain("--use-mock-keychain"); // Keychain の問い（UserNotificationCenter が前面になる）を出さない
  expect(argv[0]).not.toContain("--remote-debugging-port=9339");
});

test("H5: 使われなくなったら止まり・次で起こし直す・turn の間（hold）は止めない", async () => {
  const dir = mktmp("hl-idle");
  const fake = join(dir, "fake-chrome");
  writeFileSync(fake, `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const profile = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice(16);
appendFileSync(${JSON.stringify(join(dir, "argv.log"))}, process.pid + "\\n");
const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ Browser: "fake" }) });
writeFileSync(profile + "/DevToolsActivePort", s.port + "\\n/devtools/browser/x\\n");
setTimeout(() => process.exit(0), 30000);
`);
  armExe(fake);
  const home = join(dir, "home");
  const env = { KANGAE_HEADLESS_CHROME: fake, KANGAE_HEADLESS_IDLE_MS: "600", KANGAE_HEADLESS_WAIT_MS: "150000" }; // 起動の締切は実の時間（load 500 では bun の起動だけで 45 秒を越えた）
  const starts = () => readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n");
  const port = (u: string) => Number(new URL(u).port);
  const gone = async (p: number) => !!(await pollUntil(async () => (await probeBrowser(p)) === null, 20_000, 200));

  const u1 = (await headlessUrl(home, env))!;
  const release = headlessHold(home); // turn の間
  await Bun.sleep(1500);
  expect(await probeBrowser(port(u1))).toBe(u1); // hold 中は idle を過ぎても生きている（負の対照: hold を外すと次で死ぬ）
  release();
  expect(await gone(port(u1))).toBe(true); // 使い終わって idle を過ぎたら止まる（締切は Date.now 基準・混雑で timer が遅れても実の 20 秒まで待つ）
  expect(starts().length).toBe(1);
  const u2 = (await headlessUrl(home, env))!; // 次の turn でまた読める
  expect(await probeBrowser(port(u2))).toBe(u2);
  expect(starts().length).toBe(2);
  expect(await gone(port(u2))).toBe(true);
}, 240_000); // 実の待ち（idle 600ms の後の停止を最大 20 秒 poll）が 5 秒の既定を超える（既定のまま足して単独でも落ちていた）

// 起動が遅い fake（混雑の Chrome）。delay ms 後に port を書く
function slowFake(dir: string, delay: number) {
  const fake = join(dir, "slow-chrome");
  writeFileSync(fake, `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const profile = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice(16);
appendFileSync(${JSON.stringify(join(dir, "argv.log"))}, process.pid + "\\n");
setTimeout(() => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ Browser: "fake" }) });
  writeFileSync(profile + "/DevToolsActivePort", s.port + "\\n/devtools/browser/x\\n");
}, ${delay});
setTimeout(() => process.exit(0), 30000);
`);
  armExe(fake);
  return fake;
}

test("headless: 起動が遅くても締切（実の時間）まで待ち、同時の 2 つの頼みで Chrome は 1 本", async () => {
  const dir = mktmp("hl-slow");
  const env = { KANGAE_HEADLESS_CHROME: slowFake(dir, 1500), KANGAE_HEADLESS_WAIT_MS: "20000" };
  const home = join(dir, "home");
  const [a, b] = await Promise.all([headlessUrl(home, env), headlessUrl(home, env)]);
  expect(a).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(b).toBe(a);
  expect(readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").length).toBe(1);
  // 締切を短くすると（= 待ちを固定回数にした実装と同じ）赤くなる: 負の対照は下の「越えたら Error」
}, 30_000);

test("headless: 締切を越えたら黙って null にせず、人に分かる 1 行の Error（次の頼みは起こし直す）", async () => {
  const dir = mktmp("hl-late");
  const home = join(dir, "home");
  const late = { KANGAE_HEADLESS_CHROME: slowFake(dir, 3000), KANGAE_HEADLESS_WAIT_MS: "800" };
  const t0 = Date.now();
  const err = await headlessUrl(home, late).then(() => null, (e: Error) => e);
  expect(err?.message).toMatch(/agent 用の browser が起きませんでした.*もう一度/);
  expect(Date.now() - t0).toBeLessThan(5000);
  const ok = await headlessUrl(home, { KANGAE_HEADLESS_CHROME: slowFake(dir, 0) }); // memo は残らない
  expect(ok).toMatch(/^http/);
}, 30_000);
