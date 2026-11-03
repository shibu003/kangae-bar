// tmpleak-1: 起動 disk の $TMPDIR に test の temp が 36,000 件 / 600MB 残った。(1) preload が run 全体の temp を 1 本の folder に入れて終わりに消す (2) 残った物は tools/clean-tmp.ts（許可表の完全一致・30 分以上前・symlink は辿らない・dry-run 既定）
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { clean, find, prefixOf } from "../tools/clean-tmp.ts";
import { mktmp } from "./tmp.ts";
import { TMP_PREFIXES } from "../tools/tmp-prefixes.ts";

const root = join(import.meta.dir, "..");
const MIN = 30 * 60_000;
const old = (p: string) => { const t = new Date(Date.now() - 2 * 3600_000); utimesSync(p, t, t); };

// この test の temp は preload の root の中（= run の終わりに消える）。掃除 tool には本物の $TMPDIR ではなく、その中の使い捨て dir を渡す
const sandbox = () => realpathSync(mktmp("tl1"));

test("preload: 試験の tmpdir() は run 専用の短い名前の folder（kt + 6 字）の中で、その直下は本物の $TMPDIR", () => {
  const t = realpathSync(tmpdir());
  expect(/^kt[A-Za-z0-9]{6}$/.test(basename(t))).toBe(true);
  expect(readFileSync(join(root, "test/preload-home.ts"), "utf8")).toContain("afterAll(() =>"); // 終わりに丸ごと消す（process.on("exit") は bun test では走らない）
});

test("clean-tmp: 許可表に完全一致する（prefix + 英数 6 字）古い folder だけを消す。UUID 名・別 project・symlink・file・新しい物・長さの違う名前は消さない", () => {
  const d = sandbox();
  const mk = (name: string, o: { old?: boolean; file?: boolean } = {}) => {
    const p = join(d, name);
    if (o.file) writeFileSync(p, "x"); else { mkdirSync(p); writeFileSync(join(p, "f"), "x"); }
    if (o.old !== false) old(p);
    return p;
  };
  const gone = [mk("ws-aB3dE9"), mk("w8g4-ZZ99aa"), mk("kangae-ui-abcdef"), mk("ktqwerty"), mk("ks-anything-aB3dE9"), mk("ks-a-b-c-Zz9Zz9")]; // 旧名の prefix + 新しい ks-<名前>-6 字
  const keep = [
    mk("ks-anything-aB3dE9x"), // ks- でも 7 字
    mk("ks-aB3dE9"), // ks- に名前が無い
    mk("ws-aB3dE9x"), // 7 字
    mk("ws-aB3d"), // 4 字
    mk("ws-NEWnew", { old: false }), // 新しい
    mk("0024f707-895b-4e2b-8ae2-8aa4d9947222"), // UUID
    mk("other-project-abc123"), // 許可表に無い
    mk("ws-file01", { file: true }), // file
    mk("com.apple.something"), // 他人の物
  ];
  // symlink（向き先は消されてはならない物）
  const target = mktmp("tl1t"); writeFileSync(join(target, "precious"), "keep");
  symlinkSync(target, join(d, "ws-lnk123"));
  const dry = clean(d, { apply: false, minAgeMs: MIN, size: true });
  expect(dry.found).toBe(gone.length);
  expect(dry.removed).toBe(0);
  expect(dry.kb).toBeGreaterThan(0);
  for (const p of [...gone, ...keep]) expect(existsSync(p), "dry-run は消さない: " + p).toBe(true);
  const r = clean(d, { apply: true, minAgeMs: MIN, size: false });
  expect(r.removed).toBe(gone.length);
  for (const p of gone) expect(existsSync(p), "消える: " + p).toBe(false);
  for (const p of keep) expect(existsSync(p), "残る: " + p).toBe(true);
  expect(lstatSync(join(d, "ws-lnk123")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(target, "precious"), "utf8")).toBe("keep"); // symlink を辿って消していない
});

test("clean-tmp: 他人の folder（別の uid）と、直下でない物は対象に入れない・--min-age 以下は消さない", () => {
  const d = sandbox();
  mkdirSync(join(d, "ws-aB3dE9")); // 新しい
  mkdirSync(join(d, "x")); mkdirSync(join(d, "x/ws-zzzzzz")); old(join(d, "x/ws-zzzzzz")); old(join(d, "x"));
  expect(find(d, MIN).map((f) => f.name)).toEqual([]);
  old(join(d, "ws-aB3dE9"));
  expect(find(d, MIN).map((f) => f.name)).toEqual(["ws-aB3dE9"]);
  expect(find(d, MIN, Date.now(), (process.getuid?.() ?? 0) + 1)).toEqual([]); // uid が違う物は消さない
});

test("許可表: 試験（test/・docs/verify）の mkdtemp は全部 test/tmp.ts の mktmp を通る（0 件）・src / tools / scripts の mkdtemp の prefix は tools/tmp-prefixes.ts にある", () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === "node_modules" || e.name.startsWith(".") ? [] : e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|sh|mjs)$/.test(e.name) ? [join(dir, e.name)] : []);
  const own = new Set(["test/tmp.ts", "test/preload-home.ts", "test/tmpleak1.test.ts"].map((f) => join(root, f))); // helper 本体・run 専用 folder を作る preload・この検査の見本の文字列
  const bare: string[] = [], miss: string[] = [];
  for (const d of ["test", "tools", "src", "scripts", "docs/verify"]) {
    if (!existsSync(join(root, d))) continue;
    for (const f of walk(join(root, d))) {
      if (own.has(f)) continue;
      const s = readFileSync(f, "utf8");
      const rel = f.slice(root.length + 1);
      if (d === "test" || d === "docs/verify") { for (const m of s.matchAll(/mkdtemp(?:Sync)?\(/g)) bare.push(`${rel}:${s.slice(0, m.index).split("\n").length}`); continue; }
      for (const m of s.matchAll(/mkdtemp(?:Sync)?\(\s*(?:join\(\s*(?:tmpdir\(\)|os\.tmpdir\(\)|TMP\w*|process\.env\.TMPDIR\s*\?\?\s*"\/tmp"|`\$\{[^}]*\}`)\s*,\s*)?[`"']([^`"'$]*)/g)) {
        const p = m[1]!;
        if (p && !TMP_PREFIXES.includes(p)) miss.push(`${rel}: ${p}`);
      }
    }
  }
  expect(bare, "mktmp（test/tmp.ts）を通さない mkdtemp").toEqual([]);
  expect(miss).toEqual([]);
  expect(prefixOf("ktabc123")).toBe("kt");
  expect(prefixOf("ws-abc12")).toBeNull();
  expect(prefixOf("ks-foo-abc123")).toBe("ks-");
  expect(/^ks-r16-x-[A-Za-z0-9]{6}$/.test(basename(mktmp("r16-x")))).toBe(true); // helper の名前は clean-tmp の規則に合う
  expect(prefixOf(basename(mktmp("a b/c")))).toBe("ks-"); // 名前に記号があっても掃除の規則に合う
});

test("gemini の policy file は turn の終わりに消す（turn ごとに tmp に残らない）", () => {
  const src = readFileSync(join(root, "src/main.ts"), "utf8");
  expect(src).toContain("const pol = polPath = join(tmpdir()");
  expect(src).toContain("if (polPath) try { unlinkSync(polPath); } catch {}");
});

test("実物: preload を付けた bun test を 1 回回すと、その run の temp（test が作って消し忘れた物も）は run の終わりに全部消える", async () => {
  const outer = sandbox(), tdir = sandbox();
  writeFileSync(join(tdir, "leaky.test.ts"), `import { test, expect } from "bun:test";\nimport { mkdtempSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\ntest("leak", () => { for (let i = 0; i < 3; i++) writeFileSync(join(mkdtempSync(join(tmpdir(), "leak-")), "f"), "x"); expect(1).toBe(1); });\n`);
  const p = Bun.spawn(["bun", "test", "--preload", join(root, "test/preload-home.ts"), join(tdir, "leaky.test.ts")], { cwd: tdir, env: { ...process.env, TMPDIR: outer }, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  expect(await p.exited).toBe(0);
  expect(out).toContain("1 pass");
  expect(readdirSync(outer)).toEqual([]); // run 専用 folder ごと消えた（leak-… も kangae-test-… も残らない）
}, 120_000);
