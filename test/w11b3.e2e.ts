// W2e の通し（手で回す: bun test/web-lease.e2e.ts [--front-watch /path/to/front-watch]）。隔離した home・socket・profile で、本物の Chromium + 本物の拡張 + 本物の常駐を通す。
// owner の bar・常駐・profile には触らない。Chromium は `open -g`（前面にしない）で起こす。人の操作は CDP の trusted event で代役する。
import { mktmp } from "./tmp.ts";
import { humanAsk } from "./human-ask.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalIn, findSw } from "./cdp-sw.ts";
import { rememberOurs } from "./front-judge.ts";
import { cuaDriver } from "../src/lease.ts";
import { CHROMIUM_APP, chromiumArgs, prepare, resetWorkers, stageExtension } from "../src/launch.ts";
import { spawnDaemon } from "./spawn-daemon";

const root = join(import.meta.dir, "..");
const D = mktmp("kangae-w11b3");
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
  const u = new URL(r.url);
  return new Response(`<!doctype html><title>${u.pathname}${u.search}</title><h1>${u.pathname}</h1><label>メモ <input id="q"></label><button id="send">保存</button><ul id="saved"></ul>
<script>document.getElementById("send").onclick=()=>{const t=Date.now();while(Date.now()-t<2000);const li=document.createElement("li");li.textContent=document.getElementById("q").value;document.getElementById("saved").append(li)}</script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
} });
const DOC = "/d/1AbCdEfGh23/edit", DOC2 = "/d/9ZyXwVuTs41/edit", FREE = "/inbox";
const url = (p: string, n: string) => `http://127.0.0.1:${server.port}${p}?n=${n}`;

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


const deadline = setTimeout(() => { say("TIMEOUT"); cleanup(); process.exit(2); }, 300_000);

try {
  const b = Bun.spawnSync(["bun", "build", "--compile", join(root, "src/main.ts"), "--outfile", bin], { cwd: root });
  if (b.exitCode !== 0) throw new Error("build 失敗: " + b.stderr.toString());
  spawnDaemon([bin, "--daemon"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
  for (let i = 0; i < 60 && !(await ask({ op: "ping" })); i++) await Bun.sleep(250);
  const roots = [] as string[];
  for (const t of ["A", "B", "C", "D", "E", "F"]) roots.push((await ask({ op: "add", text: `agent ${t}` })).node.id);
  const o = { app: CHROMIUM_APP, profile, hostBinary: bin, extensionDir: join(root, "extension"), mockKeychain: true, extraArgs: [`--remote-debugging-port=${cdpPort}`, "--no-startup-window", "--headless=new", "--enable-unsafe-extension-debugging"] };
  prepare(o);
  const ext = stageExtension(o.extensionDir, join(D, "extension"));
  resetWorkers(profile, JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")).version);
  Bun.spawn(["open", "-g", "-n", "-a", CHROMIUM_APP, "--env", `KANGAE_HOME=${env.KANGAE_HOME}`, "--env", `KANGAE_SOCK=${sock}`, "--env", `KANGAE_PROFILE=${profile}`, "--args", ...chromiumArgs(o, ext), ...(o.extraArgs ?? [])], { stdout: "ignore", stderr: "ignore" });
  const sw: any = await findSw({ port: cdpPort, extensionDir: ext, nudgeUrl: url(DOC, "nudge") });
  await evalIn(sw.webSocketDebuggerUrl, `chrome.windows.create({url:${JSON.stringify(url(DOC, "nudge"))},focused:false}).then(w=>w.id)`);
  for (let i = 0; i < 40; i++) { try { if ((await targets()).some((t: any) => t.url.includes("n=nudge"))) break; } catch {} await Bun.sleep(500); }
  const browser = await cdp((await jget("/json/version")).webSocketDebuggerUrl);
  const tabs: [string, string][] = [["A", DOC], ["B", DOC], ["C", DOC2], ["D", FREE], ["E", FREE], ["F", DOC]];
  for (const [n, p] of tabs) await browser.send("Target.createTarget", { url: url(p, n), background: true });
  await Bun.sleep(2500);
  const tabIdOf = async (n: string) => JSON.parse(await evalIn(sw.webSocketDebuggerUrl, `chrome.tabs.query({}).then(a=>JSON.stringify(a.find(t=>t.url.includes("n=${n}"))?.id))`));
  await human({ op: "leaseMode", app: "*", mode: "allow" });
  const L: Record<string, { tok: string; input: string; button: string }> = {};
  for (const [i, [n]] of tabs.entries()) {
    const g = await human({ op: "leaseGive", rootId: roots[i], tabId: await tabIdOf(n) });
    if (!g.ok) throw new Error(`give ${n}: ${JSON.stringify(g).slice(0, 200)}`);
    const tok = `tab:${g.lease.surface.tabId}|${g.lease.gen}|${g.lease.owner}`;
    const st = act(tok, "get_window_state", {});
    L[n] = { tok, input: /(d\d+)\ttextbox/.exec(st.out)?.[1] ?? "", button: /(d\d+)\tbutton\t保存/.exec(st.out)?.[1] ?? "" };
  }
  check("6 tab を渡して読めた", Object.values(L).every((x) => x.input && x.button), JSON.stringify(L).slice(0, 200));
  // 非同期に act を打って経過時間と原文を取る（保存 button は 2 秒 busy）
  const run = async (n: string) => { const t = Date.now(); const p = Bun.spawn([bin, "act", "click", JSON.stringify({ element_token: L[n]!.button })], { env: { ...process.env, ...env, KANGAE_LEASE: L[n]!.tok }, stdout: "pipe", stderr: "pipe" }); const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text()); await p.exited; return { n, ms: Date.now() - t, code: p.exitCode, out }; };
  // 同時に: 同じ文書 A・B・F、別の文書 C、id の無い頁 D・E
  const res = Object.fromEntries((await Promise.all(["A", "B", "F", "C", "D", "E"].map(run))).map((r) => [r.n, r]));
  say("原文: " + JSON.stringify(Object.values(res).map((r) => [r.n, r.ms, r.code, r.out.slice(0, 120)])));
  const same = [res.A!, res.B!, res.F!].sort((x, y) => x.ms - y.ms);
  check("同じ文書 3 tab の書き換えは順番待ち（速い順に ≈2s・≈4s・≈6s 以上）", same[1]!.ms >= 3500 && same[2]!.ms >= 5500, same.map((r) => `${r.n}:${r.ms}ms code${r.code}`).join(" "));
  check("別の文書 C は待たない（≈2s）", res.C!.ms < 3500 && res.C!.code === 0, `${res.C!.ms}ms`);
  check("id の無い頁 D・E は並行のまま（どちらも ≈2s・待たない）", res.D!.ms < 3500 && res.E!.ms < 3500 && res.D!.code === 0 && res.E!.code === 0, `D=${res.D!.ms} E=${res.E!.ms}`);
  check("待った書き換えも最後は通る（時間切れで断られない・全部 code 0）", same.every((r) => r.code === 0), same.map((r) => r.out.slice(0, 80)).join(" | "));
} catch (e) {
  say("ERROR " + (e as Error).stack);
  fails.push("error");
} finally {
  clearTimeout(deadline);
  cleanup();
}
say(fails.length ? `\nFAIL ${fails.length}: ${fails.join(" / ")}` : "\n全部 PASS");
process.exit(fails.length ? 1 : 0);
