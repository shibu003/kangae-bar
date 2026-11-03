// 本物の Chromium で tab を 14 枚開き、生きている tab が 8 に収まるか見る（CHROMIUM_APP=... bun test/tabs.e2e.ts）
// W3b-3: headless で回す（検査の中身は変えていない）。
import { mktmp } from "./tmp.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_APP, launch } from "../src/launch.ts";

const root = join(import.meta.dir, "..");
const dir = mktmp("kangae-tabs");
const port = 9300 + Math.floor(Math.random() * 500);
const proc = launch({
  app: CHROMIUM_APP,
  profile: join(dir, "profile"),
  hostBinary: join(root, "dist/kangae"),
  extensionDir: join(root, "extension"),
  mockKeychain: true,
  extraArgs: ["--headless=new", `--remote-debugging-port=${port}`, "about:blank"],
  env: { KANGAE_HOME: join(dir, "home"), KANGAE_SOCK: join(dir, "s.sock"), KANGAE_PROFILE: join(dir, "profile") },
});
const kill = () => {
  proc.kill();
  for (const p of Bun.spawnSync(["lsof", "-t", join(dir, "s.sock")]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  rmSync(dir, { recursive: true, force: true });
};
setTimeout(() => { console.log("TIMEOUT"); kill(); process.exit(2); }, 120_000);

const ws = async (u: string) => {
  const s = new WebSocket(u);
  await new Promise((r) => (s.onopen = r));
  let id = 0;
  const p = new Map<number, (v: any) => void>();
  s.onmessage = (e) => { const m = JSON.parse(String(e.data)); p.get(m.id)?.(m); };
  return (method: string, params: object = {}) => new Promise<any>((res) => { const i = ++id; p.set(i, res); s.send(JSON.stringify({ id: i, method, params })); });
};
try {
  let ver: any, sw: any;
  for (let i = 0; i < 60 && !sw; i++) {
    await Bun.sleep(1000);
    try {
      ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      sw = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[]).find((t) => t.type === "service_worker" && t.url.endsWith("/sw.js"));
    } catch {}
  }
  if (!sw) throw new Error("sw が見つからない");
  const browser = await ws(ver.webSocketDebuggerUrl);
  for (let i = 0; i < 14; i++) { await browser("Target.createTarget", { url: `data:text/html,<title>t${i}</title>${i}` }); await Bun.sleep(400); }
  await Bun.sleep(4000);
  const s = await ws(sw.webSocketDebuggerUrl);
  const r = await s("Runtime.evaluate", { expression: "chrome.tabs.query({}).then(t=>JSON.stringify({all:t.length,live:t.filter(x=>!x.discarded).length}))", awaitPromise: true, returnByValue: true });
  const o = JSON.parse(r.result.result.value);
  console.log(o);
  process.exitCode = o.all >= 14 && o.live <= 8 ? 0 : 1;
} finally { kill(); process.exit(process.exitCode ?? 1); }
