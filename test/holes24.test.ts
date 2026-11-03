// holes-24: agent への説明に「頁を読むには面（tab）を頼む」があり、curl / Bash の許可を人に頼ませない
import { expect, test } from "bun:test";
import { CARD_RULE } from "../src/main.ts";

test("CARD_RULE: 面を頼む文があり、curl の許可は頼まない旨がある", () => {
  expect(CARD_RULE).toContain("その頁の tab を渡してください");
  expect(CARD_RULE).toMatch(/curl や Bash の許可は人にも出せない/);
  expect(CARD_RULE).not.toMatch(/curl[^。]*許可をもらえ/);
});
