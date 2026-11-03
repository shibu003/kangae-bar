// v1.5 の通し（bun test/history.e2e.ts）。session ごとの履歴: session の group で開いた頁が side panel に新しい順で出て、押すと開く。
// W3b-3: 履歴は会話の「…」の中（#history）。headless で回す。
// 本物の Chromium・remote debugging。常駐は試験用に compile した binary（<tmp>/repo/dist/kangae）。偽の claude は無し。
import { mktmp } from "./tmp.ts";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { pollUntil } from "../src/wait.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_APP, launch } from "../src/launch.ts";

const repoSrc = join(import.meta.dir, "..");
const dir = mktmp("kangae-hist-e2e");
const home = join(dir, "home");
const repo = join(dir, "repo");
const nodes = join(dir, "nodes");
const sock = join(dir, "s.sock");
const bin = join(repo, "dist/kangae");
const port = 10900 + Math.floor(Math.random() * 300);
mkdirSync(home, { recursive: true });
mkdirSync(nodes, { recursive: true });
cpSync(join(repoSrc, "extension"), join(repo, "extension"), { recursive: true });
const build = Bun.spawnSync(["bun", "build", "--compile", "--target=bun-darwin-x64", join(repoSrc, "src/main.ts"), "--outfile", bin], { stdout: "ignore", stderr: "pipe" });
if (build.exitCode !== 0) throw new Error(`compile できない: ${build.stderr.toString()}`);

const env = { KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_NODES_DIR: nodes, KANGAE_CDP_PORT: String(port) };
const profile = join(home, "profile");
const opts = { app: CHROMIUM_APP, profile, hostBinary: bin, extensionDir: join(repo, "extension"), mockKeychain: true, debugPort: port, env };
const web = Bun.serve({
  port: 0,
  fetch: (r) => new Response(`<!doctype html><title>頁${new URL(r.url).pathname.slice(1).toUpperCase()}</title><p>hello`, { headers: { "content-type": "text/html; charset=utf-8" } }),
});
const base = `http://127.0.0.1:${web.port}/`;
let proc = launch({ ...opts, extraArgs: ["--headless=new", "about:blank"] });

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
  const list = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#history .visit')].map((b) => b.textContent))`)) as string[];
  const count = async (path: string) => (await pages(base + path)).length;

  // 1. session「履歴」を作る。まだ何も開いていない → 「まだ履歴は無い」
  await waitFor(async () => (await ev(`!document.getElementById('empty-text').disabled`)) === true, 240);
  await ev(`(() => { const i = document.getElementById('empty-text'); i.value = '履歴'; document.getElementById('empty-form').requestSubmit(); return 1; })()`);
  const id = await waitFor(async () => ((await ev(`document.querySelector('#roots .root.on .root-text')?.textContent || ''`)) === "履歴" ? await ev(`document.querySelector('#roots li').dataset.id`) : null), 120);
  if (!id) throw new Error("session が無い");
  expect("履歴が空なら「まだ履歴は無い」", !!(await waitFor(async () => ((await ev(`document.querySelector('#history .attached-empty')?.textContent`)) === "まだ履歴は無い" ? true : null), 40)));

  // 2. 頁 A を session の group に入れ、B → C と開く（side panel を開き直さずに、新しい順で増える）
  await open(`${base}a`);
  await waitFor(async () => ((await ev(`!document.getElementById('add-tab').disabled`)) ? true : null), 40);
  await ev(`document.getElementById('add-tab').click(); 1`);
  const tabId = await waitFor(async () => { const g = await ev(`chrome.tabs.query({ url: '${base}a' }).then((t) => t[0] && t[0].groupId >= 0 ? t[0].id : null)`); return g ?? null; }, 40);
  expect("頁 A が session の group に入った", tabId != null);
  const go = (path: string) => ev(`chrome.tabs.update(${tabId}, { url: '${base}${path}' }).then(() => 1)`);
  await go("b");
  await waitFor(async () => ((await list()).join() === "頁B" ? true : null), 40);
  await go("c");
  const got = await waitFor(async () => ((await list()).join() === "頁C,頁B" ? true : null), 40);
  expect("開いた頁が新しい順に出る（C, B）", !!got, await list());
  expect("履歴の札に url が tooltip で付く", (await ev(`document.querySelector('#history .visit').title.includes('${base}c')`)) === true);

  // 3. 押す: 窓に無ければ新しい tab（session の group に入る）・あれば前面で新しい tab は増えない
  await ev(`[...document.querySelectorAll('#history .visit')].find((b) => b.textContent === '頁B').click(); 1`);
  const b1 = await waitFor(async () => ((await count("b")) === 1 ? true : null), 40);
  expect("窓に無い頁を押すと、新しい tab で開く", !!b1, await targets());
  const inGroup = await waitFor(async () => ((await ev(`chrome.tabs.query({ url: '${base}b' }).then((t) => t[0].groupId >= 0)`)) === true ? true : null), 40);
  expect("開いた tab は session の group に入る", !!inGroup);
  await browser("Target.activateTarget", { targetId: plain.id });
  await ev(`[...document.querySelectorAll('#history .visit')].find((b) => b.textContent === '頁C').click(); 1`);
  const front = await waitFor(async () => ((await ev(`chrome.tabs.query({ active: true, currentWindow: true }).then((t) => t[0]?.url)`)) === `${base}c` ? true : null), 40);
  expect("窓にある頁を押すと、その tab が前面に出て、新しい tab は増えない", !!front && (await count("c")) === 1, { c: await count("c") });
} catch (e) {
  bad.push(String(e));
  console.log("ERROR", String(e));
} finally {
  console.log(bad.length ? `NG ${bad.length}: ${bad.join(" / ")}` : "ALL OK");
  const code = bad.length ? 1 : 0;
  kill();
  process.exit(code);
}
