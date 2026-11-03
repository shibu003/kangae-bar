// W13: 「この AI のきまり」の行は、守っている所と 1 対 1。守る所は 2 種類:
// - test（主）: その振る舞いを確かめる unit の test 名。在って、今の tree で通る事をここで実際に回して確かめる（振る舞いが壊れると赤＝例: lease.ts の l.hold の判断を外すと w11d が落ちてここも赤）
// - has（補助）: file に目印の字がちょうど 1 か所（消える・曖昧で赤・行番号では縛らない）
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RULES } from "../extension/rules.js";

const root = join(import.meta.dir, "..");
const count = (f: string, has: string) => readFileSync(join(root, f), "utf8").split(has).length - 1;
type Guard = { file: string; has: string } | { test: string; name: string };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// 名前を ^…$ で絞って 1 回の bun test で回す。exit 0 だけでは「0 件一致」も緑なので、pass の数が名前の数と同じかを返す
async function run(tests: { test: string; name: string }[]) {
  const files = [...new Set(tests.map((t) => t.test))], names = [...new Set(tests.map((t) => t.name))];
  const p = Bun.spawn([process.execPath, "test", "--timeout", "300000", ...files.map((f) => `./${f}`), "-t", `^(${names.map(esc).join("|")})$`], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  const n = (k: string) => Number([...out.matchAll(new RegExp(`^\\s*(\\d+) ${k}$`, "gm"))].at(-1)?.[1] ?? -1);
  return { code: await p.exited, pass: n("pass"), fail: n("fail"), want: names.length, out };
}

test("全ての行に守っている所が在り、その file に目印がちょうど 1 か所在る", () => {
  expect(RULES.length).toBeGreaterThanOrEqual(6);
  expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  for (const r of RULES) {
    expect(r.guard.length, `${r.id} に守っている所が無い`).toBeGreaterThan(0);
    for (const g of r.guard as Guard[]) if ("has" in g) expect(count(g.file, g.has), `${r.id}: ${g.file} の「${g.has}」が 1 か所に決まらない`).toBe(1);
  }
});

test("全ての行が振る舞いの試験に結ばれ、その試験が在って今の tree で通る（振る舞いを壊すと赤）", async () => {
  const tests = RULES.flatMap((r) => (r.guard as Guard[]).filter((g): g is { test: string; name: string } => "test" in g));
  for (const r of RULES) expect((r.guard as Guard[]).some((g) => "test" in g), `${r.id} が振る舞いの試験に結ばれていない`).toBe(true);
  const r = await run(tests);
  expect({ code: r.code, pass: r.pass, fail: r.fail }, r.out.slice(-3000)).toEqual({ code: 0, pass: r.want, fail: 0 });
}, 600_000);

test("確かめ方の対照: 無い名前は 0 件一致で緑にならない", async () => {
  const r = await run([{ test: "test/w11d.test.ts", name: "無い test の名前" }]);
  expect(r.code === 0 && r.pass === r.want).toBe(false);
}, 120_000);

test("専門語を人の目に出さない", () => {
  for (const r of RULES) expect(r.text, r.id).not.toMatch(/lease|token|gen\b|CDP|DOM|cookie|操作権|常駐|資源/);
});

test("panel は RULES の全行を、順に 1 行ずつ出す（行を足して守る所が無ければ上の test が赤）", () => {
  const js = readFileSync(join(root, "extension/panel.js"), "utf8");
  expect(js).toContain('import { RULES } from "./rules.js"');
  expect(js).toContain("RULES.map(");
});
