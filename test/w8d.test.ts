import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRoutines, nextAt, parseSpec, type Routine, type Spec } from "../src/routines.ts";

const tmp = () => mktmp("w8d");
const Z = (s: string) => Date.parse(s);
const LA = "America/Los_Angeles", JP = "Asia/Tokyo";

// AC-4 次の時刻
test("W8d 毎日 9:00 は地域の壁の時計のまま（日本・月末・LA の夏時間の切り替え 2026-11-01 / 03-08）", () => {
  const d: Spec = { kind: "daily", hh: 9, mm: 0 };
  expect(nextAt(d, Z("2026-10-30T23:00:00Z"), JP)).toBe(Z("2026-10-31T00:00:00Z")); // 日本 8:00 → 同じ日の 9:00
  expect(nextAt(d, Z("2026-10-31T00:30:00Z"), JP)).toBe(Z("2026-11-01T00:00:00Z")); // 月をまたぐ
  expect(nextAt(d, Z("2026-02-28T00:30:00Z"), JP)).toBe(Z("2026-03-01T00:00:00Z")); // 2 月末
  // LA: 10-31 は PDT(-7)・11-01 は PST(-8)。翌日の 9:00 は 17:00Z（JST 固定や UTC 固定だと別の時刻になる）
  expect(nextAt(d, Z("2026-10-31T17:00:00Z"), LA)).toBe(Z("2026-11-01T17:00:00Z"));
  expect(nextAt(d, Z("2026-10-31T15:00:00Z"), LA)).toBe(Z("2026-10-31T16:00:00Z"));
  // 春: 03-07 PST(-8) → 03-08 PDT(-7)
  expect(nextAt(d, Z("2026-03-07T17:00:00Z"), LA)).toBe(Z("2026-03-08T16:00:00Z"));
});
test("W8d 毎週と N 分ごと", () => {
  const w: Spec = { kind: "weekly", dow: 1, hh: 9, mm: 30 }; // 月曜 9:30
  expect(nextAt(w, Z("2026-10-08T00:00:00Z"), JP)).toBe(Z("2026-10-12T00:30:00Z")); // 2026-10-08 は木 → 10-12 月
  expect(nextAt(w, Z("2026-10-12T00:30:00Z"), JP)).toBe(Z("2026-10-19T00:30:00Z")); // ちょうどの時刻は含めない
  const e: Spec = { kind: "every", minutes: 15 };
  const a = Z("2026-10-08T00:00:00Z");
  expect(nextAt(e, a + 1, JP, a)).toBe(a + 15 * 60_000);
  expect(nextAt(e, a + 15 * 60_000, JP, a)).toBe(a + 30 * 60_000);
});

// timer・時計の偽物
function rig(agentOk = true, fetchImpl?: typeof fetch) {
  let t = Z("2026-10-08T00:00:00Z"); // JP 9:00 ちょうど
  const timers = new Set<{ fn: () => void; ms: number }>();
  const fired: { id: string; text: string }[] = [];
  const state = { ok: agentOk };
  const R = makeRoutines(tmp(), {
    now: () => t, tz: JP, fetch: fetchImpl,
    fire: (r: Routine, text: string) => { if (!state.ok) return false; fired.push({ id: r.id, text }); return true; },
    setTimer: (fn, ms) => { const x = { fn, ms }; timers.add(x); return x; },
    clearTimer: (x) => timers.delete(x as { fn: () => void; ms: number }),
  });
  R.start();
  return { R, fired, timers, state, adv: (ms: number) => { t += ms; }, now: () => t };
}

test("W8d timer は常に最大 1 本・setInterval の polling が無い", async () => {
  const { R, timers } = rig();
  R.add("請求係", { kind: "daily", hh: 9, mm: 0 }, "請求書");
  R.add("請求係", { kind: "every", minutes: 30 }, "x");
  R.add("読書係", { kind: "watch", url: "http://127.0.0.1:1/", minutes: 30 }, "");
  expect(timers.size).toBe(1);
  const only = [...timers][0]!;
  expect(only.ms).toBe(30 * 60_000); // いちばん近い時刻
  expect(readFileSync(join(import.meta.dir, "../src/routines.ts"), "utf8")).not.toMatch(/setInterval\s*\(/);
});

test("W8d routine 3 本で待つ間は timer が鳴らない・頁の 30 分後に 1 回だけ（polling なら赤）", async () => {
  let hits = 0;
  const { R, timers, adv } = rig(true, (async () => { hits++; return new Response("x", { headers: { etag: '"v1"' } }); }) as unknown as typeof fetch);
  R.add("請求係", { kind: "daily", hh: 9, mm: 0 }, "朝");
  R.add("請求係", { kind: "weekly", dow: 1, hh: 9, mm: 0 }, "週");
  R.add("請求係", { kind: "watch", url: "http://127.0.0.1:1/", minutes: 30 }, "");
  // 待つ間 = timer は 1 本・次の頁確認（30 分）まで鳴らない。短い間隔で鳴る作りなら ms が小さくなって赤
  expect(R.wakes()).toBe(0);
  expect([...timers].map((x) => x.ms)).toEqual([30 * 60_000]);
  expect(hits).toBe(0);
  adv(30 * 60_000); // 30 分後に 1 回だけ鳴る
  [...timers][0]!.fn(); await R.tick();
  expect(R.wakes()).toBe(1);
  expect(hits).toBe(1);
});

test("W8d 毎日 9:00 で 1 回起きる・次は翌日", async () => {
  const { R, fired, adv, now } = rig();
  const g = R.add("請求係", { kind: "daily", hh: 9, mm: 0 }, "請求/ を作って");
  expect(g.ok && g.r.nextAt).toBe(Z("2026-10-09T00:00:00Z"));
  adv(24 * 3600_000);
  await R.tick();
  expect(fired.length).toBe(1);
  expect(fired[0]!.text).toBe("請求/ を作って"); // 定刻なら追いつきの注記は付かない
  expect(R.all()[0]!.nextAt).toBe(Z("2026-10-10T00:00:00Z"));
  await R.tick();
  expect(fired.length).toBe(1);
  expect(now()).toBe(Z("2026-10-09T00:00:00Z"));
});

test("W8d timer が 3 時間遅れて鳴っても 1 回だけ・次の時刻は正しい（眠った Mac）", async () => {
  const { R, fired, adv } = rig();
  R.add("請求係", { kind: "every", minutes: 30 }, "確認");
  adv(3 * 3600_000); // 6 回分が過ぎた
  await R.tick();
  expect(fired.length).toBe(1);
  expect(fired[0]!.text).toContain("1 回だけ追いつきました");
  expect(R.all()[0]!.nextAt).toBe(Z("2026-10-08T03:30:00Z")); // 起点から 30 分刻みの次
  expect(R.all()[0]!.note).toContain("追いつきました");
  const d = rig();
  d.R.add("請求係", { kind: "daily", hh: 9, mm: 0 }, "朝");
  d.adv(24 * 3600_000 + 3 * 3600_000); // 9:00 の 3 時間後に起きた
  await d.R.tick();
  expect(d.fired.length).toBe(1);
  expect(d.R.all()[0]!.nextAt).toBe(Z("2026-10-10T00:00:00Z"));
});

test("W8d 24 時間より古い分は飛ばして言う・満員なら 5 分後にもう一度", async () => {
  const a = rig();
  a.R.add("請求係", { kind: "daily", hh: 9, mm: 0 }, "朝");
  a.adv(3 * 24 * 3600_000 + 3600_000);
  await a.R.tick();
  expect(a.fired.length).toBe(0);
  expect(a.R.all()[0]!.note).toContain("飛ばしました");
  expect(a.R.all()[0]!.nextAt).toBe(Z("2026-10-12T00:00:00Z"));
  const b = rig(false);
  b.R.add("請求係", { kind: "every", minutes: 10 }, "x");
  b.adv(10 * 60_000);
  await b.R.tick();
  expect(b.fired.length).toBe(0);
  expect(b.R.all()[0]!.nextAt).toBe(b.now() + 5 * 60_000);
  b.state.ok = true; b.adv(5 * 60_000);
  await b.R.tick();
  expect(b.fired.length).toBe(1);
});

test("W8d pause の間は時刻が来ても起きない・戻すと今から数える", async () => {
  const { R, fired, adv, timers } = rig();
  const g = R.add("請求係", { kind: "daily", hh: 9, mm: 0 }, "朝");
  const id = g.ok ? g.r.id : "";
  R.setEnabled(id, false);
  expect(timers.size).toBe(0); // 止めたら timer も無い
  adv(24 * 3600_000);
  await R.tick();
  expect(fired.length).toBe(0);
  R.setEnabled(id, true);
  expect(R.all()[0]!.nextAt).toBe(Z("2026-10-10T00:00:00Z")); // 止めていた間の分には追いつかない
});

// 頁の比較
function page() {
  const s = { body: "v1", etag: '"a"', lastMod: "Thu, 01 Jan 2026 00:00:00 GMT", calls: 0, cond: [] as (string | null)[] };
  const f = (async (_u: string, init?: RequestInit) => {
    s.calls++;
    const h = new Headers(init?.headers);
    s.cond.push(h.get("if-none-match"));
    if (h.get("if-none-match") === s.etag) return new Response(null, { status: 304 });
    return new Response(s.body, { headers: { etag: s.etag, "last-modified": s.lastMod } });
  }) as unknown as typeof fetch;
  return { s, f };
}
test("W8d 頁: 変わらない間は起こさない（0 回）・変えると 1 回だけ・ETag だけ変わって中身が同じなら起こさない", async () => {
  const { s, f } = page();
  const { R, fired, adv } = rig(true, f);
  R.add("読書係", { kind: "watch", url: "http://x.test/", minutes: 30 }, "要約して");
  for (let i = 0; i < 4; i++) { adv(30 * 60_000); await R.tick(); }
  expect(s.calls).toBe(4);
  expect(fired.length).toBe(0); // 最初の 1 回は基準・あとは 304
  expect(s.cond.at(-1)).toBe('"a"'); // 条件付きで取っている
  s.etag = '"b"'; // 中身は同じ
  adv(30 * 60_000); await R.tick();
  expect(fired.length).toBe(0);
  s.body = "v2"; s.etag = '"c"';
  adv(30 * 60_000); await R.tick();
  expect(fired.length).toBe(1);
  expect(fired[0]!.text).toContain("要約して");
  expect(fired[0]!.text).toContain("http://x.test/");
  expect(fired[0]!.text).toContain("<page>\nv2\n</page>"); // 常駐が取った本文を渡す（agent が頁を読めなくても答えられる）
  adv(30 * 60_000); await R.tick();
  expect(fired.length).toBe(1);
});
test("W8d 頁: 起こせなかった変化は次の確認で拾い直す・読めない頁は起こさない", async () => {
  const { s, f } = page();
  const { R, fired, adv, state } = rig(true, f);
  R.add("読書係", { kind: "watch", url: "http://x.test/", minutes: 30 }, "");
  adv(30 * 60_000); await R.tick();
  s.body = "v2"; s.etag = '"z"'; state.ok = false;
  adv(30 * 60_000); await R.tick();
  expect(fired.length).toBe(0);
  state.ok = true; adv(5 * 60_000); await R.tick();
  expect(fired.length).toBe(1);
  const bad = rig(true, (async () => { throw new Error("down"); }) as unknown as typeof fetch);
  bad.R.add("読書係", { kind: "watch", url: "http://x.test/", minutes: 30 }, "");
  bad.adv(30 * 60_000); await bad.R.tick();
  expect(bad.fired.length).toBe(0);
  expect(bad.R.all()[0]!.note).toContain("読めませんでした");
});

test("W8d 指定の読み取りと上限", () => {
  expect(parseSpec({ daily: "9:00" })).toEqual({ ok: true, spec: { kind: "daily", hh: 9, mm: 0 } });
  expect(parseSpec({ weekly: "mon 9:30" })).toEqual({ ok: true, spec: { kind: "weekly", dow: 1, hh: 9, mm: 30 } });
  expect(parseSpec({ weekly: "月 9:30" }).ok).toBe(true);
  expect(parseSpec({ daily: "25:00" }).ok).toBe(false);
  expect(parseSpec({ daily: "9:00", every: "5" }).ok).toBe(false); // 2 つ指定
  expect(parseSpec({ watch: "file:///etc/passwd" }).ok).toBe(false);
  expect(parseSpec({ watch: "http://x.test/", every: "1" }).ok).toBe(false); // 間隔の下限
  const { R } = rig();
  for (let i = 0; i < 5; i++) expect(R.add("a", { kind: "every", minutes: 5 }, "x").ok).toBe(true);
  expect(R.add("a", { kind: "every", minutes: 5 }, "x").ok).toBe(false);
  expect(R.add("b", { kind: "daily", hh: 9, mm: 0 }, "  ").ok).toBe(false);
});
