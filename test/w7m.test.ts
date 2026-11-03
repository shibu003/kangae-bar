import { mktmp } from "./tmp.ts";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asideNotices } from "../src/aside.ts";
import { readDesktop } from "../src/desktop.ts";
import { makeLeases } from "../src/lease.ts";
import { openStore } from "../src/store.ts";
import { childEnv, spawnDaemon, waitDaemon } from "./spawn-daemon.ts";

// W7m: 古い版（3fd473e・2026-10-06）の home を今の版が読む。古い版の形はここに手で書く（tools/w7m-update.ts は本物の古い常駐で同じ事を測る）
const tmp = () => mktmp("kangae-w7m");
const kept = (dir: string, name: string) => readdirSync(dir).filter((f) => f.startsWith(`${name}.unreadable-`));

// 古い版の store.ts の MIGRATIONS（user_version 5・keyword と from_id と結論を持つ）
function oldDb(path: string) {
  const db = new Database(path);
  db.run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES nodes(id), kind TEXT NOT NULL, text TEXT NOT NULL, chosen INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX nodes_parent ON nodes(parent_id);
    ALTER TABLE nodes ADD COLUMN from_id INTEGER REFERENCES nodes(id);
    ALTER TABLE nodes ADD COLUMN deleted_at INTEGER;
    ALTER TABLE nodes ADD COLUMN url TEXT;
    ALTER TABLE nodes ADD COLUMN data TEXT;
    PRAGMA user_version = 5;`);
  const ins = db.query("INSERT INTO nodes (parent_id, kind, text, chosen, created_at, from_id, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id");
  const id = (...v: any[]) => (ins.get(...v) as any).id as number;
  const root = id(null, "user", "旅行の計画", 1, 1, null, null);
  const kw = id(root, "keyword", "宿", 0, 2, null, null);
  id(kw, "keyword", "駅の近く", 0, 3, null, null);
  const c = id(root, "conclusion", "4 月の京都に 2 泊する", 0, 4, null, null);
  id(c, "step", "宿を比べる", 0, 5, null, null);
  id(root, "component", "やること", 0, 6, null, JSON.stringify({ type: "todo", items: [{ text: "宿を取る", done: true }] }));
  id(root, "component", "表", 0, 7, null, JSON.stringify({ type: "table", columns: ["a"], rows: [["1"]] }));
  const split = id(null, "user", "宿の話", 1, 8, kw, null);
  db.close();
  return { root, kw, split };
}

test("古い版の DB を開く: session・結論と次の一手・todo・表が残り、keyword は next になり、from_id の列は消さない", () => {
  const dir = tmp();
  const f = join(dir, "kangae.db");
  const o = oldDb(f);
  const s = openStore(f);
  expect(s.roots().map((r) => r.text).sort()).toEqual(["宿の話", "旅行の計画"]);
  const all = s.all();
  expect(all.map((n) => n.kind + ":" + n.text)).toEqual(expect.arrayContaining(["next:宿", "next:駅の近く", "conclusion:4 月の京都に 2 泊する", "step:宿を比べる"]));
  expect(all.find((n) => n.text === "やること")!.data).toEqual({ type: "todo", items: [{ text: "宿を取る", done: true }] });
  expect(all.find((n) => n.text === "表")!.data).toMatchObject({ type: "table" });
  // 新しい版で足しても古い列は NULL のまま壊れない
  expect(s.add(o.root, "user", "続き", true).parentId).toBe(o.root);
  const raw = new Database(f, { readonly: true });
  expect((raw.query("SELECT from_id FROM nodes WHERE id = ?").get(o.split) as any).from_id).toBe(o.kw);
  raw.close();
});

test("机の配置: 古い形は全部読める／読めない file は消さず取っておき、1 行の案内が出る", () => {
  const dir = tmp();
  writeFileSync(join(dir, "desktop.json"), JSON.stringify([{ key: "s:1", kind: "session", rootId: 1, x: 0.1, y: 0.2 }, { key: "t:https://example.com/a", kind: "tab", url: "https://example.com/a", title: "例", x: 0.5, y: 0.5 }]));
  const before = asideNotices().length; // 同じ process の他の file が先に足していてもよい（0 と決め打たない・review16）
  expect(readDesktop(dir).map((c) => c.kind)).toEqual(["session", "tab"]);
  expect(asideNotices().length).toBe(before);

  const bad = tmp();
  writeFileSync(join(bad, "desktop.json"), "{ 途中で切れた");
  expect(readDesktop(bad)).toEqual([]);
  const k = kept(bad, "desktop.json");
  expect(k.length).toBe(1);
  expect(readFileSync(join(bad, k[0]!), "utf8")).toBe("{ 途中で切れた");
  const n = asideNotices().at(-1)!;
  expect(n.what).toContain("机の配置");
  expect(n.how).toContain(k[0]!); // 次の一手: どこに取ってあるか

  const alien = tmp();
  writeFileSync(join(alien, "desktop.json"), JSON.stringify([{ key: "s:1", kind: "session", rootId: 1, x: 0, y: 0 }, { kind: "未来の札", x: 0, y: 0 }]));
  expect(readDesktop(alien).length).toBe(1);
  expect(kept(alien, "desktop.json").length).toBe(1); // 落とした札を含む前の写し
  expect(existsSync(join(alien, "desktop.json"))).toBe(true); // 読めた分は使い続ける
});

test("操作権の記録: 古い形（modes 無し）は読める／JSON でない file は取っておく", () => {
  const dir = tmp();
  writeFileSync(join(dir, "leases.json"), JSON.stringify({ floor: { "pid:1:win:2": 3 }, leases: [{ surface: { pid: 1, windowId: 2, app: "Notes", title: "メモ" }, owner: "s:1", exp: Date.now() + 1e6 }] }));
  const l = makeLeases(dir, { driver: () => null });
  expect(l.list().length).toBe(1);
  const bad = tmp();
  writeFileSync(join(bad, "leases.json"), "\u0000\u0000壊れた");
  makeLeases(bad, { driver: () => null });
  expect(kept(bad, "leases.json").length).toBe(1);
  expect(asideNotices().at(-1)!.what).toContain("操作権");
});

test("読めない DB でも常駐は起き、DB は消さず取ってある（落ちて「繋がりません」だけにならない）", async () => {
  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "kangae.db"), "これは SQLite ではない".repeat(50));
  const env = childEnv({ KANGAE_HOME: home, KANGAE_SOCK: join(dir, "k.sock"), KANGAE_BAR: join(dir, "bar.json"), KANGAE_NODES_DIR: join(dir, "nodes") });
  const p = spawnDaemon(["bun", join(import.meta.dir, "../src/main.ts"), "--daemon"], { env, stdout: "ignore" });
  try {
    await waitDaemon(p, { bar: env.KANGAE_BAR, sock: env.KANGAE_SOCK, ms: 60_000 });
    const k = kept(home, "kangae.db");
    expect(k.length).toBe(1);
    expect(readFileSync(join(home, k[0]!), "utf8")).toContain("これは SQLite ではない");
    expect(existsSync(join(home, "kangae.db"))).toBe(true); // 空の新しい記録
  } finally { p.kill(); }
}, 90_000);
