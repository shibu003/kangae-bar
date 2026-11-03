// holes-1 H1（--real = さらに UC-x1 を本物の claude で）: 常駐を落として起こし直す → 人が何も触らず tab を渡せるまでの秒数（w3c の土台を流用）。--old = 直す前の拡張（負の対照）
// W3c の通し（手で回す）: 隔離 profile の Google Chrome + 本物の拡張 + 本物の常駐で、「画面に我々の物を増やさずに別の頁を読む」を通す。
// 使い方: bun test/w3c.e2e.ts <front-watch> <win-count> [--real] [--fw-sec N] [--out <dir>]
//   既定 = 道具の仕組み（kangae act を直に打つ・claude を使わない）/ --real = UC-c1〜c3 を本物の claude（ANTHROPIC_MODEL を引き継ぐ）で。
//   owner の Chrome・profile・拡張・bar・常駐には触らない（pid は自分の user-data-dir で引く）。Chrome 154 は --load-extension が効かないので、試験だけ CDP Extensions.loadUnpacked で入れる。
//   画面に出た物は win-count（CGWindowList・自分の Chrome の pid の窓だけ）と tab の数で数える。人の画面の写真は撮らない。
import { mktmp } from "./tmp.ts";
import { humanAsk } from "./human-ask.ts";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { judgeFront, rememberOurs } from "./front-judge.ts";
import { stageExtension } from "../src/launch.ts";
import { spawnDaemon } from "./spawn-daemon";

const root = join(import.meta.dir, "..");
const [FW, WC] = [process.argv[2]!, process.argv[3]!];
const real = process.argv.includes("--real");
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const FW_SEC = Number(arg("--fw-sec") ?? (real ? 720 : 150));
const out = arg("--out");
const D = mktmp("kangae-w3c-e2e");
const sock = join(D, "s.sock");
const bin = join(D, "kangae");
const profile = join(D, "profile"); mkdirSync(profile, { recursive: true });
const cdpPort = 9300 + Math.floor(Math.random() * 500);
const env = { KANGAE_HOME: join(D, "home"), KANGAE_SOCK: sock, KANGAE_BAR: join(D, "bar.json"), KANGAE_NODES_DIR: join(D, "nodes"), KANGAE_CDP_PORT: "1" /* 既定の 9339 に居る owner の browser を agent に渡さない */ };
const humanOp = humanAsk(env.KANGAE_BAR); // sec1: 承認の表などは人が押す op＝unix socket（agent の口）では断られる。人の口（/ws）から送る
const fails: string[] = [];
const t0 = Date.now();
const clock = () => new Date().toTimeString().slice(0, 8);
const say = (s: string) => console.log(`[${clock()} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const check = (name: string, ok: boolean, detail = "") => { say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) fails.push(name); };
const raw = (title: string, body: string) => console.log(`--- ${title} ---\n${body}\n---`);

// 前面の監視は何かを起こす前から後始末の後まで 1 本で切らない
const fw = Bun.spawn([FW, String(FW_SEC)], { stdout: "pipe" }); const fwStart = Date.now();
say(`開始 mode=${real ? "real（本物の claude）" : "mechanics（act を直に打つ）"} ANTHROPIC_MODEL=${process.env.ANTHROPIC_MODEL ?? "(無し)"} load=${Bun.spawnSync(["sh", "-c", "uptime | sed 's/.*averages: //'"]).stdout.toString().trim()}`);

// ---- 試験の site（login が要る・サーバーの値は後から変わる）----
let bill = 1000;
const seen: string[] = [];
const rows = [["東京", 17], ["大阪", 42], ["福岡", 8]];
const tableHtml = `<!doctype html><title>地域別の件数</title><h1>地域別の件数</h1><table id=t></table><script>fetch("/api/rows").then(r=>r.json()).then(a=>{t.innerHTML="<tr><th>地域</th><th>件数</th></tr>"+a.map(r=>"<tr><td>"+r[0]+"</td><td>"+r[1]+"</td></tr>").join("")})</script>`;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  const u = new URL(r.url); const ck = r.headers.get("cookie") ?? ""; const authed = /sid=SECRET1/.test(ck);
  seen.push(`${u.pathname} cookie=${authed ? "あり" : "なし"} site=${r.headers.get("sec-fetch-site")} dest=${r.headers.get("sec-fetch-dest")}`);
  const html = (b: string, extra: Record<string, string> = {}) => new Response(b, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra } });
  if (u.pathname === "/login") return new Response(null, { status: 302, headers: { location: "/notes", "set-cookie": "sid=SECRET1; Path=/; HttpOnly" } });
  if (u.pathname === "/notes") return html(`<!doctype html><title>メモ</title><h1>メモ</h1><input id=q><script>window.__k=0;addEventListener("keydown",e=>{if(e.isTrusted)window.__k++},true)</script>`);
  if (u.pathname === "/bump") { bill = Number(u.searchParams.get("to")); return new Response("ok"); }
  if (!authed) return new Response("login required", { status: 401 });
  if (u.pathname === "/account") return html(`<!doctype html><title>請求</title><h1>請求</h1><p id=amt>次回請求額: ${bill.toLocaleString("en-US")}円</p>`);
  if (u.pathname === "/api/rows") return Response.json(rows);
  if (u.pathname === "/table") return html(tableHtml);
  if (u.pathname === "/xfo-table") return html(tableHtml, { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
  return new Response("404", { status: 404 });
} });
const base = `http://127.0.0.1:${server.port}`;

// ---- 常駐・Chrome・CDP ----
async function ask(m: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    let buf = "";
    Bun.connect({ unix: sock, socket: { data(s, c) { buf += new TextDecoder().decode(c); for (const l of buf.split("\n")) { try { const j = JSON.parse(l); if (j.id === id) { s.end(); resolve(j); } } catch {} } }, error() {} } }).then((s) => s.write(JSON.stringify({ id, ...m }) + "\n"), () => resolve(null));
  });
}
const act = async (token: string, tool: string, args: object) => { const p = Bun.spawn([bin, "act", tool, JSON.stringify(args)], { env: { ...process.env, ...env, KANGAE_LEASE: token }, stdout: "pipe", stderr: "pipe" }); const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { code, out: o + e }; }; // 非同期（同期で待つと sw の console を拾う口が止まる）
const cdp = async (wsUrl: string) => { const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r)); let id = 0; const pend = new Map<number, (v: any) => void>(); ws.onmessage = (e) => { const j = JSON.parse(String(e.data)); pend.get(j.id)?.(j); }; return { send: (method: string, params: object = {}) => new Promise<any>((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() }; };
const jget = async (p: string) => (await fetch(`http://127.0.0.1:${cdpPort}${p}`)).json() as Promise<any>;
const evalIn = async (wsUrl: string, expr: string): Promise<any> => { const c = await cdp(wsUrl); const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); c.close(); if (r.result?.exceptionDetails || r.error) throw new Error("evalIn: " + JSON.stringify(r).slice(0, 300)); return r.result?.result?.value; };
const typeKey = async (wsUrl: string, ch: string) => { const c = await cdp(wsUrl); await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }); await Bun.sleep(100); for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, text: ch, key: ch }); c.close(); };
const mainPid = () => Number(Bun.spawnSync(["bash", "-c", `pgrep -f -- '--user-data-dir=${profile}' | while read p; do ps -p $p -o command= | grep -q -- '--type=' || echo $p; done | head -1`]).stdout.toString().trim() || 0);
const until = async (f: () => Promise<boolean>, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await Bun.sleep(500); } return false; };

const cleanup = async () => {
  rememberOurs(D);
  say("後始末: 自分の user-data-dir の Chrome・常駐だけを止める");
  for (const p of Bun.spawnSync(["pgrep", "-f", D]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  for (const p of Bun.spawnSync(["lsof", "-t", sock]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  await Bun.sleep(1500);
  server.stop(true);
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "site-requests.log"), seen.join("\n") + "\n"); }
  rmSync(D, { recursive: true, force: true });
  say("後始末 済み");
};

try {
  const b = Bun.spawnSync(["bun", "build", "--compile", join(root, "src/main.ts"), "--outfile", bin], { cwd: root });
  if (b.exitCode !== 0) throw new Error("build 失敗: " + b.stderr.toString());
  spawnDaemon([bin, "--daemon"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
  for (let i = 0; i < 80 && !(await ask({ op: "ping" })); i++) await Bun.sleep(250);
  const rootId = (await ask({ op: "add", text: "請求の見張り" })).node.id;

  // Chrome（窓なし・前面にしない）。拡張は profile の隣に写した物を CDP で入れる（試験だけ）。native host の口は profile の NativeMessagingHosts
  const old = process.argv.includes("--old");
  if (old) { const x = join(D, "oldsrc"); mkdirSync(x, { recursive: true }); Bun.spawnSync(["sh", "-c", `cp -R ${join(root, "extension")}/. ${x}/ && git -C ${root} show HEAD:extension/sw.js > ${x}/sw.js && git -C ${root} show HEAD:extension/manifest.json > ${x}/manifest.json`]); }
  const ext = stageExtension(old ? join(D, "oldsrc") : join(root, "extension"), join(D, "extension"));
  mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
  const { HOST_NAME } = await import("../src/launch.ts"); const { EXT_ORIGIN } = await import("../src/main.ts");
  writeFileSync(join(profile, "NativeMessagingHosts", `${HOST_NAME}.json`), JSON.stringify({ name: HOST_NAME, description: "考えの空", path: bin, type: "stdio", allowed_origins: [EXT_ORIGIN] }));
  const mainChrome = `/Applications/Google Chrome.app`;
  say(`起動前の画面: ${JSON.stringify({ ...JSON.parse(Bun.spawnSync([WC, "1"]).stdout.toString()), windows: undefined })}`);
  Bun.spawn(["open", "-g", "-n", "-a", mainChrome, "--env", `KANGAE_HOME=${env.KANGAE_HOME}`, "--env", `KANGAE_SOCK=${sock}`, "--env", `KANGAE_PROFILE=${profile}`, "--args", `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--no-startup-window", "--headless=new"], { stdout: "ignore", stderr: "ignore" });
  let bws = "";
  for (let i = 0; i < 60 && !bws; i++) { try { bws = (await jget("/json/version")).webSocketDebuggerUrl; } catch { await Bun.sleep(500); } }
  const bc = await cdp(bws);
  say("Extensions.loadUnpacked → " + JSON.stringify((await bc.send("Extensions.loadUnpacked", { path: ext })).result));
  let sw: any;
  for (let i = 0; i < 60 && !sw; i++) { const c = (await jget("/json/list")).find((t: any) => t.type === "service_worker" && t.url.endsWith("/sw.js")); if (c) sw = c; else await Bun.sleep(500); }
  if (!sw) throw new Error("拡張の sw が出ない");
  { // 拡張の sw の console と未捕捉の例外を、途中経過として残す
    const w = new WebSocket(sw.webSocketDebuggerUrl); await new Promise((r) => (w.onopen = r));
    w.onmessage = (e) => { const j = JSON.parse(String(e.data)); if (j.method === "Runtime.consoleAPICalled") say(`  sw console.${j.params.type}: ${j.params.args.map((a: any) => a.value ?? a.description).join(" ").slice(0, 300)}`); if (j.method === "Runtime.exceptionThrown") say(`  sw 例外: ${JSON.stringify(j.params.exceptionDetails.exception?.description ?? j.params.exceptionDetails.text).slice(0, 400)}`); };
    w.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
  }
  const inSw = async (expr: string) => { const v = await evalIn(sw.webSocketDebuggerUrl, `(async()=>JSON.stringify(await (${expr})))()`); try { return JSON.parse(v); } catch { return v; } };
  for (let i = 0; i < 40 && !(await ask({ op: "leaseList" })); i++) await Bun.sleep(250);
  await Bun.sleep(2500); // sw が native host に繋ぐのを待つ
  say(`Chrome ${(await jget("/json/version")).Browser} pid=${mainPid()}`);

  // 画面に出た物の数え方（窓 = CGWindowList の自分の pid・tab = chrome.tabs）。試験の Chrome 自体が Dock に出る分（dockMine）は別に書く
  const screen = async () => { const w = JSON.parse(Bun.spawnSync([WC, String(mainPid())]).stdout.toString()); return { tabs: await inSw("chrome.tabs.query({}).then(a=>a.length)") as number, chromeWins: await inSw("chrome.windows.getAll().then(a=>a.length)") as number, osWindows: w.allWindows as number, onscreen: w.onscreen as number, dockMine: w.dockMine as number }; };
  const same = (a: any, b: any) => a.tabs === b.tabs && a.chromeWins === b.chromeWins && a.osWindows === b.osWindows && a.onscreen === b.onscreen;

  // 準備（人の役）: login → メモの tab（= 人の窓の tab）。請求の tab（agent に渡す）と表の頁は同じ窓の tab に
  await bc.send("Target.createTarget", { url: `${base}/login`, background: true });
  await until(async () => (await jget("/json/list")).some((t: any) => t.url.includes("/notes")), 15_000);
  await bc.send("Target.createTarget", { url: `${base}/account`, background: true });
  await until(async () => (await jget("/json/list")).some((t: any) => t.url.includes("/account")), 15_000);
  await Bun.sleep(1500);
  const pageOf = async (frag: string) => (await jget("/json/list")).find((t: any) => t.type === "page" && t.url.includes(frag));
  const human = await pageOf("/notes");
  const tabId = await inSw(`chrome.tabs.query({}).then(a=>a.find(t=>t.url.includes("/account"))?.id)`);
  say(`準備: 人の login 済み・メモの tab・請求の tab（tabId=${tabId}・頁の値は 1,000円で古くなる）`);
  bill = 2480; // サーバーの今の値は変わった（tab の頁は 1,000円のまま古い）
  await humanOp({ op: "leaseMode", app: "*", mode: "allow" }); // 承認の層は W4a の検査が持つ。ここは他の層を測る
  const give = await humanOp({ op: "leaseGive", rootId, tabId });
  check("請求の tab を渡せる", give.ok === true, JSON.stringify(give).slice(0, 120));
  const tok = `tab:${tabId}|${give.lease.gen}|${give.lease.owner}`;
  const base0 = await screen();
  say(`基準線（agent が動く前）: ${JSON.stringify(base0)}（dockMine=1 は試験の Chrome 自体）`);

  void out;
  // ---- H1: 常駐を落とす → 起こし直す → 人は何も触らず tab を渡して読ませる ----
  const readOk = async () => { const g = await humanOp({ op: "leaseGive", rootId, tabId }); if (!g?.ok) return `give失敗 ${JSON.stringify(g).slice(0, 80)}`; const r = await act(`tab:${tabId}|${g.lease.gen}|${g.lease.owner}`, "fetch_url", {}); return r.code === 0 && r.out.includes("2,480円") ? "ok" : `act失敗 ${r.out.trim().slice(0, 100)}`; };
  check("前提 常駐が生きている間は読める", (await readOk()) === "ok");
  for (const p of Bun.spawnSync(["lsof", "-t", sock]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p), "SIGKILL"); } catch {}
  const tKill = Date.now(); say("常駐を kill（以後、人は何も触らない）");
  await Bun.sleep(1000);
  spawnDaemon([bin, "--daemon"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
  say("常駐を起こし直した（bar を開き直した相当）");
  for (let i = 0; i < 80 && !(await ask({ op: "ping" })); i++) await Bun.sleep(250);
  await humanOp({ op: "leaseMode", app: "*", mode: "allow" }); const root2 = (await ask({ op: "add", text: "再起動後" })).node.id; void root2;
  let res = "", sec = -1;
  for (let i = 0; i < 12; i++) { const r = await Promise.race([readOk(), Bun.sleep(8000).then(() => "timeout")]); res = r; if (r === "ok") { sec = (Date.now() - tKill) / 1000; break; } say(`  再試行 ${((Date.now() - tKill) / 1000).toFixed(1)}s: ${r}`); await Bun.sleep(1000); }
  check(`H1 常駐の再起動の後、人が何も触らずに tab を渡して読める（${sec.toFixed(1)}s）`, sec >= 0 && sec <= 40, res);
  say(`H1 結果: ${sec} 秒（kill から）`);
  // H1d: 素の SIGTERM（logout / shutdown / kill）で落ちた常駐は、拡張が人の手なしで起こし直す。H1b: 人が押した「全部終わる」（印を置いてから SIGTERM = bar の quitAll）は起こさない。
  // H1c: 印がある間、拡張が起こす relay（native host）の数を 120 秒数える（伸びる backoff・「止まっている」を知ったら黙る）
  { const pids = () => Bun.spawnSync(["lsof", "-t", sock]).stdout.toString().split("\n").filter(Boolean).map(Number);
    const mark = join(env.KANGAE_HOME, "quit");
    const relays = new Set<number>();
    const sampleRelays = () => { for (const l of Bun.spawnSync(["bash", "-c", `ps -axo pid,command | grep -- "${D}/kangae chrome-extension://" | grep -v grep`]).stdout.toString().split("\n")) { const m = /^\s*(\d+)\s/.exec(l); if (m) relays.add(Number(m[1])); } };
    // H1d: 印を置かない素の SIGTERM
    for (const p of pids()) process.kill(p, "SIGTERM"); const tq = Date.now();
    await Bun.sleep(2000);
    check("H1d 素の SIGTERM では印は置かれない", !existsSync(mark), `印=${existsSync(mark)}`);
    await humanOp({ op: "leaseMode", app: "*", mode: "allow" }).catch(() => {});
    let rd = "", sd = -1;
    for (let i = 0; i < 40 && sd < 0; i++) { if (await ask({ op: "ping" })) { await humanOp({ op: "leaseMode", app: "*", mode: "allow" }); rd = await Promise.race([readOk(), Bun.sleep(8000).then(() => "timeout")]); if (rd === "ok") sd = (Date.now() - tq) / 1000; } if (sd < 0) await Bun.sleep(1000); }
    check(`H1d 素の SIGTERM で落ちた常駐は、人が何も触らずに拡張が起こし直し ${sd.toFixed(1)}s で読める`, sd >= 0 && sd <= 45, rd);
    // H1b + H1c: 印を置いてから SIGTERM（= bar の quitAll）
    writeFileSync(mark, String(Date.now()));
    for (const p of pids()) process.kill(p, "SIGTERM"); const tb = Date.now();
    say("印を置いて SIGTERM（quitAll の道）。120 秒、拡張が起こす relay の pid を数える");
    let aliveAt25: boolean | null = null;
    while (Date.now() - tb < 120_000) { sampleRelays(); if (aliveAt25 === null && Date.now() - tb > 25_000) aliveAt25 = !!(await ask({ op: "ping" })); await Bun.sleep(300); }
    const aliveEnd = !!(await ask({ op: "ping" }));
    check("H1b 印を置いて止めた常駐は、25 秒後も 120 秒後も拡張の再接続で起き直っていない", aliveAt25 === false && !aliveEnd, `25s=${aliveAt25} 120s=${aliveEnd}`);
    say(`H1c 印がある 120 秒に拡張が起こした relay の数 = ${relays.size}（pid ${JSON.stringify([...relays])}）`);
    check("H1c 120 秒に起こす relay は 4 つ以内", relays.size <= 4, `数=${relays.size}`);
    spawnDaemon([bin, "--daemon"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
    for (let i = 0; i < 80 && !(await ask({ op: "ping" })); i++) await Bun.sleep(250);
    await humanOp({ op: "leaseMode", app: "*", mode: "allow" });
    let r2 = "", s2 = -1; const tr = Date.now();
    for (let i = 0; i < 12; i++) { r2 = await Promise.race([readOk(), Bun.sleep(8000).then(() => "timeout")]); if (r2 === "ok") { s2 = (Date.now() - tr) / 1000; break; } await Bun.sleep(1000); }
    check(`H1b 人が起こし直した後は、人が何も触らずに ${s2.toFixed(1)}s で読める（印は常駐の起動で消える: ${!existsSync(mark)}）`, s2 >= 0 && s2 <= 90 && !existsSync(mark), r2);
  }
  if (real) {
    // ---- UC-x1: 開き直してすぐ（人は何も触らず）tab を渡して「この頁の値は？」→ 答えに値（本物の claude）----
    say("---- UC-x1: 常駐を再起動した直後に tab を渡して聞く ----");
    const g = await humanOp({ op: "leaseGive", rootId, tabId });
    check("UC-x1 再起動の後に tab を渡せる", g?.ok === true, JSON.stringify(g).slice(0, 100));
    const text = "渡した請求の頁、今の「次回請求額」はいくら？ 頁は古いかもしれないので、サーバー上の今の値で";
    const s = await ask({ op: "send", rootId, text }); say(`一言目「${text}」→ ${JSON.stringify(s).slice(0, 100)}`);
    const logs: string[] = [];
    const poll = setInterval(async () => { const r = await ask({ op: "runs", nodeIds: [rootId] }); for (const x of (r?.runs?.[0]?.log as string[] | undefined) ?? []) if (!logs.includes(x)) { logs.push(x); say(`  途中: ${x.slice(0, 200)}`); } }, 2000);
    const fin = await until(async () => { const r = await ask({ op: "runs", nodeIds: [rootId] }); const st = r?.runs?.[0]?.status; return !!st && st !== "running"; }, 420_000);
    clearInterval(poll);
    const chat = (await ask({ op: "chat", rootId })).rows as { who?: string; text: string }[];
    const reply = String([...chat].reverse().find((r) => (r.who ?? "").startsWith("they") || String(r.text).startsWith("🤖"))?.text ?? chat.at(-1)?.text ?? "");
    raw("UC-x1 返事の原文", reply);
    check("UC-x1 agent が最後まで終わった", fin);
    check("UC-x1【合格の線】返事に 2,480 円（tab の古い 1,000 円ではない）", /2,?480/.test(reply), reply.slice(0, 120));
    const proj = join(homedir(), ".claude/projects"); const tag = D.split("/").pop()!; const m = new Map<string, number>();
    if (existsSync(proj)) for (const d of readdirSync(proj).filter((n) => n.includes(tag))) for (const f of readdirSync(join(proj, d)).filter((x) => x.endsWith(".jsonl"))) for (const x of readFileSync(join(proj, d, f), "utf8").matchAll(/"model":"([^"]+)"/g)) m.set(x[1]!, (m.get(x[1]!) ?? 0) + 1);
    say(`答えた model: ${JSON.stringify([...m])}`);
    check("答えた model が claude-sonnet-5-5 だけ", m.size > 0 && [...m.keys()].every((k) => k === "claude-sonnet-5-5"), JSON.stringify([...m]));
  }
  say(`最後の画面: ${JSON.stringify(await screen())}`);
} catch (e) {
  fails.push("例外: " + String((e as Error)?.stack ?? e));
  console.log(String((e as Error)?.stack ?? e));
}
await cleanup();
await Bun.sleep(Math.max(0, (FW_SEC + 1) * 1000 - (Date.now() - fwStart)));
const fwOut = (await new Response(fw.stdout).text()).trim();
console.log(`--- front-watch 全文（何かを起こす前〜後始末の後まで ${Math.round((Date.now() - fwStart) / 1000)}s・切っていない）---\n${fwOut}`);
{ const j = judgeFront(fwOut, { paths: [D] }); check("AC-3 前面が変わった回数 = 0（最初から後始末の後まで）", j.ok, j.detail); };
console.log(fails.length ? `\nFAIL ${fails.length}: ${fails.join(" / ")}` : `\n全部 PASS（${real ? "本物の claude" : "道具の仕組み"}）`);
process.exit(fails.length ? 1 : 0);
