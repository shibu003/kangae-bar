// tmpleak-2: tools/disk-watch.ts（suite の前後で増えた場所を特定する・読むだけ）と、clean-tmp の file 成果物の許可
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diff, sizes, snap, type Snap } from "../tools/disk-watch.ts";
import { clean, find } from "../tools/clean-tmp.ts";

const mk = (o: Partial<Snap>): Snap => ({ at: 0, dfFreeMB: 1000, dirs: {}, kids: {}, ...o });

test("diff: df の減りを『候補 dir の増え』と『swap file の増え』に分けて、増えた順に出す", () => {
  const a = mk({ dfFreeMB: 36000, swapfilesMB: 5120, dirs: { "/t": 100 * 1024, "/c": 500 * 1024 }, kids: { "/t": { x: 50 * 1024 }, "/c": {} } });
  const b = mk({ dfFreeMB: 34900, swapfilesMB: 6144, dirs: { "/t": 160 * 1024, "/c": 500 * 1024 }, kids: { "/t": { x: 110 * 1024, y: 2048 }, "/c": {} } });
  const r = diff(a, b);
  expect(r.dfMB).toBe(-1100);
  expect(r.swapFilesMB).toBe(1024); // 1 GiB の swap file が 1 つ増えた
  expect(Math.round(r.sumKB / 1024)).toBe(60);
  expect(r.dirs[0]).toMatchObject({ dir: "/t", kb: 60 * 1024 });
  expect(r.dirs[0]!.kids.map((k) => k.name)).toEqual(["x", "y"]); // 増えた順
  expect(-r.dfMB - Math.round(r.sumKB / 1024) - r.swapFilesMB).toBe(16); // 説明できない減り（残り）
});

test("sizes / snap: 読むだけ（dir を作らない・消さない）・1 階層下の大きさを返す", () => {
  const d = realpathSync(mktmp("dw"));
  mkdirSync(join(d, "a")); writeFileSync(join(d, "a/f"), "x".repeat(300_000)); writeFileSync(join(d, "g"), "y");
  const before = readdirSync(d).sort();
  const z = sizes(d);
  expect(z.total).toBeGreaterThan(200);
  expect(z.kids["a"]).toBeGreaterThan(200);
  const s = snap([d]);
  expect(s.dirs[d]).toBe(z.total);
  expect(s.dfFreeMB).toBeGreaterThan(0);
  expect(typeof s.swapfilesMB).toBe("number");
  expect(readdirSync(d).sort()).toEqual(before);
});

test("clean-tmp: file の成果物（gemini の policy・常駐の .err）は名前が完全に一致する ただの file で 30 分以上前の物だけ消す。別の名前・symlink・folder は触らない", () => {
  const d = realpathSync(mktmp("dw"));
  const old = (p: string) => { const t = new Date(Date.now() - 2 * 3600_000); utimesSync(p, t, t); };
  const files = ["kangae-gemini-policy-0024f707-895b-4e2b-8ae2-8aa4d9947222.toml", "kangae-daemon-10072-1791532901982-va7ivn.err"];
  for (const f of files) { writeFileSync(join(d, f), "x"); old(join(d, f)); }
  const keep = ["kangae-gemini-policy-notauuid.toml", "kangae-gemini-policy-0024f707-895b-4e2b-8ae2-8aa4d9947222.toml.bak", "kangae-daemon-x-y-z.err", "other.toml"];
  for (const f of keep) { writeFileSync(join(d, f), "x"); old(join(d, f)); }
  mkdirSync(join(d, "kangae-gemini-policy-11111111-2222-3333-4444-555555555555.toml")); old(join(d, "kangae-gemini-policy-11111111-2222-3333-4444-555555555555.toml")); // folder は file の許可に入らない
  const target = join(d, "precious"); writeFileSync(target, "keep");
  symlinkSync(target, join(d, "kangae-gemini-policy-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.toml"));
  expect(find(d, 30 * 60_000).map((f) => f.name).sort()).toEqual([...files].sort());
  const r = clean(d, { apply: true, minAgeMs: 30 * 60_000, size: false });
  expect(r.removed).toBe(2);
  for (const f of files) expect(existsSync(join(d, f))).toBe(false);
  for (const f of [...keep, "precious"]) expect(existsSync(join(d, f))).toBe(true);
});
