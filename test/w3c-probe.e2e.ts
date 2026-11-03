// W3c §1 の測り（a）sw の fetch（b）画面の外に置いた窓（c）offscreen 文書。隔離 profile の Google Chrome だけを起こす。
// 使い方: bun test/w3c-probe.e2e.ts /tmp/kw-front-watch /tmp/kw-win-count
//   画面に出た物は win-count（CGWindowList・指した pid の窓だけ）と tab の数で数える。人の画面の写真は撮らない。
//   拡張は Chrome 154 で --load-extension が効かないので、試験だけ CDP Extensions.loadUnpacked で入れる（--enable-unsafe-extension-debugging・隔離 profile のみ。製品の道ではない）。
import { mktmp } from "./tmp.ts";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageExtension } from "../src/launch.ts";

const root = join(import.meta.dir, "..");
const [FW, WC] = [process.argv[2]!, process.argv[3]!];
const D = mktmp("kangae-w3c");
const profile = join(D, "profile"); mkdirSync(profile, { recursive: true });
const port = 9300 + Math.floor(Math.random() * 500);
const t0 = Date.now(); const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const app = "/Applications/Google Chrome.app";
const FW_SEC = 150;
const fw = Bun.spawn([FW, String(FW_SEC)], { stdout: "pipe" }); const fwStart = Date.now();

// ---- 試験の site（login が要る）。リクエストごとに Cookie / Sec-Fetch-Site / 呼び出し元を記録する ----
const seen: string[] = [];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  const u = new URL(r.url); const ck = r.headers.get("cookie") ?? "";
  seen.push(`${u.pathname}${u.search} cookie=[${ck}] site=${r.headers.get("sec-fetch-site")} dest=${r.headers.get("sec-fetch-dest")}`);
  if (u.pathname === "/login") return new Response("logged in", { headers: [["set-cookie", "sid=SECRET1; Path=/; HttpOnly"], ["set-cookie", "lax=L1; Path=/; SameSite=Lax"], ["set-cookie", "strict=S1; Path=/; SameSite=Strict"]] });
  if (u.pathname === "/data") return new Response(/sid=SECRET1/.test(ck) ? "balance=1234" : "login required", { headers: { "cache-control": "no-store" } });
  if (u.pathname === "/app" || u.pathname === "/xfo") return new Response(`<!doctype html><title>app</title><table id=t></table><script>
let raf=0;(function f(){raf++;requestAnimationFrame(f)})();let tick=0;setInterval(()=>tick++,100);
fetch("/data").then(r=>r.text()).then(v=>{t.innerHTML="<tr><td>"+v+"</td></tr>";});
setTimeout(()=>{const o={table:document.getElementById("t").innerText,vis:document.visibilityState,raf,tick};window.__o=o;try{parent.postMessage({kangae:o},"*")}catch{}},1500);</script>`, { headers: { "content-type": "text/html; charset=utf-8", ...(u.pathname === "/xfo" ? { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } : {}) } });
  return new Response("404", { status: 404 });
} });
const base = `http://127.0.0.1:${server.port}`;

// ---- Chrome を起こす（open -g -n・窓なし・隔離 profile） ----
const ext = stageExtension(join(root, "extension"), join(D, "extension"));
const m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")); m.permissions.push("offscreen"); m.content_scripts = [{ matches: ["http://127.0.0.1/*"], js: ["probe-cs.js"], all_frames: true, run_at: "document_idle" }];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));
writeFileSync(join(ext, "probe-cs.js"), `chrome.runtime.sendMessage({op:"probeCs",url:location.href,isTop:window===window.top,ancestor:location.ancestorOrigins?[...location.ancestorOrigins]:null}).catch(()=>{})`);
writeFileSync(join(ext, "probe-off.html"), `<!doctype html><script src="probe-off.js"></script>`);
writeFileSync(join(ext, "probe-off.js"), `addEventListener("message",e=>{if(e.data?.kangae)chrome.runtime.sendMessage({op:"probeOff",o:e.data.kangae})});chrome.runtime.onMessage.addListener((m)=>{if(m.op==="probeLoad"){let f=document.getElementById("f");if(f)f.remove();f=document.createElement("iframe");f.id="f";f.src=m.url;document.body.append(f)}});`);
const mainPid = () => Number(Bun.spawnSync(["bash", "-c", `pgrep -f -- '--user-data-dir=${profile}' | while read p; do ps -p $p -o command= | grep -q -- '--type=' || echo $p; done | head -1`]).stdout.toString().trim() || 0);
const wc = () => { try { return JSON.parse(Bun.spawnSync([WC, String(mainPid())]).stdout.toString()); } catch { return null; } };
const cdp = async (wsUrl: string) => { const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r)); let id = 0; const pend = new Map<number, (v: any) => void>(); ws.onmessage = (e) => { const j = JSON.parse(String(e.data)); pend.get(j.id)?.(j); }; return { send: (method: string, params: object = {}) => new Promise<any>((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() }; };
const jget = async (p: string) => (await fetch(`http://127.0.0.1:${port}${p}`)).json() as Promise<any>;
let swWs = "";
const inSw = async (expr: string): Promise<any> => { const c = await cdp(swWs); const r = await c.send("Runtime.evaluate", { expression: `(async()=>JSON.stringify(await (${expr})))()`, awaitPromise: true, returnByValue: true }); c.close(); if (r.result?.exceptionDetails) return "ERR " + JSON.stringify(r.result.exceptionDetails).slice(0, 200); const v = r.result?.result?.value; try { return JSON.parse(v); } catch { return v; } };
const counts = async () => { const w = wc(); return { tabs: await inSw("chrome.tabs.query({}).then(a=>a.length)"), wins: await inSw("chrome.windows.getAll().then(a=>a.length)"), os_windows: w?.allWindows, onscreen: w?.onscreen, visible: w?.visible, dockMine: w?.dockMine, dockApps: w?.dockApps, bounds: (w?.windows ?? []).map((x: any) => `${x.x},${x.y} ${x.w}x${x.h} onScreenArea=${x.onScreenArea}`) }; };
const row = async (name: string, extra: unknown = "") => { say(`■ ${name}\n    出た物: ${JSON.stringify(await counts())}\n    結果: ${typeof extra === "string" ? extra : JSON.stringify(extra)}`); };

try {
  say(`起動前: ${JSON.stringify({ ...(wc() ?? {}), windows: undefined })}`);
  Bun.spawn(["open", "-g", "-n", "-a", app, "--args", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--no-startup-window"], { stdout: "ignore", stderr: "ignore" });
  let browserWs = "";
  for (let i = 0; i < 40 && !browserWs; i++) { try { browserWs = (await jget("/json/version")).webSocketDebuggerUrl; } catch { await Bun.sleep(500); } }
  const bc = await cdp(browserWs);
  const lr = await bc.send("Extensions.loadUnpacked", { path: ext }); say(`Extensions.loadUnpacked → ${JSON.stringify(lr)}`);
  for (let i = 0; i < 40 && !swWs; i++) { const c = (await jget("/json/list")).find((t: any) => t.type === "service_worker" && t.url.endsWith("/sw.js")); if (c) swWs = c.webSocketDebuggerUrl; else await Bun.sleep(500); }
  if (!swWs) throw new Error("sw が出ない");
  await Bun.sleep(1500);
  say(`Chrome ${(await jget("/json/version")).Browser} pid=${mainPid()}`);
  await row("0 起動直後（窓なし・拡張あり）= 基準線。dockMine=1 は試験の Chrome 自体（製品が増やした物ではない）");

  // ---------- (a) sw の fetch ----------
  const F = (path: string, extra = "") => `fetch(${JSON.stringify(base + path)},{credentials:"include"${extra}}).then(async r=>({s:r.status,t:(await r.text()).slice(0,100),h:r.headers.get("content-type")}))`;
  const noCookie = await inSw(`fetch(${JSON.stringify(base + "/data")},{credentials:"omit"}).then(r=>r.text())`);
  await row("(a1) fetch /data を cookie なしで", `原文=${JSON.stringify(noCookie)}`);
  // 人の login を再現: 人の tab（CDP の createTarget・試験の準備）で /login → 閉じる。これは準備なので表の外に分けて数える
  const humanTab = await bc.send("Target.createTarget", { url: base + "/login", background: true });
  say(`準備: 人の login の tab を作った（試験の準備・製品の物ではない）→ ${JSON.stringify(humanTab.result)}`);
  await Bun.sleep(1500);
  say(`準備の最中の出た物: ${JSON.stringify(await counts())}`);
  await bc.send("Target.closeTarget", { targetId: humanTab.result.targetId }); await Bun.sleep(1000);
  await row("(準備の後) login の tab を閉じた後");
  const before = await counts();
  const a2 = await inSw(F("/data"));
  const a2b = await inSw(`fetch(${JSON.stringify(base + "/data")}).then(r=>r.text())`);
  const a2c = await inSw(`fetch(${JSON.stringify(base + "/data")},{credentials:"omit"}).then(r=>r.text())`);
  const a3 = await inSw(F("/app"));
  const after = await counts();
  await row("(a2) 人が login した後の fetch /data", { "credentials:include": a2, "既定": a2b, "omit": a2c, "tab・窓の増減": `${before.tabs}→${after.tabs} tab / ${before.wins}→${after.wins} 窓`, "/app の生の HTML に値は在るか": a3.t.includes("balance") });
  say(`サーバーが見た要求（Cookie / Sec-Fetch-Site）:\n    ${seen.slice(-6).join("\n    ")}`);
  const a4 = await inSw(`fetch(${JSON.stringify(base + "/app")},{credentials:"include"}).then(r=>r.text()).then(t=>({hasData:t.includes("balance"),hasTable:/<table id=t><\\/table>/.test(t)}))`);
  say(`(a4) JS で描かれる頁を fetch で取ると: ${JSON.stringify(a4)}（値は入っていない＝描画が要る仕事は fetch では足りない）`);

  // ---------- (b) 画面の外に置いた窓 ----------
  const mk = async (name: string, opts: object) => {
    const r = await inSw(`chrome.windows.create(${JSON.stringify({ url: base + "/app", ...opts })}).then(w=>({id:w.id,left:w.left,top:w.top,width:w.width,height:w.height,state:w.state,focused:w.focused,tab:w.tabs?.[0]?.id}))`);
    await Bun.sleep(3500);
    const probe = r?.tab ? await inSw(`chrome.scripting.executeScript({target:{tabId:${r.tab}},func:()=>window.__o,world:\"MAIN\"}).then(a=>a[0]?.result)`) : null;
    const got = r?.id ? await inSw(`chrome.windows.get(${r.id}).then(w=>({left:w.left,top:w.top,state:w.state}))`) : null;
    await row(name, { 作った時の返り: r, 作った後の位置: got, "頁の中(table/可視/rAF/tick)": probe });
    return r;
  };
  const rm = async (r: any) => { if (r?.id) await inSw(`chrome.windows.remove(${r.id})`); await Bun.sleep(800); };
  const b1 = await mk("(b1) windows.create({left:-10000,top:-10000,width:800,height:600,focused:false})", { left: -10000, top: -10000, width: 800, height: 600, focused: false }); await rm(b1);
  const b2 = await mk("(b2) windows.create({left:99999,top:99999,...focused:false})（右下の遠く）", { left: 99999, top: 99999, width: 800, height: 600, focused: false }); await rm(b2);
  const b3 = await mk("(b3) windows.create({type:'popup',left:-10000,top:-10000,width:400,height:300,focused:false})", { type: "popup", left: -10000, top: -10000, width: 400, height: 300, focused: false }); await rm(b3);
  const b4 = await mk("(b4 対照) windows.create({width:800,height:600,focused:false})（位置の指定なし）", { width: 800, height: 600, focused: false }); await rm(b4);
  // b6: 画面にある窓を後から画面の外へ動かす（update）
  const b6 = await mk("(b6 前半) windows.create({width:800,height:600,focused:false})（画面にある）", { width: 800, height: 600, focused: false });
  const u6 = await inSw(`chrome.windows.update(${b6.id},{left:-10000,top:-10000}).then(w=>({left:w.left,top:w.top}))`);
  await row("(b6 後半) windows.update({left:-10000,top:-10000})", { update_returned: u6 });
  const u6b = await inSw(`chrome.windows.update(${b6.id},{left:-400,top:100}).then(w=>({left:w.left,top:w.top,width:w.width}))`); await Bun.sleep(800);
  await row("(b7) windows.update({left:-400})（幅 800 の窓の半分だけ画面の外）", { update_returned: u6b });
  const u6c = await inSw(`chrome.windows.update(${b6.id},{state:"minimized"}).then(w=>({state:w.state}))`); await Bun.sleep(1200);
  await row("(b8) windows.update({state:'minimized'})（作った後に最小化）", { update_returned: u6c });
  await rm(b6);
  // b9: 最小化した窓を作業場にして tab を足す（人役の窓 1 つが画面にある）
  const humanWin = await inSw(`chrome.windows.create({url:${JSON.stringify(base + "/data")},left:200,top:200,width:600,height:400,focused:false}).then(w=>w.id)`); await Bun.sleep(1500);
  const wk = await inSw(`chrome.windows.create({url:${JSON.stringify(base + "/app")},width:800,height:600,focused:false}).then(w=>w.id)`); await Bun.sleep(1500);
  await inSw(`chrome.windows.update(${wk},{state:"minimized"}).then(()=>1)`); await Bun.sleep(1200);
  const hb = await inSw(`chrome.tabs.query({windowId:${humanWin}}).then(a=>a.length)`);
  const t2 = await inSw(`chrome.tabs.create({windowId:${wk},url:${JSON.stringify(base + "/app")},active:false}).then(t=>t.id)`); await Bun.sleep(3000);
  const ha = await inSw(`chrome.tabs.query({windowId:${humanWin}}).then(a=>a.length)`);
  const wkState = await inSw(`chrome.windows.get(${wk}).then(w=>w.state)`);
  const vis = await inSw(`chrome.scripting.executeScript({target:{tabId:${t2}},func:()=>window.__o,world:\"MAIN\"}).then(a=>a[0]?.result)`);
  await row("(b9) 最小化した窓に tab を足す（人役の窓が画面にある）", { "人の窓の tab 数": `${hb}→${ha}`, "足した tab": t2, workspace_state: wkState, "頁の中(table/可視/rAF/tick)": vis });
  await inSw(`chrome.windows.remove(${wk})`); await inSw(`chrome.windows.remove(${humanWin})`); await Bun.sleep(800);

  // ---------- (c) offscreen 文書 ----------
  const off = await inSw(`chrome.offscreen.createDocument({url:"probe-off.html",reasons:["IFRAME_SCRIPTING"],justification:"W3c probe"}).then(()=>"ok")`);
  await Bun.sleep(800);
  const got: any[] = [];
  const sc2 = async () => { const c = await cdp(swWs); await c.send("Runtime.evaluate", { expression: `chrome.runtime.sendMessage({op:"probeLoad",url:${JSON.stringify(base + "/xfo")}}).catch(()=>{});1` }); c.close(); await Bun.sleep(4000); };
  const sc = await cdp(swWs); // sw に届く probeOff を拾うため、sw の message listener を足す
  await sc.send("Runtime.evaluate", { expression: `globalThis.__off=[];chrome.runtime.onMessage.addListener(m=>{if(m.op==="probeOff")globalThis.__off.push(m.o);if(m.op==="probeCs")globalThis.__off.push({cs:m})});chrome.runtime.sendMessage({op:"probeLoad",url:${JSON.stringify(base + "/app")}}).catch(()=>{});1` });
  sc.close(); await Bun.sleep(4000);
  const res = await inSw(`globalThis.__off`);
  await sc2();
  const res2 = await inSw(`globalThis.__off.slice(${(res as any[]).length})`);
  await row("(c1) chrome.offscreen の文書に /app を iframe で描く", { createDocument: off, 頁が描いたもの: res, "X-Frame-Options:DENY の頁（既存の embed-rules が剥がすか）": res2, "サーバーが見た最後の /data": seen.filter((s) => s.startsWith("/data")).at(-1) });
  await inSw(`chrome.offscreen.closeDocument().then(()=>1)`).catch(() => {});
  await row("(c1 後) offscreen を閉じた後");
} catch (e) { say("ERROR " + (e as Error).stack); }
say("後始末: 起こした Chrome だけを止める（自分の user-data-dir の pid のみ）");
for (const p of Bun.spawnSync(["pgrep", "-f", D]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
await Bun.sleep(1500); server.stop(true); rmSync(D, { recursive: true, force: true }); say("後始末 済み");
await Bun.sleep(Math.max(0, (FW_SEC + 1) * 1000 - (Date.now() - fwStart)));
say("--- front-watch 全文（最初から後始末の後まで・切っていない）---\n" + (await new Response(fw.stdout).text()).trim());
process.exit(0);
