// affected — 変えた src / extension に効く試験を全部回す（commit の前に打つ）
// 使い方: bun tools/affected.ts [--base impl/w1a] [--list] [--files a,b] [--staged]   --list は回さず一覧だけ・--files は git を見ずその unit を回す
// --staged は index にある変更だけを見る（.githooks/pre-commit が使う）。時間切れは単独で再走し、それでも時間切れなら止めず但し書きに出す（exit 0）
// load は止める理由にしない（この機械は常に 250〜450）。結果の先頭に書くだけ
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { testTimeoutMs } from "./test-timeout.ts";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const EXTS = ["", ".ts", ".js", ".json", "/index.ts"];
// 相対 import / dynamic import / readFileSync(new URL("../x")) / join(dir, "../x") の相対 path 文字列
const REL = /["'`](\.{1,2}\/[^"'`\s]+)["'`]/g;
// test が "extension/panel.js" のように root 相対で名指す物
const ROOTREL = /["'`/](?:src|extension)\/[\w./-]+\.(?:ts|js|json|html)/g;

function resolveFile(from: string, spec: string): string | null {
  for (const e of EXTS) {
    const p = resolve(dirname(from), spec + e);
    if (p.startsWith(ROOT) && existsSync(p) && /\.[a-z]+$/.test(p)) return relative(ROOT, p);
  }
  return null;
}

// file が（間接も含めて）読む src / extension の集合
const memo = new Map<string, Set<string>>(); // 1 process の中で同じ file の閉包を作り直さない（affected を何度も呼ぶ試験が全 file を読み直して 5 秒を越えていた）
export function reads(rel: string, seen?: Set<string>): Set<string> {
  if (!seen) { let m = memo.get(rel); if (!m) memo.set(rel, (m = reads(rel, new Set()))); return m; }
  if (seen.has(rel)) return seen;
  seen.add(rel);
  if (!/\.(ts|js)$/.test(rel)) return seen;
  const text = readFileSync(join(ROOT, rel), "utf8");
  for (const m of text.matchAll(REL)) {
    const r = resolveFile(join(ROOT, rel), m[1]!);
    if (r && /^(src|extension)\//.test(r)) reads(r, seen);
  }
  for (const m of text.matchAll(ROOTREL)) {
    const r = m[0].replace(/^["'`/]/, "");
    if (existsSync(join(ROOT, r))) reads(r, seen);
  }
  return seen;
}

// 常駐・compile した binary・Chromium・claude を起こす重い *.test.ts（unit として回すと load 450 で時間切れ → Skip-affected が日常になる）。
// file 名を .e2e.ts に寄せない: bun test は *.test.ts しか拾わず、runner の「bun test 全部」から落ちる。だからここの表で分ける。値 = 実測秒（docs/verify/affectedclass/）
export const HEAVY: Record<string, number> = {
  "test/e2e.test.ts": 101,
  "test/affectedhook.test.ts": 361, // 使い捨ての clone で git commit を 10 本打つ（load 140 で時間切れ・affectedfast 報告）
  "test/w25b.test.ts": 120, // bun build --compile を 2 本・常駐を 1 本起こす（W25b・表に書き忘れると unit として回る）
  "test/review10.test.ts": 120, // 常駐を 7 本起こす。120 は下限（時間切れの報告のみ・秒は docs/verify/heavyfix/run1.txt で直す）
  "test/w55.test.ts": 120, // 実物の swift bar を build する（W55・混んだ機械で 7 分）
};

export function testFiles() {
  const unit: string[] = [], e2e: string[] = [];
  for (const f of readdirSync(join(ROOT, "test")).sort()) {
    if (f.endsWith(".e2e.ts") || `test/${f}` in HEAVY) e2e.push(`test/${f}`);
    else if (f.endsWith(".test.ts")) unit.push(`test/${f}`);
  }
  const uc = readdirSync(join(ROOT, "docs/verify"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, "docs/verify", d.name, "uc.ts")))
    .map((d) => `docs/verify/${d.name}/uc.ts`);
  return { unit, e2e, uc };
}

// changed（root 相対 path）に効く test file。test 自身が変わっていればそれも入る
export function affected(changed: string[], tests: string[]): string[] {
  const set = new Set(changed);
  return tests.filter((t) => set.has(t) || [...reads(t)].some((r) => set.has(r)));
}

// 共有の .git/config を試験が書き換えた事故（2026-10-08 に 2 回・core.bare=true / user.email=t@t）の見張り。commit の度・affected の度に止める
export function gitGuard(root: string): string | null {
  // 共有 config だけでなく config.worktree・include も含め、local / worktree scope の実効値を git に読ませる（--file --get は include も config.worktree も core.bare=yes も見落とす）
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))) as Record<string, string>;
  const p = Bun.spawnSync(["git", "-C", root, "config", "--show-scope", "--get-regexp", "^(core\\.bare|user\\.(email|name))$"], { env });
  if (p.exitCode !== 0 && p.exitCode !== 1) return null; // git が読めない（repo でない）時は止めない
  const bad = new Set<string>();
  for (const line of p.stdout.toString().split("\n")) {
    const [scope, key, ...v] = line.split(/[\t ]+/);
    if (!key || (scope !== "local" && scope !== "worktree")) continue;
    const val = v.join(" ");
    if (key === "core.bare" ? val === "" || /^(true|yes|on|1)$/i.test(val) : true) bad.add(key);
  }
  return bad.size ? `共有の .git/config が書き換えられています: ${[...bad].join(", ")}。\`git config core.bare false\` / \`git config --unset user.email\` で戻し、直前に走った試験を operator に（${Bun.spawnSync(["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { env }).stdout.toString().trim()}/config）` : null;
}

const LIMIT = Number(process.env.AFFECTED_TIMEOUT_SEC) || 120;

// bun が最後に印字する "Ran N tests across M files" が file 数と合う時だけ「最後まで走った」。試験が途中で process.exit(0) すると exit 0 のまま後ろの file が走らない（まとめると、後ろの赤が全部隠れる）
export const completed = (out: string, n: number) => Number(out.match(/Ran \d+ tests? across (\d+) files?/)?.[1]) === n;

async function run(files: string[], sec: number) {
  const t0 = Date.now();
  // env は明示で渡す: bun は `delete process.env.X` を子の既定の env に映さない（hook の GIT_DIR / GIT_INDEX_FILE が試験に漏れ、試験の子の git が本物の branch に commit した・2026-10-14 W62）
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))) as Record<string, string>;
  const p = Bun.spawn(["bun", "test", "--timeout", String(testTimeoutMs()), ...files.map((f) => `./${f}`)], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(9), sec * 1000);
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  const code = await p.exited;
  clearTimeout(timer);
  return { ok: code === 0 && completed(out, files.length), timeout: Date.now() - t0 >= sec * 1000, sec: Math.round((Date.now() - t0) / 1000), out };
}

// まとめて回した出力から、赤い file と「最後まで行かなかった file」を拾う（bun は file ごとに "path:" の見出しを出し、test の赤は "(fail)"）
export function sortBatch(out: string, files: string[]) {
  const seen: string[] = [], red = new Set<string>();
  let cur = "";
  for (const l of out.split("\n")) {
    const h = l.match(/^(\S+\.test\.ts):$/);
    if (h) { cur = h[1]!.replace(/^\.\//, ""); seen.push(cur); }
    else if (cur && /^\(fail\)/.test(l)) red.add(cur);
  }
  const last = seen.at(-1);
  return { red, unfinished: files.filter((f) => !seen.includes(f) || f === last) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const g = gitGuard(ROOT);
  if (g) { console.error(`★★★ gitguard: ${g}`); process.exit(2); }
  if (args.includes("--guard")) process.exit(0);
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1] ?? "impl/w1a" : "impl/w1a";
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", ROOT, ...a]).stdout.toString().split("\n").filter(Boolean);
  const fork = git("merge-base", base, "HEAD")[0] ?? base; // base が先へ進んでも自分の枝が変えた物だけ
  const changed = args.includes("--staged")
    ? git("diff", "--cached", "--name-only")
    : [...new Set([...git("diff", "--name-only", fork), ...git("ls-files", "--others", "--exclude-standard")])];
  // hook から呼ばれると GIT_DIR / GIT_INDEX_FILE が入っている。試験が子の git を打つと本物の repo に書くので外す（index は上で読み終えた）
  for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];
  const { unit, e2e, uc } = testFiles();
  const hit = args.includes("--files") ? args[args.indexOf("--files") + 1]!.split(",") : affected(changed, unit);
  const load = Bun.spawnSync(["uptime"]).stdout.toString().match(/load averages?: ([\d.]+)/)?.[1];
  console.log(`load(1m)=${load}  base=${base}  変えた src/extension: ${changed.filter((c) => /^(src|extension)\//.test(c)).join(" ") || "なし"}`);
  console.log(`unit ${hit.length} 本: ${hit.join(" ") || "なし"}`);
  const heavy = [...affected(changed, e2e), ...affected(changed, uc)];
  console.log(`e2e/UC（回さない・runner に頼む）: ${heavy.join(" ") || "なし"}`);
  if (args.includes("--list")) process.exit(0);
  let red = 0, slow = 0;
  const T0 = Date.now();
  const alone = async (f: string) => {
    let r = await run([f], LIMIT);
    let tag = r.ok ? "PASS" : "FAIL";
    if (!r.ok && r.timeout) {
      const again = await run([f], LIMIT); // 混雑の赤か: 単独でもう 1 回
      tag = again.ok ? "時間（単独で通る）" : again.timeout ? "時間切れ（混雑・止めない）" : "FAIL";
      r = again;
    }
    if (tag.startsWith("時間切れ")) slow++;
    else if (!/^(PASS|時間)/.test(tag)) red++;
    console.log(`${tag}  ${f}  ${r.sec}s`);
    if (!r.ok) console.log(r.out.split("\n").filter((l) => /fail|error|✗|\(fail\)/i.test(l)).slice(0, 5).join("\n"));
  };
  if (hit.length) {
    // unit は 1 回の bun test にまとめる（process の起動は 1 回）。赤・時間切れ・最後まで行かなかった file だけ単独で再走する
    const b = await run(hit, LIMIT);
    if (b.ok) for (const f of hit) console.log(`PASS  ${f}`);
    else {
      const { red: reds, unfinished } = sortBatch(b.out, hit);
      const again = hit.filter((f) => reds.size === 0 || reds.has(f) || (b.timeout && unfinished.includes(f))); // 赤の出所が読めない時は全部単独で
      for (const f of hit) if (!again.includes(f)) console.log(`PASS  ${f}`);
      for (const f of again) await alone(f);
    }
    console.log(`まとめて ${hit.length} 本 ${Math.round((Date.now() - T0) / 1000)}s`);
  }
  if (slow) console.log(`但し書き: ${slow} 本は時間切れで測れていない（混雑）— 報告に書く`);
  console.log(red ? `赤 ${red} 本 — 報告の前に直す` : "unit 全部通った（e2e/UC は上の名前だけ）");
  process.exit(red ? 1 : 0);
}
