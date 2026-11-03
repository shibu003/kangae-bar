// 前面を奪わない面の用意の実測（W2f ④）。front-watch を「何かを起こす前」から「後始末の後」まで切らずに回し、各手の時刻を同じ時計で並べる。
// 使い方: bun test/front-probe.e2e.ts /path/to/front-watch
import { mktmp } from "./tmp.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_APP, chromiumArgs, prepare, resetWorkers, stageExtension } from "../src/launch.ts";
import { spawnDaemon } from "./spawn-daemon";

const root = join(import.meta.dir, "..");
const D = mktmp("kangae-fp");
const sock = join(D, "s.sock");
const bin = join(D, "kangae");
const cdpPort = 9300 + Math.floor(Math.random() * 500);
const profile = join(D, "profile");
const env = { KANGAE_HOME: join(D, "home"), KANGAE_SOCK: sock };
const t0 = Date.now();
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new Response(`<!doctype html><title>${new URL(r.url).searchParams.get("n")}</title>x`, { headers: { "content-type": "text/html" } }) });
const url = (n: string) => `http://127.0.0.1:${server.port}/p?n=${n}`;
// ---- 常駐への口 ----
async function ask(m: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    let buf = "";
    Bun.connect({ unix: sock, socket: { data(s, c) { buf += new TextDecoder().decode(c); for (const l of buf.split("\n")) { try { const j = JSON.parse(l); if (j.id === id) { s.end(); resolve(j); } } catch {} } }, error() {} } }).then((s) => s.write(JSON.stringify({ id, ...m }) + "\n"), () => resolve(null));
  });
}
const act = (token: string, tool: string, args: object) => {
  const r = Bun.spawnSync([bin, "act", tool, JSON.stringify(args)], { env: { ...process.env, ...env, KANGAE_LEASE: token } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

// ---- CDP（人の代役と、拡張の sw に tabId を聞く用。agent の道には使わない） ----
async function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m); };
  return { send: (method: string, params: object = {}) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}
const jget = async (p: string) => (await fetch(`http://127.0.0.1:${cdpPort}${p}`)).json() as Promise<any>;
const targets = async () => (await jget("/json/list")).filter((t: any) => t.type === "page");
const evalIn = async (wsUrl: string, expr: string): Promise<any> => { const c = await cdp(wsUrl); const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); c.close(); if (r.result?.exceptionDetails || r.error) throw new Error("evalIn: " + JSON.stringify(r).slice(0, 300)); return r.result?.result?.value; };
const page = async (n: string) => (await targets()).find((t: any) => t.url.includes(`n=${n}`));
const typeKey = async (wsUrl: string, ch: string) => { const c = await cdp(wsUrl); await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }); await Bun.sleep(150); for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, text: ch, key: ch }); await Bun.sleep(100); c.close(); };


// --stress: 全 CPU を埋めた状態で測る（移動の開始の遅れの tail を見る。測定が済んだら必ず止める）
const burners = process.argv.includes("--stress") ? Array.from({ length: Number(Bun.spawnSync(["sysctl", "-n", "hw.logicalcpu"]).stdout.toString()) * 2 }, () => Bun.spawn(["yes"], { stdout: "ignore", stderr: "ignore" })) : [];
const cleanup = () => {
  for (const b of burners) try { b.kill(); } catch {}
  for (const p of Bun.spawnSync(["pgrep", "-f", D]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  for (const p of Bun.spawnSync(["lsof", "-t", sock]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  server.stop(true);
  rmSync(D, { recursive: true, force: true });
};

const control = process.argv[3] === "--control"; // 陽性対照: 窓つきで起こす（奪う事が分かっている起こし方。測りが奪いを検出できる事の証明）
const fw = Bun.spawn([process.argv[2]!, "75"], { stdout: "pipe" }); // 最初に起こす。後始末が済むまで切らない
const fwStart = Date.now();
say("front-watch 開始（75 秒・何も起こす前から）");
const jlist = async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as any[];
try {
  // 常駐は拡張の native host のために要る
  const b = Bun.spawnSync(["bun", "build", "--compile", join(root, "src/main.ts"), "--outfile", bin], { cwd: root });
  if (b.exitCode !== 0) throw new Error("build 失敗");
  spawnDaemon([bin, "--daemon"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
  for (let i = 0; i < 60 && !(await ask({ op: "ping" })); i++) await Bun.sleep(250);
  const o = { app: CHROMIUM_APP, profile, hostBinary: bin, extensionDir: join(root, "extension"), mockKeychain: true, extraArgs: [`--remote-debugging-port=${cdpPort}`, ...(control ? [url("startup")] : ["--no-startup-window"])] };
  prepare(o);
  const ext = stageExtension(o.extensionDir, join(D, "extension"));
  resetWorkers(profile, JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")).version);
  say("手 0: open -g -n -a Chromium --no-startup-window（窓なし）");
  Bun.spawn(["open", "-g", "-n", "-a", CHROMIUM_APP, "--args", ...chromiumArgs(o, ext), ...(o.extraArgs ?? [])], { stdout: "ignore", stderr: "ignore" });
  let sw: any;
  for (let i = 0; i < 40 && !sw; i++) { try { const c = (await jlist()).find((t) => t.type === "service_worker" && t.url.includes("sw.js")); if (c && (await evalIn(c.webSocketDebuggerUrl, "!!chrome.tabs").catch(() => false)) === true) sw = c; } catch {} if (!sw) await Bun.sleep(500); }
  if (!sw) throw new Error("sw が出ない");
  const inSw = (expr: string) => evalIn(sw.webSocketDebuggerUrl, `(async()=>{return JSON.stringify(await (${expr}))})()`);
  say("手 0 の後: sw が動いた（窓は " + await inSw("chrome.windows.getAll().then(a=>a.length)") + " 枚）");
  await Bun.sleep(5000);
  if (control) throw new Error("control: ここまで");
  const step = async (name: string, expr: string) => { say(`手: ${name}`); const r = await inSw(expr).catch((e) => "ERR " + e.message); say(`  → ${String(r).slice(0, 120)}`); await Bun.sleep(5000); };
  await step("C2 chrome.windows.create({state:'minimized'})（最初の窓。窓が 0 の browser に作る）", `chrome.windows.create({url:${JSON.stringify(url("c2"))},state:"minimized"}).then(w=>({id:w.id,state:w.state,focused:w.focused}))`);
  await step("C3 既存の窓に chrome.tabs.create({active:false})", `chrome.windows.getAll().then(ws=>chrome.tabs.create({url:${JSON.stringify(url("c3"))},active:false,windowId:ws[0].id})).then(t=>({id:t.id,active:t.active}))`);
  await step("C1 chrome.windows.create({focused:false})（2 枚目）", `chrome.windows.create({url:${JSON.stringify(url("c1"))},focused:false}).then(w=>({id:w.id,state:w.state,focused:w.focused}))`);
  say("手: C4 CDP Target.createTarget({newWindow:true, background:true})（3 枚目）");
  { const c = await cdp((await jget("/json/version")).webSocketDebuggerUrl); const r = await c.send("Target.createTarget", { url: url("c4"), newWindow: true, background: true }); say("  → " + JSON.stringify(r).slice(0, 100)); c.close(); await Bun.sleep(5000); }
  await step("対照 chrome.windows.create({})（既定。focused 指定なし）", `chrome.windows.create({url:${JSON.stringify(url("ctl"))}}).then(w=>({id:w.id,focused:w.focused}))`);
} catch (e) {
  say("ERROR " + (e as Error).stack);
}
// 後始末（測定の中）
say("後始末: Chromium を止める");
for (const p of Bun.spawnSync(["pgrep", "-f", D]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
for (const p of Bun.spawnSync(["lsof", "-t", sock]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
server.stop(true);
rmSync(D, { recursive: true, force: true });
say("後始末 済み");
await Bun.sleep(Math.max(0, 76_000 - (Date.now() - fwStart)));
console.log("--- front-watch 全文（最初から後始末の後まで・切っていない）---\n" + (await new Response(fw.stdout).text()).trim());
process.exit(0);
