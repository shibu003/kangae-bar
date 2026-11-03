// $TMPDIR に残った kangae の test の temp を掃除する（tmpleak-1）。既定は dry-run（件数と大きさだけ）・--apply で消す。
// 消す物 = $TMPDIR 直下の「許可表（tools/tmp-prefixes.ts）の prefix + 英数 6 字」に完全一致する、ただの folder で、
//          作ってから --min-age（既定 30 分）以上経った物だけ。symlink・UUID 名・他 project の物・file は触らない。消す時も symlink は辿らない。
// 使い方: bun tools/clean-tmp.ts [--apply] [--min-age <分>] [--size]（--size は du で大きさも数える＝件数が多いと 1 分ほど）
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMP_PREFIXES } from "./tmp-prefixes.ts";

export type Found = { name: string; path: string; prefix: string };
// file の成果物（mkdtemp でない・名前に id が入る）の許可: gemini の turn の policy（製品。今は turn の終わりに消すが、前の版が残した分）・test の常駐の stderr の log。名前が完全に一致する ただの file だけ
export const FILE_PATTERNS: [string, RegExp][] = [["kangae-gemini-policy-", /^kangae-gemini-policy-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.toml$/], ["kangae-daemon-", /^kangae-daemon-\d+-\d+-[a-z0-9]{1,8}\.err$/]];
const SUFFIX = /^[A-Za-z0-9]{6}$/;
// 試験の temp は test/tmp.ts の mktmp を通り、名前は ks-<名前>-<英数 6 字>。この 1 つの規則で掃除する（許可表への足し忘れが起きない・tmpleak-3）。TMP_PREFIXES は mktmp を通らない物（src・tools・scripts と、前の版が残した旧名）
const KS = /^ks-[A-Za-z0-9_-]+-[A-Za-z0-9]{6}$/;
export const prefixOf = (name: string): string | null => { if (KS.test(name)) return "ks-"; for (const p of TMP_PREFIXES) if (name.startsWith(p) && SUFFIX.test(name.slice(p.length))) return p; return null; };

// dir 直下の候補。symlink・file・新しい物・許可表に無い名前は入れない
export function find(dir: string, minAgeMs: number, now = Date.now(), uid = process.getuid?.()): Found[] {
  const out: Found[] = [];
  for (const name of readdirSync(dir)) {
    const prefix = prefixOf(name) ?? FILE_PATTERNS.find(([, re]) => re.test(name))?.[0] ?? null;
    if (!prefix) continue;
    const path = join(dir, name);
    let st; try { st = lstatSync(path); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (!(FILE_PATTERNS.some(([, re]) => re.test(name)) ? st.isFile() : st.isDirectory())) continue; // file の成果物は file・mkdtemp の物は folder
    if (uid !== undefined && st.uid !== uid) continue;
    if (now - st.mtimeMs < minAgeMs) continue;
    out.push({ name, path, prefix });
  }
  return out;
}

export function sizeKb(paths: string[]): number {
  let kb = 0;
  for (let i = 0; i < paths.length; i += 200) {
    const r = Bun.spawnSync(["/usr/bin/du", "-sk", ...paths.slice(i, i + 200)], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
    for (const l of r.split("\n")) kb += Number(l.split("\t")[0]) || 0;
  }
  return kb;
}

export function clean(dir: string, o: { apply: boolean; minAgeMs: number; size: boolean; now?: number }) {
  const real = realpathSync(dir);
  const found = find(real, o.minAgeMs, o.now);
  const byPrefix = new Map<string, number>();
  for (const f of found) byPrefix.set(f.prefix, (byPrefix.get(f.prefix) ?? 0) + 1);
  const kb = o.size ? sizeKb(found.map((f) => f.path)) : null;
  let removed = 0;
  if (o.apply) for (const f of found) {
    // 消す直前にもう一度: まだ直下の ただの folder（symlink に替わっていない）
    try { const st = lstatSync(f.path); const isFile = FILE_PATTERNS.some(([, re]) => re.test(f.name)); if (st.isSymbolicLink() || (isFile ? !st.isFile() : !st.isDirectory()) || realpathSync(join(real, f.name)) !== join(real, f.name)) continue; rmSync(f.path, { recursive: true, force: true }); removed++; } catch {}
  }
  return { dir: real, found: found.length, kb, removed, byPrefix: [...byPrefix].sort((a, b) => b[1] - a[1]) };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const apply = a.includes("--apply"), size = a.includes("--size");
  const ai = a.indexOf("--min-age"), min = ai >= 0 ? Number(a[ai + 1]) : 30;
  if (!Number.isFinite(min) || min < 1) { console.error("--min-age は分（1 以上）で"); process.exit(2); }
  const r = clean(tmpdir(), { apply, minAgeMs: min * 60_000, size });
  console.log(`${apply ? "消しました" : "dry-run（消していません・--apply で消す）"}: ${r.dir}\n  対象 ${r.found} 件${r.kb !== null ? `・合計 ${(r.kb / 1024).toFixed(0)} MB` : "（大きさは --size で）"}・${min} 分以上前の物だけ${apply ? `・消した ${r.removed} 件` : ""}`);
  for (const [p, n] of r.byPrefix.slice(0, 15)) console.log(`  ${String(n).padStart(6)}  ${p}`);
}
