// v0 の通し（bun test/v0.e2e.ts）。panel.html を普通の tab で開いて操る。
// W3b-3: 今の画面（DM の一覧・上の 1 行 #hd-st）の selector に直し、headless で回す。最初の送信は常駐が agent を探すのに 2 分近く掛かる事がある（待つ）。
// 本物の Chromium・remote debugging・偽の claude と偽の login shell。KANGAE_OPEN_CMD は /usr/bin/true。
// 見るもの: 作る → 根の行 / ＋今のタブで http の tab が根と tab group / 送信で行が増え run /
// 「新しいタブの見出しを青くして」で新しいタブの h1 の color が青 / 既定の見た目に戻す。
import { mktmp } from "./tmp.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_APP, launch } from "../src/launch.ts";
import { armExe } from "./exe";

const root = join(import.meta.dir, "..");
const dir = mktmp("kangae-v0e");
const port = 10000 + Math.floor(Math.random() * 500);
const web = `http://127.0.0.1:${port}/json/version`;
mkdirSync(join(dir, "home"), { recursive: true });
const fakebin = join(dir, "bin");
mkdirSync(fakebin);
// 仕事の送信は stream-json の claude。sleep の間 run は running のまま（色を変えても「動いています」が残る）
writeFileSync(
  join(fakebin, "claude"),
  `#!/bin/sh
case "$1" in auth) exit 0;; esac
case "$*" in
  *stream-json*)
    printf '%s\\n' '{"type":"system","subtype":"init","session_id":"S1"}'
    printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"進めています"}]}}'
    sleep 120
    printf '%s\\n' '{"type":"result","result":"設問3まで進めました","session_id":"S1"}'
    exit 0 ;;
esac
`,
);
writeFileSync(join(dir, "shell.sh"), `#!/bin/sh\nprintf '%s' "${fakebin}:/usr/bin:/bin"\n`);
for (const f of [join(fakebin, "claude"), join(dir, "shell.sh")]) armExe(f);

const proc = launch({
  app: CHROMIUM_APP,
  profile: join(dir, "profile"),
  hostBinary: join(root, "dist/kangae"),
  extensionDir: join(root, "extension"),
  mockKeychain: true,
  extraArgs: ["--headless=new", `--remote-debugging-port=${port}`, "about:blank"],
  env: {
    KANGAE_HOME: join(dir, "home"),
    KANGAE_PROFILE: join(dir, "profile"),
    KANGAE_SOCK: join(dir, "s.sock"),
    SHELL: join(dir, "shell.sh"),
    KANGAE_NODES_DIR: join(dir, "nodes"),
    KANGAE_OPEN_CMD: "/usr/bin/true",
  },
});
const kill = () => {
  proc.kill();
  for (const p of Bun.spawnSync(["lsof", "-t", join(dir, "s.sock")]).stdout.toString().split("\n").filter(Boolean)) {
    try { process.kill(Number(p)); } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
};
const timer = setTimeout(() => { console.log("TIMEOUT"); kill(); process.exit(2); }, 360_000);

type Target = { id?: string; type?: string; url?: string; webSocketDebuggerUrl?: string };
type Send = (method: string, params?: object) => Promise<any>;

function cdp(u: string): Promise<Send> {
  const s = new WebSocket(u);
  return new Promise((resolve) => {
    s.onopen = () => {
      let id = 0;
      const wait = new Map<number, (v: any) => void>();
      s.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        wait.get(m.id)?.(m);
      };
      resolve((method, params = {}) => new Promise((res) => {
        const i = ++id;
        wait.set(i, res);
        s.send(JSON.stringify({ id: i, method, params }));
      }));
    };
  });
}

const flat = (s: string) => s.replace(/\s/g, "").toLowerCase();
const isBlue = (style: string, computed: string) => {
  const s = flat(style);
  return (s === "blue" || s === "#0000ff" || s === "#00f" || s === "rgb(0,0,255)") && flat(computed) === "rgb(0,0,255)";
};

async function targets(): Promise<Target[]> {
  try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[]; } catch { return []; }
}

const shot = async (send: Send, n: string) => {
  if (!process.env.SHOT_DIR) return;
  await send("Page.enable");
  const data = (await send("Page.captureScreenshot")).result?.data;
  if (typeof data === "string") writeFileSync(join(process.env.SHOT_DIR, n), Buffer.from(data, "base64"));
};

try {
  let sw: Target | undefined;
  for (let i = 0; i < 60 && !sw?.webSocketDebuggerUrl; i++) {
    sw = (await targets()).find((t) => t.type === "service_worker" && (t.url ?? "").endsWith("/sw.js"));
    if (!sw?.webSocketDebuggerUrl) await Bun.sleep(1000);
  }
  const swUrl = sw?.webSocketDebuggerUrl;
  if (!swUrl) throw new Error("service worker が無い");
  // panel.html は browser の口から普通の tab で開く（sw に頼ると、登録し直しの間に評価が消える事がある）
  const ver = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const browser = await cdp(ver.webSocketDebuggerUrl);
  const extId = new URL(sw!.url!).host;
  const made_ = await browser("Target.createTarget", { url: `chrome-extension://${extId}/panel.html` });
  if (made_.error) console.log("createTarget", JSON.stringify(made_.error));

  let panel: Target | undefined;
  for (let i = 0; i < 120 && !panel?.webSocketDebuggerUrl; i++) {
    panel = (await targets()).find((t) => t.type === "page" && (t.url ?? "").endsWith("/panel.html"));
    if (!panel?.webSocketDebuggerUrl) await Bun.sleep(500);
  }
  const panelUrl = panel?.webSocketDebuggerUrl;
  if (!panelUrl) throw new Error("panel.html の tab が無い");
  const send = await cdp(panelUrl);
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
  const ev = async (e: string) => {
    const m = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) console.log("eval", m.result.exceptionDetails.text ?? m.result.exceptionDetails.exception?.description ?? "");
    return m.result?.result?.value;
  };
  const json = async (e: string) => {
    const v = await ev(e);
    if (typeof v !== "string" || !v) return null;
    try { return JSON.parse(v); } catch { return null; }
  };

  let ready: any = null;
  for (let i = 0; i < 45; i++) {
    ready = await json(`JSON.stringify({ disabled: document.getElementById('empty-text').disabled, placeholder: document.getElementById('empty-text').placeholder, msg: document.getElementById('empty-msg').textContent })`);
    if (ready?.placeholder === "失敗") break;
    if (ready && ready.disabled === false) break;
    await Bun.sleep(1000);
  }
  console.log("panel:", JSON.stringify(ready));
  if (!ready || ready.disabled !== false) throw new Error("作る欄が有効にならない");

  // ① 作る → 根の行
  await ev(`(() => { const i = document.getElementById('empty-text'); i.value = ${JSON.stringify("課題")}; document.getElementById('empty-form').requestSubmit(); return 1; })()`);
  let rootText = "";
  for (let i = 0; i < 40 && rootText !== "課題"; i++) {
    rootText = (await ev("document.querySelector('.root.on .root-text')?.textContent ?? ''")) ?? "";
    if (rootText !== "課題") await Bun.sleep(250);
  }
  const rootCount = Number(await ev("document.querySelectorAll('#roots .root').length"));
  const rootId = String(await ev("document.querySelector('.root.on')?.dataset.id ?? ''"));
  const made = rootText === "課題" && rootCount === 1 && rootId !== "";
  console.log("作る:", JSON.stringify({ rootText, rootCount, rootId }));
  await shot(send, "v0-1.png");

  // ② ＋今のタブ。前面が http のときだけ押せる
  await ev(`chrome.tabs.create({ url: ${JSON.stringify(web)}, active: true }).then(() => 1)`);
  let addEnabled = false;
  for (let i = 0; i < 40 && !addEnabled; i++) {
    addEnabled = (await ev("document.getElementById('add-tab').disabled === false")) === true;
    if (!addEnabled) await Bun.sleep(250);
  }
  await ev("document.getElementById('add-tab').click(); 1");
  await Bun.sleep(400);
  const groupExpr = `(async () => {
    const id = document.querySelector('.root.on')?.dataset.id ?? '';
    const groups = await chrome.tabGroups.query({});
    const g = groups.find((x) => (x.title || '').endsWith('\\u00b7#' + id));
    const tabs = g ? await chrome.tabs.query({ groupId: g.id }) : [];
    const tree = await new Promise((r) => {
      const p = chrome.runtime.connect();
      const mid = 'v0-tree';
      const t = setTimeout(() => r(null), 8000);
      p.onMessage.addListener((m) => { if (m.id === mid) { clearTimeout(t); r(m); } });
      p.postMessage({ id: mid, op: 'tree', rootId: Number(id) });
    });
    return JSON.stringify({ id, title: g ? g.title : '', urls: tabs.map((t) => t.url || t.pendingUrl || ''), nodes: tree && tree.nodes ? tree.nodes : [] });
  })()`;
  let groupedInfo: any = null;
  for (let i = 0; i < 40; i++) {
    groupedInfo = await json(groupExpr);
    const urls: string[] = groupedInfo?.urls ?? [];
    const nodes: any[] = groupedInfo?.nodes ?? [];
    const hit = urls.some((u) => u.includes("/json/version")) && nodes.some((n) => n.kind === "tab" && n.parentId === Number(rootId) && String(n.url ?? "").includes("/json/version"));
    if (groupedInfo?.title === `課題 \u00b7#${rootId}` && hit) break;
    await Bun.sleep(250);
  }
  const grouped = groupedInfo?.title === `課題 \u00b7#${rootId}`
    && (groupedInfo?.urls ?? []).some((u: string) => u.includes("/json/version"))
    && (groupedInfo?.nodes ?? []).some((n: any) => n.kind === "tab" && n.parentId === Number(rootId) && String(n.url ?? "").includes("/json/version"));
  console.log("＋今のタブ:", JSON.stringify(groupedInfo));
  await shot(send, "v0-2.png");

  const texts = async () => (await json("JSON.stringify([...document.querySelectorAll('#rows .chat-text')].map((n) => n.textContent))")) as string[] | null;
  const same = (xs: string[] | null, want: string[]) => {
    if (!xs || xs.length !== want.length) return false;
    for (let i = 0; i < want.length; i++) if (xs[i] !== want[i]) return false;
    return true;
  };
  const running = async () => {
    // 開いている会話の「動いています」は一覧でなく上の 1 行（#hd-st の「進んでいます」）に出る（一覧は見ていない会話だけ）
    const mark = ((await ev("document.getElementById('hd-st')?.textContent ?? ''")) ?? "").includes("進んでいます") ? "動いています" : "";
    const runs = await json(`new Promise((r) => {
      const p = chrome.runtime.connect();
      const mid = 'v0-runs';
      const t = setTimeout(() => r(''), 8000);
      p.onMessage.addListener((m) => { if (m.id === mid) { clearTimeout(t); r(JSON.stringify(m)); } });
      p.postMessage({ id: mid, op: 'runs', nodeIds: [Number(document.querySelector('.root.on')?.dataset.id)] });
    })`);
    const live = Array.isArray(runs?.runs) && runs.runs.some((r: any) => r.status === "running" && r.nodeId === Number(rootId));
    return { mark, live, roots: Number(await ev("document.querySelectorAll('#roots .root').length")) };
  };
  const submit = async (text: string) => {
    await ev(`(() => { const f = document.getElementById('send-form'); const i = f.querySelector('input'); i.value = ${JSON.stringify(text)}; f.requestSubmit(); return 1; })()`);
  };

  // ③ 送信で行が増え、run が起きる。上段の根は増えない
  await Bun.sleep(400);
  const t0 = Date.now();
  await submit("設問3を解いて");
  let sentRows: string[] | null = null;
  let sentRun: any = null;
  for (let i = 0; i < 400; i++) {
    sentRows = await texts();
    sentRun = await running();
    if (same(sentRows, ["設問3を解いて"]) && sentRun.mark === "動いています" && sentRun.live && sentRun.roots === 1) break;
    if (i === 399 && !(sentRows ?? []).includes("設問3を解いて")) await submit("設問3を解いて");
    await Bun.sleep(250);
  }
  const sent = same(sentRows, ["設問3を解いて"]) && sentRun?.mark === "動いています" && sentRun?.live === true && sentRun?.roots === 1;
  console.log("送信:", JSON.stringify({ sentRows, sentRun, 秒: Math.round((Date.now() - t0) / 1000) }));
  await shot(send, "v0-3.png");

  // ④ 新しいタブの見出しを青くして。仕事の「動いています」は残る
  await Bun.sleep(400);
  await submit("新しいタブの見出しを青くして");
  let paintedRows: string[] | null = null;
  let clearShown = false;
  for (let i = 0; i < 40; i++) {
    paintedRows = await texts();
    clearShown = (await ev("document.getElementById('clear-ui').hidden === false")) === true;
    if (paintedRows?.length === 2 && clearShown) break;
    if (i === 20 && !(paintedRows ?? []).includes("新しいタブの見出しを青くして")) await submit("新しいタブの見出しを青くして");
    await Bun.sleep(250);
  }
  await Bun.sleep(1000);
  const still = await running();
  const before = new Set((await targets()).map((t) => t.id).filter((id): id is string => !!id));
  await ev("chrome.tabs.create({ url: 'chrome://newtab/', active: false }).then(() => 1)");
  const readH1 = async (pageSend: Send) => {
    const m = await pageSend("Runtime.evaluate", {
      expression: "(() => { const h = document.querySelector('h1'); const b = document.getElementById('open'); if (!h || !b) return ''; return JSON.stringify({ text: h.textContent || '', style: h.style.color || '', computed: getComputedStyle(h).color || '', open: (b.textContent || '').trim() }); })()",
      returnByValue: true,
    });
    const v = m.result?.result?.value;
    if (typeof v !== "string" || !v) return null;
    try { return JSON.parse(v) as { text: string; style: string; computed: string; open: string }; } catch { return null; }
  };
  let ntpSend: Send | null = null;
  let ntp: { text: string; style: string; computed: string; open: string } | null = null;
  const sockets = new Map<string, Send>();
  for (let i = 0; i < 40 && !ntp; i++) {
    const list = (await targets()).filter((t) => t.type === "page" && t.id && t.webSocketDebuggerUrl && !(t.url ?? "").includes("panel.html") && !(t.url ?? "").includes("/json/version"));
    const ordered = [...list.filter((t) => t.id && !before.has(t.id)), ...list.filter((t) => t.id && before.has(t.id))];
    for (const t of ordered) {
      const id = t.id;
      const url = t.webSocketDebuggerUrl;
      if (!id || !url) continue;
      const pageSend = sockets.get(id) ?? await cdp(url);
      sockets.set(id, pageSend);
      const info = await readH1(pageSend);
      const fresh = !!id && !before.has(id);
      if (info?.open === "会話を開く" && info.text === "Kangae" && (fresh || isBlue(info.style, info.computed))) {
        ntpSend = pageSend;
        if (isBlue(info.style, info.computed)) ntp = info;
        break;
      }
    }
    if (!ntp) await Bun.sleep(500);
  }
  const painted = same(paintedRows, ["設問3を解いて", "新しいタブの見出しを青くして"])
    && clearShown
    && still?.mark === "動いています"
    && still?.live === true
    && still?.roots === 1
    && !!ntp
    && isBlue(ntp.style, ntp.computed);
  console.log("青:", JSON.stringify({ paintedRows, clearShown, still, ntp }));
  if (ntpSend) await shot(ntpSend, "v0-4.png");

  // ⑤ 既定の見た目に戻す。開いている新しいタブの h1 から青が外れ、送った行は残る
  let restoredInfo: { text: string; style: string; computed: string; open: string } | null = null;
  let clearHidden = false;
  for (let i = 0; i < 40; i++) {
    clearHidden = (await ev("document.getElementById('clear-ui').hidden === true")) === true;
    if (!clearHidden) await ev("document.getElementById('clear-ui').click(); 1");
    if (ntpSend) restoredInfo = await readH1(ntpSend);
    const rows = await texts();
    const back = !!restoredInfo && restoredInfo.style === "" && flat(restoredInfo.computed) !== "rgb(0,0,255)" && restoredInfo.text === "Kangae" && restoredInfo.open === "会話を開く";
    if (clearHidden && back && same(rows, ["設問3を解いて", "新しいタブの見出しを青くして"])) break;
    await Bun.sleep(250);
  }
  const restoredRows = await texts();
  const restored = clearHidden
    && !!restoredInfo
    && restoredInfo.style === ""
    && flat(restoredInfo.computed) !== "rgb(0,0,255)"
    && restoredInfo.text === "Kangae"
    && restoredInfo.open === "会話を開く"
    && same(restoredRows, ["設問3を解いて", "新しいタブの見出しを青くして"]);
  console.log("戻す:", JSON.stringify({ clearHidden, restoredInfo, restoredRows }));
  await shot(send, "v0-5.png");

  const ok = made && addEnabled && grouped && sent && painted && restored;
  console.log("v0", JSON.stringify({ made, addEnabled, grouped, sent, painted, restored }));
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.log("ERR", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  kill();
  process.exit(process.exitCode ?? 1);
}
