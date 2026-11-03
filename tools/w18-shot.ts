// w18-shot: ハンバーガーの agent 一覧 → A を選んで話しかける → 返事は A のチャットだけ・B のチャットに A の文が出ない、を headless Chromium の /panel で明・暗に撮る。偽の claude（temp）・temp の home。画面に出ない。
// 使い方（runner）: bun tools/w18-shot.ts [outDir]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capOf } from "../src/lease.ts";
import { openStore } from "../src/store.ts";
import { spawnDaemon } from "../test/spawn-daemon";
import { pollUntil } from "../src/wait.ts";

const repo = join(import.meta.dir, "..");
const OUT = process.argv[2] ?? join(repo, "docs/verify/w18/run1");
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
{
  const st = openStore(join(home, "kangae.db"));
  const mkAgent = (name: string, text: string, reply: string) => {
    const r = st.add(null, "user", text, true);
    st.add(r.id, "user", `🤖 claude: ${reply}`, true);
    mkdirSync(join(home, "agents", name), { recursive: true });
    writeFileSync(join(home, "agents", name, "agent.json"), JSON.stringify({ name, nodeId: r.id, unread: false, answer: reply, answeredAt: Date.now() - 60_000, createdAt: Date.now() - 600_000 }));
  };
  mkAgent("agentB", "B の頼み: 資料を 6 つ作って", "6 つ揃いました");
  mkAgent("agentA", "A の頼み: 3 社の料金を調べて", "調べました。3 社とも 12 か月からです");
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
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "document.documentElement.style.setProperty('--bar-inset-left','78px')" });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(preload, "utf8") });
  const ev = (expression: string) => send("Runtime.evaluate", { expression, returnByValue: true });
  const open = (key: string) => ev(`[...document.querySelectorAll('.root')].find(b=>b.textContent.includes(${JSON.stringify(key)}))?.click();'ok'`);
  for (const dark of [false, true]) {
    const k = dark ? "dark" : "light", c = BACK[k];
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await send("Emulation.setDeviceMetricsOverride", { width: 460, height: 760, deviceScaleFactor: 2, mobile: false });
    await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16), a: 1 } });
    await send("Page.navigate", { url });
    for (let i = 0; i < 40; i++) { const v = await ev("document.querySelectorAll('.root').length"); if (v.result?.result?.value >= 2) break; await Bun.sleep(500); }
    await Bun.sleep(3000);
    const shoot = async (name: string) => { const shot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(OUT, `cr-${k}-${name}.png`), Buffer.from(shot.result.data, "base64")); say(`chromium ${k}-${name}`); };
    await shoot("1-list"); // ハンバーガーを押した後の agent 一覧（2 件）
    await open("agentA"); await Bun.sleep(2000); await shoot("2-A-open"); // 左上がハンバーガー
    if (!dark) {
      await ev("const i=document.getElementById('send-text');i.value='Aへ: 今週の予定をまとめて';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('send-form').requestSubmit();'ok'");
      await Bun.sleep(9000); await shoot("3-A-sent"); // 送った文と A の返事が A のチャットに
    }
    await ev("document.getElementById('hd-list')?.click();'ok'"); await Bun.sleep(800);
    await open("agentB"); await Bun.sleep(2000); await shoot("4-B-untouched"); // B のチャットに A の文が出ない
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
