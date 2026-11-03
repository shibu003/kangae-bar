// weight: 部品の分類・cputime の読み・footprint の読み・自分の木だけを数える・集計
import { expect, test } from "bun:test";
import { classify, cpuSecOf, parseFootprint, parsePs, summarize, treeOf } from "../tools/weight.ts";

test("weight 分類: 7 つの部品（claude が kangae の引数に出ても常駐にならない）", () => {
  expect(classify("/Users/x/Applications/Kangae Bar.app/Contents/MacOS/KangaeBar --relaunch")).toBe("KangaeBar");
  expect(classify("/Users/x/Applications/Kangae Bar.app/Contents/Resources/bin/kangae --daemon")).toBe("常駐 kangae");
  expect(classify("/usr/local/bin/claude -p 頼み --append-system-prompt /x/bin/kangae")).toBe("claude CLI");
  expect(classify("/x/.local/bin/cua-driver mcp")).toBe("cua-driver");
  expect(classify("/S/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent")).toBe("WebContent");
  expect(classify("/C/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer")).toBe("Chrome の tab");
  expect(classify("/bin/sh -c x")).toBe("その他");
  expect(classify("/C/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process")).toBe("その他"); // Chrome の tab は renderer だけ
});

test("weight cputime と footprint の読み", () => {
  expect(cpuSecOf("0:00.07")).toBeCloseTo(0.07);
  expect(cpuSecOf("248:45.58")).toBeCloseTo(248 * 60 + 45.58);
  expect(cpuSecOf("1-02:03:04.50")).toBeCloseTo(86400 + 2 * 3600 + 3 * 60 + 4.5);
  expect(parseFootprint("bash [44351]: 64-bit    Footprint: 960 KB\n    phys_footprint: 1816 KB\n")).toEqual({ pid: 44351, mb: 1816 / 1024 });
  expect(parseFootprint("x [7]: 64-bit Footprint: 1 GB\n phys_footprint: 1.5 GB")).toEqual({ pid: 7, mb: 1536 });
  expect(parseFootprint("error")).toBeNull();
});

test("weight 木: 自分の root の子孫と、responsible が木の中の物だけ。他人の process は入らない", () => {
  const rows = parsePs([" 10 1 0:01.00 root", " 11 10 0:02.00 child", " 12 11 0:03.00 grandchild", " 20 1 0:09.00 stranger", " 21 20 0:09.00 stranger-child", " 30 1 0:04.00 webcontent-of-mine", " 31 1 0:04.00 webcontent-of-other"].join("\n"));
  expect(treeOf(rows, [10]).map((r) => r.pid).sort()).toEqual([10, 11, 12]);
  expect(treeOf(rows, [10], new Set([30])).map((r) => r.pid).sort()).toEqual([10, 11, 12, 30]);
});

test("weight 集計: 平均と最大（CPU は部品ごとの合計の時系列に対して）", () => {
  const s = summarize([{ t: 0, cpu: { "claude CLI": 10 }, mb: { "claude CLI": 100 }, n: { "claude CLI": 1 } }, { t: 1, cpu: { "claude CLI": 30 }, mb: { "claude CLI": 300 }, n: { "claude CLI": 2 } }]);
  expect(s["claude CLI"]).toEqual({ procs: 2, cpuAvg: 20, cpuMax: 30, mbAvg: 200, mbMax: 300 });
  expect(s["常駐 kangae"].cpuMax).toBe(0);
});
