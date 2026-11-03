// W8e-2 の通し（手で回す: bun test/w8e.e2e.ts [--front-watch /path/to/front-watch]）。隔離した home・socket・profile で、本物の Chromium + 本物の拡張 + 本物の常駐を通す。
// owner の bar・常駐・profile には触らない。Chromium は `open -g`（前面にしない）で起こす。人の操作は CDP の trusted event で代役する。
import { mktmp } from "./tmp.ts";
import { humanAsk } from "./human-ask.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeFront, rememberOurs } from "./front-judge.ts";
import { cuaDriver } from "../src/lease.ts";
import { launchScratchPad } from "../tools/scratch-pad.ts";
import { CHROMIUM_APP, chromiumArgs, prepare, resetWorkers, stageExtension } from "../src/launch.ts";
import { spawnDaemon } from "./spawn-daemon";

const root = join(import.meta.dir, "..");
const D = mktmp("kangae-w8e");
const sock = join(D, "s.sock");
const bin = join(D, "kangae");
const cdpPort = 9300 + Math.floor(Math.random() * 500);
const profile = join(D, "profile");
const env = { KANGAE_HOME: join(D, "home"), KANGAE_SOCK: sock, KANGAE_BAR: join(D, "bar.json") };
const human = humanAsk(env.KANGAE_BAR); // sec1: 承認の表などは人が押す op＝unix socket（agent の口）では断られる。人の口（/ws）から送る
const fails: string[] = [];
const t0 = Date.now();
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const check = (name: string, ok: boolean, detail = "") => { say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) fails.push(name); };

// ---- 試験用の頁（入力欄・保存 button・保存一覧。「送信」だと W8a で destructive になり聞かれる。trusted な keydown を数える） ----
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  const n = new URL(r.url).searchParams.get("n") ?? "x";
  return new Response(`<!doctype html><title>page ${n}</title><body style="margin:0;background:#fff"><h1 id="h">page ${n}</h1><div id="b" style="height:300px;background:#ccc"></div>`, { headers: { "content-type": "text/html; charset=utf-8" } });
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
const evalIn = async (wsUrl: string, expr: string) => { const c = await cdp(wsUrl); const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); c.close(); if (r.result?.exceptionDetails || r.error) throw new Error("evalIn: " + JSON.stringify(r).slice(0, 300)); return r.result?.result?.value; };
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
  const o = { app: CHROMIUM_APP, profile, hostBinary: bin, extensionDir: join(root, "extension"), mockKeychain: true, extraArgs: [`--remote-debugging-port=${cdpPort}`, "--no-startup-window", "--headless=new"] };
  prepare(o);
  const ext = stageExtension(o.extensionDir, join(D, "extension"));
  resetWorkers(profile, JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")).version);
  Bun.spawn(["open", "-g", "-n", "-a", CHROMIUM_APP, "--env", `KANGAE_HOME=${env.KANGAE_HOME}`, "--env", `KANGAE_SOCK=${sock}`, "--env", `KANGAE_PROFILE=${profile}`, "--args", ...chromiumArgs(o, ext), ...(o.extraArgs ?? [])], { stdout: "ignore", stderr: "ignore" });
  // 窓は作る時に前面を奪う事がある（open -g でも）。起こしは --no-startup-window（窓なし）、最初の窓は focused:false で用意する（実測: test/front-probe.e2e.ts）
  let sw: any;
  for (let i = 0; i < 60 && !sw; i++) {
    const c = (await jget("/json/list").catch(() => [])).find((t: any) => t.type === "service_worker" && t.url.includes("sw.js"));
    if (c && (await evalIn(c.webSocketDebuggerUrl, "typeof chrome !== 'undefined' && !!chrome.tabs").catch(() => false)) === true) sw = c; else await Bun.sleep(500);
  }
  if (!sw) throw new Error("拡張の service worker が見つかりません");
  await evalIn(sw.webSocketDebuggerUrl, `chrome.windows.create({url:${JSON.stringify(url("human"))},focused:false}).then(w=>w.id)`);
  for (let i = 0; i < 40; i++) { try { if ((await targets()).some((t: any) => t.url.includes("n=human"))) break; } catch {} await Bun.sleep(500); }
  const browser = await cdp((await jget("/json/version")).webSocketDebuggerUrl);
  for (const n of ["A", "B", "other"]) await browser.send("Target.createTarget", { url: url(n), background: true }); // 前面にしない
  await Bun.sleep(2500);

  // 4. UC-e1〜e3（headless の拡張の道＝tab。窓の前面化は呼ぶ口の unit までで、実機の 1 回は operator の許可制）
  const evalSw = (e: string) => evalIn(sw.webSocketDebuggerUrl, e);
  const winW = JSON.parse(await evalSw(`chrome.windows.create({url:${JSON.stringify(url("W"))},focused:false}).then(w=>JSON.stringify(w.id))`)); // 自分の窓の中の active tab = 撮れる tab
  await Bun.sleep(1500);
  const tabIdOf = async (n: string) => JSON.parse(await evalSw(`chrome.tabs.query({}).then(a=>JSON.stringify(a.find(t=>t.url.includes("n=${n}"))?.id))`));
  const activeNow = async () => JSON.parse(await evalSw(`chrome.tabs.query({active:true,windowId:${winW}}).then(a=>JSON.stringify(a.map(t=>t.url)))`));
  const activeHuman = async () => JSON.parse(await evalSw(`chrome.tabs.query({active:true}).then(a=>JSON.stringify(a.map(t=>t.url)))`));
  const tW = await tabIdOf("W"), tOther = await tabIdOf("other"), tHuman = await tabIdOf("human");
  const pW = await page("W");
  await human({ op: "leaseMode", app: "*", mode: "allow" });
  const gW = await human({ op: "leaseGive", rootId: r1, tabId: tW });
  const gO = await human({ op: "leaseGive", rootId: r2, tabId: tOther });
  check("準備 面を 2 つ渡せる（W = 自分の窓の前の tab・other = 人の窓の裏の tab）", gW.ok === true && gO.ok === true, JSON.stringify([gW.hint, gO.hint]));
  const keyW = `tab:${tW}`, keyO = `tab:${tOther}`;
  const tint = (c: string) => evalIn(pW.webSocketDebuggerUrl, `document.getElementById("b").style.background=${JSON.stringify(c)};document.getElementById("h").textContent=${JSON.stringify(c)};1`);
  const activeBefore = JSON.stringify(await activeHuman());

  // UC-e1: agent が働く間（頁が変わる）、数秒あけた 2 枚の写真が違う
  const s1 = await ask({ op: "peek", key: keyW, visible: true });
  check("UC-e1 1 枚目が撮れる（jpeg の data URL）", s1.ok === true && String(s1.img).startsWith("data:image/jpeg;base64,"), JSON.stringify(s1).slice(0, 160));
  await tint("#e11"); await Bun.sleep(3500);
  const s2 = await ask({ op: "peek", key: keyW, visible: true });
  check("UC-e1 3.5 秒あけた 2 枚目が撮れて、1 枚目と違う", s2.ok === true && s2.img !== s1.img, `${String(s1.img).length}B → ${String(s2.img).length}B`);
  check("UC-e1 絵は小さい（native messaging の 1MB に収まる・目安 100KB 未満）", String(s2.img).length < 100_000, `${String(s2.img).length}B`);

  // 重さ: 4 秒ごとに 6 枚（panel が見えている間の実際の間隔）。この試験の Chrome・常駐の全 process の CPU 秒の増え（標本 1 回・混雑時は参考値）
  const cpu = () => Number(Bun.spawnSync(["sh", "-c", `ps -o cputime= -p $(pgrep -f -- ${D} | paste -sd, -) | awk -F'[:.]' '{s+=$1*60+$2+$3/100} END {print s+0}'`]).stdout.toString().trim());
  const [c0, w0] = [cpu(), Date.now()];
  const ms: number[] = [];
  for (let i = 0; i < 6; i++) { const t = performance.now(); await ask({ op: "peek", key: keyW, visible: true }); ms.push(Math.round(performance.now() - t)); await Bun.sleep(4000); }
  say(`重さ: 6 枚 / ${((Date.now() - w0) / 1000).toFixed(0)}s 間・1 枚 ${ms.join(",")}ms・全 process の CPU +${(cpu() - c0).toFixed(2)}s（load ${Bun.spawnSync(["sh", "-c", "uptime | sed 's/.*averages: //'"]).stdout.toString().trim()}）`);
  // 見えていない / 撮れない
  const hid = await ask({ op: "peek", key: keyW, visible: false });
  check("見えていない間は撮らない", hid.ok === false, hid.hint);
  const bg = await ask({ op: "peek", key: keyO, visible: true });
  check("UC-e3 撮れない面（裏の tab）は絵なしで理由 1 行・dialog なし", bg.ok === false && /^絵は出せません: /.test(bg.hint) && !String(bg.hint).includes("\n"), bg.hint);

  // UC-e2: 押さない間は前面が変わらない → 人が押した時だけ、その面が前に 1 回
  await Bun.sleep(4000);
  const idle = JSON.stringify(await activeHuman());
  check("UC-e2 押さない間（撮り続けた区間）は tab の前面が変わらない", idle === activeBefore, `${activeBefore} → ${idle}`);
  const o0 = JSON.stringify(await activeHuman());
  const pressAt = Date.now();
  const f = await human({ op: "peekFront", key: keyO });
  await Bun.sleep(800);
  const o1 = await activeHuman();
  check("UC-e2 押すと、その面（other の tab）だけが前に出る", f.ok === true && o1.some((u: string) => u.includes("n=other")), `${o0} → ${JSON.stringify(o1)} / 押した ${new Date(pressAt).toTimeString().slice(0, 8)}`);
  const left = (await ask({ op: "leaseList" })).leases.map((l: any) => l.key);
  check("UC-e2 押した後も操作権は取り戻されない（人の意思の前面化で agent は止まらない）", left.includes(keyO) && left.includes(keyW), JSON.stringify(left));
  void tHuman;
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
  { const j = judgeFront(out, { paths: [D] }); check("UC-e2 macOS の前面が変わった回数 = 0（headless の tab の前面化は macOS の前面を動かさない・最初から後始末の後まで）", j.ok, j.detail); };
}
say(fails.length ? `\nFAIL ${fails.length}: ${fails.join(" / ")}` : "\n全部 PASS");
process.exit(fails.length ? 1 : 0);
