// v1.4 の通し（bun test/desktop.e2e.ts）。ブラウザの中のデスクトップ: session・tab・terminal の札を置く・引きずる・押す・外す。
// W3b-3: headless（--window-size=1400,900。既定の 800x600 だと窓の位置の clamp が変わって 5 件赤になる）で回す。
// 本物の Chromium・remote debugging。常駐は試験用に compile した binary（<tmp>/repo/dist/kangae）。偽の claude は無し。
// terminal は KANGAE_OPEN_CMD を記録 script に替えて、Terminal.app を起こさずに「開く引数」を見る。
import { mktmp } from "./tmp.ts";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { pollUntil } from "../src/wait.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_APP, launch } from "../src/launch.ts";
import { armExe } from "./exe";

const repoSrc = join(import.meta.dir, "..");
const dir = mktmp("kangae-desk-e2e");
const home = join(dir, "home");
const repo = join(dir, "repo");
const nodes = join(dir, "nodes");
const openLog = join(dir, "open.log");
const openCmd = join(dir, "open.sh");
const sock = join(dir, "s.sock");
const bin = join(repo, "dist/kangae");
const port = 10600 + Math.floor(Math.random() * 300);
mkdirSync(home, { recursive: true });
mkdirSync(nodes, { recursive: true });
writeFileSync(openCmd, `#!/bin/sh\necho "$@" >> "${openLog}"\n`);
armExe(openCmd);
cpSync(join(repoSrc, "extension"), join(repo, "extension"), { recursive: true });
const build = Bun.spawnSync(["bun", "build", "--compile", "--target=bun-darwin-x64", join(repoSrc, "src/main.ts"), "--outfile", bin], { stdout: "ignore", stderr: "pipe" });
if (build.exitCode !== 0) throw new Error(`compile できない: ${build.stderr.toString()}`);

const env = { KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_NODES_DIR: nodes, KANGAE_OPEN_CMD: openCmd, KANGAE_CDP_PORT: String(port) };
const profile = join(home, "profile");
const opts = { app: CHROMIUM_APP, profile, hostBinary: bin, extensionDir: join(repo, "extension"), mockKeychain: true, debugPort: port, env };
// 試験の web 頁（題名と favicon を持つ）
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const web = Bun.serve({
  port: 0,
  fetch: (r) => (r.headers.get("sec-fetch-dest") === "iframe" && iframeHits++, new URL(r.url).pathname === "/f.png" ? new Response(png, { headers: { "content-type": "image/png" } }) : new Response('<!doctype html><title>試験の頁</title><link rel="icon" href="/f.png"><p>hello', { headers: { "content-type": "text/html; charset=utf-8" } })),
});
const pageUrl = `http://127.0.0.1:${web.port}/`;
let iframeHits = 0;
let proc = launch({ ...opts, extraArgs: ["--headless=new", "--window-size=1400,900", "about:blank"] });

const kill = () => {
  try { proc.kill(); } catch {}
  web.stop(true);
  for (const p of Bun.spawnSync(["lsof", "-t", sock]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
  rmSync(dir, { recursive: true, force: true });
};
setTimeout(() => { console.log("TIMEOUT"); kill(); process.exit(2); }, 420_000);

type Target = { id?: string; type?: string; url?: string; title?: string; webSocketDebuggerUrl?: string; targetId?: string };
type Send = (method: string, params?: object) => Promise<{ result?: any; error?: unknown }>;
const bad: string[] = [];
const expect = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log("OK", name);
  else {
    bad.push(name);
    console.log("NG", name, detail === undefined ? "" : JSON.stringify(detail));
  }
};
const cdp = (u: string): Promise<Send> => {
  const s = new WebSocket(u);
  return new Promise((resolve) => {
    s.onopen = () => {
      let id = 0;
      const wait = new Map<number, (v: any) => void>();
      s.onmessage = (e) => { const m = JSON.parse(String(e.data)); wait.get(m.id)?.(m); };
      resolve((method, params = {}) => new Promise((res) => { const i = ++id; wait.set(i, res); s.send(JSON.stringify({ id: i, method, params })); }));
    };
  });
};
const targets = async (): Promise<Target[]> => {
  try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[]; } catch { return []; }
};
const waitFor = async <T>(f: () => Promise<T | null | false | undefined>, n = 60, ms = 500): Promise<T | null> => (await pollUntil(f, n * ms, ms)) ?? null; // 締切は n×ms 秒（src/wait.ts）
const pages = async (suffix: string) => (await targets()).filter((t) => t.type === "page" && (t.url ?? "").endsWith(suffix));
const saved = () => { try { return JSON.parse(readFileSync(join(home, "desktop.json"), "utf8")) as { key: string; x: number; y: number; win?: { x: number; y: number; w: number; h: number; open: boolean } }[]; } catch { return []; } };
const attach = async (t: Target) => {
  const send = await cdp(t.webSocketDebuggerUrl!);
  return { send, ev: async (e: string): Promise<any> => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value };
};

try {
  const sw = await waitFor(async () => (await targets()).find((t) => t.type === "service_worker" && (t.url ?? "").endsWith("/sw.js")), 120, 1000);
  if (!sw?.url) throw new Error("service worker が無い");
  const extId = new URL(sw.url).host;
  const ver = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const browser = await cdp(ver.webSocketDebuggerUrl);
  const open = async (url: string) => (await browser("Target.createTarget", { url })).result?.targetId as string;
  await open(`chrome-extension://${extId}/panel.html`);
  const plain = await waitFor(async () => (await pages("/panel.html"))[0], 120);
  if (!plain?.webSocketDebuggerUrl) throw new Error("panel.html の tab が無い");
  const { ev } = await attach(plain);

  // 1. session「ギャル」を作る。前面が拡張の頁なので「今のタブをデスクトップに置く」は押せず、理由が出る
  await waitFor(async () => (await ev(`!document.getElementById('empty-text').disabled`)) === true, 240);
  await ev(`(() => { const i = document.getElementById('empty-text'); i.value = 'ギャル'; document.getElementById('empty-form').requestSubmit(); return 1; })()`);
  const id = await waitFor(async () => {
    const t = await ev(`document.querySelector('#roots .root.on .root-text')?.textContent || ''`);
    return t === "ギャル" ? await ev(`document.querySelector('#roots li').dataset.id`) : null;
  }, 120);
  expect("session を作れた", !!id);
  if (!id) throw new Error("session が無い");
  const reason = await waitFor(async () => ((await ev(`document.getElementById('tab-to-desktop').disabled && !document.getElementById('desk-reason').hidden`)) ? true : null), 20);
  expect("前面が拡張の頁なら「今のタブをデスクトップに置く」は押せず、理由が出る", !!reason);

  // 2. 新しいタブ: 何も置いていなければ案内の 1 行。macOS のデスクトップを作る道は panel から無い
  expect("panel に .app を作る口は無い（op desktop は無い）", (await ev(`document.documentElement.outerHTML.includes('.app')`)) === false);
  await open(`chrome-extension://${extId}/newtab.html`);
  const ntp1 = await waitFor(async () => (await pages("/newtab.html"))[0], 60);
  if (!ntp1?.webSocketDebuggerUrl) throw new Error("newtab.html の tab が無い");
  const n1 = await attach(ntp1);
  await waitFor(async () => ((await n1.ev(`document.body.dataset.desk`)) === "0" ? true : null), 40);
  expect("置いていなければ案内の 1 行（見出しと「会話を開く」も残る）", (await n1.ev(`!document.getElementById('desk-empty').hidden && !!document.getElementById('open') && document.querySelector('h1').textContent === 'Kangae'`)) === true);

  // 3. session を置く → 札が出る（開いたままの新しいタブにも配られる）・もう一度は「もうある」
  await ev(`document.getElementById('to-desktop').click(); 1`);
  const note = await waitFor(async () => (await ev(`document.getElementById('desktop-note').hidden ? '' : document.getElementById('desktop-note').textContent`)) || null, 60);
  expect("panel に「デスクトップに置いた: ギャル」", note === "デスクトップに置いた: ギャル", note);
  const card = await waitFor(async () => ((await n1.ev(`document.querySelector('.card.session .name')?.textContent`)) === "ギャル" ? true : null), 40);
  expect("開いている新しいタブに session の札が出る（案内は消える）", !!card && (await n1.ev(`document.getElementById('desk-empty').hidden`)) === true);
  await ev(`document.getElementById('to-desktop').click(); 1`);
  expect("もう一度は「もうデスクトップにある」で 2 枚にならない", !!(await waitFor(async () => ((await ev(`document.getElementById('desktop-note').textContent`)) === "もうデスクトップにある" ? true : null), 40)) && saved().length === 1, saved());

  // 4. 引きずって動かす → 位置が変わり、file にも残り、開き直しても同じ
  const before = saved()[0]!;
  const c0 = JSON.parse(await n1.ev(`JSON.stringify(document.querySelector('.card.session').getBoundingClientRect().toJSON())`));
  const mx = c0.left + 40, my = c0.top + 12;
  const mouse = (send: Send, type: string, x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  await mouse(n1.send, "mousePressed", mx, my);
  for (let i = 1; i <= 5; i++) await mouse(n1.send, "mouseMoved", mx + 40 * i, my + 30 * i);
  await mouse(n1.send, "mouseReleased", mx + 200, my + 150);
  const moved = await waitFor(async () => { const s = saved()[0]; return s && (s.x !== before.x || s.y !== before.y) ? s : null; }, 20);
  expect("引きずると位置が変わり desktop.json に残る", !!moved && moved.x > before.x && moved.y > before.y, { before, moved });
  expect("引きずっただけでは session のタブは開かない", (await pages(`/panel.html?session=${id}`)).length === 0);
  await browser("Target.closeTarget", { targetId: ntp1.id });
  await open(`chrome-extension://${extId}/newtab.html`);
  const ntp2 = await waitFor(async () => (await pages("/newtab.html"))[0], 60);
  let n2 = await attach(ntp2!);
  await waitFor(async () => ((await n2.ev(`document.body.dataset.desk`)) === "1" ? true : null), 40);
  const c1 = JSON.parse(await n2.ev(`JSON.stringify(document.querySelector('.card.session').getBoundingClientRect().toJSON())`));
  const d1 = JSON.parse(await n2.ev(`JSON.stringify(document.getElementById('desk').getBoundingClientRect().toJSON())`));
  const want = { x: moved!.x * (d1.width - 140), y: moved!.y * (d1.height - c1.height) };
  expect("開き直しても同じ位置", Math.abs(c1.left - d1.left - want.x) < 2 && Math.abs(c1.top - d1.top - want.y) < 2, { c1, d1, want });

  const rect = async (sel: string) => JSON.parse(await n2.ev(`JSON.stringify(document.querySelector('${sel}').getBoundingClientRect().toJSON())`));
  const press = async (sel: string, dx = 40, dy = 12) => { const r = await rect(sel); await mouse(n2.send, "mousePressed", r.left + dx, r.top + dy); await mouse(n2.send, "mouseReleased", r.left + dx, r.top + dy); };
  const drag = async (sel: string, dx: number, dy: number, fromX = 40, fromY = 12) => {
    const r = await rect(sel);
    const x = r.left + fromX, y = r.top + fromY;
    await mouse(n2.send, "mousePressed", x, y);
    for (let i = 1; i <= 5; i++) await mouse(n2.send, "mouseMoved", x + (dx * i) / 5, y + (dy * i) / 5);
    await mouse(n2.send, "mouseReleased", x + dx, y + dy);
  };
  const winOf = (key: string) => saved().find((c) => c.key === key)?.win;

  // 5. 押す → デスクトップの中に session の窓（panel.html?session=<id> の iframe）。別のタブは開かない
  const sw1 = `.win[data-key="s:${id}"]`;
  await press(".card.session");
  const w1 = await waitFor(async () => ((await n2.ev(`document.querySelector('${sw1} iframe')?.src || ''`)).endsWith(`/panel.html?session=${id}`) ? true : null), 40);
  expect("札を押すと、デスクトップの中に session の窓が開く（iframe に panel.html?session=<id>）", !!w1);
  expect("別のタブは開かない", (await pages(`/panel.html?session=${id}`)).length === 0);
  const inner = await waitFor(async () => ((await n2.ev(`document.querySelector('${sw1} iframe').contentDocument?.querySelector('#roots .root.on .root-text')?.textContent || ''`)) === "ギャル" ? true : null), 60);
  expect("窓の中で session の panel が動く（「ギャル」が選ばれている）", !!inner);
  await waitFor(async () => (winOf(`s:${id}`)?.open ? true : null), 20);
  expect("窓が開いている事と大きさが desktop.json に残る", winOf(`s:${id}`)?.open === true && winOf(`s:${id}`)?.w === 520 && winOf(`s:${id}`)?.h === 420, saved());

  // 5b. 窓を引きずる・角で大きさを変える → 保存。もう一度押しても窓は 2 枚にならない
  const g0 = winOf(`s:${id}`)!;
  await drag(`${sw1} .win-bar`, 120, 60);
  const g1 = await waitFor(async () => { const w = winOf(`s:${id}`); return w && w.x !== g0.x ? w : null; }, 20);
  expect("題名の帯を引きずると窓が動き、位置が残る", !!g1 && Math.abs(g1.x - g0.x - 120) <= 2 && Math.abs(g1.y - g0.y - 60) <= 2, { g0, g1 });
  await drag(`${sw1} .win-grip`, 80, 50, 8, 8);
  const g2 = await waitFor(async () => { const w = winOf(`s:${id}`); return w && w.w !== g0.w ? w : null; }, 20);
  expect("右下の角を引きずると大きさが変わり、残る", !!g2 && Math.abs(g2.w - g0.w - 80) <= 2 && Math.abs(g2.h - g0.h - 50) <= 2, { g0, g2 });
  expect("窓を動かしても iframe は開き直されない（panel は動いたまま）", (await n2.ev(`document.querySelector('${sw1} iframe').contentDocument?.querySelector('#roots .root.on .root-text')?.textContent`)) === "ギャル");

  // 5c. 新しいタブを開き直しても、窓が同じ位置・大きさで戻る
  const wr = await rect(sw1);
  await browser("Target.closeTarget", { targetId: ntp2!.id });
  await open(`chrome-extension://${extId}/newtab.html`);
  const ntp3 = await waitFor(async () => (await pages("/newtab.html"))[0], 60);
  n2 = await attach(ntp3!);
  await waitFor(async () => ((await n2.ev(`document.body.dataset.desk`)) === "1" ? true : null), 40);
  await waitFor(async () => ((await n2.ev(`!!document.querySelector('${sw1}')`)) === true ? true : null), 40);
  const wr2 = await rect(sw1);
  expect("開き直しても窓が同じ位置・大きさで戻る", Math.abs(wr.left - wr2.left) < 2 && Math.abs(wr.top - wr2.top) < 2 && Math.abs(wr.width - wr2.width) < 2 && Math.abs(wr.height - wr2.height) < 2, { wr, wr2 });

  // 6. tab: 前面を試験の頁にして「今のタブをデスクトップに置く」
  const webId = await open(pageUrl);
  const enabled = await waitFor(async () => ((await ev(`!document.getElementById('tab-to-desktop').disabled`)) ? true : null), 40);
  expect("前面が web の頁なら「今のタブをデスクトップに置く」が押せる", !!enabled, await ev(`document.getElementById('tab-to-desktop').outerHTML`));
  await waitFor(async () => (((await targets()).find((t) => t.id === webId)?.title ?? "") === "試験の頁" ? true : null), 40);
  await Bun.sleep(1000); // favicon が tab に載るのを待つ
  await ev(`document.getElementById('tab-to-desktop').click(); 1`);
  const note3 = await waitFor(async () => { const t = await ev(`document.getElementById('desktop-note').textContent`); return t.includes("試験の頁") ? t : null; }, 40);
  expect("panel に「デスクトップに置いた: 試験の頁」", note3 === "デスクトップに置いた: 試験の頁", note3);
  const tabCard = await waitFor(async () => ((await n2.ev(`document.querySelector('.card.tab .name')?.textContent`)) === "試験の頁" ? true : null), 40);
  expect("tab の札が出る（題名）", !!tabCard);
  expect("tab の札に favicon（tab が持っていた物）", (await n2.ev(`document.querySelector('.card.tab img')?.src || ''`)) === `${pageUrl}f.png`, await n2.ev(`document.querySelector('.card.tab')?.outerHTML`));
  expect("tab の札は枠なし・session の札は枠あり", (await n2.ev(`getComputedStyle(document.querySelector('.card.tab')).borderColor !== getComputedStyle(document.querySelector('.card.session')).borderColor`)) === true);

  // 7. tab の札を押す → 窓の中に頁（iframe）。押した窓が前に来る。「タブで開く」で普通のタブへ
  await browser("Target.activateTarget", { targetId: ntp3!.id });
  await n2.ev(`document.querySelector('${sw1} .win-close').click(); 1`); // 札が窓の下に隠れないよう session の窓を一旦閉じる
  await waitFor(async () => ((await n2.ev(`!document.querySelector('${sw1}')`)) === true ? true : null), 20);
  expect("窓の「×」で窓は閉じるが、札は残り、開いていない事が残る", (await n2.ev(`!!document.querySelector('.card.session')`)) === true && winOf(`s:${id}`)?.open === false, saved());
  const hitsBefore = iframeHits;
  await press(".card.tab");
  const tw = await waitFor(async () => ((await n2.ev(`document.querySelector('.win[data-key^="t:"] iframe')?.src || ''`)) === pageUrl ? true : null), 40);
  expect("tab の札を押すと、デスクトップの中に頁の窓が開く", !!tw);
  await waitFor(async () => (iframeHits > hitsBefore ? true : null), 20);
  expect("窓の頁は iframe として読まれた（Sec-Fetch-Dest: iframe）", iframeHits > hitsBefore, iframeHits);
  // 頁の窓を右下の隅へ寄せて、session の札が隠れないようにしてから session の札を押す
  await n2.ev(`(() => { const d = document.getElementById('desk'); call('desktopWindow', { key: document.querySelector('.win[data-key^="t:"]').dataset.key, win: { x: d.clientWidth - 300, y: d.clientHeight - 200, w: 280, h: 180, open: true } }); return 1; })()`);
  await Bun.sleep(800);
  await press(".card.session");
  await waitFor(async () => ((await n2.ev(`!!document.querySelector('${sw1}')`)) === true ? true : null), 20);
  const z = async (sel: string) => Number(await n2.ev(`getComputedStyle(document.querySelector('${sel}')).zIndex`));
  expect("あとから開いた窓が前に来る", (await z(sw1)) > (await z('.win[data-key^="t:"]')));
  await press('.win[data-key^="t:"] .win-bar', 90, 8); // session の窓に覆われていない右側を押す
  expect("窓の帯を押すと、その窓が一番前に来る", (await z('.win[data-key^="t:"]')) > (await z(sw1)));
  await press(".card.tab", 6, 12);
  await Bun.sleep(500);
  expect("同じ札をもう一度押しても窓は 2 枚にならない", (await n2.ev(`document.querySelectorAll('.win').length`)) === 2);
  await browser("Target.closeTarget", { targetId: webId });
  await waitFor(async () => ((await pages(pageUrl)).length === 0 ? true : null), 20);
  await browser("Target.activateTarget", { targetId: ntp3!.id });
  await press('.win[data-key^="t:"] .win-pop', 20, 8);
  expect("「タブで開く」で普通のタブとして開く", !!(await waitFor(async () => ((await pages(pageUrl)).length === 1 ? true : null), 30)), await targets());
  await n2.ev(`document.querySelectorAll('.win-close').forEach((b) => b.click()); 1`);
  await waitFor(async () => ((await n2.ev(`document.querySelectorAll('.win').length`)) === 0 ? true : null), 20);

  // 8. terminal: panel で ギャル を選んだまま「ターミナルをデスクトップに置く」→ 札 → 押すと作業場所を開く
  await ev(`document.getElementById('term-to-desktop').click(); 1`);
  const note4 = await waitFor(async () => { const t = await ev(`document.getElementById('desktop-note').textContent`); return t.includes("ターミナル") ? t : null; }, 40);
  expect("panel に「デスクトップに置いた: ギャル のターミナル」", note4 === "デスクトップに置いた: ギャル のターミナル", note4);
  const tc = await waitFor(async () => ((await n2.ev(`document.querySelector('.card.terminal .name')?.textContent`)) === "ギャル のターミナル" ? true : null), 40);
  expect("terminal の札（⌘ の印）", !!tc && (await n2.ev(`document.querySelector('.card.terminal .mark')?.textContent`)) === "⌘");
  await browser("Target.activateTarget", { targetId: ntp3!.id });
  const kids = () => Bun.spawnSync(["lsof", "-t", sock]).stdout.toString().split("\n").filter(Boolean).reduce((n, p) => n + Bun.spawnSync(["pgrep", "-P", p]).stdout.toString().split("\n").filter(Boolean).length, 0);
  const k0 = kids();
  await press(".card.terminal");
  const xw = '.win[data-key^="x:"]';
  const shown = await waitFor(async () => ((await n2.ev(`!!document.querySelector('${xw} .xterm-rows')`)) === true ? true : null), 40);
  expect("terminal の札を押すと、デスクトップの中に端末の窓（xterm）が開く", !!shown);
  const screen = () => n2.ev(`document.querySelector('${xw} .xterm-rows')?.textContent || ''`) as Promise<string>;
  const nodeDir = join(nodes, readdirSync(nodes)[0] ?? "-");
  expect("端末の shell が 1 本起きた（常駐の子）", !!(await waitFor(async () => (kids() === k0 + 1 ? true : null), 20)), { k0, now: kids() });
  const tr = await rect(`${xw} .xterm`);
  await mouse(n2.send, "mousePressed", tr.left + 40, tr.top + 40);
  await mouse(n2.send, "mouseReleased", tr.left + 40, tr.top + 40);
  const type = async (t: string) => { await n2.send("Input.insertText", { text: t }); for (const type of ["keyDown", "keyUp"]) await n2.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }); };
  await Bun.sleep(1500); // shell の最初の prompt を待つ
  await type("echo kangae$((40+2)); pwd");
  const echoed = await waitFor(async () => ((await screen()).includes("kangae42") ? true : null), 30);
  expect("窓に打った command の結果が画面に出る（echo kangae → kangae42）", !!echoed, (await screen()).slice(-300));
  const flat = (t: string) => t.replace(/\s+/g, "");
  expect("shell の cwd は session の作業場所（AGENTS.md の dir）", flat(await screen()).includes(flat(realpathSync(nodeDir))) && existsSync(join(nodeDir, "AGENTS.md")), { nodeDir, screen: (await screen()).slice(-300) });
  // 窓の大きさを変えると shell の行・列も変わる（stty size の結果を前後で比べる）
  const ttySize = async (tag: string) => {
    const r = await rect(`${xw} .xterm`);
    await mouse(n2.send, "mousePressed", r.left + 30, r.top + 30);
    await mouse(n2.send, "mouseReleased", r.left + 30, r.top + 30);
    await type(`echo ${tag}$(stty size | tr ' ' x)E`);
    const m = await waitFor(async () => new RegExp(`${tag}(\\d+)x(\\d+)E`).exec(await screen()), 20);
    return m ? { rows: Number(m[1]), cols: Number(m[2]) } : null;
  };
  const sz0 = await ttySize("QA");
  await drag(`${xw} .win-grip`, -160, -80, 8, 8);
  const sz1 = await ttySize("QB");
  expect("窓を小さくすると shell の画面の大きさも追随する（stty size の列・行が減る）", !!sz0 && !!sz1 && sz1.cols < sz0.cols && sz1.rows < sz0.rows, { sz0, sz1 });
  // 「Terminal で開く」は今まで通り作業場所を macOS の Terminal で開く
  await press(`${xw} .win-pop`, 20, 8);
  const log = await waitFor(async () => (existsSync(openLog) ? readFileSync(openLog, "utf8").trim() : null), 40);
  const wd = /^-a Terminal (.+)$/m.exec(log ?? "")?.[1];
  expect("「Terminal で開く」は「-a Terminal <作業場所>」で開く", !!wd && wd.startsWith(nodes), log);
  expect("作業場所に session の文脈（AGENTS.md）ができる", !!wd && existsSync(join(wd, "AGENTS.md")) && readFileSync(join(wd, "AGENTS.md"), "utf8").includes("ギャル"));
  // 窓を閉じると shell も止まる（孤児を残さない）
  await n2.ev(`document.querySelector('${xw} .win-close').click(); 1`);
  expect("窓の「×」で shell も止まる", !!(await waitFor(async () => (kids() === k0 ? true : null), 20)), { k0, now: kids() });
  // 開き直せば、新しい shell で窓が戻る（札は残っている）
  await press(".card.terminal");
  expect("札をもう一度押すと新しい shell の窓が開く", !!(await waitFor(async () => ((await n2.ev(`!!document.querySelector('${xw} .xterm-rows')`)) === true && kids() === k0 + 1 ? true : null), 30)), { k0, now: kids() });
  // 新しいタブを開き直す・閉じる: 窓は位置ごと戻り、閉じた方の shell は残らない
  await browser("Target.closeTarget", { targetId: ntp3!.id });
  expect("新しいタブを閉じると shell が止まる", !!(await waitFor(async () => (kids() === k0 ? true : null), 20)), { k0, now: kids() });
  await open(`chrome-extension://${extId}/newtab.html`);
  const ntp4 = await waitFor(async () => (await pages("/newtab.html"))[0], 60);
  n2 = await attach(ntp4!);
  expect("開き直した新しいタブに端末の窓が戻り、新しい shell が 1 本", !!(await waitFor(async () => ((await n2.ev(`!!document.querySelector('${xw} .xterm-rows')`)) === true && kids() === k0 + 1 ? true : null), 30)), { k0, now: kids() });
  await browser("Target.closeTarget", { targetId: ntp4!.id });
  await open(`chrome-extension://${extId}/newtab.html`);
  const ntp5 = await waitFor(async () => (await pages("/newtab.html"))[0], 60);
  n2 = await attach(ntp5!);
  await waitFor(async () => ((await n2.ev(`document.body.dataset.desk`)) === "3" ? true : null), 40);

  // 9. × で外す（端末の窓が開いたままの札を外すと shell も止まる）（session は消えない）
  await n2.ev(`document.querySelector('.card.tab .x').click(); document.querySelector('.card.terminal .x').click(); document.querySelector('.card.session .x').click(); 1`);
  const gone = await waitFor(async () => ((await n2.ev(`document.body.dataset.desk`)) === "0" ? true : null), 40);
  expect("× で札が外れ、案内が戻る", !!gone && saved().length === 0 && (await n2.ev(`!document.getElementById('desk-empty').hidden`)) === true, saved());
  expect("外しても session は side panel に残る", (await ev(`document.querySelector('#roots li')?.dataset.id`)) === id);
} catch (e) {
  bad.push(String(e));
  console.log("ERROR", String(e));
} finally {
  console.log(bad.length ? `NG ${bad.length}: ${bad.join(" / ")}` : "ALL OK");
  const code = bad.length ? 1 : 0;
  kill();
  process.exit(code);
}
