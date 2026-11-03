// W17b: panel の「登録した command」一覧（読むだけ）。daemon の読み出し op と panel の形。読む file を literal で名指す: "extension/panel.js" "extension/panel.html" "src/main.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCmd } from "../src/cmds.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

let top: string, ui: string, proj: string;
beforeEach(() => { top = realpathSync(mktmp("w17b")); ui = join(top, "ui"); proj = join(top, "proj"); mkdirSync(ui); mkdirSync(proj); });
afterEach(() => rmSync(top, { recursive: true, force: true }));
const handler = () => makeHandler(openStore(":memory:"), async () => [], undefined, undefined, { uiHome: ui });

test("W17b 常駐の cmdList: 空は []・登録すると 名前・場所・行・日・ok が出る・書き換えると ok:false。値の読み出しだけで、登録の op は無い", async () => {
  const h = handler();
  expect(await h({ op: "cmdList" })).toMatchObject({ ok: true, items: [] });
  const r = addCmd(ui, "build", proj, ["/bin/echo", "hi"], 600, Date.UTC(2026, 9, 9));
  if (!r.ok) throw new Error(r.hint);
  const one: any = await h({ op: "cmdList" });
  expect(one.items).toEqual([{ name: "build", cwd: proj, line: "/bin/echo hi", at: Date.UTC(2026, 9, 9), network: false, reads: [], app: false, ok: true }]);
  const f = join(ui, "commands.json"), j = JSON.parse(readFileSync(f, "utf8"));
  j.items[0].argv = ["/usr/bin/touch", "x"];
  writeFileSync(f, JSON.stringify(j));
  expect(((await h({ op: "cmdList" })) as any).items[0].ok).toBe(false);
  for (const op of ["cmdAdd", "cmdRm", "cmdSet"]) expect(await h({ op, name: "x", cwd: proj, argv: ["/bin/echo"] } as any)).toMatchObject({ ok: false });
});

test("W17b panel: 欄が在り（html）・一覧は読むだけ（input / form / button を作らない）・0 件は節を隠す・外し方は cmd-rm の行を見せるだけ", () => {
  expect(readFileSync("extension/panel.html", "utf8")).toContain('id="cmds"');
  const js = readFileSync("extension/panel.js", "utf8");
  const a = js.indexOf("async function loadCmds()"), b = js.indexOf("async function loadMods()");
  expect(a).toBeGreaterThan(0);
  const body = js.slice(a, b);
  expect(body).toContain("box.hidden = true"); // W97: 0 件は「まだありません」（節の外）だけで、例は出さない
  expect(body).not.toContain("まだ何も登録していません");
  expect(body).not.toContain("cmd-add");
  expect(body).toContain("kangae cmd-rm ${c.name}");
  expect(body).toContain("登録した日");
  for (const w of ['"input"', '"form"', '"button"', '"textarea"', "call(\"cmd", "onclick", "innerHTML"]) expect(body).not.toContain(w);
  expect(js).toContain("loadCmds();"); // loadLeases から呼ばれる
});
