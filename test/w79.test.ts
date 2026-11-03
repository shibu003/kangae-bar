// W79（要件 37「閉じている間は icon だけで描画 0・押した時だけ縮小 snapshot・常時 screencast しない」）: 一覧の行は icon だけ。縮小絵を撮りに行くのは人が押した面と認証 card の面だけ。
// 誰も押していない間は、panel が何度見に来ても撮影 0。本物のポインタ・cua のカーソルは使わない（絵は既存の peek の道＝常駐の peek-lite が変わった時だけ撮る）
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { peekKeys } from "../extension/groups.js";

const leases = [{ key: "tab:1" }, { key: "tab:2" }, { key: "app:Zed" }];
const none = { rows: new Set<string>(), open: new Set<string>(), auth: [] as string[] };

test("W79 誰も押していない時は、4 秒ごとに 15 回見に来ても撮りに行く面が 0（渡している面が何本あっても）", () => {
  let shots = 0;
  for (let t = 0; t < 15; t++) shots += peekKeys(leases, none).length;
  expect(shots).toBe(0);
});

test("W79 撮りに行くのは、行の icon を押した面・「拡げる」を押した面・認証 card の面だけ（他の面は撮らない）", () => {
  expect(peekKeys(leases, { ...none, rows: new Set(["tab:2"]) })).toEqual(["tab:2"]);
  expect(peekKeys(leases, { ...none, open: new Set(["app:Zed"]) })).toEqual(["app:Zed"]);
  expect(peekKeys(leases, { ...none, auth: ["tab:1"] })).toEqual(["tab:1"]);
  expect(peekKeys(leases, { rows: new Set(["tab:1"]), open: new Set(["tab:2"]), auth: ["app:Zed"] })).toEqual(["tab:1", "tab:2", "app:Zed"]);
  expect(peekKeys(leases, { ...none, rows: new Set(["tab:99"]) })).toEqual([]); // 渡していない面（もう無い）は撮らない
});

test("W79 panel: peekTick は peekKeys が選んだ面だけを撮る・押した直後に 1 枚撮る・閉じたら古い絵を捨てる・渡している面を無条件に回す形が無い", () => {
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const tick = js.slice(js.indexOf("async function peekTick()"), js.indexOf("function peekEl(key)"));
  expect(tick).toContain("peekKeys(leaseRows ?? [], { rows: rowPeek, open: peekOpen, auth: authKeys })");
  expect(tick).toContain("leaseRows.filter((x) => want.includes(x.key))");
  expect(tick).not.toMatch(/for \(const l of leaseRows\)/);
  expect(js).toMatch(/kg-peek[^\n]*peekLast\[k\] = 0; paintList\(\); peekTick\(\)/); // 押した直後に 1 枚
  expect(js).toMatch(/rowPeek\.delete\(k\); delete peekCache\[k\]/);
  expect(js).toContain("authKeys = (r.auth ?? []).map((c) => c.key);");
  expect(js.match(/call\("peek"/g)!.length).toBe(1); // 撮りに行く口は peekTick の 1 か所だけ
});
