// W41b: desktop op 段 3（URL scheme は open -g だけ・App Intents は openAppWhenRun:false だけ・どちらも起動済みの app だけ）と段 4（file・閉じた app にも届く）。正本 docs/BRIEF-w41.md の続き / docs/design-desktop-ops.md。読む file: "src/mods.ts" "src/lease.ts"
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mktmp } from "./tmp.ts";
import { makeLeases } from "../src/lease.ts";
import { APP_OPS, intentGate, urlGate } from "../src/mods.ts";

let top: string, home: string, vault: string, up: boolean, osaLog: string[], opened: string[], intents: { w: string; input: string }[];
const osa = async (s: string) => { osaLog.push(s); return { ok: true, text: /is running$/.test(s) ? String(up) : "" }; };
const mk = () => makeLeases(join(top, "lease"), { defaultMode: "ask", approvalMs: 5000, osa, home, openUrl: async (u) => { opened.push(u); return { ok: true, text: "渡しました" }; }, intent: async (w, input) => { intents.push({ w, input }); return { ok: true, text: "{}" }; } });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const card = async (L: ReturnType<typeof mk>) => { for (let i = 0; i < 300 && !L.approvals().length; i++) await tick(); return L.approvals()[0]!; };
const allow = async (L: ReturnType<typeof mk>, p: Promise<unknown>) => { const a = await card(L); L.answer(a.id, true); return { a, r: await p }; };

beforeEach(() => {
  top = mktmp("w41b"); mkdirSync(join(top, "lease"));
  home = join(top, "home"); vault = join(top, "vaults/MyVault"); mkdirSync(vault, { recursive: true }); mkdirSync(join(vault, "daily")); mkdirSync(join(home, "Library/Application Support/obsidian"), { recursive: true });
  writeFileSync(join(home, "Library/Application Support/obsidian/obsidian.json"), JSON.stringify({ vaults: { a1: { path: vault, ts: 1 } } }));
  up = false; osaLog = []; opened = []; intents = [];
});
afterEach(() => rmSync(top, { recursive: true, force: true }));

test("W41b-1 段 4 read: app が閉じていても vault の名前が読める・read も card（review26）・osa は 1 本も打たない", async () => {
  const L = mk();
  const { a, r } = await allow(L, L.opRun("s:1", "Obsidian", "list-vaults", {}));
  expect(a).toMatchObject({ tool: "op_read" });
  expect(JSON.parse((r as any).text)).toMatchObject({ via: "file", result: '["MyVault"]' });
  expect(osaLog).toEqual([]);
});

test("W41b-2 段 4 write: 閉じた app にも届くが毎回 card（書く path を見せる）。許す前は file が増えない・許すと末尾に足す（上書きしない）", async () => {
  const L = mk();
  writeFileSync(join(vault, "daily/a.md"), "first");
  const p = L.opRun("s:1", "Obsidian", "append-to-note", { vault: "MyVault", file: "daily/a.md", text: "二行目\n三行目" });
  const a = await card(L);
  expect(a).toMatchObject({ tool: "op_write", danger: true });
  expect(a.note).toContain(join(vault, "daily/a.md"));
  await tick(30);
  expect(readFileSync(join(vault, "daily/a.md"), "utf8")).toBe("first");
  L.answer(a.id, true);
  expect(await p).toMatchObject({ ok: true });
  expect(readFileSync(join(vault, "daily/a.md"), "utf8")).toBe("first\n二行目\n三行目\n");
  const q = L.opRun("s:1", "Obsidian", "append-to-note", { vault: "MyVault", file: "daily/a.md", text: "x" });
  L.answer((await card(L)).id, false);
  expect(await q).toMatchObject({ ok: false, why: "denied" });
  expect(readFileSync(join(vault, "daily/a.md"), "utf8")).toBe("first\n二行目\n三行目\n");
});

test("W41b-3 段 4 の path は vault の中だけ: .. ・絶対 path・隠し folder・.md 以外・知らない vault・vault の外を指す symlink は card の前に断る", async () => {
  const L = mk();
  mkdirSync(join(top, "outside")); symlinkSync(join(top, "outside"), join(vault, "link"));
  for (const file of ["../x.md", "/etc/x.md", ".obsidian/x.md", "daily/a.txt", "daily/../../x.md", "link/x.md", "nofolder/a.md", "daily//a.md"]) {
    expect(await L.opRun("s:1", "Obsidian", "append-to-note", { vault: "MyVault", file, text: "x" }), file).toMatchObject({ ok: false, why: "tool" });
  }
  expect(await L.opRun("s:1", "Obsidian", "append-to-note", { vault: "Other", file: "a.md", text: "x" })).toMatchObject({ ok: false, why: "tool" });
  expect(L.approvals()).toEqual([]);
  expect(existsSync(join(top, "outside/x.md"))).toBe(false);
});

test("W41b-4 段 3 URL scheme: 起動済みの時だけ open -g で渡す・未起動は断る（open を打たない）・write は毎回 card に URL を出す", async () => {
  const L = mk();
  expect(await L.opRun("s:1", "Obsidian", "open-note", { vault: "MyVault", file: "a b.md" })).toMatchObject({ ok: false, why: "surface" });
  expect(opened).toEqual([]);
  expect(L.approvals()).toEqual([]);
  up = true;
  const { a, r } = await allow(L, L.opRun("s:1", "Obsidian", "open-note", { vault: "MyVault", file: "a b.md" }));
  expect(a.note).toContain("obsidian://open?vault=MyVault&file=a%20b.md");
  expect(r).toMatchObject({ ok: true });
  expect(opened).toEqual(["obsidian://open?vault=MyVault&file=a%20b.md"]);
  expect(urlGate("obsidian://open?x=1 2", "obsidian")).not.toBeNull();
  expect(urlGate("https://evil/", "obsidian")).not.toBeNull();
  expect(urlGate('obsidian://open?x="', "obsidian")).not.toBeNull();
});

test("W41b-5 段 3 App Intents: openAppWhenRun:false の action だけ（true・無い・読めないは断る）・起動済みだけ・card 後に wrapper を呼ぶ", async () => {
  const app = join(top, "Fake.app"); mkdirSync(join(app, "Contents/Resources/Metadata.appintents"), { recursive: true });
  writeFileSync(join(app, "Contents/Resources/Metadata.appintents/extract.actionsdata"), JSON.stringify({ actions: { Bg: { openAppWhenRun: false }, Fg: { openAppWhenRun: true } } }));
  expect(intentGate(app, "Bg")).toBeNull();
  expect(intentGate(app, "Fg")).toContain("窓を出す");
  expect(intentGate(app, "Nope")).toContain("ありません");
  expect(intentGate(join(top, "none"), "Bg")).toContain("読めません");
  // 実物の Notes: CreateNote は窓なし・OpenNote は窓を出す宣言（この Mac に Notes が在る時だけ）
  if (existsSync("/System/Applications/Notes.app")) { expect(intentGate("/System/Applications/Notes.app", "CreateNoteLinkAction")).toBeNull(); expect(intentGate("/System/Applications/Notes.app", "OpenNoteLinkAction")).not.toBeNull(); }
  const L = mk();
  const op = APP_OPS.find((o) => o.app === "Notes" && o.name === "create-note")!;
  expect(op).toMatchObject({ via: "intent", permission: "write" });
  up = false;
  if (existsSync("/System/Applications/Notes.app")) {
    expect(await L.opRun("s:1", "Notes", "create-note", { name: "t", contents: "c" })).toMatchObject({ ok: false, why: "surface" });
    expect(intents).toEqual([]);
    up = true;
    const { a, r } = await allow(L, L.opRun("s:1", "Notes", "create-note", { name: "t", contents: "c\nd" }));
    expect(a.note).toContain("CreateNoteLinkAction");
    expect(r).toMatchObject({ ok: true });
    expect(intents).toEqual([{ w: "kangae-CreateNoteLinkAction", input: JSON.stringify({ name: "t", contents: "c\nd" }) }]);
  }
});

test("W41b-6 窓を出す action の op は表に置けない: 表の intent op は全部 gate を通る（表の腐りを検出）", () => {
  for (const o of APP_OPS.filter((x) => x.via === "intent")) if (existsSync(o.intent!.appPath)) expect(intentGate(o.intent!.appPath, o.intent!.action), o.name).toBeNull();
});

test("W41b-7 agent への案内に op の入口（Terminal・Obsidian・Notes）がある（allowedTools の op:* だけで案内が無いと使われない）", () => {
  const main = readFileSync("src/main.ts", "utf8");
  for (const w of ["op Terminal read-front-tab", "op Terminal run-in-front-tab", "op Obsidian list-vaults", "append-to-note", "op Notes create-note"]) expect(main.includes(w), w).toBe(true);
});
