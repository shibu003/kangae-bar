// W21 ④: 「別の Space の窓を読む許可がありません」の案内は、実際に読もうとして許可が無くて読めなかった時だけ最初の画面に出す。読む file を literal で名指す: "src/first-run.ts" "src/lease.ts"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("W21-4 許可の案内は、別の Space の窓を実際に読もうとして断られた時だけ（要らない人・web だけの会話に「あなたの番です」を出さない）", () => {
  const fr = readFileSync("src/first-run.ts", "utf8");
  expect(fr.includes("if (i.ax === false && i.axWanted) out.push(")).toBe(true);
  expect(fr.includes("axWanted: axWanted()")).toBe(true);
  expect(readFileSync("src/lease.ts", "utf8").includes("axWantedAt = Date.now()")).toBe(true);
});
