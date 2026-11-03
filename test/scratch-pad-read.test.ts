import { expect, test } from "bun:test";
import type { Driver } from "../src/lease.ts";
import { readPadText } from "../tools/scratch-pad.ts";

const drv = (state: (n: number) => any, win: any): Driver => { let n = 0; return { close() {}, async call(tool) { if (tool === "list_windows") return { text: "", isError: false, data: { windows: [win] } }; return { text: "", isError: false, data: state(n++) }; } }; };

test("読めたら TextArea の値", async () => {
  expect(await readPadText(drv((n) => ({ elements: n ? [{ role: "AXTextArea", value: "一二三" }] : [] }), {}), 1, 7, 10_000)).toBe("一二三");
});

test("読めない時は要素数・role・窓の Space の原文が理由に出る（別 Space の窓は要素 0）", async () => {
  const e = await readPadText(drv(() => ({ elements: [] }), { window_id: 7, on_current_space: false, space_ids: [3] }), 1, 7, 1).catch((x) => String(x));
  expect(e).toContain("要素 0 件");
  expect(e).toContain('"on_current_space":false');
});
