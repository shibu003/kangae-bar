// holes-4 H9 の切り分け probe（手で回す: tools/e2e-lock.sh bun test/holes4-sw-probe.e2e.ts [秒]）。
// 拡張を load した headless Chromium（web-w2f と同じ起こし方）で、sw が「無い / 止まっている / 起こせば出る」のどれかを
// 2 秒ごとの target 一覧の原文（/json/list と browser の Target.getTargets）で残す。直さない・解釈は最後の 1 行だけ。
// 流れ: 0〜NUDGE 秒は何もしない → NUDGE 秒で http の頁を 1 枚開いて閉じる → 続けて見る。profile の Preferences に拡張の状態（disable_reasons・state）も残す。
import { mktmp } from "./tmp.ts";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_APP, chromiumArgs, prepare, resetWorkers, stageExtension } from "../src/launch.ts";

const root = join(import.meta.dir, "..");
const D = mktmp("kangae-h4sw");
const profile = join(D, "profile");
const port = 9300 + Math.floor(Math.random() * 500);
const TOTAL = Number(process.argv[2] ?? 90), NUDGE = 40;
const t0 = Date.now();
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
say(`load=${Bun.spawnSync(["sh", "-c", "uptime | sed 's/.*averages: //'"]).stdout.toString().trim()} port=${port}`);

const get = async (p: string, init?: RequestInit) => (await fetch(`http://127.0.0.1:${port}${p}`, { ...init, signal: AbortSignal.timeout(4000) })).json() as Promise<any>;
const browserTargets = (ws: string): Promise<any[]> => new Promise((res) => {
  const w = new WebSocket(ws); const t = setTimeout(() => { try { w.close(); } catch {} res([{ error: "timeout" }]); }, 4000);
  w.onerror = () => { clearTimeout(t); res([{ error: "ws" }]); };
  w.onopen = () => w.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
  w.onmessage = (e) => { clearTimeout(t); try { w.close(); } catch {} res(JSON.parse(String(e.data)).result?.targetInfos ?? [{ error: "noresult" }]); };
});
const short = (ts: any[]) => ts.map((t) => `${t.type}:${String(t.url ?? t.error).slice(0, 70)}`).join(" | ");

const o = { app: CHROMIUM_APP, profile, hostBinary: join(D, "no-such-host"), extensionDir: join(root, "extension"), mockKeychain: true, extraArgs: [`--remote-debugging-port=${port}`, "--no-startup-window", "--headless=new"] };
prepare(o);
const ext = stageExtension(o.extensionDir, join(D, "extension"));
resetWorkers(profile, JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")).version);
const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<title>nudge</title>nudge", { headers: { "content-type": "text/html" } }) });
Bun.spawn(["open", "-g", "-n", "-a", CHROMIUM_APP, "--args", ...chromiumArgs(o, ext), ...(o.extraArgs ?? [])], { stdout: "ignore", stderr: "ignore" });

let firstSw = -1, nudged = false, lastSw = "", swEver = false;
const swIn = (ts: any[]) => ts.filter((t) => t.type === "service_worker" && String(t.url).includes("sw.js"));
while (Date.now() - t0 < TOTAL * 1000) {
  const s = ((Date.now() - t0) / 1000).toFixed(0);
  try {
    const list = await get("/json/list");
    const ver = await get("/json/version").catch(() => null);
    const bt = ver?.webSocketDebuggerUrl ? await browserTargets(ver.webSocketDebuggerUrl) : [];
    const sw = swIn(list), swb = swIn(bt);
    const now = `list ${list.length}件 sw=${sw.length} / browser ${bt.length}件 sw=${swb.length}`;
    if ((sw.length || swb.length) && firstSw < 0) firstSw = Date.now() - t0;
    if (sw.length || swb.length) swEver = true;
    const state = `${now} :: ${short(list)} || B: ${short(bt)}`;
    if (state !== lastSw || Number(s) % 10 === 0) say(state);
    lastSw = state;
    if (!nudged && Date.now() - t0 > NUDGE * 1000) {
      nudged = true; say(`NUDGE: http の頁を開く（sw が居ない=${!(sw.length || swb.length)}）`);
      const nt = await get(`/json/new?${encodeURI(`http://127.0.0.1:${srv.port}/`)}`, { method: "PUT" }).catch((e) => { say(`nudge 失敗 ${e}`); return null; });
      await Bun.sleep(1500); if (nt?.id) await get(`/json/close/${nt.id}`).catch(() => {});
    }
  } catch (e) { say(`debug port: ${(e as Error).name}`); }
  await Bun.sleep(2000);
}
// 拡張の状態（profile の Preferences。Secure Preferences にある事もある）
for (const f of ["Default/Preferences", "Default/Secure Preferences"]) {
  const p = join(profile, f); if (!existsSync(p)) { say(`${f}: 無し`); continue; }
  const ex = JSON.parse(readFileSync(p, "utf8"))?.extensions?.settings ?? {};
  for (const [id, v] of Object.entries<any>(ex)) if (v?.path?.includes?.("kangae-h4sw") || v?.manifest?.name) say(`${f}: ${id} state=${v.state} disable_reasons=${JSON.stringify(v.disable_reasons)} location=${v.location} path=${v.path}`);
}
say(`結論の材料: sw が一度でも出た=${swEver} 初出=${firstSw < 0 ? "なし" : (firstSw / 1000).toFixed(1) + "s"} NUDGE 前に出た=${firstSw >= 0 && firstSw < NUDGE * 1000}`);
Bun.spawnSync(["sh", "-c", `pkill -f -- "--user-data-dir=${profile}" ; true`]);
srv.stop(); process.exit(0);
