// W2f の通し（手で回す: bun test/web-w2f.e2e.ts --front-watch /path/to/front-watch）。隔離した home・socket・profile で、本物の Chromium + 本物の拡張 + 本物の常駐 + 本物の `kangae act` を通す。
// ① agent 自身の移動で操作権を保つ（移動の開始が操作の直後に入る幅を実測）／人の移動は取り戻す／分からない移動も取り戻す ② bar の「指す」と同じ leaseGive（pid・window_id・app・題）で tab が決まる ③ web の double_click / right_click / drag / hotkey
// owner の bar・常駐・profile には触らない。Chromium は `open -g`（前面にしない）で起こす。人の操作は CDP の trusted event で代役する。
import { mktmp } from "./tmp.ts";
import { humanAsk } from "./human-ask.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { pollUntil } from "../src/wait.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalIn, findSw } from "./cdp-sw.ts";
import { judgeFront, rememberOurs } from "./front-judge.ts";
import { cuaDriver } from "../src/lease.ts";
import { CHROMIUM_APP, chromiumArgs, prepare, resetWorkers, stageExtension } from "../src/launch.ts";
import { spawnDaemon } from "./spawn-daemon";

const root = join(import.meta.dir, "..");
const D = mktmp("kangae-w2f");
const sock = join(D, "s.sock");
const bin = join(D, "kangae");
const cdpPort = 9300 + Math.floor(Math.random() * 500);
const profile = join(D, "profile");
const env = { KANGAE_HOME: join(D, "home"), KANGAE_SOCK: sock, KANGAE_BAR: join(D, "bar.json") };
const humanOp = humanAsk(env.KANGAE_BAR); // sec1: 承認の表などは人が押す op＝unix socket（agent の口）では断られる。人の口（/ws）から送る
const fails: string[] = [];
const t0 = Date.now();
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const check = (name: string, ok: boolean, detail = "") => { say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) fails.push(name); };

// ---- 試験用の頁: n=<名前>。次の頁への link（#go）・遅れて動く link（#late）・手で数える playground ----
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  const n = new URL(r.url).searchParams.get("n") ?? "x";
  return new Response(`<!doctype html><title>page ${n}</title><h1>page ${n}</h1><label>メモ <input id="q"></label><button id="send">保存</button><ul id="saved"></ul>
<a id="go" href="/p?n=${n}_">次へ</a> <button id="late">遅れて移る</button>
<div id="dbl" tabindex="0" style="width:90px;height:30px;background:#cde">dbl</div><div id="ctx" tabindex="0" style="width:90px;height:30px;background:#edc">ctx</div>
<div id="src" tabindex="0" draggable="true" style="width:90px;height:30px;background:#dec">src</div><div id="dst" tabindex="0" style="width:90px;height:30px;background:#ffd">dst</div>
<script>window.__k=0;window.__ev=[];addEventListener("keydown",e=>{if(e.isTrusted)window.__k++;else window.__ev.push("key:"+(e.ctrlKey?"ctrl+":"")+(e.metaKey?"meta+":"")+e.key)},true);
const L=(id,t)=>document.getElementById(id).addEventListener(t,e=>window.__ev.push(id+":"+t+":"+(e.detail??"")));
L("dbl","dblclick");L("ctx","contextmenu");L("src","dragstart");L("dst","drop");L("dst","dragover");L("src","dragend");
document.getElementById("dst").addEventListener("dragover",e=>e.preventDefault());
document.getElementById("send").onclick=()=>{const q=document.getElementById("q");const li=document.createElement("li");li.textContent=q.value;document.getElementById("saved").append(li);q.value=""};
document.getElementById("late").onclick=()=>setTimeout(()=>{location.href="/p?n=${n}late"},1500)</script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
} });
const url = (n: string, host = "127.0.0.1") => `http://${host}:${server.port}/p?n=${encodeURIComponent(n)}`;

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
const page = async (n: string) => (await targets()).find((t: any) => t.url.includes(`n=${n}`));
const typeKey = async (wsUrl: string, ch: string) => { const c = await cdp(wsUrl); await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }); await Bun.sleep(150); for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, text: ch, key: ch }); await Bun.sleep(100); c.close(); };


// --stress: 全 CPU を埋めた状態で測る（移動の開始の遅れの tail を見る。測定が済んだら必ず止める）
const burners = process.argv.includes("--stress") ? Array.from({ length: Number(Bun.spawnSync(["sysctl", "-n", "hw.logicalcpu"]).stdout.toString()) * 2 }, () => Bun.spawn(["yes"], { stdout: "ignore", stderr: "ignore" })) : [];
const cleanup = () => {
  rememberOurs(D);
  for (const b of burners) try { b.kill(); } catch {}
  for (const p of Bun.spawnSync(["pgrep", "-f", D]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  for (const p of Bun.spawnSync(["lsof", "-t", sock]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  server.stop(true);
  rmSync(D, { recursive: true, force: true });
};
// 前面の監視は「何かを起こす前」から「後始末の後」まで 1 本で切らずに回す（区間を切らない）。時間は余裕を見て 110 秒
const FW_SEC = 110;
const fw = process.argv.includes("--front-watch") ? Bun.spawn([process.argv[process.argv.indexOf("--front-watch") + 1]!, String(FW_SEC)], { stdout: "pipe" }) : null;
const fwStart = Date.now();
const deadline = setTimeout(() => { say("TIMEOUT"); cleanup(); process.exit(2); }, 300_000);
const leases = async () => (await ask({ op: "leaseList" })).leases as any[];
const waitFor = async (f: () => Promise<boolean>, ms = 6000) => !!(await pollUntil(f, ms, 150));
const tokOf = (g: any) => `tab:${g.lease.surface.tabId}|${g.lease.gen}|${g.lease.owner}`;
const tokenIn = (out: string, re: RegExp) => re.exec(out)?.[1];

try {
  // 1. 常駐の binary を作り、隔離した常駐を起こす
  const b = Bun.spawnSync(["bun", "build", "--compile", join(root, "src/main.ts"), "--outfile", bin], { cwd: root });
  if (b.exitCode !== 0) throw new Error("build 失敗: " + b.stderr.toString());
  spawnDaemon([bin, "--daemon"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
  for (let i = 0; i < 60 && !(await ask({ op: "ping" })); i++) await Bun.sleep(250);
  const r1 = (await ask({ op: "add", text: "web agent A" })).node.id;

  // 2. Chromium を前面にせず起こす（open -g）
  const o = { app: CHROMIUM_APP, profile, hostBinary: bin, extensionDir: join(root, "extension"), mockKeychain: true, extraArgs: [`--remote-debugging-port=${cdpPort}`, "--no-startup-window", "--headless=new", "--enable-unsafe-extension-debugging"] };
  prepare(o);
  const ext = stageExtension(o.extensionDir, join(D, "extension"));
  resetWorkers(profile, JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")).version);
  Bun.spawn(["open", "-g", "-n", "-a", CHROMIUM_APP, "--env", `KANGAE_HOME=${env.KANGAE_HOME}`, "--env", `KANGAE_SOCK=${sock}`, "--env", `KANGAE_PROFILE=${profile}`, "--args", ...chromiumArgs(o, ext), ...(o.extraArgs ?? [])], { stdout: "ignore", stderr: "ignore" });
  const sw: any = await findSw({ port: cdpPort, extensionDir: ext, nudgeUrl: url("human") }); // 締切 120 秒・1 回 4 秒（test/cdp-sw.ts）
  // 窓は作る時に前面を奪う事がある（open -g でも）。起こしは --no-startup-window（窓なし）、面は focused:false で用意する（実測: test/front-probe.e2e.ts）
  for (const n of ["A", "human"]) await evalIn(sw.webSocketDebuggerUrl, `chrome.windows.create({url:${JSON.stringify(url(n))},focused:false}).then(w=>w.id)`);
  for (let i = 0; i < 40; i++) { try { const ts = await targets(); if (["A", "human"].every((n) => ts.some((t: any) => t.url.includes(`n=${n}`)))) break; } catch {} await Bun.sleep(500); }
  await Bun.sleep(1500);
  // 試験の道具: sw の中で「実際に起きた移動の種類」を記録する（常駐に送る物と同じ webNavigation。判定の根拠を報告に残す）
  await evalIn(sw.webSocketDebuggerUrl, `globalThis.__nl=[];chrome.webNavigation.onCommitted.addListener(d=>{if(d.frameId===0)__nl.push(d.tabId+":"+d.transitionType+":"+(d.transitionQualifiers||[]).join("+"))});1`);
  const navLog = async () => JSON.parse(await evalIn(sw.webSocketDebuggerUrl, "JSON.stringify(__nl.splice(0))")) as string[];
  const tabIdOf = async (n: string) => JSON.parse(await evalIn(sw.webSocketDebuggerUrl, `chrome.tabs.query({}).then(a=>JSON.stringify(a.find(t=>t.url.includes("n=${n}"))?.id))`));
  const activeNow = async () => JSON.parse(await evalIn(sw.webSocketDebuggerUrl, `chrome.tabs.query({active:true}).then(a=>JSON.stringify(a.map(t=>t.id)))`));
  const tA = await tabIdOf("A");
  const human = await page("human");
  const aWs = async () => (await targets()).find((t: any) => t.url.includes("n=A"))!.webSocketDebuggerUrl;
  const aUrl = async () => (await targets()).find((t: any) => t.url.includes("n=A"))!.url;

  const samples: string[] = [];
  const sampler = setInterval(async () => { try { samples.push(JSON.stringify(await activeNow())); } catch {} }, 700);
  const tabIds = async () => JSON.parse(await evalIn(sw.webSocketDebuggerUrl, `chrome.tabs.query({}).then(a=>JSON.stringify(a.map(t=>t.id).sort()))`)) as number[];
  const tabsBefore = JSON.stringify(await tabIds());
  const keysBefore = await evalIn(human.webSocketDebuggerUrl, "window.__k");

  // ② bar の「指す」と同じ口（pid・window_id・app・題）で、browser の窓 → その窓の今見ている tab
  const probe = cuaDriver(`w2f-probe-${crypto.randomUUID()}`);
  const lw = await probe!.call("list_windows", {});
  const chromWins = ((lw.data?.windows as any[] | undefined) ?? []).filter((w) => /chrom/i.test(w.app_name ?? ""));
  say("--- list_windows（Chromium 系）---\n" + chromWins.map((w) => `pid=${w.pid} window=${w.window_id} app=${w.app_name} title=${JSON.stringify(w.title)}`).join("\n"));
  probe!.close();
  const win = chromWins.find((w) => String(w.title).startsWith("page A"));
  check("② 指す: 窓が見つかる（bar と同じ list_windows）", !!win, win ? `pid=${win.pid} window=${win.window_id} title=${JSON.stringify(win.title)}` : "");
  await humanOp({ op: "leaseMode", app: "*", mode: "allow" }); // 承認の層は W4a の検査が持つ。ここは他の層を測る
  const gBad = await humanOp({ op: "leaseGive", rootId: r1, pid: win.pid, windowId: win.window_id, app: win.app_name, title: "どの tab にも無い題 - Chromium" });
  check("② 指す: どの tab か決められない窓は渡さない（理由つき・窓の面にもならない）", gBad.ok === false && (await leases()).length === 0, String(gBad.hint));
  const gA = await humanOp({ op: "leaseGive", rootId: r1, pid: win.pid, windowId: win.window_id, app: win.app_name, title: win.title });
  check("② 指す: browser の窓を指すと、その窓の今見ている tab が渡る（窓の面ではなく tab の面）", gA.ok === true && gA.lease?.surface?.tabId === tA && gA.lease.surface.docId, JSON.stringify(gA).slice(0, 220));
  const tokA = tokOf(gA); // agent が渡された時に持つ token。以降の移動を経ても、この文字列のまま使い続ける
  const gen0 = gA.lease.gen;

  // ① agent が link を押して次の頁へ進み、そのまま仕事を続ける（N 回。移動の開始が操作の終わりから何 ms 後かを実測）
  const N = 12;
  const afterEnd: number[] = [], fromStart: number[] = [], types: string[] = [];
  let hops = 0;
  for (let i = 1; i <= N; i++) {
    const st = act(tokA, "get_window_state", {});
    const go = tokenIn(st.out, /(d\d+)\tlink\t次へ/);
    if (!go) { say(`  hop ${i}: link が読めない: ${st.out.slice(0, 120)}`); break; }
    const before = (await leases())[0];
    const c = act(tokA, "click", { element_token: go });
    const moved = await waitFor(async () => { const l = (await leases())[0]; return !!l && l.gen > before.gen && l.surface.docId !== before.surface.docId; });
    const l = (await leases())[0];
    if (!moved || !l) { say(`  hop ${i}: 操作権が保たれなかった: click=${c.out.trim().slice(0, 80)} lease=${JSON.stringify(l)?.slice(0, 120)}`); break; }
    hops++;
    afterEnd.push(l.lastNav.afterEnd); fromStart.push(l.lastNav.fromStart); types.push(l.lastNav.type);
    if (i === 3) for (let k = 0; k < 5; k++) await typeKey(human.webSocketDebuggerUrl, "z"); // 人は別の tab に打ち続ける
  }
  const ls = await leases();
  const note = act(tokA, "get_window_state", {});
  check("① AC-1 agent の click で 12 回 次の頁へ進んでも操作権は保たれ、最初の token のまま読める", hops === N && ls.length === 1 && ls[0].gen === gen0 + N && note.code === 0 && note.out.includes("page A_".repeat(1)), `hops=${hops}/${N} gen ${gen0}→${ls[0]?.gen} url=${await aUrl()}`);
  say(`実測 移動の開始 − 操作の終わり(ms): ${JSON.stringify(afterEnd)} / 移動の開始 − 操作の始まり(ms): ${JSON.stringify(fromStart)} / 種類: ${[...new Set(types)].join(",")}`);
  check("① 実測: 移動の開始は全て操作の終わりの NAV_AFTER_MS(100ms) 以内（外れた物は 0 件）", afterEnd.length === hops && afterEnd.every((x) => x != null && x <= 100), `max=${Math.max(...afterEnd)}ms min=${Math.min(...afterEnd)}ms`);
  // 通し 2: 最後の頁で書いて保存できる
  const st2 = act(tokA, "get_window_state", {}).out;
  const inp = tokenIn(st2, /(d\d+)\ttextbox/), send = tokenIn(st2, /(d\d+)\tbutton\t保存/);
  act(tokA, "type_text", { element_token: inp, text: "移った先の頁で続けた" });
  act(tokA, "click", { element_token: send });
  const saved = JSON.parse(await evalIn(await aWs(), "JSON.stringify([...document.querySelectorAll('#saved li')].map(l=>l.textContent))"));
  check("① AC-1 移った先の頁でそのまま書いて保存できた（同じ lease・同じ token）", saved.join() === "移った先の頁で続けた", saved.join());
  const keysHuman = (await evalIn(human.webSocketDebuggerUrl, "window.__k")) - keysBefore;
  check("AC-2 人の入力 5 個が全部 human の tab へ・agent の tab へ 0（取りこぼし 0・混入 0）", keysHuman === 5 && (await evalIn(await aWs(), "window.__k")) === 0, `human=${keysHuman} agentTab=${await evalIn(await aWs(), "window.__k")}`);

  // ③ web の残りの道具
  const pl = act(tokA, "get_window_state", {}).out;
  const el = (name: string) => tokenIn(pl, new RegExp(`(d\\d+)\\telement\\t${name}\\b`));
  const ev = async () => JSON.parse(await evalIn(await aWs(), "JSON.stringify(window.__ev)")) as string[];
  const r1d = act(tokA, "double_click", { element_token: el("dbl") });
  const r1r = act(tokA, "right_click", { element_token: el("ctx") });
  const r1g = act(tokA, "drag", { element_token: el("src"), to_element_token: el("dst") });
  const r1h = act(tokA, "hotkey", { keys: ["cmd", "k"] });
  const evs = await ev();
  say(`③ 打った物と返った原文:\n  double_click → ${r1d.out.trim()}\n  right_click → ${r1r.out.trim()}\n  drag → ${r1g.out.trim()}\n  hotkey cmd+k → ${r1h.out.trim()}\n  ページが受けた event: ${JSON.stringify(evs)}`);
  check("③ double_click: ページが dblclick（detail=2）を受けた", evs.includes("dbl:dblclick:2"));
  check("③ right_click: ページが contextmenu を受けた", evs.some((e) => e.startsWith("ctx:contextmenu")));
  check("③ drag: ページが dragstart → drop → dragend を受けた", ["src:dragstart", "dst:drop:0", "src:dragend:0"].every((x) => evs.some((e) => e.startsWith(x.replace(/:0$/, "")))));
  check("③ hotkey: ページが meta+k を受けた", evs.includes("key:meta+k"));
  const refuse = act(tokA, "hotkey", { keys: ["cmd", "t"] });
  const noTo = act(tokA, "drag", { element_token: el("src") });
  check("③ browser 自身の操作（cmd+t）は理由つきで拒否される（黙って効かないではない）", refuse.code === 1 && refuse.out.includes("browser 自身"), refuse.out.trim().slice(0, 120));
  check("③ drag は落とす先が無いと理由つきで断る", noTo.code === 1 || noTo.out.includes("to_element_token"), noTo.out.trim().slice(0, 100));
  check("③ 道具を使っても lease は生きたまま・tab の数は変わらない", (await leases()).length === 1 && JSON.stringify(await tabIds()) === tabsBefore, `tab ${tabsBefore}`);
  clearInterval(sampler);
  const actives = samples.filter((s) => s !== samples[0]);
  check("AC-2 active tab が変わった回数 = 0", actives.length === 0, `標本 ${samples.length} 件・active tabId=${samples[0]}（移動しても tabId は同じ）`);
  await navLog();

  // AC-3: 人が起こした移動は取り戻す（0 件実行）
  const reGive = async () => { await waitFor(async () => (await evalIn(await aWs(), "document.readyState")) === "complete"); await Bun.sleep(400); const g = await humanOp({ op: "leaseGive", rootId: r1, tabId: tA }); if (!g.ok) throw new Error("渡し直せない: " + JSON.stringify(g)); return tokOf(g); };
  const reclaimed = async (name: string, tk: string, kind: string) => {
    const gone = await waitFor(async () => (await leases()).length === 0, 4000);
    const typed = act(tk, "type_text", { element_token: "d1", text: "実行されてはいけない" });
    const log = await navLog();
    check(name, gone && typed.code === 1 && typed.out.includes("拒否"), `${kind} 移動の種類=${log.join(",")} → ${typed.out.trim().slice(0, 60)}`);
  };
  { // a: 人が link を実際に押した（trusted の mousedown）
    const tk = await reGive();
    const pt = JSON.parse(await evalIn(await aWs(), `JSON.stringify((()=>{const r=document.getElementById("go").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})())`));
    const c = await cdp(await aWs());
    await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    c.close();
    await reclaimed("AC-3 人が link を押して移動した → 取り戻す（agent は止まる・0 件実行）", tk, "link 押下");
  }
  { // b: 人が URL を入れて移動した（typed）
    const tk = await reGive();
    const c = await cdp(await aWs()); await c.send("Page.navigate", { url: url("A_typed") }); c.close();
    await reclaimed("AC-3 人が URL を変えた → 取り戻す", tk, "URL 入力");
  }
  { // c: 人が再読み込み
    const tk = await reGive();
    const c = await cdp(await aWs()); await c.send("Page.reload"); c.close();
    await reclaimed("AC-3 人が再読み込みした → 取り戻す", tk, "reload");
  }
  { // d: 人が戻る
    const tk = await reGive();
    const c = await cdp(await aWs());
    const h = await c.send("Page.getNavigationHistory");
    await c.send("Page.navigateToHistoryEntry", { entryId: h.result.entries[h.result.currentIndex - 1].id });
    c.close();
    await reclaimed("AC-3 人が戻るを押した → 取り戻す", tk, "戻る");
  }
  // AC-4: 区別が付かない時は安全側（取り戻す）
  { // e: agent が押したが、移動したのは 1.5 秒後にページ自身が動かした物（操作の外）
    const tk = await reGive();
    const st = act(tk, "get_window_state", {}).out;
    const c = act(tk, "click", { element_token: tokenIn(st, /(d\d+)\tbutton\t遅れて移る/) });
    say(`  e: ${c.out.trim()}`);
    await waitFor(async () => (await aUrl()).includes("late"), 5000);
    await reclaimed("AC-4 agent の操作の 1.5 秒後にページが動いた（agent が起こしたと言い切れない）→ 取り戻す", tk, "遅れた自動移動");
  }
  { // f: agent の操作の直後に、人が URL を入れた（時刻は操作の窓の中・種類が typed）
    const tk = await reGive();
    const st = act(tk, "get_window_state", {}).out;
    act(tk, "click", { element_token: tokenIn(st, /(d\d+)\tbutton\t保存/) });
    const c = await cdp(await aWs()); await c.send("Page.navigate", { url: url("A_race") }); c.close();
    await reclaimed("AC-4 agent の操作の直後に人が URL を入れた（時刻だけでは区別が付かない）→ 取り戻す", tk, "操作直後の URL 入力");
  }
  { // g: 取り戻された後に、移動前の token で動かそうとしても 0 件
    const tk = await reGive();
    const c = await cdp(await aWs()); await c.send("Page.reload"); c.close();
    await waitFor(async () => (await leases()).length === 0, 4000);
    check("AC-3 取り戻された後は、移動前の token は gen で拒否", act(tk, "click", {}).out.includes("拒否"));
  }

} catch (e) {
  say("ERROR " + (e as Error).stack);
  fails.push("error");
} finally {
  clearTimeout(deadline);
  cleanup(); // 後始末も測定の中
}
if (fw) {
  await Bun.sleep(Math.max(0, (FW_SEC + 1) * 1000 - (Date.now() - fwStart)));
  const out = await new Response(fw.stdout).text();
  say(`--- front-watch 全文（何かを起こす前〜後始末の後まで ${Math.round((Date.now() - fwStart) / 1000)}s・区間を切っていない）---\n` + out.trim());
  { const j = judgeFront(out, { paths: [D] }); check("AC-2 前面が変わった回数 = 0（最初から後始末の後まで）", j.ok, j.detail); };
}
say(fails.length ? `\nFAIL ${fails.length}: ${fails.join(" / ")}` : "\n全部 PASS");
process.exit(fails.length ? 1 : 0);
