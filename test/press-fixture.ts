// W63 の試験の共通: 押す操作 1 つと、全部差し替えた環境
import { mktmp } from "./tmp";
import type { Press } from "../src/press";
import type { EnvDeps } from "../src/press-env";

export const tmp = () => mktmp("pw63");
export const mkPress = (over: Partial<Press> = {}): Press => ({
  v: 1, id: "a1b2c3d4", name: "予定を足す", madeAt: 1700000000000,
  fields: { title: { ask: true, label: "予定の名前" }, cal: { fixed: "仕事" }, when: { range: ["09:00", "18:00"] } },
  stages: [
    { n: 1, kind: "env", goal: "カレンダーを開く", requires: ["chromium-ext", "login:calendar.google.com"], post: { kind: "face", app: "web", titleLike: "Calendar" }, way: { kind: "act", app: "web", tool: "open_tab", args: { url: { const: "https://calendar.google.com" } } } },
    { n: 2, kind: "op", goal: "予定を入れる", requires: ["brew", "adb"], pre: { kind: "none" }, post: { kind: "result", like: "created" }, way: { kind: "act", app: "web", tool: "fill", args: { text: { field: "title" }, cal: { field: "cal" } } } },
  ],
  expect: { result: "calendar.event.created" }, onMismatch: "ask", limits: { maxRuns: 5 },
  claims: ["予定は消せば元に戻ります"],
  runs: { total: 7, clean: 5, lastAt: 1700000001000 }, ...over,
});
export const env = (over: Partial<EnvDeps> = {}): EnvDeps => ({ exists: () => false, which: () => false, extensionConnected: () => true, appInstalled: () => false, cmds: [], ...over });
