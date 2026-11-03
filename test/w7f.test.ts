// W7f: 試験の「JSON を読む呼び出し」が空・途中の返事で EOF の例外になり後ろを巻き込む（run5: SyntaxError: JSON Parse error: Unexpected EOF）事の再発止め。
import { expect, test } from "bun:test";
import { parseJson } from "../docs/verify/wait.ts";

test("空の返事は、呼び出しの名前と長さつきの理由で落ちる（素の EOF ではない）", () => {
  expect(() => parseJson("", "real の bar.json")).toThrow(/real の bar\.json: JSON が読めない（0 byte/);
  expect(() => parseJson('{"port":12', "x")).toThrow(/x: JSON が読めない（10 byte・先頭「\{"port":12」/);
  expect(parseJson('{"a":1}', "x")).toEqual({ a: 1 });
});

test("bar.json は tmp に書いて rename（空の瞬間を見せない）", async () => {
  const src = await Bun.file(`${import.meta.dir}/../src/main.ts`).text();
  expect(src).toMatch(/renameSync\(`\$\{bar\}\.\$\{process\.pid\}\.tmp`, bar\)/);
  expect(src).not.toMatch(/writeFileSync\(bar,/);
});
