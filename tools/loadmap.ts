// 機械の重さの内訳を測る。ps を 10 秒ごとに 30 回。何も止めない・起こさない。
// 環境変数は「KANGAE_HOME が在るか」だけ（値は捨てる）。CPU は %cpu（生涯平均）ではなく cputime の差分。
import { execFileSync } from "node:child_process"
import { loadavg, cpus } from "node:os"
import { writeFileSync } from "node:fs"

const N = Number(process.argv[2] ?? 30), EVERY = Number(process.argv[3] ?? 10) * 1000
const out = process.argv[4] ?? "docs/verify/loadmap/loadmap.json"
const CATS = ["試験の残り物", "AIブラウザsession", "他projectのsession", "CEOのapp", "OS", "その他"] as const
type Cat = (typeof CATS)[number]
type P = { pid: number; ppid: number; rss: number; cpu: number; cmd: string; kh: boolean }

const secs = (t: string) => { const [m, s] = t.split(":"); return Number(m) * 60 + Number(s) }
const sh = (c: string, a: string[]) => execFileSync(c, a, { encoding: "utf8", maxBuffer: 1 << 28 })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function snap(): P[] {
  // 1 行目の列は固定、残りは command + env（env は KANGAE_HOME= の有無だけ読む）
  const lines = sh("ps", ["eww", "-Ao", "pid=,ppid=,rss=,time=,command="]).split("\n")
  const ps: P[] = []
  for (const l of lines) {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const [, pid, ppid, rss, cpu, rest = ""] = m
    ps.push({ pid: +pid!, ppid: +ppid!, rss: +rss!, cpu: secs(cpu!), kh: / KANGAE_HOME=/.test(rest), cmd: rest.split(" ")[0] + " " + (rest.match(/^\S+\s+(\S+)/)?.[1] ?? "") })
  }
  return ps
}

const cwdCache = new Map<number, string>()
function cwd(pid: number) {
  if (!cwdCache.has(pid)) {
    try { cwdCache.set(pid, sh("lsof", ["-a", "-d", "cwd", "-Fn", "-p", String(pid)]).split("\n").find((x) => x.startsWith("n"))?.slice(1) ?? "") } catch { cwdCache.set(pid, "") }
  }
  return cwdCache.get(pid)!
}

const isClaude = (p: P) => /(^|\/)claude( |$)/.test(p.cmd) || /claude-code|\/claude\/versions\//.test(p.cmd)
function classify(p: P, by: Map<number, P>): Cat {
  if (p.kh) return "試験の残り物"
  if (/Chrome for Testing|[Cc]hromium|headless_shell/.test(p.cmd)) return "試験の残り物"
  if (p.ppid === 1 && /(^|\/)bun /.test(p.cmd)) return "試験の残り物"
  for (let q: P | undefined = p, i = 0; q && i < 30; q = by.get(q.ppid), i++) {
    if (q.kh) return "試験の残り物"
    if (isClaude(q)) return /kangae-sora/.test(cwd(q.pid)) ? "AIブラウザsession" : "他projectのsession"
  }
  if (/^\/(System|usr\/libexec|usr\/sbin|sbin|Library\/Apple)|^(kernel_task|launchd)/.test(p.cmd)) return "OS"
  if (/^\/Applications\//.test(p.cmd)) return "CEOのapp"
  return "その他"
}

const swap = () => sh("sysctl", ["-n", "vm.swapusage"]).trim()
const rows: any[] = []
let prev = new Map<number, P>(), prevT = Date.now()
for (let i = 0; i < N; i++) {
  const ps = snap(), now = Date.now(), dt = (now - prevT) / 1000
  const by = new Map(ps.map((p) => [p.pid, p]))
  const agg = Object.fromEntries(CATS.map((c) => [c, { cpu: 0, rss: 0, n: 0 }])) as Record<Cat, { cpu: number; rss: number; n: number }>
  for (const p of ps) {
    const a = agg[classify(p, by)]
    a.n++; a.rss += p.rss / 1024
    const o = prev.get(p.pid)
    if (o && i > 0 && p.cpu >= o.cpu) a.cpu += ((p.cpu - o.cpu) / dt) * 100
  }
  rows.push({ i, t: new Date().toISOString(), load: loadavg()[0], swap: swap(), agg })
  prev = by; prevT = now
  if (i < N - 1) await sleep(EVERY)
}
writeFileSync(out, JSON.stringify({ ncpu: cpus().length, rows }, null, 1))
process.exit(0)
