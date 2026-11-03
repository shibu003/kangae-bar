// v1.4 の埋め込みの実測（bun test/embed.e2e.ts）。拡張の頁の iframe だけ X-Frame-Options / frame-ancestors を外す事と、埋め込んだ頁に cookie（ログイン）が付く事。
// W3b-3: headless で回す（検査の中身は変えていない）。
// 本物の Chromium・remote debugging。常駐は試験用に compile した binary（<tmp>/repo/dist/kangae）。偽の claude は無し。
import { mktmp } from "./tmp.ts";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { pollUntil } from "../src/wait.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_APP, launch } from "../src/launch.ts";

const repoSrc = join(import.meta.dir, "..");
const dir = mktmp("kangae-embed-e2e");
const home = join(dir, "home");
const repo = join(dir, "repo");
const sock = join(dir, "s.sock");
const bin = join(repo, "dist/kangae");
const port = 11200 + Math.floor(Math.random() * 300);
mkdirSync(home, { recursive: true });
cpSync(join(repoSrc, "extension"), join(repo, "extension"), { recursive: true });
const build = Bun.spawnSync(["bun", "build", "--compile", "--target=bun-darwin-x64", join(repoSrc, "src/main.ts"), "--outfile", bin], { stdout: "ignore", stderr: "pipe" });
if (build.exitCode !== 0) throw new Error(`compile できない: ${build.stderr.toString()}`);

const env = { KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_CDP_PORT: String(port) };
const profile = join(home, "profile");
const opts = { app: CHROMIUM_APP, profile, hostBinary: bin, extensionDir: join(repo, "extension"), mockKeychain: true, debugPort: port, env };
const hits: { path: string; cookie: string }[] = [];
const web = Bun.serve({
  port: 0,
  fetch: (r) => {
    const u = new URL(r.url);
    const cookie = r.headers.get("cookie") ?? "";
    hits.push({ path: u.pathname + u.search, cookie });
    if (u.pathname === "/login") return new Response("<!doctype html><p>ok", { headers: { "content-type": "text/html", "set-cookie": "sid=abc; Path=/; SameSite=Lax" } });
    if (u.pathname === "/ping") return new Response("ok");
    const h: Record<string, string> = { "content-type": "text/html" };
    if (u.pathname === "/deny") { h["x-frame-options"] = "DENY"; h["content-security-policy"] = "frame-ancestors 'none'"; }
    return new Response("<!doctype html><title>埋め込みの頁</title><script>fetch('/ping?from=' + location.pathname)</script><p>hello", { headers: h });
  },
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
  // ログイン: 普通のタブで /login を開いて cookie（SameSite=Lax）を立てる
  await open(`${base}login`);
  await waitFor(async () => (hits.some((h) => h.path === "/login") ? true : null), 40);
  await Bun.sleep(500);
  await open(`chrome-extension://${extId}/newtab.html`);
  const nt = await waitFor(async () => (await pages("/newtab.html"))[0], 60);
  const { ev } = await attach(nt!);
  await waitFor(async () => ((await ev(`document.readyState`)) === "complete" ? true : null), 40);
  const embed = (path: string) => ev(`new Promise((r) => { const f = document.createElement('iframe'); f.src = '${base}${path}'; f.onload = () => r(1); document.body.append(f); setTimeout(() => r(0), 8000); })`);
  await embed("deny");
  await Bun.sleep(1500);
  expect("DENY の頁が拡張の iframe に描かれる（頁の script が動く）", hits.some((h) => h.path === "/ping?from=/deny"), hits);
  const d = hits.find((h) => h.path === "/deny");
  expect("埋め込んだ頁の要求に cookie（ログイン）が付く", !!d && d.cookie.includes("sid=abc"), hits);
  // 普通のタブで開く頁の守りは変えない: DENY の頁を iframe に入れた普通の頁では描かれない
  hits.length = 0;
  await open(`${base}outer?x=1`);
  await ev(`1`);
  const outer = await waitFor(async () => (await pages("/outer?x=1"))[0], 40);
  await (await attach(outer!)).ev(`new Promise((r) => { const f = document.createElement('iframe'); f.src = '/deny'; f.onload = () => r(1); document.body.append(f); setTimeout(() => r(0), 8000); })`);
  await Bun.sleep(1500);
  expect("普通のタブでは DENY の頁は描かれない（守りは外れていない）", hits.some((h) => h.path === "/deny") && !hits.filter((h) => h.path === "/ping?from=/deny").length, hits);
} catch (e) {
  bad.push(String(e));
  console.log("ERROR", String(e));
} finally {
  console.log(bad.length ? `NG ${bad.length}: ${bad.join(" / ")}` : "ALL OK");
  const code = bad.length ? 1 : 0;
  kill();
  process.exit(code);
}
