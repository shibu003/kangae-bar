import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Kind = "user" | "next" | "conclusion" | "step" | "tab" | "component" | "visit";
export type Node = {
  id: number;
  parentId: number | null;
  kind: Kind;
  text: string;
  chosen: boolean;
  createdAt: number;
  deletedAt: number | null;
  url: string | null; // タブの節だけが持つ
  data: unknown; // 部品の節だけが持つ（型ごとの形は components.ts）
};

const MIGRATIONS = [
  `CREATE TABLE nodes (
     id INTEGER PRIMARY KEY,
     parent_id INTEGER REFERENCES nodes(id),
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     chosen INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX nodes_parent ON nodes(parent_id);`,
  `ALTER TABLE nodes ADD COLUMN from_id INTEGER REFERENCES nodes(id);`,
  `ALTER TABLE nodes ADD COLUMN deleted_at INTEGER;`,
  `ALTER TABLE nodes ADD COLUMN url TEXT;`,
  `ALTER TABLE nodes ADD COLUMN data TEXT;`,
  // keyword の木をやめた（W3a）。前の枝は、その返事にぶら下がる「次の一手」として残す（会話は壊さない）
  `UPDATE nodes SET kind = 'next' WHERE kind = 'keyword';`,
];

type Row = { id: number; parent_id: number | null; kind: Kind; text: string; chosen: number; created_at: number; deleted_at: number | null; url: string | null; data: string | null };
const toNode = (r: Row): Node => ({
  id: r.id,
  parentId: r.parent_id,
  kind: r.kind,
  text: r.text,
  chosen: r.chosen === 1,
  createdAt: r.created_at,
  deletedAt: r.deleted_at ?? null,
  url: r.url ?? null,
  data: r.data ? JSON.parse(r.data) : null,
});

export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.run(MIGRATIONS[v]!);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }

  const insert = db.query(
    "INSERT INTO nodes (parent_id, kind, text, chosen, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
  );
  const byId = db.query("SELECT * FROM nodes WHERE id = ?");
  const children = db.query("SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id");
  // 消した物は印（消した時刻）を付けて残す。一覧・木には出さないが、分けた木の文脈はたどれる
  const subtree = `WITH RECURSIVE t(id) AS (SELECT id FROM nodes WHERE id = ?1
       UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id)`;

  const get = (id: number): Node | null => {
    const r = byId.get(id) as Row | null;
    return r ? toNode(r) : null;
  };

  return {
    add(parentId: number | null, kind: Kind, text: string, chosen = false): Node {
      return toNode(insert.get(parentId, kind, text, chosen ? 1 : 0, Date.now()) as Row);
    },
    get,
    children(parentId: number): Node[] {
      return (children.all(parentId) as Row[]).map(toNode);
    },
    // 根から id までの道（祖先の一言を、根 → 今の節の順に）
    path(id: number): Node[] {
      const out: Node[] = [];
      for (let n = get(id); n; n = n.parentId === null ? null : get(n.parentId)) out.unshift(n);
      return out;
    },
    // 兄弟のうち 1 つを選ぶと、残りは「選ばなかった」として残る
    choose(id: number): Node | null {
      const n = get(id);
      if (!n) return null;
      db.query("UPDATE nodes SET chosen = 1 WHERE id = ?").run(id);
      return get(id);
    },
    // 根から下の木を全部（画面用）
    tree(rootId: number): Node[] {
      const rows = db
        .query(
          `WITH RECURSIVE t(id) AS (SELECT id FROM nodes WHERE id = ?1 AND deleted_at IS NULL
             UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id WHERE n.deleted_at IS NULL)
           SELECT * FROM nodes WHERE id IN (SELECT id FROM t) ORDER BY id`,
        )
        .all(rootId) as Row[];
      return rows.map(toNode);
    },
    all(): Node[] {
      return (db.query("SELECT * FROM nodes WHERE deleted_at IS NULL ORDER BY id").all() as Row[]).map(toNode);
    },
    // 返事（reply）にぶら下がる次の一手。前の分は消さない
    addNext(replyId: number, texts: string[]): Node[] {
      return db.transaction(() => texts.map((t) => toNode(insert.get(replyId, "next", t, 0, Date.now()) as Row)))();
    },
    // 生きている根の名前だけ変える
    rename(id: number, text: string): Node | null {
      const n = get(id);
      if (!n || n.parentId !== null || n.deletedAt !== null || n.kind !== "user") return null;
      db.query("UPDATE nodes SET text = ? WHERE id = ?").run(text, id);
      return get(id);
    },
    // その節と下の枝を消す。まだ消していない物にだけ、同じ時刻の印を付ける
    remove(id: number): Node | null {
      const n = get(id);
      if (!n || n.deletedAt !== null) return null;
      db.query(`${subtree} UPDATE nodes SET deleted_at = ?2 WHERE id IN (SELECT id FROM t) AND deleted_at IS NULL`).run(id, Date.now());
      return get(id);
    },
    // 消した時と同じ印の物だけ戻す（その前に別で消した枝は戻さない）
    restore(id: number): Node | null {
      const n = get(id);
      if (!n || n.deletedAt === null) return null;
      db.query(`${subtree} UPDATE nodes SET deleted_at = NULL WHERE id IN (SELECT id FROM t) AND deleted_at = ?2`).run(id, n.deletedAt);
      return get(id);
    },
    // session の履歴。生きている根の子だけ。最後の visit と同じ url は足さない（間に別の url があれば足す）
    visit(rootId: number, url: string, title: string): Node | null {
      const root = get(rootId);
      if (!root || root.parentId !== null || root.deletedAt !== null) return null;
      let u: URL;
      try { u = new URL(url); } catch { return null; }
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      const last = this.children(rootId).filter((c) => c.kind === "visit").at(-1);
      if (last?.url === u.href) return null;
      const text = (title.trim() || u.host).slice(0, 120);
      return toNode(db.query("INSERT INTO nodes (parent_id, kind, text, chosen, created_at, url) VALUES (?, 'visit', ?, 0, ?, ?) RETURNING *").get(rootId, text, Date.now(), u.href) as Row);
    },
    // その根の visit を新しい順に limit 件（既定 20）。根が無い・消えていれば空
    history(rootId: number, limit = 20): Node[] {
      const root = get(rootId);
      if (!root || root.parentId !== null || root.deletedAt !== null) return [];
      const n = Math.floor(Number(limit));
      if (!Number.isFinite(n) || n <= 0) return [];
      return this.children(rootId).filter((c) => c.kind === "visit").slice(-n).reverse();
    },
    // 節にタブを足す（http(s) だけ。同じ URL は重ねない）
    addTabs(id: number, tabs: { title: string; url: string }[]): Node[] {
      const have = new Set(this.children(id).filter((c) => c.kind === "tab").map((c) => c.url));
      const q = db.query("INSERT INTO nodes (parent_id, kind, text, chosen, created_at, url) VALUES (?, 'tab', ?, 0, ?, ?) RETURNING *");
      const out: Node[] = [];
      db.transaction(() => {
        for (const t of tabs) {
          let u: URL;
          try { u = new URL(t.url); } catch { continue; }
          if (!/^https?:$/.test(u.protocol) || have.has(u.href)) continue;
          have.add(u.href);
          out.push(toNode(q.get(id, (t.title || u.host).slice(0, 120), Date.now(), u.href) as Row));
        }
      })();
      return out;
    },
    // 部品（表・グラフ・todo・役割）を節の下に足す / 中身を置き換える
    addComponent(id: number, title: string, data: unknown): Node {
      return toNode(db.query("INSERT INTO nodes (parent_id, kind, text, chosen, created_at, data) VALUES (?, 'component', ?, 0, ?, ?) RETURNING *").get(id, title, Date.now(), JSON.stringify(data)) as Row);
    },
    setData(id: number, data: unknown): Node | null {
      db.query("UPDATE nodes SET data = ? WHERE id = ? AND kind = 'component'").run(JSON.stringify(data), id);
      return get(id);
    },
    // その節の todo（いちばん新しい物）
    todoOf(id: number): Node | null {
      return this.children(id).filter((c) => c.kind === "component" && (c.data as { type?: string } | null)?.type === "todo").at(-1) ?? null;
    },
    roots(): Node[] {
      return (db.query("SELECT * FROM nodes WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY id DESC").all() as Row[]).map(toNode);
    },
    close: () => db.close(),
  };
}
export type Store = ReturnType<typeof openStore>;
