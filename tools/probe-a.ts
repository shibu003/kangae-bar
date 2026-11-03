// Probe A（docs/verify/probeA/PROBE.md）: 製品の Chromium（port 9339）で hidden tab が frame を描くか・背景 tab への入力が focus を取らないか。
// 使い方: bun tools/probe-a.ts [--port 9339] [--out <dir>] [--dry-run]
//   --dry-run: 接続せず、打つ CDP の列だけ出す（load が高い時・手順の確認用）。実機は PROBE.md の開始条件（load < 30）を見てから。
// 出す物: out/probeA.json（各手の ms と返事）・out/frame.jpg（captureScreenshot）。front-watch は別 terminal（PROBE.md §0）。
import { mkdirSync, writeFileSync } from "node:fs";
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? (process.argv[i + 1] ?? d) : d; };
const port = Number(arg("--port", "9339")), out = arg("--out", "docs/verify/probeA"), dry = process.argv.includes("--dry-run");
const steps = ["createTarget(hidden,background)", "attach(flatten)", "Emulation.setFocusEmulationEnabled(true)", "別 session: Page.startScreencast(16px)", "Page.captureScreenshot ×3（ms）", "Input.dispatchMouseEvent(pressed/released・背景 tab)", "Input.insertText", "closeTarget"];
if (dry) { console.log(steps.map((s, i) => `${i + 1}. ${s}`).join("\n")); process.exit(0); }
mkdirSync(out, { recursive: true });
const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const wait = new Map<number, (v: any) => void>();
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); wait.get(m.id)?.(m); };
const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((res) => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const log: Record<string, unknown>[] = []; const rec = (step: string, ms: number, r: any) => { log.push({ step, ms, error: r?.error?.message, ok: !r?.error }); console.log(`${step}: ${ms}ms ${r?.error ? "ERR " + r.error.message : "ok"}`); return r; };
const timed = async (step: string, p: Promise<any>) => { const t = performance.now(); const r = await p; return rec(step, Math.round(performance.now() - t), r); };
const t = await timed("createTarget", send("Target.createTarget", { url: "data:text/html,<body style='background:#2a7;font:40px sans-serif'>probeA<script>setInterval(()=>document.title=String(Date.now()),100)</script>", hidden: true, background: true }));
const targetId = t.result?.targetId; if (!targetId) { writeFileSync(`${out}/probeA.json`, JSON.stringify(log, null, 2)); console.log("hidden tab を作れなかった＝RESULT の P1 は赤（原文を記録）"); process.exit(1); }
const a = await timed("attach", send("Target.attachToTarget", { targetId, flatten: true })); const sid = a.result.sessionId;
await timed("setFocusEmulationEnabled", send("Emulation.setFocusEmulationEnabled", { enabled: true }, sid));
const b = await send("Target.attachToTarget", { targetId, flatten: true }); const cast = b.result.sessionId; // 別 session で compositor を起こす（設計 1-A 段 3）
await timed("startScreencast(16px)", send("Page.startScreencast", { format: "jpeg", quality: 10, maxWidth: 16, maxHeight: 16, everyNthFrame: 1 }, cast));
for (let n = 1; n <= 3; n++) { const s = await timed(`captureScreenshot#${n}`, Promise.race([send("Page.captureScreenshot", { format: "jpeg", quality: 60 }, sid), new Promise((r) => setTimeout(() => r({ error: { message: "hang >30s" } }), 30000))])); if (s.result?.data && n === 1) writeFileSync(`${out}/frame.jpg`, Buffer.from(s.result.data, "base64")); }
await timed("mousePressed", send("Input.dispatchMouseEvent", { type: "mousePressed", x: 50, y: 50, button: "left", clickCount: 1 }, sid));
await timed("mouseReleased", send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 50, y: 50, button: "left", clickCount: 1 }, sid));
await timed("insertText", send("Input.insertText", { text: "abc" }, sid));
console.log("front-watch の記録を今すぐ確認（この間に前面が変わったか＝P3）。Enter で closeTarget"); await new Promise((r) => process.stdin.once("data", r));
await timed("closeTarget", send("Target.closeTarget", { targetId }));
writeFileSync(`${out}/probeA.json`, JSON.stringify(log, null, 2)); process.exit(0);
