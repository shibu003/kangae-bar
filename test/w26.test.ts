// W26: agent の作業場所の既定を ~/Documents（macOS の TCC の対象）から ~/Library/…/Kangae/nodes へ。常駐の起動時に 1 回・冪等で移す（rename だけ・旧には symlink を残す）。試験は temp の home だけ（owner の home に触らない）。読む file を literal で名指す: "src/paths.ts" "src/main.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgents } from "../src/agents.ts";
import { migrateNodesDir, nodesDefault, OLD_NODES, ownerDirs, pointsAtOwner, resolvePath } from "../src/paths.ts";

let H: string, old: string, neu: string;
beforeEach(() => { H = realpathSync(mktmp("w26")); old = OLD_NODES(H); neu = nodesDefault(H); });
afterEach(() => rmSync(H, { recursive: true, force: true }));
const isLink = (p: string) => lstatSync(p).isSymbolicLink();

test("W26-1 旧が実の folder: 新へ rename・旧は新を指す symlink に・中身はそのまま（コピーも削除も無い）・2 回目は何もしない", () => {
  mkdirSync(join(old, "1 agent A"), { recursive: true });
  writeFileSync(join(old, "1 agent A", "AGENTS.md"), "メモ");
  const ino = lstatSync(old).ino;
  expect(migrateNodesDir(H, {})).toBe("moved");
  expect(lstatSync(neu).ino).toBe(ino); // 同じ folder が動いただけ（rename）
  expect(isLink(old)).toBe(true);
  expect(readlinkSync(old)).toBe(neu);
  expect(readFileSync(join(old, "1 agent A", "AGENTS.md"), "utf8")).toBe("メモ"); // 旧 path 越しにも読める
  expect(readFileSync(join(neu, "1 agent A", "AGENTS.md"), "utf8")).toBe("メモ");
  expect(migrateNodesDir(H, {})).toBe("exists"); // 冪等
  expect(isLink(old)).toBe(true);
  expect(readlinkSync(old)).toBe(neu);
});

test("W26-2 新が既に在る: 何も触らない（旧が実の folder のままでも・中身が別でも）", () => {
  mkdirSync(neu, { recursive: true }); writeFileSync(join(neu, "mine"), "新");
  mkdirSync(old, { recursive: true }); writeFileSync(join(old, "theirs"), "旧");
  expect(migrateNodesDir(H, {})).toBe("exists");
  expect(isLink(old)).toBe(false);
  expect(existsSync(join(old, "theirs"))).toBe(true);
  expect(existsSync(join(neu, "mine"))).toBe(true);
  expect(existsSync(join(neu, "theirs"))).toBe(false);
});

test("W26-3 旧が無い: 新を作るだけ（旧の場所に何も作らない）", () => {
  expect(migrateNodesDir(H, {})).toBe("created");
  expect(lstatSync(neu).isDirectory()).toBe(true);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(join(H, "Documents"))).toBe(false); // ~/Documents に触れない
});

test("W26-4 旧が別の場所への symlink（人が自分で置いた）: 触らず、新を作るだけ", () => {
  const elsewhere = join(H, "mine"); mkdirSync(elsewhere); mkdirSync(join(H, "Documents"));
  symlinkSync(elsewhere, old);
  expect(migrateNodesDir(H, {})).toBe("created");
  expect(readlinkSync(old)).toBe(elsewhere);
  expect(existsSync(neu)).toBe(true);
});

test("W26-5 KANGAE_NODES_DIR が指定されていれば何も触らない・試験（NODE_ENV=test）は home を渡さない限り何もしない（owner の home を守る）", () => {
  mkdirSync(old, { recursive: true });
  expect(migrateNodesDir(H, { KANGAE_NODES_DIR: join(H, "x") })).toBe("skipped");
  expect(isLink(old)).toBe(false);
  expect(existsSync(neu)).toBe(false);
  // 本物の home を引かない守りの検査。守り（NODE_ENV=test なら何もしない）を外した負の対照を回しても、この呼びが owner の home に届かないよう、
  // HOME を temp にしてから呼ぶ（os.homedir() は HOME を読む）。2026-10-09: 守りを外す負の対照が、home 未指定のこの呼びで実の ~/Documents/考えの空 を rename した
  const savedHome = process.env.HOME;
  process.env.HOME = H;
  try {
    mkdirSync(old, { recursive: true });
    expect(migrateNodesDir(undefined, { NODE_ENV: "test" })).toBe("skipped");
    expect(isLink(old)).toBe(false);
    expect(existsSync(neu)).toBe(false);
  } finally { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; }
});

test("W26-6 rename した後に symlink が置けなかったら rename を戻す（旧が消えた状態を残さない・中身は元の場所に）", () => {
  mkdirSync(join(old, "x"), { recursive: true }); writeFileSync(join(old, "x", "f"), "中身");
  const ino = lstatSync(old).ino;
  expect(migrateNodesDir(H, {}, () => { throw new Error("EPERM"); })).toBe("skipped");
  expect(isLink(old)).toBe(false);
  expect(lstatSync(old).ino).toBe(ino); // 元の folder がそのまま戻った
  expect(readFileSync(join(old, "x", "f"), "utf8")).toBe("中身");
  expect(existsSync(neu)).toBe(false);
  expect(migrateNodesDir(H, {})).toBe("moved"); // 次の起動でやり直せる
});

test("W26-7 既定の作業場所は TCC の外（~/Library/…/Kangae/nodes）・owner の場所の表に入っている（試験が本物に触れない守りが効く）", () => {
  expect(nodesDefault(H)).toBe(join(H, "Library", "Application Support" + "/Kangae", "nodes"));
  expect(nodesDefault(H).includes("/Documents/")).toBe(false);
  expect(ownerDirs(H)).toContain(nodesDefault(H));
  expect(pointsAtOwner(nodesDefault(H), H)).toBe(true);
  expect(() => resolvePath("KANGAE_NODES_DIR", () => nodesDefault(H), { NODE_ENV: "test" }, H)).toThrow("owner の場所を指す");
  expect(readFileSync("src/main.ts", "utf8").includes('resolvePath("KANGAE_NODES_DIR", () => nodesDefault())')).toBe(true);
});

test("W26-8 移した時だけ、覚えている sessionId を捨てる（cwd の path が替わると claude --resume が続きを見つけられない）。名前と記憶は残る", () => {
  const home = join(H, "kangae-home"); mkdirSync(home);
  const a = makeAgents(home);
  a.write({ name: "agentA", nodeId: 1, sessionId: "s-1", startedAt: 1, updatedAt: 1 } as any);
  a.write({ name: "agentB", nodeId: 2, startedAt: 1, updatedAt: 1 } as any);
  a.forgetSessions();
  expect(a.read("agentA")).toMatchObject({ name: "agentA", nodeId: 1 });
  expect(a.read("agentA")!.sessionId).toBeUndefined();
  expect(a.read("agentB")).toMatchObject({ name: "agentB", nodeId: 2 });
  const main = readFileSync("src/main.ts", "utf8");
  expect(main.includes('if (migrateNodesDir() === "moved") makeAgents(home).forgetSessions();')).toBe(true);
});
