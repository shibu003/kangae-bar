import { expect, test } from "bun:test";
import { providersFromHits } from "../src/llm.ts";

test("見つかった command だけが provider になる。hermes と openclaw は入り、gemini は入らない", () => {
  const ids = providersFromHits(new Set(["hermes", "openclaw", "gemini", "claude"])).map((p) => p.id);
  expect(ids).toContain("hermes");
  expect(ids).toContain("openclaw");
  expect(ids).toContain("claude");
  expect(ids).not.toContain("gemini");
});
