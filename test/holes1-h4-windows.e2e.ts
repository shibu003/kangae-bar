// holes-1 H4: 試験が「自分の Chromium の窓」を OS に作るか（win-count の allWindows）を、headed と headless で比べる。使い方: bun test/holes1-h4-windows.e2e.ts <win-count>
// headed（陽性対照）は窓が多く Dock に出る app になり、--headless=new は Dock に出ず窓も少ない（残る 1 つは画面に出ない補助）。これが「web-lease / web-w2f を headless にした直し」の根拠。自分の user-data-dir の Chromium だけを止める
import { mktmp } from "./tmp.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_APP } from "../src/launch.ts";
const WC = process.argv[2]!;
const results: Record<string, number> = {}; const dock: Record<string, number> = {};
for (const mode of ["headed", "headless"]) {
  const D = mktmp("kangae-h4"); const port = 9300 + Math.floor(Math.random() * 500);
  Bun.spawn(["open", "-g", "-n", "-a", CHROMIUM_APP, "--args", `--user-data-dir=${D}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--no-startup-window", ...(mode === "headless" ? ["--headless=new"] : [])], { stdout: "ignore", stderr: "ignore" });
  let ws = ""; for (let i = 0; i < 60 && !ws; i++) { try { ws = ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as any).webSocketDebuggerUrl; } catch { await Bun.sleep(500); } }
  const sock = new WebSocket(ws); await new Promise((r) => (sock.onopen = r));
  const send = (m: string, p: object) => new Promise<any>((res) => { sock.onmessage = (e) => res(JSON.parse(String(e.data))); sock.send(JSON.stringify({ id: 1, method: m, params: p })); });
  await send("Target.createTarget", { url: "about:blank", newWindow: true, background: true }); await Bun.sleep(2500);
  const pid = Number(Bun.spawnSync(["bash", "-c", `pgrep -f -- '--user-data-dir=${D}' | while read p; do ps -p $p -o command= | grep -q -- '--type=' || echo $p; done | head -1`]).stdout.toString().trim() || 0);
  const wc = JSON.parse(Bun.spawnSync([WC, String(pid)]).stdout.toString());
  results[mode] = wc.allWindows; dock[mode] = wc.dockMine; console.log(`  ${mode} の窓: ${JSON.stringify(wc.windows)}`); console.log(`${mode}: pid=${pid} allWindows=${wc.allWindows} onscreen=${wc.onscreen} dockMine=${wc.dockMine}`);
  for (const p of Bun.spawnSync(["pgrep", "-f", D]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  await Bun.sleep(1500); rmSync(D, { recursive: true, force: true });
}
const ok = results.headed! > results.headless! && dock.headed === 1 && dock.headless === 0;
console.log(ok ? "PASS headed は窓が多く Dock に出る（陽性対照）・headless は窓が少なく Dock に出ない" : `FAIL ${JSON.stringify(results)}`);
process.exit(ok ? 0 : 1);
