// holes-14 の probe（手で回す: bun test/panel-probe.e2e.ts）。dm.e2e が「Page.navigate が 60 秒返らない」根を切り分ける。
// 常駐の /panel が headers を返すまでの実時間（fetch 直・5 回）と、同じ頁を headless Chrome で開いた時の Page.navigate の実時間を、手ごとに並べる。token は出さない。
import { mktmp } from "./tmp.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { cdpOpen } from "./cdp-sw.ts";
import { spawnDaemon } from "./spawn-daemon";
import { pollUntil } from "../src/wait.ts";

const D = mktmp("kangae-pp");
const repo = join(import.meta.dir, "..");
const t0 = Date.now();
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s load ${loadavg()[0]!.toFixed(0)}] ${s}`);
const sock = join(D, "main.sock"), bar = join(D, "main-bar.json"), home = join(D, "home");
mkdirSync(home, { recursive: true });
const proc = spawnDaemon(["bun", join(repo, "src/main.ts"), "--daemon"], { env: { ...(process.env as Record<string, string>), KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_BAR: bar, KANGAE_NODES_DIR: join(D, "nodes") }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
const cdpPort = 9900 + Math.floor(Math.random() * 90);
const chrome = Bun.spawn(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(D, "profile")}`, "--window-size=480,820", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdout: "ignore", stderr: "ignore" });
const step = async (name: string, f: () => Promise<unknown>) => {
  const s = Date.now();
  try { const r = await f(); say(`${name}: ${Date.now() - s}ms ${r ?? ""}`); } catch (e) { say(`${name}: ${Date.now() - s}ms 失敗 ${(e as Error).message}`); }
};
try {
  await pollUntil(() => existsSync(bar) && existsSync(sock), 60_000, 100);
  const j = JSON.parse(readFileSync(bar, "utf8")) as { port: number; token: string };
  say(`常駐 pid ${proc.pid} port ${j.port}`);
  const url = `http://127.0.0.1:${j.port}/panel?token=${j.token}`;
  for (let i = 0; i < 5; i++) await step(`fetch /panel headers #${i}`, async () => { const r = await fetch(url, { signal: AbortSignal.timeout(60_000) }); const h = Date.now(); await r.text(); return `status ${r.status}・body ${Date.now() - h}ms`; });
  let page: Awaited<ReturnType<typeof cdpOpen>> | undefined;
  await step("cdpOpen（/json/new で /panel を開く）", async () => { page = await cdpOpen(cdpPort, url); });
  if (page) {
    await step("title（開いた直後）", async () => JSON.stringify(await page!.ev("document.title + '|' + document.readyState + '|' + location.pathname")));
    await step("Page.navigate 同じ url", () => page!.send("Page.navigate", { url }));
    await step("title（navigate 後）", async () => JSON.stringify(await page!.ev("document.title + '|' + document.readyState")));
    await step("Page.navigate url&b=1", () => page!.send("Page.navigate", { url: `${url}&b=1` }));
    await step("Page.navigate about:blank", () => page!.send("Page.navigate", { url: "about:blank" }));
    await step("Page.navigate url（blank の後）", () => page!.send("Page.navigate", { url }));
    page.close();
  }
} finally {
  try { chrome.kill(); } catch {}
  try { proc.kill(); } catch {}
  await Bun.sleep(300);
  rmSync(D, { recursive: true, force: true });
  process.exit(0);
}
