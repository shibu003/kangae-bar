// W2e の通し（手で回す: bun test/web-lease.e2e.ts [--front-watch /path/to/front-watch]）。隔離した home・socket・profile で、本物の Chromium + 本物の拡張 + 本物の常駐を通す。
// owner の bar・常駐・profile には触らない。Chromium は `open -g`（前面にしない）で起こす。人の操作は CDP の trusted event で代役する。
import { mktmp } from "./tmp.ts";
import { humanAsk } from "./human-ask.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalIn, findSw } from "./cdp-sw.ts";
import { judgeFront, rememberOurs } from "./front-judge.ts";
import { cuaDriver } from "../src/lease.ts";
import { launchScratchPad } from "../tools/scratch-pad.ts";
import { CHROMIUM_APP, chromiumArgs, prepare, resetWorkers, stageExtension } from "../src/launch.ts";
import { spawnDaemon } from "./spawn-daemon";

const root = join(import.meta.dir, "..");
const D = mktmp("kangae-w2e");
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

// ---- 試験用の頁（入力欄・保存 button・保存一覧。「送信」だと W8a で destructive になり聞かれる。trusted な keydown を数える） ----
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  const n = new URL(r.url).searchParams.get("n") ?? "x";
  return new Response(`<!doctype html><title>page ${n}</title><h1>page ${n}</h1><label>メモ <input id="q"></label><button id="send">保存</button><ul id="saved"></ul>
<script>window.__k=0;addEventListener("keydown",e=>{if(e.isTrusted)window.__k++},true);
document.getElementById("send").onclick=()=>{const q=document.getElementById("q");const li=document.createElement("li");li.textContent=q.value;document.getElementById("saved").append(li);q.value=""}</script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
} });
const url = (n: string, host = "127.0.0.1") => `http://${host}:${server.port}/p?n=${n}`;

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

let padStop: (() => Promise<void>) | undefined;
const cleanup = () => {
  rememberOurs(D);
  // 後始末も測定の中。どの手で前面が動くかを front-watch の時刻と突き合わせられるよう、手の間を空けて時刻を出す
  say("後始末 1: 的の app（ScratchPad）を止める");
  void padStop?.();
  Bun.sleepSync(1500);
  say("後始末 2: Chromium と常駐を止める");
  for (const p of Bun.spawnSync(["pgrep", "-f", D]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  for (const p of Bun.spawnSync(["lsof", "-t", sock]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  Bun.sleepSync(1500);
  say("後始末 3: 一時 file を消す");
  server.stop(true);
  rmSync(D, { recursive: true, force: true });
};
// 前面の監視は「何かを起こす前」から「後始末の後」まで 1 本で切らずに回す
const FW_SEC = 150;
const fw = process.argv.includes("--front-watch") ? Bun.spawn([process.argv[process.argv.indexOf("--front-watch") + 1]!, String(FW_SEC)], { stdout: "pipe" }) : null;
const fwStart = Date.now();
const deadline = setTimeout(() => { say("TIMEOUT"); cleanup(); process.exit(2); }, 300_000);

try {
  // 1. 常駐の binary を作り、隔離した常駐を起こす
  const b = Bun.spawnSync(["bun", "build", "--compile", join(root, "src/main.ts"), "--outfile", bin], { cwd: root });
  if (b.exitCode !== 0) throw new Error("build 失敗: " + b.stderr.toString());
  spawnDaemon([bin, "--daemon"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
  for (let i = 0; i < 60 && !(await ask({ op: "ping" })); i++) await Bun.sleep(250);
  const r1 = (await ask({ op: "add", text: "web agent A" })).node.id;
  const r2 = (await ask({ op: "add", text: "web agent B" })).node.id;

  // 2. Chromium を前面にせず起こす（open -g）。拡張は profile の隣に写した物を読む
  const o = { app: CHROMIUM_APP, profile, hostBinary: bin, extensionDir: join(root, "extension"), mockKeychain: true, extraArgs: [`--remote-debugging-port=${cdpPort}`, "--no-startup-window", "--headless=new", "--enable-unsafe-extension-debugging"] };
  prepare(o);
  const ext = stageExtension(o.extensionDir, join(D, "extension"));
  resetWorkers(profile, JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")).version);
  Bun.spawn(["open", "-g", "-n", "-a", CHROMIUM_APP, "--env", `KANGAE_HOME=${env.KANGAE_HOME}`, "--env", `KANGAE_SOCK=${sock}`, "--env", `KANGAE_PROFILE=${profile}`, "--args", ...chromiumArgs(o, ext), ...(o.extraArgs ?? [])], { stdout: "ignore", stderr: "ignore" });
  // 窓は作る時に前面を奪う事がある（open -g でも）。起こしは --no-startup-window（窓なし）、最初の窓は focused:false で用意する（実測: test/front-probe.e2e.ts）
  const sw: any = await findSw({ port: cdpPort, extensionDir: ext, nudgeUrl: url("human") }); // 締切 120 秒・1 回 4 秒（test/cdp-sw.ts）
  await evalIn(sw.webSocketDebuggerUrl, `chrome.windows.create({url:${JSON.stringify(url("human"))},focused:false}).then(w=>w.id)`);
  for (let i = 0; i < 40; i++) { try { if ((await targets()).some((t: any) => t.url.includes("n=human"))) break; } catch {} await Bun.sleep(500); }
  const browser = await cdp((await jget("/json/version")).webSocketDebuggerUrl);
  for (const n of ["A", "B", "other"]) await browser.send("Target.createTarget", { url: url(n), background: true }); // 前面にしない
  await Bun.sleep(2500);

  // 拡張の sw から tabId を聞く（試験の道具。製品の道は panel の「渡す」）
  const tabIdOf = async (n: string) => JSON.parse(await evalIn(sw.webSocketDebuggerUrl, `chrome.tabs.query({}).then(a=>JSON.stringify(a.find(t=>t.url.includes("n=${n}"))?.id))`));
  const activeNow = async () => JSON.parse(await evalIn(sw.webSocketDebuggerUrl, `chrome.tabs.query({active:true}).then(a=>JSON.stringify(a.map(t=>t.url)))`));
  const tA = await tabIdOf("A"), tB = await tabIdOf("B"), tOther = await tabIdOf("other");
  say(`tabId: A=${tA} B=${tB} other=${tOther}`);
  const human = await page("human"), pA = await page("A"), pB = await page("B");

  // 3. AC-1: tab を渡す（panel と同じ op）→ agent が CLI でその tab だけを読み書き。人は別 tab を使い続ける
  await humanOp({ op: "leaseMode", app: "*", mode: "allow" }); // 承認の層は W4a の検査が持つ。ここは他の層を測る
  const gA = await humanOp({ op: "leaseGive", rootId: r1, tabId: tA });
  check("AC-1 tab を渡せる", gA.ok === true, JSON.stringify(gA).slice(0, 160));
  const tokA = `${gA.lease.surface.tabId ? "tab:" + gA.lease.surface.tabId : ""}|${gA.lease.gen}|${gA.lease.owner}`;
  const samples: string[] = [];
  const sampler = setInterval(async () => { try { samples.push(JSON.stringify(await activeNow())); } catch {} }, 700);
  const keysBefore = await evalIn(human.webSocketDebuggerUrl, "window.__k");
  const st = act(tokA, "get_window_state", {});
  say("--- get_window_state 原文 ---\n" + st.out.slice(0, 600));
  const input = /(d\d+)\ttextbox/.exec(st.out)?.[1], button = /(d\d+)\tbutton\t保存/.exec(st.out)?.[1];
  check("AC-1 読めて要素の token が出る", st.code === 0 && !!input && !!button);
  for (let i = 1; i <= 5; i++) {
    await typeKey(human.webSocketDebuggerUrl, "z"); // 人が別の tab に打つ
    const t = act(tokA, "type_text", { element_token: input, text: `memo${i}` });
    const c = act(tokA, "click", { element_token: button });
    if (t.code !== 0 || c.code !== 0) say(`  ${i}: ${t.out} ${c.out}`);
  }
  await Bun.sleep(500);
  const savedA = JSON.parse(await evalIn(pA.webSocketDebuggerUrl, "JSON.stringify([...document.querySelectorAll('#saved li')].map(l=>l.textContent))"));
  const savedB = JSON.parse(await evalIn(pB.webSocketDebuggerUrl, "JSON.stringify([...document.querySelectorAll('#saved li')].map(l=>l.textContent))"));
  const keysHuman = (await evalIn(human.webSocketDebuggerUrl, "window.__k")) - keysBefore;
  const keysA = await evalIn(pA.webSocketDebuggerUrl, "window.__k");
  check("AC-1 agent が渡された tab だけに書けた", savedA.join(",") === "memo1,memo2,memo3,memo4,memo5" && savedB.length === 0, `A=${savedA.length}件 B=${savedB.length}件`);
  check("AC-2 人の入力 5 個が全部 human の tab へ・agent の tab へ 0（取りこぼし 0・混入 0）", keysHuman === 5 && keysA === 0, `human=${keysHuman} agentTab=${keysA}`);
  check("AC-1 lease は生きたまま（agent の操作で取り戻されない）", (await ask({ op: "leaseList" })).leases.length === 1);
  // 渡していない tab を agent が狙う・press_key の記号
  const bad = act(tokA, "click", { element_token: "d1", tabId: tB, docId: "x" });
  check("AC-1 agent が別の tab を指しても A にしか効かない（B は 0 件のまま）", JSON.parse(await evalIn(pB.webSocketDebuggerUrl, "JSON.stringify(document.querySelectorAll('#saved li').length)")) === 0, bad.out.slice(0, 80));
  const pk = act(tokA, "press_key", { key: "+" });
  check("press_key の記号は拒否されて type_text を案内する", pk.code === 1 && pk.out.includes("type_text"), pk.out.trim().slice(0, 100));
  clearInterval(sampler);
  const actives = samples.filter((s) => s !== samples[0]);
  check("AC-2 active tab が変わった回数 = 0", actives.length === 0, `標本 ${samples.length} 件・最初=${samples[0]}`);

  // 4. AC-3: 再読み込み・別 site で古い操作権は拒否
  await (async () => { const c = await cdp(pA.webSocketDebuggerUrl); await c.send("Page.reload"); c.close(); })();
  await Bun.sleep(1500);
  const after = act(tokA, "type_text", { element_token: input, text: "古い" });
  const pA2 = await page("A");
  check("AC-3 再読み込み後は古い操作権が拒否され 0 件実行", after.code === 1 && after.out.includes("拒否") && (await evalIn(pA2.webSocketDebuggerUrl, "document.getElementById('q').value")) === "", after.out.trim().slice(0, 100));
  check("AC-3 文書が変わった時点で操作権は取り戻された（lease 0）", (await ask({ op: "leaseList" })).leases.length === 0);
  const gA2 = await humanOp({ op: "leaseGive", rootId: r1, tabId: tA });
  const tokA2 = `tab:${tA}|${gA2.lease.gen}|${gA2.lease.owner}`;
  check("AC-3 渡し直すと世代が上がり、古い token は通らない", gA2.ok && gA2.lease.gen > gA.lease.gen && act(tokA, "click", { element_token: "d1" }).code === 1);
  await (async () => { const c = await cdp(pA2.webSocketDebuggerUrl); await c.send("Page.navigate", { url: url("A", "localhost") }); c.close(); })(); // 別 site（別 origin）へ
  await Bun.sleep(1500);
  const after2 = act(tokA2, "click", { element_token: "d1" });
  check("AC-3 別 site へ移動した後も古い操作権は拒否", after2.code === 1 && after2.out.includes("拒否"), after2.out.trim().slice(0, 100));

  // 5. AC-4（web 側）: 2 つの tab に別々の agent。互いの面に書かない
  const pA3 = await page("A");
  const gA3 = await humanOp({ op: "leaseGive", rootId: r1, tabId: tA });
  const gB = await humanOp({ op: "leaseGive", rootId: r2, tabId: tB });
  const tk = (g: any) => `tab:${g.lease.surface.tabId}|${g.lease.gen}|${g.lease.owner}`;
  const sA = act(tk(gA3), "get_window_state", {}).out, sB = act(tk(gB), "get_window_state", {}).out;
  const inA = /(d\d+)\ttextbox/.exec(sA)?.[1]!, inB = /(d\d+)\ttextbox/.exec(sB)?.[1]!;
  act(tk(gA3), "type_text", { element_token: inA, text: "AだけのA" });
  act(tk(gB), "type_text", { element_token: inB, text: "BだけのB" });
  const crossAB = act(tk(gB), "type_text", { element_token: inA, text: "混入" }); // B の持ち主が A の token を使っても、B の面にしか効かない
  const vA = await evalIn((await page("A")).webSocketDebuggerUrl, "document.getElementById('q').value");
  const vB = await evalIn((await page("B")).webSocketDebuggerUrl, "document.getElementById('q').value");
  check("AC-4 互いの面への書き込み 0", vA === "AだけのA" && !vB.includes("A") && !vA.includes("混入"), `A="${vA}" B="${vB}"（B の持ち主が A の token を打っても B 自身の面にしか入らない）cross=${crossAB.code}`);
  const stolen = act(tk(gA3), "type_text", { element_token: inA, text: "x" }).code === 0 && (await humanOp({ op: "leaseGive", rootId: r2, tabId: tA })).ok === false;
  check("AC-4 1 つの tab に持ち主は 1 人（別の会話が渡し込めない）", stolen);

  // 5b. AC-4（窓 + tab）: app の窓（自分で組む tools/scratch-pad の的・Calculator など本物の app は使わない）に別の agent を付け、tab の agent と互いの面に書かない
  const r3 = (await ask({ op: "add", text: "window agent" })).node.id;
  const probe = cuaDriver(`w2e-probe-${crypto.randomUUID()}`);
  const sp = await launchScratchPad(D, `的-w2e-${process.pid}`, probe!);
  padStop = sp.stop;
  probe!.close();
  const calcPid = sp.pid, calcWin = sp.win;
  check("AC-4 窓 ScratchPad が見つかる", !!calcWin, `pid=${calcPid} window=${calcWin?.window_id}`);
  if (calcWin && calcWin.on_current_space === false) {
    // owner が今見ている Space と的の窓の Space が違う（owner の机の置き方で起きる・2026-10-06 実測: 要素 0）。読み書きの AC-4 は測れないので「未測」と言い、代わりに門の理由つき拒否を測る
    say(`未測: AC-4 の読み書き（的の窓が別の Space: space_ids=${JSON.stringify(calcWin.space_ids)} current=${calcWin.current_space_id}）`);
    const gW = await humanOp({ op: "leaseGive", rootId: r3, pid: calcPid, windowId: calcWin.window_id, app: "ScratchPad", title: "" });
    const off = act(`${calcPid}:${calcWin.window_id}|${gW.lease.gen}|${gW.lease.owner}`, "get_window_state", {});
    check("AC-4' 別の Space の窓は、混雑と取り違えず理由つきで拒否される", off.code === 1 && /別の Space/.test(off.out), off.out.trim().slice(0, 140));
    await ask({ op: "leaseTakeback", key: `${calcPid}:${calcWin.window_id}` });
  } else if (calcWin) {
    const gW = await humanOp({ op: "leaseGive", rootId: r3, pid: calcPid, windowId: calcWin.window_id, app: "ScratchPad", title: "" });
    check("AC-4 窓を渡せる（tab の持ち主 2 人と同時）", gW.ok === true && (await ask({ op: "leaseList" })).leases.length === 3);
    const tkW = `${calcPid}:${calcWin.window_id}|${gW.lease.gen}|${gW.lease.owner}`;
    const ws = act(tkW, "get_window_state", {}).out;
    const area = /(s[0-9a-f]+:\d+)\tTextArea\b/.exec(ws)?.[1];
    say("--- 窓 get_window_state 先頭 ---\n" + ws.split("\n").slice(0, 4).join("\n"));
    if (area) say("窓 type_text 7: " + act(tkW, "type_text", { element_token: area, text: "7", tabId: tA }).out.trim().slice(0, 100)); // 窓の持ち主が tab を狙っても窓にしか効かない
    const disp = (t: string) => /TextArea\t([^\n]*)/.exec(t)?.[1]?.replace(/^ = /, "").replace(/ = .*$/, "") ?? "";
    const d1 = disp(act(tkW, "get_window_state", {}).out);
    const savedBefore = await evalIn((await page("A")).webSocketDebuggerUrl, "document.querySelectorAll('#saved li').length");
    const viaTab = act(tk(gA3), "click", { element_token: /(d\d+)\tbutton/.exec(sA)?.[1], pid: calcPid, window_id: calcWin.window_id, element_token_win: area }); // tab の持ち主が窓を狙っても tab にしか効かない
    const d2 = disp(act(tkW, "get_window_state", {}).out);
    const savedAfter = await evalIn((await page("A")).webSocketDebuggerUrl, "document.querySelectorAll('#saved li').length");
    check("AC-4 窓の agent の type_text は窓だけ（表示 7）・tab の agent が窓を狙っても窓は変わらず tab にだけ効く", d1 === "7" && d2 === "7" && savedAfter === savedBefore + 1, `表示 ${d1}→${d2}・tab の保存 ${savedBefore}→${savedAfter}・${viaTab.out.trim().slice(0, 40)}`);
    await ask({ op: "leaseTakeback", key: `${calcPid}:${calcWin.window_id}` });
    // 的の app を止めるのは試験の後始末（cleanup）。測定の間に止めない
  }

  // 6. 取り戻し: 人がその tab を前面にした / その tab に入力した
  const hb = await cdp((await jget("/json/version")).webSocketDebuggerUrl);
  say("前面にする前の active: " + JSON.stringify(await activeNow()));
  await hb.send("Target.activateTarget", { targetId: (await page("A")).id });
  await Bun.sleep(1200);
  say("前面にした後の active: " + JSON.stringify(await activeNow()));
  const left = (await ask({ op: "leaseList" })).leases.map((l: any) => l.key);
  check("取り戻し: 人が渡した tab を前面にしたら agent は止まる（A だけ外れ B は残る）", !left.includes(`tab:${tA}`) && left.includes(`tab:${tB}`), left.join(","));
  check("取り戻し: 古い操作権は拒否", act(tk(gA3), "click", { element_token: inA }).code === 1);
  // 人が「今開いている tab」を渡した直後（前面のまま）にその tab へ入力した場合（onActivated は鳴らない道）
  await ask({ op: "leaseTakeback", key: `tab:${tB}` });
  await hb.send("Target.activateTarget", { targetId: (await page("other")).id });
  await Bun.sleep(800);
  const gO = await humanOp({ op: "leaseGive", rootId: r2, tabId: tOther });
  check("取り戻し（入力）: 前面の tab を渡せる", gO.ok === true);
  await typeKey((await page("other")).webSocketDebuggerUrl, "q"); // 人が渡した tab に入力した（trusted）
  await Bun.sleep(1200);
  check("取り戻し: 人が渡した tab に入力したら agent は止まる", (await ask({ op: "leaseList" })).leases.length === 0);
  hb.close();
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
