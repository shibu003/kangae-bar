// w28-shot: bar の panel を窓の大きさ 4 通り × 明・暗 × 一覧 / 会話（承認 card つき）/ 長い報告 / 新規（空）で撮り、見づらさを数字でも拾う（14px 未満の字・36px 未満の押せる物・横あふれ・コントラスト）。headless Chromium のみ・画面に出ない。
// 使い方（runner・低 load の時）: bun tools/w28-shot.ts <outDir>   例: docs/verify/w28/before
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capOf } from "../src/lease.ts";
import { openStore } from "../src/store.ts";
import { spawnDaemon } from "../test/spawn-daemon";
import { pollUntil } from "../src/wait.ts";

const repo = join(import.meta.dir, "..");
const OUT = process.argv[2] ?? join(repo, "docs/verify/w28/run");
mkdirSync(OUT, { recursive: true });
const D = mkdtempSync(join(tmpdir(), "kangae-barshot-"));
const say = (s: string) => console.log(s);
const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd); if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`); return r.stdout.toString(); };
const BACK = { light: "f3f3f6", dark: "232326" };


// 3. 偽の leaseList（W11a の 6 行・W11c の 3 状態・W11d の離れたら始めます・W8g-4 の金庫 card・承認 card）。capOf は本物
const now = Date.now();
const mk = (surface: any, o: any = {}) => { const l: any = { surface, owner: "s:1", gen: 1, exp: now + 20 * 60_000, confirmed: true, ...o }; return { key: o.key, ...l, token: "t", undo: o.undo ?? 0, rights: capOf(l, o.mode ?? "ask", now, "default") }; };
const fixture = {
  ok: true,
  leases: [mk({ app: "Zed", title: "ER_Triage_GUI", pid: 11, windowId: 1 }, { key: "win:11:1", owner: "s:3", undo: 1 })],
  approvals: [
    { id: "a1", key: "win:11:1", owner: "s:3", app: "メモ", title: "買い物", tool: "open_app", what: "Zed を裏で開きます（/Users/you/work/ER_Triage_GUI）", danger: true, note: "今の画面は変わりません（前には出しません）。許すと、agent はこの app の窓を操作できるようになります。断ると何も開きません" },
    { id: "a2", key: "win:11:1", owner: "s:3", app: "Zed", title: "ER_Triage_GUI", tool: "click", what: "削除を押す", danger: true },
  ],
  recoveries: [], carries: [],
  routineCards: [], modes: [],
};
const preload = join(D, "preload.js");
writeFileSync(preload, `(()=>{const F=${JSON.stringify(fixture)};const R=WebSocket;globalThis.WebSocket=class extends R{send(s){try{const m=JSON.parse(s);if(m.op==="leaseList"){setTimeout(()=>this.onmessage&&this.onmessage({data:JSON.stringify({id:m.id,...F})}),0);return}}catch{}super.send(s)}};})();`);
writeFileSync(join(OUT, "fixture.json"), JSON.stringify(fixture, null, 1));

// 4. 試験の常駐（temp の home。CEO の ~/.kangae・bar.json には触らない）
const home = join(D, "home"), sock = join(D, "main.sock"), barJson = join(D, "main-bar.json");
mkdirSync(home, { recursive: true });
{
  const st = openStore(join(home, "kangae.db"));
  const mkAgent = (name: string, text: string, reply: string) => {
    const r = st.add(null, "user", text, true);
    st.add(r.id, "user", `🤖 claude: ${reply}`, true);
    mkdirSync(join(home, "agents", name), { recursive: true });
    writeFileSync(join(home, "agents", name, "agent.json"), JSON.stringify({ name, nodeId: r.id, unread: false, answer: reply, answeredAt: Date.now() - 60_000, createdAt: Date.now() - 600_000 }));
  };
  mkAgent("agent B", "B の頼み: 資料を 6 つ作って", "6 つ揃いました");
  const long = "調べた結果です。\n\n1. 候補は 3 つありました。いちばん安いのは https://example.com/pricing/plans/business/annual/discount-campaign-2026-10?utm_source=newsletter&utm_medium=email です。\n2. 次に /Users/you/Documents/資料/2026年度/第3四半期/営業/報告書_最終版.xlsx を開いて比べました。\n3. どれも契約は 12 か月からで、途中で解約すると違約金が出ます。\n\n次の一手: 候補 1 で申し込むか決めてください。";
  mkAgent("料金しらべ", "3 社の料金を調べて", long);
  mkAgent("agent A", "A の頼み: 3 社の料金を調べて", "調べました。3 社とも 12 か月からです");
  st.close();
}
// 偽の claude（login shell の PATH 経由）。A への文には A の返事を返す
const fakebin = join(D, "bin"); mkdirSync(fakebin, { recursive: true });
writeFileSync(join(fakebin, "claude"), `#!/bin/sh\ncase "$1" in auth) exit 0;; esac\ncase "$2" in *Aへ*) printf '%s\\n' '{"type":"result","result":"Aです。今週の予定をまとめました。月曜は料金の比較です。"}';; *) printf '%s\\n' '{"type":"result","result":"Bです。"}';; esac\n`, { mode: 0o755 });
writeFileSync(join(D, "shell.sh"), `#!/bin/sh\nprintf '%s' "${fakebin}:/usr/bin:/bin"\n`, { mode: 0o755 });
const daemon = spawnDaemon(["bun", join(repo, "src/main.ts"), "--daemon"], { env: { ...(process.env as Record<string, string>), KANGAE_HOME: home, SHELL: join(D, "shell.sh"), KANGAE_SOCK: sock, KANGAE_BAR: barJson, KANGAE_NODES_DIR: join(D, "nodes") }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
let chrome: ReturnType<typeof Bun.spawn> | undefined;
try {
  await pollUntil(() => existsSync(barJson) && existsSync(sock), 60_000, 100);
  const j = JSON.parse(readFileSync(barJson, "utf8")) as { port: number; token: string };
  const url = `http://127.0.0.1:${j.port}/panel?token=${j.token}`;
  say(`常駐 port ${j.port}`);


  // 6. headless Chromium（同じ url・同じ preload・同じ地・同じ大きさ）
  const port = 9900 + Math.floor(Math.random() * 90);
  chrome = Bun.spawn(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(D, "profile")}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  await pollUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, 30_000, 200);
  const tgt = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as any;
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r as any));
  let id = 0; const wait = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); wait.get(m.id)?.(m); };
  const send = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "document.documentElement.dataset.bar='1';document.documentElement.style.setProperty('--bar-inset-left','78px')" });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(preload, "utf8") });
  const ev = (expression: string) => send("Runtime.evaluate", { expression, returnByValue: true });
  const open = (key: string) => ev(`[...document.querySelectorAll('.root')].find(b=>b.textContent.includes(${JSON.stringify(key)}))?.click();'ok'`);
  const METRICS = `(() => {
    const lum = (c) => { const v = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const parse = (s) => { const m = s.match(/[\\d.]+/g); return m ? m.map(Number) : [0, 0, 0, 0]; };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.length > 3 ? c[3] > 0.5 : true) { if ((c[3] ?? 1) > 0.5) return c.slice(0, 3); } } return parse(getComputedStyle(document.body).backgroundColor).slice(0, 3); };
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    const small = {}, low = {}, tiny = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!vis(el)) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const cs = getComputedStyle(el);
      if (own) {
        const px = parseFloat(cs.fontSize); const key = (el.id ? "#" + el.id : "") + "." + String(el.className).split(" ").join(".");
        if (px < 14) small[key] = (small[key] ?? 0) + 1;
        const fg = parse(cs.color).slice(0, 3), bg = bgOf(el); const L1 = lum(fg), L2 = lum(bg); const cr = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        if (cr < 4.5) low[key] = Math.min(low[key] ?? 99, Math.round(cr * 10) / 10);
      }
      if (el.matches("button, input, a, select, .root, [role=button]")) { const r = el.getBoundingClientRect(); if (r.height < 36 || r.width < 36) tiny.push((el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + String(el.className).split(" ").join(".")) + " " + Math.round(r.width) + "x" + Math.round(r.height)); }
    }
    const over = document.documentElement.scrollWidth > innerWidth + 1;
    return JSON.stringify({ small, low, tiny: [...new Set(tiny)], overflowX: over });
  })()`;
  const metrics: Record<string, unknown> = {};
  const SIZES = [[320, 420], [360, 480], [460, 640], [720, 800]] as const;
  for (const [w, h] of SIZES) for (const dark of [false, true]) {
    const k = dark ? "dark" : "light", c = BACK[k];
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
    await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16), a: 1 } });
    await send("Page.navigate", { url });
    for (let i = 0; i < 40; i++) { const v = await ev("document.querySelectorAll('.root').length"); if (v.result?.result?.value >= 3) break; await Bun.sleep(500); }
    await Bun.sleep(2500);
    const shoot = async (name: string) => {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, `cr-${w}x${h}-${k}-${name}.png`), Buffer.from(shot.result.data, "base64"));
      const m = await ev(METRICS); metrics[`${w}x${h}-${k}-${name}`] = JSON.parse(m.result?.result?.value ?? "null"); say(`chromium ${w}x${h}-${k}-${name}`);
    };
    await shoot("1-list");
    await open("agent A"); await Bun.sleep(1800); await shoot("2-conv-approval");
    await ev("document.getElementById('hd-list')?.click();'ok'"); await Bun.sleep(600);
    await open("料金しらべ"); await Bun.sleep(1800); await shoot("3-long");
    await ev("document.getElementById('plus')?.click();'ok'"); await Bun.sleep(1000); await shoot("4-new");
  }
  writeFileSync(join(OUT, "metrics.json"), JSON.stringify(metrics, null, 1));
  ws.close();
} finally {
  try { chrome?.kill(); } catch {}
  try { daemon.kill(); } catch {}
  await Bun.sleep(500);
  rmSync(D + "/profile", { recursive: true, force: true });
  rmSync(D, { recursive: true, force: true });
  process.exit(0);
}
