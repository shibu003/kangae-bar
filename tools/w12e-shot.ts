// w12e-shot: 報告の窓（一覧の「終わりました」・未読の ●・長い報告・報告 0 件・既読・失敗）を headless Chromium の /panel で明・暗に撮る。temp の home に会話を先に入れてから常駐を起こす。画面に出ない。
// 使い方（runner）: bun tools/w12e-shot.ts [outDir]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capOf } from "../src/lease.ts";
import { openStore } from "../src/store.ts";
import { spawnDaemon } from "../test/spawn-daemon";
import { pollUntil } from "../src/wait.ts";

const repo = join(import.meta.dir, "..");
const OUT = process.argv[2] ?? join(repo, "docs/verify/w12e/run1");
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
  leases: [], approvals: [], recoveries: [], carries: [],
  routineCards: [], modes: [],
};
const preload = join(D, "preload.js");
writeFileSync(preload, `(()=>{const F=${JSON.stringify(fixture)};const R=WebSocket;globalThis.WebSocket=class extends R{send(s){try{const m=JSON.parse(s);if(m.op==="leaseList"){setTimeout(()=>this.onmessage&&this.onmessage({data:JSON.stringify({id:m.id,...F})}),0);return}}catch{}super.send(s)}};})();`);
writeFileSync(join(OUT, "fixture.json"), JSON.stringify(fixture, null, 1));

// 4. 試験の常駐（temp の home。CEO の ~/.kangae・bar.json には触らない）
const home = join(D, "home"), sock = join(D, "main.sock"), barJson = join(D, "main-bar.json");
mkdirSync(home, { recursive: true });
// 会話を先に入れる（常駐の store と agent.json と同じ形）。1 = 未読の長い報告 / 2 = 既読 / 3 = 失敗 / 4 = まだ何も話していない
{
  const st = openStore(join(home, "kangae.db"));
  const long = "調べた結果です。\n\n1. 候補は 3 つありました。いちばん安いのは https://example.com/pricing/plans/business/annual/discount-campaign-2026-10?utm_source=newsletter&utm_medium=email&utm_campaign=autumn_sale_very_long_parameter_name_that_does_not_wrap です。\n2. 次に /Users/you/Documents/資料/2026年度/第3四半期/営業/報告書_最終版_修正済み_本当に最後.xlsx を開いて比べました。\n3. どれも契約は 12 か月からで、途中で解約すると違約金が出ます。\n\n次の一手: 候補 1 で申し込むか決めてください。";
  const mkAgent = (name: string, text: string, reply: string, o: { unread: boolean; answer: string }) => {
    const r = st.add(null, "user", text, true);
    st.add(r.id, "user", `🤖 claude: ${reply}`, true);
    mkdirSync(join(home, "agents", name), { recursive: true });
    writeFileSync(join(home, "agents", name, "agent.json"), JSON.stringify({ name, nodeId: r.id, unread: o.unread, answer: o.answer, answeredAt: Date.now() - 60_000, createdAt: Date.now() - 600_000 }));
  };
  mkAgent("料金しらべ", "3 社の料金を調べて", long, { unread: true, answer: long.split("\n")[0]! });
  mkAgent("資料作り", "資料を 6 つ作って", "6 つ揃いました", { unread: false, answer: "6 つ揃いました" });
  mkAgent("注文", "この頁で注文して", "✗ うまく終われませんでした。指示を出すと続きから頼めます", { unread: true, answer: "✗ うまく終われませんでした。指示を出すと続きから頼めます" });
  st.add(null, "user", "あとで考えること", true);
  st.close();
}
const daemon = spawnDaemon(["bun", join(repo, "src/main.ts"), "--daemon"], { env: { ...(process.env as Record<string, string>), KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_BAR: barJson, KANGAE_NODES_DIR: join(D, "nodes") }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
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
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "document.documentElement.style.setProperty('--bar-inset-left','78px')" });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(preload, "utf8") });
  for (const dark of [false, true]) {
    const c = BACK[dark ? "dark" : "light"];
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await send("Emulation.setDeviceMetricsOverride", { width: 460, height: 760, deviceScaleFactor: 2, mobile: false });
    await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16), a: 1 } });
    await send("Page.navigate", { url });
    for (let i = 0; i < 40; i++) { const v = await send("Runtime.evaluate", { expression: "document.querySelectorAll('.root').length", returnByValue: true }); if (v.result?.result?.value >= 4) break; await Bun.sleep(500); }
    await Bun.sleep(3000); // roots を読んだ後の「一覧を開く」まで待つ
    const shoot = async (name: string) => { const shot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(OUT, `cr-${dark ? "dark" : "light"}-${name}.png`), Buffer.from(shot.result.data, "base64")); say(`chromium ${dark ? "dark" : "light"}-${name}`); };
    await shoot("list"); // 一覧: 終わりました + 未読の ●・既読・失敗・まだ何も話していない
    for (const [name, key] of [["long", "料金しらべ"], ["failed", "注文"], ["empty", "あとで考えること"]] as const) {
      await send("Runtime.evaluate", { expression: `[...document.querySelectorAll('.root')].find(b=>b.textContent.includes(${JSON.stringify(key)}))?.click();'ok'` });
      await Bun.sleep(2500);
      await shoot(name);
      await send("Runtime.evaluate", { expression: "document.getElementById('hd-list')?.click();'ok'" });
      await Bun.sleep(800);
    }
  }
  ws.close();
} finally {
  try { chrome?.kill(); } catch {}
  try { daemon.kill(); } catch {}
  await Bun.sleep(500);
  rmSync(D + "/profile", { recursive: true, force: true });
  rmSync(D, { recursive: true, force: true });
  process.exit(0);
}
