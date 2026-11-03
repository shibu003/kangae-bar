// holes-26: 試験の fake 実行 file に隔離の印が付いていたら、起こす前に理由つきで FAIL・印が無ければ評価を済ませて返す
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armExe } from "./exe";

test("隔離の印つきは「macOS が止めます（path）」で throw し、起こさない", () => {
  const d = mktmp("h26-q");
  const p = join(d, "chrome");
  writeFileSync(p, `#!/bin/sh\ntouch "${d}/ran"\n`);
  Bun.spawnSync(["/usr/bin/xattr", "-w", "com.apple.quarantine", "0081;00000000;Safari;", p]);
  expect(() => armExe(p)).toThrow(`macOS が止めます（隔離の印 com.apple.quarantine が付いた実行 file: ${p}）`);
  expect(Bun.file(join(d, "ran")).size).toBe(0); // 起こしていない
});

test("印が無ければ評価を済ませる起動は本文を走らせず、2 回目以降は本文どおり動く（sh と bun の shebang）", () => {
  const d = mktmp("h26-ok");
  const sh = join(d, "bw");
  writeFileSync(sh, `#!/bin/sh\necho "$1" >> "${d}/sh.log"\n`);
  const js = join(d, "chrome");
  writeFileSync(js, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(join(d, "js.log"))}, process.argv[2] + "\\n");\n`);
  for (const p of [sh, js]) expect(armExe(p)).toBe(p);
  expect(Bun.file(join(d, "sh.log")).size + Bun.file(join(d, "js.log")).size).toBe(0);
  for (const p of [sh, js]) expect(Bun.spawnSync([p, "a"]).exitCode).toBe(0);
  expect(readFileSync(join(d, "sh.log"), "utf8")).toBe("a\n");
  expect(readFileSync(join(d, "js.log"), "utf8")).toBe("a\n");
});
