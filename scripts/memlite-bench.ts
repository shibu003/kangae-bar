// agent 用 headless Chrome・試験の Chrome（dm.e2e と同じ引数）・常駐（--daemon）の RSS を、起きた直後・頁 1 枚・idle の後で測る（memlite）。
// 人の Chrome には触らない（自前の一時 profile だけ・--headless=new で窓も Dock も出ない＝lsappinfo で BackgroundOnly を確かめた）。常駐は置き場を全部 temp にして起こす
// 使い方: bun scripts/memlite-bench.ts [標本数=3] [idle 秒=60] [行名に含む語=全部]  → 表（MB・中央値/最小/最大）を標準出力へ
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headlessArgs } from "../src/headless.ts";
import { scrubOwnerEnv } from "../src/paths.ts";
import { spawnDaemon } from "../test/spawn-daemon.ts";

// 変種 = 今の引数（base）に足す物。効いた物だけ src/headless.ts に入れる
const candidateArgs: Record<string, string[]> = {
  base: [],
  "gpu切": ["--disable-gpu"],
  "renderer上限1": ["--renderer-process-limit=1"],
  "site分けず": ["--disable-site-isolation-trials", "--disable-features=IsolateOrigins,site-per-process"],
  "背景機能切": ["--disable-extensions", "--disable-sync", "--disable-translate", "--disable-features=Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions", "--no-pings", "--metrics-recording-only"],
  "js heap上限": ["--js-flags=--max-old-space-size=256"],
  "全部": ["--disable-gpu", "--renderer-process-limit=1", "--disable-site-isolation-trials", "--disable-features=IsolateOrigins,site-per-process,Translate,MediaRouter,OptimizationHints", "--disable-extensions", "--disable-sync", "--no-pings", "--metrics-recording-only"],
};

const BIN = process.env.KANGAE_HEADLESS_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const N = Number(process.argv[2]) || 3, IDLE = Number(process.argv[3]) || 60;

// root pid から子孫の RSS 合計（MB）
function treeMb(root: number): { mb: number; procs: number } {
  const rows = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss="]).stdout.toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map<number, number[]>(); const rss = new Map<number, number>();
  for (const [p, pp, r] of rows) { rss.set(p, r); (kids.get(pp) ?? kids.set(pp, []).get(pp)!).push(p); }
  let kb = 0, procs = 0; const st = [root];
  while (st.length) { const p = st.pop()!; if (!rss.has(p)) continue; kb += rss.get(p)!; procs++; st.push(...(kids.get(p) ?? [])); }
  return { mb: Math.round(kb / 1024), procs };
}
// 起こした Chrome は親が死んでも残る（Bun.spawn の子は道連れにならない）ので、止められた時（SIGINT/SIGTERM・例外）も全部たたむ
const live = new Set<ReturnType<typeof Bun.spawn>>(), profiles = new Set<string>();
const descendants = (root: number): number[] => {
  const rows = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]).stdout.toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const out: number[] = [], st = [root];
  while (st.length) { const q = st.pop()!; for (const [c, pp] of rows) if (pp === q) { out.push(c); st.push(c); } }
  return out;
};
const killTree = (p: ReturnType<typeof Bun.spawn>) => { const ds = descendants(p.pid); try { p.kill(); } catch {} for (const d of ds) try { process.kill(d, "SIGKILL"); } catch {} };
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { live.forEach(killTree); profiles.forEach((d) => rmSync(d, { recursive: true, force: true })); process.exit(1); });
process.once("exit", () => live.forEach(killTree));
const page = Bun.serve({ port: 0, fetch: () => new Response(`<html><body>${"<p>kangae memlite 計測用の頁</p>".repeat(500)}<script>setInterval(()=>{},1000)</script></body></html>`, { headers: { "content-type": "text/html" } }) });

// 試験の Chrome = test/dm.e2e.ts:83 と同じ引数（headlessArgs ではない）
const e2eArgs = (profile: string) => ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=480,820", "--no-first-run", "--no-default-browser-check"];
async function once(extra: string[], args = (pr: string) => headlessArgs(pr).filter((a) => a !== "about:blank")) {
  const profile = mkdtempSync(join(tmpdir(), "memlite-"));
  const p = Bun.spawn([BIN, ...args(profile), ...extra, "about:blank"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  live.add(p); profiles.add(profile);
  try {
    let port = 0;
    for (let i = 0; i < 300 && !port; i++) { await Bun.sleep(200); try { port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {} }
    if (!port) throw new Error("起きなかった");
    await Bun.sleep(3000);
    const boot = treeMb(p.pid);
    await fetch(`http://127.0.0.1:${port}/json/new?http://127.0.0.1:${page.port}/`, { method: "PUT" });
    await Bun.sleep(5000);
    const open = treeMb(p.pid);
    await Bun.sleep(IDLE * 1000);
    return { boot, open, idle: treeMb(p.pid) };
  } finally {
    killTree(p); await Promise.race([p.exited, Bun.sleep(5000)]); live.delete(p); profiles.delete(profile); // 止まってから profile を消す（先に消すと書き込み中で残る）
    rmSync(profile, { recursive: true, force: true });
  }
}
// 常駐 = dm.e2e の startDaemon と同じ起こし方（置き場は全部 temp・親が死ねば自分で止まる）。頁 1 枚 = /panel を 1 回 GET
async function daemonOnce() {
  const D = mkdtempSync(join(tmpdir(), "memlite-d-")); profiles.add(D);
  const env: Record<string, string | undefined> = { ...process.env, KANGAE_HOME: join(D, "home"), KANGAE_SOCK: join(D, "d.sock"), KANGAE_BAR: join(D, "bar.json"), KANGAE_NODES_DIR: join(D, "nodes") };
  for (const k of ["KANGAE_MODS", "KANGAE_CHROME_DIR", "KANGAE_PROFILE", "CHROMIUM_APP"]) delete env[k];
  scrubOwnerEnv(env); mkdirSync(env.KANGAE_HOME!, { recursive: true });
  const p = spawnDaemon(["bun", join(import.meta.dir, "../src/main.ts"), "--daemon"], { env, stdin: "ignore", stdout: "ignore" });
  live.add(p);
  try {
    for (let i = 0; i < 600 && !existsSync(env.KANGAE_BAR!); i++) await Bun.sleep(200);
    if (!existsSync(env.KANGAE_BAR!)) throw new Error("常駐が起きなかった");
    await Bun.sleep(3000);
    const boot = treeMb(p.pid);
    const { port } = JSON.parse(readFileSync(env.KANGAE_BAR!, "utf8"));
    await fetch(`http://127.0.0.1:${port}/panel`).catch(() => {});
    await Bun.sleep(5000);
    const open = treeMb(p.pid);
    await Bun.sleep(IDLE * 1000);
    return { boot, open, idle: treeMb(p.pid) };
  } finally {
    killTree(p); await Promise.race([p.exited, Bun.sleep(5000)]); live.delete(p); profiles.delete(D);
    rmSync(D, { recursive: true, force: true });
  }
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`標本 ${N}・idle ${IDLE}s・bin ${BIN}\n| 変種 | 直後 MB(proc) | 頁1枚 MB(proc) | idle後 MB(proc) | 最小〜最大(idle後) |\n|---|---|---|---|---|`);
const rows: [string, () => ReturnType<typeof once>][] = [
  ...Object.entries(candidateArgs).map(([name, extra]) => [name, () => once(extra)] as [string, () => ReturnType<typeof once>]),
  ["試験の Chrome(dm.e2e の引数)", () => once([], e2eArgs)],
  ["常駐 --daemon", daemonOnce],
];
for (const [name, run] of rows.filter(([n]) => n.includes(process.argv[4] ?? ""))) {
  const rs = []; for (let i = 0; i < N; i++) rs.push(await run().catch((e) => (console.error(name, String(e)), null)));
  const ok = rs.filter((r): r is NonNullable<typeof r> => !!r);
  if (!ok.length) { console.log(`| ${name} | 失敗 | | | |`); continue; }
  const f = (k: "boot" | "open" | "idle") => `${med(ok.map((r) => r[k].mb))}(${med(ok.map((r) => r[k].procs))})`;
  const id = ok.map((r) => r.idle.mb);
  console.log(`| ${name} (n=${ok.length}) | ${f("boot")} | ${f("open")} | ${f("idle")} | ${Math.min(...id)}〜${Math.max(...id)} |`);
}
page.stop(); process.exit(0);
