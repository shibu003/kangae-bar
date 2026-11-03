// w12d-shot: 承認 card（open_app・open_tab・普通の 1 手）の文を headless Chromium の /panel で明・暗に撮る。WKWebView・front-watch・swiftc は使わない（画面に出ない）。
// 使い方（runner）: bun tools/w12d-shot.ts [outDir]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capOf } from "../src/lease.ts";
import { spawnDaemon } from "../test/spawn-daemon";
import { pollUntil } from "../src/wait.ts";

const repo = join(import.meta.dir, "..");
const OUT = process.argv[2] ?? join(repo, "docs/verify/w12d/run1");
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
  leases: [
    mk({ app: "メモ", title: "買い物", pid: 11, windowId: 1 }, { key: "win:11:1", hold: true, waitSince: now, undo: 2 }),
    mk({ app: "Google Chrome", title: "Example Domain", tabId: 5, url: "https://example.com/" }, { key: "tab:5", owner: "s:2", mode: "allow" }),
  ],
  approvals: [
    { id: "a1", key: "win:11:1", app: "メモ", title: "買い物", tool: "open_app", what: "Zed を裏で開きます（/Users/you/work/folder）", danger: true, note: "今の画面は変わりません（前には出しません）。許すと、agent はこの app の窓を操作できるようになります。断ると何も開きません" },
    { id: "a2", key: "tab:5", app: "Google Chrome", title: "Example Domain", tool: "open_tab", what: "新しい tab で https://docs.google.com を開きます", open: "https://docs.google.com", danger: true, note: "開く URL: https://docs.google.com/document/create。URL に、読んだ頁の中身（名前・番号・文）が入っていないか見てから許してください。tab は裏で開くので、今の画面は変わりません。断ると何も開きません" },
    { id: "a3", key: "tab:5", app: "Google Chrome", title: "Example Domain", tool: "click", what: "削除を押す", danger: true },
  ],
  recoveries: [
    { key: "win:11:1", owner: "s:1", app: "メモ", title: "買い物", phase: "reclaimed", sent: 0, steps: [{ phase: "stopping", at: now - 3000 }, { phase: "reclaimed", at: now - 2000 }, { phase: "prevented", at: now - 1000 }] },
    { key: "tab:5", owner: "s:2", app: "Google Chrome", title: "Example Domain", phase: "unknown", sent: 1, steps: [{ phase: "stopping", at: now - 5000 }, { phase: "verifying", at: now - 4000 }, { phase: "unknown", at: now - 3000 }] },
  ],
  carries: [],
  routineCards: [], modes: [],
};
const preload = join(D, "preload.js");
writeFileSync(preload, `(()=>{const F=${JSON.stringify(fixture)};const R=WebSocket;globalThis.WebSocket=class extends R{send(s){try{const m=JSON.parse(s);if(m.op==="leaseList"){setTimeout(()=>this.onmessage&&this.onmessage({data:JSON.stringify({id:m.id,...F})}),0);return}}catch{}super.send(s)}};})();`);
writeFileSync(join(OUT, "fixture.json"), JSON.stringify(fixture, null, 1));

// 4. 試験の常駐（temp の home。CEO の ~/.kangae・bar.json には触らない）
const home = join(D, "home"), sock = join(D, "main.sock"), barJson = join(D, "main-bar.json");
mkdirSync(home, { recursive: true });
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
  for (const [dark, open, h] of [[false, false, 640], [true, false, 640], [false, true, 1500], [true, true, 1500]] as const) {
    const name = `${dark ? "dark" : "light"}${open ? "-open" : ""}`;
    const c = BACK[dark ? "dark" : "light"];
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await send("Emulation.setDeviceMetricsOverride", { width: 460, height: h, deviceScaleFactor: 2, mobile: false });
    await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16), a: 1 } });
    await send("Page.navigate", { url });
    await Bun.sleep(4000);
    if (open) await send("Runtime.evaluate", { expression: "document.querySelectorAll('details').forEach(d=>d.open=true);document.documentElement.scrollTop=0;'ok'" });
    await Bun.sleep(1000);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `cr-${name}.png`), Buffer.from(shot.result.data, "base64"));
    say(`chromium ${name}: ${join(OUT, `cr-${name}.png`)}`);
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
