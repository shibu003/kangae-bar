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
  const ext = stageExtension(join(root, "extension"), join(D, "extension"));
  mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
  const { HOST_NAME } = await import("../src/launch.ts"); const { EXT_ORIGIN } = await import("../src/main.ts");
  writeFileSync(join(profile, "NativeMessagingHosts", `${HOST_NAME}.json`), JSON.stringify({ name: HOST_NAME, description: "考えの空", path: bin, type: "stdio", allowed_origins: [EXT_ORIGIN] }));
  const mainChrome = `/Applications/Google Chrome.app`;
  say(`起動前の画面: ${JSON.stringify({ ...JSON.parse(Bun.spawnSync([WC, "1"]).stdout.toString()), windows: undefined })}`);
  Bun.spawn(["open", "-g", "-n", "-a", mainChrome, "--env", `KANGAE_HOME=${env.KANGAE_HOME}`, "--env", `KANGAE_SOCK=${sock}`, "--env", `KANGAE_PROFILE=${profile}`, "--args", `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--no-startup-window"], { stdout: "ignore", stderr: "ignore" });
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

  const dump = (name: string, text: string) => { if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, name), text); } };
  if (!real) {
    // ---- 道具の仕組み（claude を使わない）----
    const before = seen.length;
    const f1 = await act(tok, "fetch_url", {});
    raw("fetch_url（url 省略 = tab の今の頁）", f1.out.slice(0, 400));
    check("M1 fetch_url が tab の今の頁のサーバー上の値を返す（tab の古い 1,000円ではなく 2,480円）", f1.code === 0 && f1.out.includes("2,480円") && !f1.out.includes("1,000円"));
    check("M1 サーバーが見たのは cookie ありの dest=empty（拡張の fetch・document の読み込みではない）", seen.slice(before).some((s) => s.startsWith("/account cookie=あり") && s.includes("dest=empty")), seen.slice(before).join(" | "));
    check("M1 tab・窓が 1 つも増えない", same(await screen(), base0), JSON.stringify(await screen()));
    const f2 = await act(tok, "fetch_url", { url: "http://localhost:" + server.port + "/account" });
    check("M2 別の origin（localhost）は門が拒否・サーバーへ要求が行かない", f2.code === 1 && f2.out.includes("同じ site") && !seen.some((s) => s.includes("localhost")), f2.out.trim().slice(0, 120));
    const f3 = await act(tok, "fetch_url", { url: "/table" });
    check("M3 JS で描かれる頁を fetch_url で取ると、値は入らない（描画が要る）", f3.code === 0 && !f3.out.includes("大阪") && f3.out.includes("render_url"), f3.out.slice(0, 160).replace(/\n/g, " "));
    const r1 = await act(tok, "render_url", { url: "/table" });
    raw("render_url /table", r1.out.slice(0, 300));
    check("M4 render_url が JS の描いた表を読める（東京 17・大阪 42・福岡 8）", r1.code === 0 && r1.out.includes("大阪") && r1.out.includes("42") && r1.out.includes("福岡"));
    check("M4 描いた後も tab・窓が増えない・offscreen 文書は閉じ・content script の登録は残らない", same(await screen(), base0) && (await inSw("chrome.offscreen.hasDocument()")) === false && (await inSw("chrome.scripting.getRegisteredContentScripts().then(a=>a.length)")) === 0, JSON.stringify({ screen: await screen(), has: await inSw("chrome.offscreen.hasDocument()"), regs: await inSw("chrome.scripting.getRegisteredContentScripts().then(a=>a.length)") }));
    const r2 = await act(tok, "render_url", { url: "/xfo-table" });
    check("M5 X-Frame-Options: DENY の頁も既存の embed-rules で描ける", r2.code === 0 && r2.out.includes("大阪"), r2.out.slice(0, 100).replace(/\n/g, " "));
    const both = await Promise.all([0, 1, 2, 3].map(async () => act(tok, "render_url", { url: "/table" })));
    check("M6 render_url を同時に 4 本（片方が終わっても他方が壊れない）", both.every((x) => x.code === 0 && x.out.includes("大阪")), both.map((x) => `${x.code}:${x.out.trim().slice(0, 90).replace(/\n/g, " ")}`).join(" | "));
    check("M6 同時の後も offscreen 文書は閉じ・登録は残らない", (await inSw("chrome.offscreen.hasDocument()")) === false && (await inSw("chrome.scripting.getRegisteredContentScripts().then(a=>a.length)")) === 0);
    check("M7 lease は生きたまま（読むだけでは取り戻されない）", (await ask({ op: "leaseList" })).leases.length === 1);
    const login = await pageOf("/notes");
    check("M8 cookie が無ければ（omit した対照）サーバーは 401: 人の cookie が乗っている証拠は cookie=あり の要求", seen.some((s) => s.startsWith("/api/rows cookie=あり")), seen.filter((s) => s.startsWith("/api/rows")).slice(0, 3).join(" | "));
    void login;
  } else {
    // ---- UC-c1〜c3（本物の claude）----
    const models = () => { const proj = join(homedir(), ".claude/projects"); const tag = D.split("/").pop()!; const m = new Map<string, number>(); if (existsSync(proj)) for (const d of readdirSync(proj).filter((n) => n.includes(tag))) for (const f of readdirSync(join(proj, d)).filter((x) => x.endsWith(".jsonl"))) for (const x of readFileSync(join(proj, d, f), "utf8").matchAll(/"model":"([^"]+)"/g)) m.set(x[1]!, (m.get(x[1]!) ?? 0) + 1); return m; };
    const runUc = async (name: string, text: string, during?: () => Promise<unknown>) => {
      const bUc = await screen(); const nSeen = seen.length;
      const s = await ask({ op: "send", rootId, text });
      say(`${name}: 一言目「${text}」→ ${JSON.stringify(s).slice(0, 120)}`);
      let log: string[] = [];
      const poll = setInterval(async () => { const r = await ask({ op: "runs", nodeIds: [rootId] }); const l = r?.runs?.[0]?.log as string[] | undefined; if (l) for (const x of l) if (!log.includes(x)) { log.push(x); say(`  途中: ${x.slice(0, 220)}`); } }, 2000);
      const dur = during?.();
      const finished = await until(async () => { const r = await ask({ op: "runs", nodeIds: [rootId] }); const st = r?.runs?.[0]?.status; return !!st && st !== "running"; }, 420_000);
      clearInterval(poll); await dur;
      const runs = (await ask({ op: "runs", nodeIds: [rootId] })).runs[0];
      const chat = (await ask({ op: "chat", rootId })).rows as { who?: string; text: string; body?: string }[];
      const reply = String([...chat].reverse().find((r) => (r.who ?? "").startsWith("they") || String(r.text).startsWith("🤖"))?.text ?? chat.at(-1)?.text ?? "");
      raw(`${name} 返事の原文`, reply);
      dump(`${name}-run.log`, `# ${name}\n一言目: ${text}\n状態: ${runs.status}\n\n## 途中経過\n${log.join("\n")}\n\n## 返事の原文\n${reply}\n\n## サーバーが見た要求\n${seen.slice(nSeen).join("\n")}\n`);
      const aUc = await screen();
      check(`${name} agent が最後まで終わった（status=${runs.status}）`, finished && runs.status === "idle");
      check(`${name} 画面に我々の物が増えない（tab・窓・onscreen が前後で同じ）`, same(aUc, bUc), `前=${JSON.stringify(bUc)} 後=${JSON.stringify(aUc)}`);
      return { reply, log, since: seen.slice(nSeen) };
    };
    // UC-c1 読むだけ
    const c1 = await runUc("UC-c1", "渡した請求の頁、今の「次回請求額」はいくら？ 頁は古いかもしれないので、サーバー上の今の値で");
    check("UC-c1【合格の線】返事に 2,480 円が入る（tab の古い 1,000 円ではない）", /2,?480/.test(c1.reply), c1.reply.slice(0, 120));
    check("UC-c1 agent は拡張の道（fetch の dest=empty か iframe の描画）で今の頁を取った（log 行は 80 字で切れるのでサーバー側の証拠で見る）", c1.since.some((s) => s.startsWith("/account cookie=あり") && (s.includes("site=none dest=empty") || s.includes("dest=iframe"))), c1.since.join(" | "));
    check("UC-c1 サーバーが見たのは cookie ありの dest=empty の /account（拡張の fetch）", c1.since.some((s) => s.startsWith("/account cookie=あり") && s.includes("dest=empty")), c1.since.join(" | "));
    // UC-c2 描画が要る
    const c2 = await runUc("UC-c2", "同じ site の /table の「地域別の件数」の表を読んで、一番多い地域を教えて");
    check("UC-c2【合格の線】返事に「大阪」（42）が入る", c2.reply.includes("大阪"), c2.reply.slice(0, 120));
    check("UC-c2 agent は見えない面で描いた（/table が dest=iframe で読まれた）", c2.since.some((s) => s.startsWith("/table cookie=あり") && s.includes("dest=iframe")), c2.since.join(" | "));
    check("UC-c2 サーバーが見たのは iframe の中の /api/rows（cookie あり・same-origin）", c2.since.some((s) => s.startsWith("/api/rows cookie=あり")), c2.since.join(" | "));
    // UC-c3 人が打っている最中に UC-c1
    bill = 3150;
    let typed = 0; const keysBefore = await evalIn(human.webSocketDebuggerUrl, "window.__k");
    const tabsHuman = async () => (await jget("/json/list")).filter((t: any) => t.type === "page").length;
    const tabsBefore = await tabsHuman();
    let stop = false;
    const human3 = (async () => { while (!stop) { await typeKey(human.webSocketDebuggerUrl, "z"); typed++; await Bun.sleep(600); } })();
    const c3 = await runUc("UC-c3", "渡した請求の頁、今の「次回請求額」はいくら？ サーバー上の今の値で", async () => { /* 人は並行して打ち続ける */ });
    stop = true; await human3; await Bun.sleep(500);
    const keys = (await evalIn(human.webSocketDebuggerUrl, "window.__k")) - keysBefore;
    check("UC-c3【合格の線】返事に 3,150 円", /3,?150/.test(c3.reply), c3.reply.slice(0, 120));
    check("UC-c3 人の入力が 1 つも取りこぼされない・人の tab に全部届いた", keys === typed && typed > 5, `打った=${typed} 届いた=${keys}`);
    check("UC-c3 人の窓の tab strip に何も増えない（tab 数が前後で同じ）", (await tabsHuman()) === tabsBefore, `前=${tabsBefore} 後=${await tabsHuman()}`);
    check("UC-c3 lease は agent の操作で取り戻されていない", (await ask({ op: "leaseList" })).leases.length === 1);
    const m = models();
    say(`答えた model（claude の session 記録 jsonl）: ${JSON.stringify([...m])} env ANTHROPIC_MODEL=${process.env.ANTHROPIC_MODEL ?? "(無し)"}`);
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
