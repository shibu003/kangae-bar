// W54c（CEO 許可 10-14）: 常駐の起動時に注入器（~/.kangae/bin の .app）を準備し、自己確認が通った時だけ lease の配信に渡す。ここは偽の起動器の上の配線の test（実 binary の実行は docs/verify/w54/RESULT.md の実測の節）
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dragPostBin, openDragPost } from "../src/dragpost.ts";

const src = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const mk = (o: { env?: Record<string, string | undefined>; exists?: boolean; out?: string; code?: number } = {}) => {
  const ran: { app: string; args: string[] }[] = [];
  const dp = openDragPost({ home: "/h/.kangae", env: o.env ?? {}, exists: () => o.exists ?? true, runApp: async (app, args) => { ran.push({ app, args }); return { code: o.code ?? 0, out: o.out ?? '{"ok":true,"pointer":{"before":[1,1],"after":[1,1]}}' }; } });
  return { dp, ran };
};

test("W54c 起動時の準備: .app が在れば自己確認を 1 回だけ走らせ、通れば ready・通らなければ ready にならない（配らない）", async () => {
  const a = mk(); await Bun.sleep(10);
  expect(a.ran).toEqual([{ app: "/h/.kangae/bin/Kangae Bar 注入.app", args: ["--selfcheck"] }]);
  expect(a.dp!.ready()).toBe(true);
  const b = mk({ out: '{"ok":false,"why":"自分の窓に届きませんでした"}' }); await Bun.sleep(10);
  expect(b.dp!.ready()).toBe(false);
  expect(b.ran).toHaveLength(1);
  const c = mk({ code: 1, out: "" }); await Bun.sleep(10);
  expect(c.dp!.ready()).toBe(false);
});

test("W54c 起こさない時: .app が無い・試験（NODE_ENV=test）・KANGAE_NO_DRAGPOST=1 は undefined で、helper を 1 回も起こさない（今のまま）", () => {
  for (const o of [{ exists: false }, { env: { NODE_ENV: "test" } }, { env: { KANGAE_NO_DRAGPOST: "1" } }] as { env?: Record<string, string>; exists?: boolean }[]) { const r = mk(o); expect(r.dp, JSON.stringify(o)).toBeUndefined(); expect(r.ran).toEqual([]); }
  expect(dragPostBin("/h/.kangae")).toBe("/h/.kangae/bin/Kangae Bar 注入.app/Contents/MacOS/KangaeDragPost");
});

test("W54c 配線: 常駐の makeHandler は opts.dragPost を優先し、無ければ起動時の 1 個（defaultDragPost）を lease に渡す。.app は LaunchServices で起こす（許可が 1 つの名前に付く）・1 プロセスに 1 個", () => {
  const m = src("src/main.ts");
  expect(m).toContain("dragPost: opts.dragPost ?? defaultDragPost(),");
  expect(m).toContain("if (dragPostOnce !== null) return dragPostOnce;");
  expect(m).toContain('["open", "-g", "-n", "-W", "--stdout", out, "-a", app, "--args", ...args]');
  expect(m).toContain("openDragPost({ home, env: process.env, exists: existsSync, runApp:");
  expect(m.match(/openDragPost\(/g)!.length).toBe(1); // 準備の入口は 1 か所
});
