// review16 の攻撃: install-bar.sh（curl | sh の供給の鎖）と W7m（読めない記録の取り置き）。人の ~/Applications・本物の home には触らない（全部 temp・KANGAE_APPS / KANGAE_NO_OPEN）
import { mktmp } from "./tmp.ts";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStoreKeeping, setAside } from "../src/aside.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000); // install-bar.sh を行ごとの長さの数だけ実際に通す test がある（混んだ機械で 12 秒かかった・W57 で script が長くなった）

const tmp = (p: string) => mktmp(`r16-${p}`);
const sh = (c: string, env: Record<string, string> = {}, input?: string) => {
  const r = Bun.spawnSync(["sh", "-c", c], { env: { ...process.env, ...env }, stdin: input === undefined ? "ignore" : Buffer.from(input) });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

// 配る形の install-bar.sh（dist-bar.sh と同じ sed）と、file:// の置き場に偽の zip（両 arch）
function dist(version: string) {
  const d = tmp("dist"), app = join(d, "s", "Kangae Bar.app", "Contents");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "Info.plist"), "<plist/>");
  writeFileSync(join(app, "version"), version);
  for (const a of ["x64", "arm64"]) expect(sh(`ditto -c -k '${d}/s' '${d}/KangaeBar-${a}.zip'`).code).toBe(0);
  const sha = sh(`shasum -a 256 '${d}/KangaeBar-x64.zip' | cut -d' ' -f1`).out.trim();
  const body = readFileSync(join(import.meta.dir, "../scripts/install-bar.sh"), "utf8").replaceAll("@SHA_x64@", sha).replaceAll("@SHA_arm64@", sha);
  return { base: `file://${d}`, body };
}
function apps(version = "old") {
  const a = tmp("apps");
  mkdirSync(join(a, "Kangae Bar.app", "Contents"), { recursive: true });
  writeFileSync(join(a, "Kangae Bar.app", "Contents", "version"), version);
  return a;
}
const ver = (a: string) => { try { return readFileSync(join(a, "Kangae Bar.app", "Contents", "version"), "utf8"); } catch { return null; } };

test("install-bar.sh: 配る形で通すと新しい版が入り、隠しの組み立て場は残らない", () => {
  const { base, body } = dist("new");
  const a = apps();
  const r = sh("sh", { KANGAE_BASE: base, KANGAE_APPS: a, KANGAE_NO_OPEN: "1" }, body);
  expect(r.code).toBe(0);
  expect(ver(a)).toBe("new");
  expect(readdirSync(a)).toEqual(["Kangae Bar.app"]);
});

test("install-bar.sh: curl | sh が途中で切れても（行のどこで切れても）前の .app は消えない", () => {
  const { base, body } = dist("new");
  const lines = body.split("\n");
  const broke: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const a = apps();
    sh("sh", { KANGAE_BASE: base, KANGAE_APPS: a, KANGAE_NO_OPEN: "1" }, lines.slice(0, i).join("\n") + "\n");
    if (ver(a) !== "old" && ver(a) !== "new") broke.push(`${i}: ${lines[i - 1]}`);
  }
  expect(broke).toEqual([]);
});

test("install-bar.sh: .app を置く途中で失敗しても前の .app は残り、半端な .app を残さない", () => {
  const { base, body } = dist("new");
  const a = apps();
  // 置き場への ditto だけ、半分書いてから失敗する（満杯・権限の代わり）
  const bin = tmp("bin");
  writeFileSync(join(bin, "ditto"), `#!/bin/sh\ncase "$*" in *"${a}"*) for l; do d="$l"; done; mkdir -p "$d/Contents"; echo half > "$d/Contents/version"; exit 1;; esac\nexec /usr/bin/ditto "$@"\n`);
  chmodSync(join(bin, "ditto"), 0o755);
  const r = sh("sh", { KANGAE_BASE: base, KANGAE_APPS: a, KANGAE_NO_OPEN: "1", PATH: `${bin}:${process.env.PATH}` }, body);
  expect(r.code).not.toBe(0);
  expect(ver(a)).toBe("old");
  expect(readdirSync(a)).toEqual(["Kangae Bar.app"]);
});

test("install-bar.sh: sha256 が合わない物は入れず、前の .app に触らない", () => {
  const { base, body } = dist("new");
  const a = apps();
  const r = sh("sh", { KANGAE_BASE: base, KANGAE_APPS: a, KANGAE_NO_OPEN: "1" }, body.replace(/^SHA_(x64|arm64)=.*$/gm, "SHA_$1=" + "0".repeat(64)));
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("sha256 が合わない");
  expect(ver(a)).toBe("old");
  expect(readdirSync(a)).toEqual(["Kangae Bar.app"]);
});

// 人が書いた物が WAL にだけ在る記録（落ちた常駐の写し＝checkpoint 前）
function walDb(dir: string) {
  const src = join(dir, "src.db"), f = join(dir, "kangae.db");
  const db = new Database(src);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA wal_autocheckpoint = 0");
  db.run("CREATE TABLE nodes (id INTEGER PRIMARY KEY, text TEXT)");
  for (let i = 0; i < 50; i++) db.run("INSERT INTO nodes (text) VALUES (?)", [`人の物${i}`]);
  for (const s of ["", "-wal", "-shm"]) if (existsSync(src + s)) copyFileSync(src + s, f + s);
  db.close();
  return f;
}

test("W7m: 取り置きが途中で失敗したら元の記録（本体と -wal）に触らない", () => {
  const dir = tmp("aside");
  const f = walDb(dir);
  const wal = statSync(f + "-wal").size;
  expect(wal).toBeGreaterThan(0);
  const now = new Date(Date.UTC(2026, 9, 9, 1, 2, 3));
  mkdirSync(`${f}.unreadable-20261009010203-wal`); // 写しの -wal が作れない（満杯・権限の代わり）
  expect(setAside(f, "記録", { now })).toBeNull();
  // 呼び出し元は続けて同じ path を開く。元が残っていれば人の物はそのまま読める
  expect(existsSync(f)).toBe(true);
  expect(statSync(f + "-wal").size).toBe(wal);
  const db = new Database(f);
  expect((db.query("SELECT count(*) n FROM nodes").get() as any).n).toBe(50);
  db.close();
  expect(existsSync(`${f}.unreadable-20261009010203`)).toBe(false); // 半端な写しは残さない
});

test("W7m: 取り置いた写し（本体 + -wal）だけで人の物が全部読める", () => {
  const dir = tmp("aside2");
  const f = walDb(dir);
  const kept = setAside(f, "記録", { now: new Date(Date.UTC(2026, 9, 9, 1, 2, 4)) })!;
  expect(existsSync(f) || existsSync(f + "-wal")).toBe(false);
  const db = new Database(kept, { readonly: true });
  expect((db.query("SELECT count(*) n FROM nodes").get() as any).n).toBe(50);
  db.close();
});

test("W7m: 別の常駐が鍵を持っている（移行中・BUSY）時、健全な記録を取り置かない", () => {
  const dir = tmp("busy");
  const f = join(dir, "kangae.db");
  openStoreKeeping(f).add(null, "user", "人の物", true);
  const a = new Database(f);
  a.run("PRAGMA user_version = 5"); // 最後の移行（UPDATE）が残っている古い版の記録
  a.run("BEGIN EXCLUSIVE"); // 先に起きた常駐が移行中
  a.run("INSERT INTO nodes (kind, text, created_at) VALUES ('user', '移行中', 1)");
  expect(() => openStoreKeeping(f)).toThrow(/locked|busy/i);
  a.run("COMMIT");
  expect(readdirSync(dir).filter((n) => n.includes(".unreadable-"))).toEqual([]);
  expect((a.query("SELECT count(*) n FROM nodes").get() as any).n).toBe(2);
  a.close();
});

test("W7m: 本当に DB でない記録は今まで通り取り置いて空から起きる", () => {
  const dir = tmp("notadb");
  const f = join(dir, "kangae.db");
  writeFileSync(f, "これは SQLite ではない".repeat(50));
  const s = openStoreKeeping(f);
  expect(s.roots()).toEqual([]);
  expect(readdirSync(dir).filter((n) => n.includes(".unreadable-")).length).toBe(1);
});
