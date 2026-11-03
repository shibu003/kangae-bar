// suite の前後で「どこが増えたか」を特定する軽い道具（tmpleak-2）。読むだけ（du と df だけ・何も消さない・書くのは --out の file だけ）。df の差ではなく候補 dir の du を前後で比べる。
// 使い方: bun tools/disk-watch.ts snap --out before.json   …suite…   bun tools/disk-watch.ts snap --out after.json   bun tools/disk-watch.ts diff before.json after.json
// 候補 = 実行時に決まる（$TMPDIR・/private/tmp・~/.kangae・~/Library/Caches・~/Library/Logs・~/.bun・~/.cache・DiagnosticReports・user の cache（/var/folders/*/*/C）・~/.npm …）。各 dir は 1 階層下まで数える。
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type Snap = { at: number; dfFreeMB: number; dirs: Record<string, number>; kids: Record<string, Record<string, number>>; swapfilesMB?: number; swapUsedMB?: number };

export const candidates = (home = homedir(), tmp = tmpdir()): string[] => {
  const t = (() => { try { return realpathSync(tmp); } catch { return tmp; } })();
  const userCache = join(t, "..", "C");
  return [t, "/private/tmp", join(home, ".kangae"), join(home, "Library/Caches"), join(home, "Library/Logs"), join(home, ".bun"), join(home, ".cache"), join(home, ".npm"), join(home, ".local/share"), join(home, "Library/Application Support"), join(home, "Library/Saved Application State"), userCache, "/Library/Caches"].filter((p, i, a) => existsSync(p) && a.indexOf(p) === i);
};

// du -sk（本体）と du -k -d 1（1 階層下）。読めない所は 0 として数える（権限の error は捨てる）
export function sizes(dir: string): { total: number; kids: Record<string, number> } {
  const r = Bun.spawnSync(["/usr/bin/du", "-k", "-d", "1", dir], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
  let total = 0; const kids: Record<string, number> = {};
  for (const l of r.split("\n")) {
    const [k, ...rest] = l.split("\t"); const p = rest.join("\t"); if (!p) continue;
    if (p === dir || p === dir + "/") total = Number(k) || 0; else kids[p.slice(dir.length).replace(/^\//, "")] = Number(k) || 0;
  }
  return { total, kids };
}

export function dfFreeMB(path = "/System/Volumes/Data"): number {
  const r = Bun.spawnSync(["/bin/df", "-k", existsSync(path) ? path : "/"], { stdout: "pipe" }).stdout.toString().trim().split("\n").at(-1)!.split(/\s+/);
  return Math.round(Number(r[3]) / 1024);
}

// macOS の swap file（/System/Volumes/VM/swapfile0…・1 つ 1GiB）。空きが 1GB 単位で減って戻らない時の最有力（8GB の機械で複数の session / Chrome を回すと増え、圧が引いても残る）。file の増減ではないので候補 dir の du には出ない
export function swap(): { filesMB: number; usedMB: number } {
  const filesMB = Math.round((Number(Bun.spawnSync(["/usr/bin/du", "-sk", "/System/Volumes/VM"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().split("\t")[0]) || 0) / 1024);
  const used = /used = ([\d.]+)M/.exec(Bun.spawnSync(["/usr/sbin/sysctl", "-n", "vm.swapusage"], { stdout: "pipe" }).stdout.toString())?.[1];
  return { filesMB, usedMB: Math.round(Number(used) || 0) };
}

export function snap(dirs = candidates()): Snap {
  const w = swap();
  const s: Snap = { at: Date.now(), dfFreeMB: dfFreeMB(), dirs: {}, kids: {}, swapfilesMB: w.filesMB, swapUsedMB: w.usedMB };
  for (const d of dirs) { const z = sizes(d); s.dirs[d] = z.total; s.kids[d] = z.kids; }
  return s;
}

// 増えた順（KB）。1 階層下の増減も出す（新しく出来た物・消えた物を含む）
export function diff(a: Snap, b: Snap) {
  const dirs = Object.keys({ ...a.dirs, ...b.dirs }).map((d) => {
    const kids = Object.keys({ ...(a.kids[d] ?? {}), ...(b.kids[d] ?? {}) }).map((k) => ({ name: k, kb: (b.kids[d]?.[k] ?? 0) - (a.kids[d]?.[k] ?? 0) })).filter((x) => x.kb !== 0).sort((x, y) => y.kb - x.kb);
    return { dir: d, kb: (b.dirs[d] ?? 0) - (a.dirs[d] ?? 0), kids };
  }).sort((x, y) => y.kb - x.kb);
  return { dfMB: b.dfFreeMB - a.dfFreeMB, sumKB: dirs.reduce((n, d) => n + d.kb, 0), swapFilesMB: (b.swapfilesMB ?? 0) - (a.swapfilesMB ?? 0), swapUsedMB: (b.swapUsedMB ?? 0) - (a.swapUsedMB ?? 0), dirs };
}

if (import.meta.main) {
  const [cmd, ...a] = process.argv.slice(2);
  const oi = a.indexOf("--out");
  if (cmd === "snap") {
    const s = snap();
    if (oi >= 0) writeFileSync(a[oi + 1]!, JSON.stringify(s)); // 書くのは --out の file だけ
    console.log(`snap: df 空き ${s.dfFreeMB} MB・swap file ${s.swapfilesMB} MB（使用中 ${s.swapUsedMB} MB）・候補 ${Object.keys(s.dirs).length} dir`);
    for (const [d, kb] of Object.entries(s.dirs)) console.log(`  ${String(Math.round(kb / 1024)).padStart(7)} MB  ${d}`);
  } else if (cmd === "diff" && a.length >= 2) {
    const r = diff(JSON.parse(readFileSync(a[0]!, "utf8")), JSON.parse(readFileSync(a[1]!, "utf8")));
    console.log(`df 空きの差 ${r.dfMB} MB ／ 候補 dir の増減の和 ${Math.round(r.sumKB / 1024)} MB ／ swap file の増減 ${r.swapFilesMB} MB（使用中 ${r.swapUsedMB} MB）`);
    const unexplained = -r.dfMB - Math.round(r.sumKB / 1024) - r.swapFilesMB;
    console.log(`  → 説明できない減り ${unexplained} MB（df の減り − 候補 dir の増え − swap file の増え。${r.swapFilesMB >= 512 ? "swap file が増えている＝test の漏れではなく memory の圧" : "大きければ候補の外に増えた物がある"}）`);
    for (const d of r.dirs.filter((x) => Math.abs(x.kb) >= 1024)) {
      console.log(`  ${(d.kb >= 0 ? "+" : "") + Math.round(d.kb / 1024)} MB  ${d.dir}`);
      for (const k of d.kids.slice(0, 6).filter((x) => Math.abs(x.kb) >= 512)) console.log(`      ${(k.kb >= 0 ? "+" : "") + Math.round(k.kb / 1024)} MB  ${k.name}`);
    }
  } else { console.error("使い方: bun tools/disk-watch.ts snap [--out f.json] | diff before.json after.json"); process.exit(2); }
}
