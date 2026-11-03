// review18: W17a（登録済み command の口）を攻める。cwd の包含・実行 file・承認後の差し替え・出力の置き場
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCmd, argvInside, inside, minimalEnv, overlaps } from "../src/cmds.ts";
import { makeLeases, winDir, type Driver } from "../src/lease.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000); // holes-30: sandbox / process を起こす test は混んだ機械（load 600）で 30 秒を超える＝既定を混み倍率×実測の余裕に

let top: string, ui: string, work: string, proj: string;
const A = { pid: 10, windowId: 1, app: "Zed", title: "" };
const driver = (): Driver => ({ call: async (tool) => ({ text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }), close() {} });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const mk = () => makeLeases(join(top, "lease"), { driver, defaultMode: "allow", approvalMs: 3000 });
const face = (L: ReturnType<typeof mk>, owner = "s:1") => { const g = L.give(A, owner); if (!g.ok) throw new Error(); };
const ctx = () => ({ uiHome: ui, workDir: work });
const reg = (name: string, argv: string[], cwd = proj) => { const r = addCmd(ui, name, cwd, argv); if (!r.ok) throw new Error(r.hint); return r.cmd; };
const ask = async (L: ReturnType<typeof mk>) => { for (let i = 0; i < 200 && !L.approvals().length; i++) await tick(); return L.approvals()[0]!; };

beforeEach(() => {
  top = realpathSync(mktmp("r18"));
  ui = join(top, "ui"); work = join(top, "proj", "work"); proj = join(top, "proj"); // 作業場所は登録された場所の中
  for (const d of [ui, proj, work, join(top, "lease")]) mkdirSync(d);
});
afterEach(() => rmSync(top, { recursive: true, force: true }));

test("W37（user 承認済み）: 登録した場所が作業場所を中に含む（親 folder）でも断られない（card が出て、folder の中身が変わると書く）。断られるのは uiHome と重なる物だけ", async () => {
  const marker = join(proj, "ran");
  reg("build", ["/usr/bin/touch", marker], proj);
  const L = mk(); face(L);
  const p = L.runCmd("s:1", "build", ctx());
  const a = await ask(L);
  expect(a).toMatchObject({ tool: "run_cmd" });
  expect(a.note).toContain("書き換えてから build します");
  L.answer(a.id, false);
  expect(await p).toMatchObject({ ok: false, why: "denied" });
  expect(existsSync(marker)).toBe(false);
});
test("場所が uiHome を含む（home 直下で登録）でも走らない", async () => {
  const L = mk(); face(L);
  reg("build", ["/bin/echo", "x"], top);
  expect(await L.runCmd("s:1", "build", { uiHome: ui, workDir: join(tmpdir(), "elsewhere") })).toMatchObject({ ok: false, why: "tool" });
});
test("大文字小文字を変えた path でも包含を見抜く（macOS）", () => {
  if (process.platform !== "darwin") return;
  expect(inside(work.toUpperCase(), work)).toBe(true);
  expect(overlaps(proj.toUpperCase(), work)).toBe(true);
});
test("argv に uiHome の中の絶対 path の file（--opt=/path の形も）があれば走らない（W37・user 承認済み: 作業場所の中の path は seatbelt が守るので断らない）", async () => {
  const other = join(top, "other"); mkdirSync(other);
  writeFileSync(join(work, "x.sh"), "echo pwned > " + join(other, "p"));
  for (const argv of [["/bin/sh", join(ui, "commands.json")], ["/bin/sh", `--rcfile=${join(ui, "commands.json")}`]]) {
    reg("build", argv, other);
    const L = mk(); face(L);
    expect(await L.runCmd("s:1", "build", ctx())).toMatchObject({ ok: false, why: "tool" });
  }
  expect(existsSync(join(other, "p"))).toBe(false);
  expect(argvInside(["/bin/echo", "/etc/hosts"], work, ui)).toBe(false);
  expect(argvInside(["/bin/sh", join(work, "x.sh")], ui)).toBe(false); // 作業場所の中は uiHome ではない
});
test("承認を待つ間に、場所が uiHome への symlink に差し替わったら走らない", async () => {
  const other = join(top, "other"); mkdirSync(other);
  const marker = join(top, "ran");
  reg("build", ["/usr/bin/touch", marker], other);
  const L = mk(); face(L);
  const p = L.runCmd("s:1", "build", ctx());
  const a = await ask(L);
  rmSync(other, { recursive: true }); symlinkSync(ui, other);
  L.answer(a.id, true);
  expect(await p).toMatchObject({ ok: false, why: "tool" });
  expect(existsSync(marker)).toBe(false);
});
test("承認を待つ間に、登録が外されても（同じ名前で行だけ替えても）走らない", async () => {
  const other = join(top, "other"); mkdirSync(other);
  const marker = join(other, "ran");
  reg("build", ["/bin/echo", "ok"], other);
  const L = mk(); face(L);
  const p = L.runCmd("s:1", "build", ctx());
  const a = await ask(L);
  const f = join(ui, "commands.json"), j = JSON.parse(readFileSync(f, "utf8"));
  j.items = [];
  writeFileSync(f, JSON.stringify(j));
  L.answer(a.id, true);
  expect(((await p) as any).ok).toBe(false);
  expect(existsSync(marker)).toBe(false);
});
test("出力の全文は shots ではなく会話ごとの置き場に置かれ、別の会話の置き場とは交わらない。env に KANGAE_* は渡らない", async () => {
  const other = join(top, "other"); mkdirSync(other);
  process.env.KANGAE_OWNER = "s:9"; process.env.KANGAE_LEASE = "tok";
  try { expect(Object.keys(minimalEnv()).some((k) => k.startsWith("KANGAE"))).toBe(false); } finally { delete process.env.KANGAE_OWNER; delete process.env.KANGAE_LEASE; }
  reg("build", ["/bin/echo", "hi"], other);
  const L = mk(); face(L);
  const pr = L.runCmd("s:1", "build", ctx());
  L.answer((await ask(L)).id, true);
  const r: any = await pr;
  expect(r.ok).toBe(true);
  const path = r.text.match(/(\/\S+run-\S+\.txt)/)![1] as string;
  expect(path.startsWith(realpathSync(winDir(ui, "s:1")) + "/")).toBe(true);
  expect(path.startsWith(join(ui, "shots"))).toBe(false);
  expect(winDir(ui, "s:1")).not.toBe(winDir(ui, "s:2"));
});
