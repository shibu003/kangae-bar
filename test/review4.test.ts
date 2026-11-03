// review4: holes-8 / holes-9 / headlessfix の攻撃
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHome, watchParent } from "../src/main";
import { headlessUrl } from "../src/headless";
import { armExe } from "./exe";

test("watchParent の既定の生死: 生きている pid では止まらず、居ない pid では止まる", async () => {
  let stopped = 0;
  const live = watchParent({ KANGAE_PARENT_PID: String(process.pid) }, () => stopped++, 5)!;
  await Bun.sleep(40); expect(stopped).toBe(0); clearInterval(live);
  const dead = Bun.spawnSync(["true"]).pid; // 終わった子の pid
  const gone = watchParent({ KANGAE_PARENT_PID: String(dead) }, () => stopped++, 5)!;
  await Bun.sleep(40); expect(stopped).toBeGreaterThan(0); clearInterval(gone);
});

test("resolveHome: 空文字の KANGAE_HOME でも試験の下では throw（owner の home に落ちない）・製品は既定", () => {
  expect(() => resolveHome({ NODE_ENV: "test", KANGAE_HOME: "" })).toThrow();
  expect(resolveHome({ NODE_ENV: "production" })).toMatch(/Application Support\/Kangae$/);
});

test("headlessUrl: 起動が締切を越えて throw しても busy は戻り、結果を覚えず次の呼びで起こし直す", async () => {
  const d = mktmp("kangae-r4");
  const fake = join(d, "chrome"); writeFileSync(fake, "#!/bin/sh\nsleep 5\n"); armExe(fake);
  const env = { ...process.env, KANGAE_HEADLESS_CHROME: fake, KANGAE_HEADLESS_WAIT_MS: "300", KANGAE_HEADLESS_IDLE_MS: "50" };
  await expect(headlessUrl(d, env)).rejects.toThrow(/起きませんでした/);
  await expect(headlessUrl(d, env)).rejects.toThrow(/起きませんでした/); // 失敗を覚えていたら即 resolve / 同じ promise
  await Bun.sleep(150); // idle timer が busy 戻りで再び張られても例外を出さない
});
