// 製品の重さを部品ごとに数字で出す測り（weight）。CEO「製品として CPU が重いのはストレス・Rust にすべきか」の答えの元。
// 測るのは「自分が起こした pid（--root）とその子孫」＋ WebKit / Chrome のように launchd の子になる物は responsible（責任を負う process）が自分の木にいる時だけ。機械全体は測らない。
// 部品: 常駐 kangae / KangaeBar / WebContent / claude CLI / cua-driver / Chrome の tab。それ以外は「その他」。
// CPU% = ps の cputime（累積）の差 ÷ 経過秒（1 core = 100%）。ps の %cpu は減衰平均で、短い場面の測りに使えない。
// メモリ = footprint コマンドの phys_footprint（RSS は swap で当てにならない）。重いので --fp-interval 秒ごと。
// 使い方: bun tools/weight.ts --scene idle --secs 600 --root <pid>[,<pid>] [--responsible <responsible の実行 file>] [--interval 2] [--fp-interval 30] [--out docs/verify/weight] [--dry-run]
//   --dry-run: 機械を測らず、組み込みの fixture で「分類 → 集計 → 表」だけ流す（load が高い時・手順の確認用）。実機は PROBE.md の開始条件（load < 30）の後。
import { mkdirSync, writeFileSync } from "node:fs";

export const PARTS = ["常駐 kangae", "KangaeBar", "WebContent", "claude CLI", "cua-driver", "Chrome の tab", "その他"] as const;
export type Part = (typeof PARTS)[number];
export type Row = { pid: number; ppid: number; cpuSec: number; cmd: string };

// 先に当たった物が勝つ（claude CLI が kangae の引数に出ても常駐にならないよう、kangae は実行 file 名で見る）
export const classify = (cmd: string): Part => {
  const exe = cmd.split(/\s--?[a-z]|\s\S+:\/\//)[0] ?? cmd; // 実行 file の部分（引数の手前）
  if (/WebKit\.WebContent|com\.apple\.WebKit\.WebContent/.test(exe)) return "WebContent";
  if (/(Chrome|Chromium)( Helper \(Renderer\)|.*--type=renderer)/.test(cmd) && /--type=renderer|Helper \(Renderer\)/.test(cmd)) return "Chrome の tab";
  if (/KangaeBar/.test(exe)) return "KangaeBar";
  if (/cua-driver/.test(exe)) return "cua-driver";
  if (/(^|\/)claude(\s|$)|claude-code/.test(exe)) return "claude CLI";
  if (/(^|\/)kangae(\s|$)/.test(exe)) return "常駐 kangae";
  return "その他";
};

// ps の cputime（[D-][H:]MM:SS.ss）→ 秒
export const cpuSecOf = (t: string) => { const m = t.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/); return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 0; };
export const parsePs = (out: string): Row[] => out.split("\n").flatMap((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cpuSec: cpuSecOf(m[3]!), cmd: m[4]! }] : []; });
// footprint の出力 → { pid, MB }（phys_footprint の行）
export const parseFootprint = (out: string): { pid: number; mb: number } | null => {
  const pid = out.match(/\[(\d+)\]:/)?.[1], m = out.match(/phys_footprint:\s*([\d.]+)\s*(B|KB|MB|GB)/);
  if (!pid || !m) return null;
  return { pid: Number(pid), mb: Number(m[1]) * ({ B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 } as const)[m[2] as "B" | "KB" | "MB" | "GB"] };
};
// roots とその子孫。extra（responsible が木の中の process）も入れる
export const treeOf = (rows: Row[], roots: number[], extra: Set<number> = new Set()) => {
  const kids = new Map<number, number[]>(); for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const seen = new Set<number>(), q = [...roots];
  while (q.length) { const p = q.pop()!; if (seen.has(p)) continue; seen.add(p); q.push(...(kids.get(p) ?? [])); }
  for (const p of extra) seen.add(p);
  return rows.filter((r) => seen.has(r.pid));
};

export type Sample = { t: number; cpu: Record<string, number>; mb?: Record<string, number>; n: Record<string, number> }; // 部品ごとの合計（その時点）
export const summarize = (samples: Sample[]) => Object.fromEntries(PARTS.map((p) => {
  const cpu = samples.map((s) => s.cpu[p] ?? 0), mb = samples.filter((s) => s.mb).map((s) => s.mb![p] ?? 0), n = samples.map((s) => s.n[p] ?? 0);
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return [p, { procs: Math.max(0, ...n), cpuAvg: avg(cpu), cpuMax: Math.max(0, ...cpu), mbAvg: avg(mb), mbMax: Math.max(0, ...mb) }];
})) as Record<Part, { procs: number; cpuAvg: number; cpuMax: number; mbAvg: number; mbMax: number }>;
export const table = (scene: string, secs: number, sum: ReturnType<typeof summarize>) => [`# weight: ${scene}（${secs} 秒）`, "", "| 部品 | process 数（最大） | CPU% 平均 | CPU% 最大 | footprint MB 平均 | footprint MB 最大 |", "|---|---|---|---|---|---|", ...PARTS.map((p) => { const x = sum[p]; return `| ${p} | ${x.procs} | ${x.cpuAvg.toFixed(1)} | ${x.cpuMax.toFixed(1)} | ${x.mbAvg.toFixed(0)} | ${x.mbMax.toFixed(0)} |`; }), "", "CPU% は 1 core = 100%。常駐 / Bar / WebContent / claude / cua / Chrome の tab 以外は「その他」。"].join("\n");

// ---- 実測 ----
const arg = (k: string, d = "") => { const i = process.argv.indexOf(k); return i >= 0 ? (process.argv[i + 1] ?? d) : d; };
const psRows = () => parsePs(Bun.spawnSync(["ps", "-axo", "pid=,ppid=,cputime=,command="]).stdout.toString());
const footprintMB = (pid: number) => parseFootprint(Bun.spawnSync(["footprint", "-p", String(pid), "--noCategories"]).stdout.toString())?.mb ?? null;
// WebKit / Chrome の子は launchd の子（ppid 1）。responsible が自分の木にいる物だけ自分の物とみなす
const responsibleOf = (bin: string, pids: number[]) => { const m = new Map<number, number>(); if (!bin || !pids.length) return m; for (const l of Bun.spawnSync([bin, ...pids.map(String)]).stdout.toString().split("\n")) { const x = l.match(/^pid (\d+) → responsible (\d+)/); if (x) m.set(Number(x[1]), Number(x[2])); } return m; };

if (import.meta.main) {
  const scene = arg("--scene", "scene"), secs = Number(arg("--secs", "600")), interval = Number(arg("--interval", "2")), fpEvery = Number(arg("--fp-interval", "30")), out = arg("--out", "docs/verify/weight");
  if (process.argv.includes("--dry-run")) {
    const fx: Row[] = [[10, 1, "KangaeBar --relaunch"], [11, 10, "/x/bin/kangae --daemon"], [12, 11, "/usr/local/bin/claude -p hi"], [13, 11, "/x/cua-driver mcp"], [14, 1, "/S/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent"], [15, 1, "/C/Google Chrome Helper (Renderer) --type=renderer"], [16, 11, "/bin/sh -c x"]].map(([pid, ppid, cmd]) => ({ pid: pid as number, ppid: ppid as number, cpuSec: 0, cmd: cmd as string }));
    const tree = treeOf(fx, [10], new Set([14, 15]));
    const cpu: Record<string, number> = {}, n: Record<string, number> = {};
    for (const r of tree) { const p = classify(r.cmd); cpu[p] = (cpu[p] ?? 0) + 1.5; n[p] = (n[p] ?? 0) + 1; }
    console.log(table("dry-run（fixture）", 0, summarize([{ t: 0, cpu, mb: Object.fromEntries(Object.keys(cpu).map((k) => [k, 10])), n }])));
    process.exit(0);
  }
  const roots = arg("--root").split(",").map(Number).filter((x) => x > 1);
  if (!roots.length) { console.error("--root <自分が起こした pid>[,<pid>] が要ります（機械全体は測らない）"); process.exit(2); }
  const resp = arg("--responsible");
  const samples: Sample[] = [];
  let prev = new Map<number, number>(), tPrev = Date.now(), fp: Record<string, number> | undefined, fpAt = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    const rows = psRows();
    const direct = treeOf(rows, roots);
    const inTree = new Set(direct.map((r) => r.pid)), cands = rows.filter((r) => !inTree.has(r.pid) && r.ppid === 1 && ["WebContent", "Chrome の tab"].includes(classify(r.cmd))).map((r) => r.pid);
    const rp = responsibleOf(resp, cands), extra = new Set(cands.filter((p) => inTree.has(rp.get(p) ?? -1)));
    const tree = treeOf(rows, roots, extra), now = Date.now(), dt = (now - tPrev) / 1000;
    const cpu: Record<string, number> = {}, n: Record<string, number> = {}, cur = new Map<number, number>();
    for (const r of tree) { const p = classify(r.cmd); cur.set(r.pid, r.cpuSec); n[p] = (n[p] ?? 0) + 1; if (prev.has(r.pid) && dt > 0) cpu[p] = (cpu[p] ?? 0) + Math.max(0, (r.cpuSec - prev.get(r.pid)!) / dt) * 100; }
    if (now - fpAt >= fpEvery * 1000) { fp = {}; for (const r of tree) { const mb = footprintMB(r.pid); if (mb !== null) { const p = classify(r.cmd); fp[p] = (fp[p] ?? 0) + mb; } } fpAt = now; }
    if (prev.size) samples.push({ t: now, cpu, mb: fp, n }); // 最初の 1 回は差が取れない
    prev = cur; tPrev = now;
    await Bun.sleep(interval * 1000);
  }
  const sum = summarize(samples);
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/${scene}.json`, JSON.stringify({ scene, secs, roots, samples: samples.length, sum }, null, 2));
  writeFileSync(`${out}/${scene}.md`, table(scene, secs, sum) + "\n");
  console.log(table(scene, secs, sum));
}
