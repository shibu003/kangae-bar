// W3c 先の測り 0: 隔離 profile の Google Chrome に拡張が入るか（--load-extension が今の版で効くか）・Dock と窓の増え方
// 使い方: bun test/w3c-launch.ts [--flag-off] [--direct]   後始末まで 1 本。owner の Chrome には触らない（pid は自分の user-data-dir で引く）
import { mktmp } from "./tmp.ts";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageExtension } from "../src/launch.ts";
const root = join(import.meta.dir, "..");
const D = mktmp("kangae-w3c");
const profile = join(D, "profile"); mkdirSync(profile, { recursive: true });
const port = 9300 + Math.floor(Math.random() * 500);
const t0 = Date.now(); const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const app = "/Applications/Google Chrome.app";
const ext = stageExtension(join(root, "extension"), join(D, "extension"));
const flagOff = process.argv.includes("--flag-off"); const direct = process.argv.includes("--direct");
const cdpLoad = process.argv.includes("--cdp-load");
const args = [`--user-data-dir=${profile}`, ...(cdpLoad ? [] : [`--load-extension=${ext}`]), `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--no-startup-window", ...(process.argv.includes("--cdp-load") ? ["--enable-unsafe-extension-debugging"] : []), ...(flagOff ? ["--disable-features=DisableLoadExtensionCommandLineSwitch"] : [])];
const mainPid = () => Number(Bun.spawnSync(["bash", "-c", `pgrep -f -- '--user-data-dir=${profile}' | while read p; do ps -p $p -o command= | grep -q -- '--type=' || echo $p; done | head -1`]).stdout.toString().trim() || 0);
const wc = () => Bun.spawnSync(["/tmp/kw-win-count", String(mainPid())]).stdout.toString().trim();
try {
  say(`起動前 win-count: ${Bun.spawnSync(["/tmp/kw-win-count", "1"]).stdout.toString().trim()}`);
  if (direct) Bun.spawn([join(app, "Contents/MacOS/Google Chrome"), ...args], { stdout: "ignore", stderr: "ignore", detached: true }).unref();
  else Bun.spawn(["open", "-g", "-n", "-a", app, "--args", ...args], { stdout: "ignore", stderr: "ignore" });
  say(`起動 (${direct ? "direct exec" : "open -g -n"} flagOff=${flagOff})`);
  if (cdpLoad) {
    let ws: WebSocket | null = null;
    for (let i = 0; i < 30 && !ws; i++) { try { const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as any; const w = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r, j) => { w.onopen = r; w.onerror = j; }); ws = w; } catch { await Bun.sleep(500); } }
    const r = await new Promise<any>((res) => { ws!.onmessage = (e) => res(JSON.parse(String(e.data))); ws!.send(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: ext } })); });
    say(`Extensions.loadUnpacked → ${JSON.stringify(r).slice(0, 200)}`);
  }
  let list: any[] = [];
  for (let i = 0; i < 30; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[]; if (list.some((t) => t.url.includes("kmhgbmikobfdminananoaeheobngmaef"))) break; } catch {} await Bun.sleep(500); }
  say(`targets: ${JSON.stringify(list.map((t) => [t.type, t.url.slice(0, 60)]))}`);
  say(`pid=${mainPid()} win-count: ${wc()}`);
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as any; say(`version: ${v.Browser}`);
} catch (e) { say("ERROR " + (e as Error).message); }
for (const p of Bun.spawnSync(["pgrep", "-f", D]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
await Bun.sleep(1500); rmSync(D, { recursive: true, force: true }); say("後始末 済み");
process.exit(0);
