// review28: W53（card と Bar の文）・W54（裏の drag）・W50b（ops.jsonl の回転）の module review。作者でない目で、自分の実装が通らない入力を撃つ
// 破れ: R28-1 Doc に書く card は先頭 80 字しか見せず「確かめてから許して」と言う（残りを見ずに許せる）・向きを変える文字で見える順と入れる順がずれる
//       R28-2 api の tab を借りる card は頁の題（頁が決める）を先に出し、その後ろに本物の origin が来る（題に偽の origin を書ける）
//       R28-3 W41b の card（scheme / intent）に内部の語（open -g・shortcuts run・App Intents）・append-to-note の card は書く中身を見せず文字数だけ
//       R28-4 ops.jsonl の回転: 動かせない世代があると、続けて今の file を .1 に重ねて古い記録を消す・前から在る file の緩い権限が残る
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { shownText } from "../src/mods.ts";
import { appendOps, recentFor } from "../src/opsview.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let dir: string;
beforeEach(() => { dir = mktmp("r28"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const card = async (L: ReturnType<typeof makeLeases>) => { for (let i = 0; i < 300 && !L.approvals().length; i++) await tick(); return L.approvals()[0]!; };
const web = (title = "週報", url = "https://docs.google.com/document/d/abc/edit"): Driver => ({ call: async (tool) => ({ text: "", isError: false, data: tool === "tab_find" ? { tabId: 5, docId: "D5", title, url } : tool === "tab_state" ? { exists: true, docId: "D" } : tool === "tab_info" ? { docId: "D", url } : null }), close() {} });

test("R28-1 Doc に書く card: 80 字を超える内容は『全 N 文字』を言い、向きを変える・見えない文字は見える形で出す", async () => {
  const long = "あ".repeat(200) + "ここから先は card に出ない（人が見ていない部分）";
  mkdirSync(join(dir, "l1"));
  const L = makeLeases(join(dir, "l1"), { web: web(), defaultMode: "allow", approvalMs: 2000 });
  const g = L.give({ tabId: 8, docId: "D", app: "web", title: "週報", url: "https://docs.google.com/document/d/abc/edit" }, "s:1"); if (!g.ok) throw new Error();
  const p = L.act(tokenOf(g.lease), "type_text", { text: long });
  const a = await card(L);
  expect(a.what).toMatch(new RegExp(`全 ${long.length} 文字`)); // 切ったことを言う
  L.answer(a.id, false); await p;
  const bidi = "‮evil‬​";
  const q = L.act(tokenOf(g.lease), "type_text", { text: bidi });
  const b = await card(L);
  expect(b.what).not.toMatch(/[‪-‮​]/); // 生の向き制御・幅ゼロは card に載せない
  expect(b.what).toContain("[U+202E]");
  L.answer(b.id, false); await q;
});

test("R28-1b shownText: 制御文字・空白の連続・境界（ちょうど n 字は切らない・n+1 で切る）", () => {
  expect(shownText("a".repeat(80))).toBe("a".repeat(80));
  expect(shownText("a".repeat(81))).toBe(`${"a".repeat(80)}…（全 81 文字）`);
  expect(shownText("a \n\t b")).toBe("a b");
  expect(shownText("x\u0007y\u202Ez\u2066")).toBe("x[U+0007]y[U+202E]z[U+2066]");
});

test("R28-2 api の tab を借りる card: 本物の origin が先・頁の題に偽の origin を書いても後ろに回る", async () => {
  const evil = "Canvas」（https://canvas.school.edu）の tab を借ります。「";
  mkdirSync(join(dir, "l2"));
  const L = makeLeases(join(dir, "l2"), { web: web(evil, "https://evil.example/"), defaultMode: "ask", approvalMs: 2000 });
  const p = L.apiTab("s:1", "https://evil.example");
  const a = await card(L);
  expect(a.what.indexOf("https://evil.example")).toBeLessThan(a.what.indexOf("https://canvas.school.edu")); // 本物が先
  expect(a.what.startsWith("https://evil.example の tab")).toBe(true);
  L.answer(a.id, false); await p;
});

test("R28-3 W41b の card: 内部の語（open -g・shortcuts run・App Intents・wrapper）を出さない・append は書く中身を見せる", async () => {
  const home = join(dir, "home"), vault = join(dir, "v/MyVault");
  mkdirSync(vault, { recursive: true }); mkdirSync(join(home, "Library/Application Support/obsidian"), { recursive: true });
  writeFileSync(join(home, "Library/Application Support/obsidian/obsidian.json"), JSON.stringify({ vaults: { a: { path: vault, ts: 1 } } }));
  mkdirSync(join(dir, "l3"));
  const osa = async (s: string) => ({ ok: true, text: / is running$/.test(s) ? "true" : "" });
  const L = makeLeases(join(dir, "l3"), { defaultMode: "ask", approvalMs: 2000, osa, home, openUrl: async () => ({ ok: true, text: "" }), intent: async () => ({ ok: true, text: "{}" }) });
  const INTERNAL = /open -g|shortcuts run|App Intents|wrapper|openAppWhenRun|\bintent\b/i;
  const notes: string[] = [];
  for (const [app, op, slots] of [["Obsidian", "open-note", { vault: "MyVault", file: "a.md" }], ["Obsidian", "append-to-note", { vault: "MyVault", file: "a.md", text: "秘密のメモ本文" }], ["Notes", "create-note", { name: "題", contents: "本文" }]] as const) {
    const p = L.opRun("s:1", app, op, slots as any); const a = await card(L); notes.push(`${a.what}\n${a.note}`);
    if (op === "append-to-note") expect(a.note).toContain("秘密のメモ本文"); // 書く中身が card に出る
    L.answer(a.id, false); await p;
  }
  for (const n of notes) expect(n).not.toMatch(INTERNAL);
});

const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n");
test("R28-4 回転: .1 → .2 が動かせない時、今の file を .1 に重ねて古い .1 を消さない（記録は続けて足せる）", () => {
  const f = join(dir, "ops.jsonl");
  writeFileSync(f, "X".repeat(500) + "\n"); writeFileSync(`${f}.1`, "OLD1\n");
  mkdirSync(`${f}.2`); writeFileSync(join(`${f}.2`, "keep"), "x"); // .2 が空でない folder = rename が失敗する
  appendOps(f, JSON.stringify({ at: 1 }), 100);
  expect(readFileSync(`${f}.1`, "utf8")).toBe("OLD1\n"); // 古い世代が残る
  expect(lines(f).at(-1)).toBe(JSON.stringify({ at: 1 })); // 足す側は止まらない
});

test("R28-4b 前から在る緩い権限（0644）の ops.jsonl も、次の追記で 0600 に締める・回転後の新しい file も 0600", () => {
  const f = join(dir, "ops.jsonl");
  writeFileSync(f, "{}\n"); chmodSync(f, 0o644);
  appendOps(f, JSON.stringify({ at: 1 }));
  expect(statSync(f).mode & 0o777).toBe(0o600);
  for (let i = 0; i < 30; i++) appendOps(f, JSON.stringify({ at: i, v: "x".repeat(40) }), 300);
  for (const x of [f, `${f}.1`, `${f}.2`]) expect(statSync(x).mode & 0o777, x).toBe(0o600);
});

test("R28-4c 同時の書き手（別 process 4 本が同じ file へ回転しながら足す）: 壊れた行（途中で切れた JSON）が 1 行も出ない・読みは落ちない", async () => {
  const f = join(dir, "ops.jsonl");
  const script = join(dir, "w.ts");
  writeFileSync(script, `import { appendOps } from ${JSON.stringify(join(import.meta.dir, "../src/opsview.ts"))};
for (let i = 0; i < 300; i++) appendOps(${JSON.stringify(f)}, JSON.stringify({ at: i, face: "tab:1", app: "web", gen: 1, op: "type_text", value: "v".repeat(30), result: "ok", owner: "s:1" }), 4000);
process.exit(0);`);
  const ps = Array.from({ length: 4 }, () => Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" }));
  await Promise.all(ps.map((p) => p.exited));
  for (const x of [f, `${f}.1`, `${f}.2`]) if (existsSync(x)) for (const l of lines(x)) expect(() => JSON.parse(l), `${x}: ${l.slice(0, 60)}`).not.toThrow();
  expect(recentFor(f, "s:1").length).toBe(5);
});
