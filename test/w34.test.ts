// W34 案 A: 登録した場所（~/Downloads などの保護 folder）の最初の読みを、人が居る「登録の瞬間と常駐の起動」に出す。agent の途中（open_app の stat）で OS の確認を出さない
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCmd, touchCmdDirs } from "../src/cmds.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

const src = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
const setup = () => {
  const top = realpathSync(mktmp("w34"));
  const ui = join(top, "ui"), proj = join(top, "proj"), tool = join(top, "tool");
  for (const d of [ui, proj, tool]) mkdirSync(d);
  for (const [n, d] of [["build", proj], ["b2", tool], ["b3", proj]] as const) { const r = addCmd(ui, n, d, ["/bin/echo", "x"], 60, Date.now()); if (!r.ok) throw new Error(r.hint); } // 同じ場所は 1 回
  return { ui, proj, tool };
};

test("W34 touchCmdDirs: 登録した場所（cwd）を 1 回ずつ開く（重複なし）・読めない場所があっても残りは開く", async () => {
  const { ui, proj, tool } = setup();
  const seen: string[] = [];
  const dirs = await touchCmdDirs(ui, async (d) => { seen.push(d); if (d === proj) throw new Error("EPERM"); });
  expect(dirs.sort()).toEqual([proj, tool].sort());
  expect(seen.sort()).toEqual([proj, tool].sort());
  expect(await touchCmdDirs(join(ui, "無い"), async () => { throw new Error("呼ばれない"); })).toEqual([]); // 登録が無ければ何も開かない
});

test("W34 実物の readdir: 実在の場所を開ける（既定の読みで throw しない）", async () => {
  const { ui, proj, tool } = setup();
  expect((await touchCmdDirs(ui)).sort()).toEqual([proj, tool].sort());
});

test("W34 常駐: touchCmds の op は答えを待たずに返す・起動時と cmd-add の 2 か所から呼ぶ・cmd-add は常駐が居なければ起こさない", async () => {
  const { ui } = setup();
  const h = makeHandler(openStore(":memory:"), async () => [], undefined, undefined, { uiHome: ui });
  expect(await h({ op: "touchCmds" })).toMatchObject({ ok: true, dirs: 3 });
  const start = src.slice(src.indexOf("export async function startDaemon"), src.indexOf("export async function startDaemon") + 300);
  expect(start).toContain("touchCmdDirs(home)");
  const at = src.indexOf("const sockPath = socketPath(), up = await alive(sockPath)"), add = src.slice(at, at + 900);
  expect(add).toContain('op: "touchCmds"');
  expect(add).not.toContain("connectOrStart"); // 常駐を人の terminal の下で起こすと、許可が terminal に付く
  expect(add).toContain("Kangae がまだ動いていません"); // W12-10: 人に出る文に『常駐』を使わない
});
