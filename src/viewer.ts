// W38: Bar の agent の行の「見る」で、その agent が触った folder を人の選んだ app で前に開く（docs/BRIEF-w38.md）。
// 候補は /Applications と ~/Applications を読むだけで作る（app は 1 本も起こさない）。人だけが選び、候補に無い名前は Finder に落とす（任意の app 名で open -a を打たない）
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isEditor } from "./lease.ts";

export const ALWAYS = ["Finder", "Terminal"]; // 入っていなくても必ず出る（既定 Finder）
export const appDirs = (home = homedir()) => ["/Applications", join(home, "Applications")];

// 入っている編集器の名前（open -a に渡す名前 = .app の folder 名）。VS Code 系は Contents/Resources/app/product.json の有無で見る（fork を名前で追わない・docs/REPORT-review-w37.md §2-1）
export function listEditors(dirs = appDirs()): string[] {
  const out = new Set<string>();
  for (const d of dirs) {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".app")) continue;
      const name = n.slice(0, -4);
      if (isEditor(name, "") || existsSync(join(d, n, "Contents/Resources/app/product.json"))) out.add(name);
    }
  }
  return [...ALWAYS, ...[...out].filter((n) => !ALWAYS.includes(n)).sort()];
}

const file = (home: string) => join(home, "viewer.json");
// 今の選択。file が無い・壊れている・候補に無い名前なら Finder
export function readViewer(home: string, candidates: string[]): string {
  try { const j = JSON.parse(readFileSync(file(home), "utf8")); if (typeof j?.app === "string" && candidates.includes(j.app)) return j.app; } catch {}
  return "Finder";
}
export function writeViewer(home: string, app: string, candidates: string[]): boolean {
  if (!candidates.includes(app)) return false;
  writeFileSync(file(home) + ".tmp", JSON.stringify({ app }));
  renameSync(file(home) + ".tmp", file(home));
  return true;
}
// open に渡す引数の列。Finder は open <dir…>・Terminal は 1 folder ずつ・編集器は open -a <app> <dir…>（Zed / VS Code は 1 つの窓に複数 folder）
export function openArgs(app: string, dirs: string[]): string[][] {
  if (!dirs.length) return [];
  if (app === "Finder") return [dirs];
  if (app === "Terminal") return dirs.map((d) => ["-a", "Terminal", d]);
  return [["-a", app, ...dirs]];
}
