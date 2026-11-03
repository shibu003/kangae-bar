// W7m: 古い版の home を新しい版が読めるか。使い方: bun tools/w7m-update.ts <古い版の worktree> [<temp の作業場>]
// 古い版（git worktree add --detach <temp> 3fd473e）の常駐を temp の home で起こして人が作る物を作り → 止め → 同じ home で今の常駐を起こして読む。
// owner の home・bar・Chrome には触らない（HOME ごと temp・KANGAE_* は全部 temp 下）。Chrome は起こさない
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitDaemon } from "../test/spawn-daemon.ts";

const oldDir = resolve(process.argv[2] ?? "");
if (!existsSync(join(oldDir, "src/main.ts"))) throw new Error("古い版の worktree を渡してください");
const base = process.argv[3] ? resolve(process.argv[3]) : mkdtempSync(join(tmpdir(), "kangae-w7m-"));
const fakeHome = join(base, "h");
const home = join(fakeHome, "Library/Application Support/Kangae");
mkdirSync(home, { recursive: true });
const env = { ...process.env, HOME: fakeHome, KANGAE_HOME: home, KANGAE_SOCK: join(base, "k.sock"), KANGAE_BAR: join(base, "bar.json"), KANGAE_NODES_DIR: join(base, "nodes"), KANGAE_MODS: join(base, "mods"), KANGAE_OPEN_CMD: "true", NODE_ENV: "" } as Record<string, string>;
delete env.KANGAE_PARENT_PID;

async function call(op: any): Promise<any> {
  return await new Promise((res, rej) => {
    let buf = "";
    const id = crypto.randomUUID();
    Bun.connect({ unix: env.KANGAE_SOCK!, socket: {
      data: (s, c) => { buf += Buffer.from(c).toString(); for (const l of buf.split("\n")) { try { const m = JSON.parse(l); if (m.id === id) { s.end(); res(m); } } catch {} } },
      error: (_s, e) => rej(e),
    } }).then((s) => s.write(JSON.stringify({ id, ...op }) + "\n"), rej);
  });
}
async function run(dir: string, label: string) {
  const p = Bun.spawn(["bun", join(dir, "src/main.ts"), "--daemon"], { env, stdout: "ignore", stderr: Bun.file(join(base, `${label}.err`)), cwd: dir });
  await waitDaemon(p, { bar: env.KANGAE_BAR, sock: env.KANGAE_SOCK, log: join(base, `${label}.err`), ms: 90_000 });
  return p;
}
const stop = async (p: ReturnType<typeof Bun.spawn>) => { p.kill(); await p.exited; };

// ---- A: 古い版で人が作る物 ----
const out: any = { base };
const a = await run(oldDir, "old");
const r1 = (await call({ op: "add", text: "旅行の計画" })).node;
const r2 = (await call({ op: "add", text: "資料まとめ" })).node;
await call({ op: "note", nodeId: r1.id, text: "京都は 4 月に行く" });
await call({ op: "todo", nodeId: r1.id, action: "add", text: "宿を取る" });
await call({ op: "todo", nodeId: r1.id, action: "add", text: "切符を買う" });
await call({ op: "todo", nodeId: r1.id, action: "done", index: 1 });
await call({ op: "desktopPlace", kind: "session", rootId: r1.id });
await call({ op: "desktopPlace", kind: "session", rootId: r2.id });
await call({ op: "desktopPlace", kind: "tab", url: "https://example.com/a", title: "例" });
await call({ op: "setUi", color: "#3366cc" });
await stop(a);
// 常駐が LLM 無しでは作れない古い形（keyword の枝・結論と次の一手・分けた話題の from_id）は、古い版の DB に古い版の SQL で足す
const db = new Database(join(home, "kangae.db"));
const ins = db.query("INSERT INTO nodes (parent_id, kind, text, chosen, created_at, from_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id");
const id = (...v: any[]) => (ins.get(...v) as any).id as number;
const kw = id(r1.id, "keyword", "宿", 0, Date.now(), null);
id(kw, "keyword", "駅の近く", 0, Date.now(), null);
id(r1.id, "keyword", "予算", 0, Date.now(), null);
const c = id(r1.id, "conclusion", "4 月の京都に 2 泊する", 0, Date.now(), null);
id(c, "step", "宿を比べる", 0, Date.now(), null);
const split = id(null, "user", "宿の話", 1, Date.now(), kw);
id(split, "keyword", "朝食つき", 0, Date.now(), null);
out.oldDb = { version: (db.query("PRAGMA user_version").get() as any).user_version, rows: (db.query("SELECT count(*) n FROM nodes").get() as any).n };
db.close();
writeFileSync(join(home, "leases.json"), JSON.stringify({ floor: { "pid:111:win:222": 3 }, leases: [{ surface: { pid: 111, windowId: 222, app: "Notes", title: "メモ" }, owner: `s:${r1.id}`, exp: Date.now() + 3_600_000 }] }));
out.oldFiles = Object.fromEntries(["leases.json", "desktop.json", "ui"].map((f) => [f, existsSync(join(home, f))]));
out.oldDesktop = readFileSync(join(home, "desktop.json"), "utf8");

// ---- B: 同じ home で今の常駐 ----
const b = await run(resolve(import.meta.dir, ".."), "new");
out.status = await call({ op: "ping" });
out.roots = (await call({ op: "roots" })).roots?.map((r: any) => `${r.id}:${r.text}`);
out.all = (await call({ op: "all" })).nodes?.map((n: any) => `${n.id}<${n.parentId}:${n.kind}:${n.text}`);
out.tree = (await call({ op: "tree", rootId: r1.id }));
out.todo = (await call({ op: "todo", nodeId: r1.id, action: "list" })).text;
out.desktop = (await call({ op: "desktopList" }));
out.ui = (await call({ op: "ui" })).ui;
out.leases = (await call({ op: "leaseList" }));
out.newFiles = Object.fromEntries(["leases.json", "desktop.json", "ui", "carry-prefs.json", "routines.json"].map((f) => [f, existsSync(join(home, f))]));
await stop(b);
out.newErr = readFileSync(join(base, "new.err"), "utf8").slice(-600);
console.log(JSON.stringify(out, null, 1));
process.exit(0);
