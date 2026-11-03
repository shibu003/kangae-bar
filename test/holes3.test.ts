// holes-3: sw 探しの締切と 1 回ごとの時間切れ（H8）・e2e-lock.sh の時間切れ（H11）
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalIn, findSw, installExtension } from "./cdp-sw.ts";
import { until, waitNap } from "./e2e-lock-util.ts";

const lock = join(import.meta.dir, "../tools/e2e-lock.sh");
const run = (env: Record<string, string>, ...cmd: string[]) => {
  const t = Date.now();
  const L = join(mktmp("holes3"), "lock");
  const p = Bun.spawnSync(["sh", lock, ...cmd], { env: { ...process.env, E2E_LOCK: L, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, sec: (Date.now() - t) / 1000, out: p.stdout.toString() + p.stderr.toString() };
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("H11: timeout を過ぎたら 124・子（孫まで）が止まる", () => {
  const f = join(mktmp("holes3"), "pid");
  const r = run({ E2E_TIMEOUT_SEC: "2" }, "sh", "-c", `sleep 60 & echo $! > ${f}; wait`);
  expect(r.code).toBe(124);
  expect(r.sec).toBeLessThan(15);
  expect(alive(Number(readFileSync(f, "utf8")))).toBe(false);
}, 30_000);
test("H11: timeout が無い／間に合う時は子の exit code のまま", () => {
  expect(run({}, "sh", "-c", "exit 3").code).toBe(3);
  expect(run({ E2E_TIMEOUT_SEC: "30" }, "sh", "-c", "exit 0").code).toBe(0);
  expect(run({}, "sh", "-c", "sleep 3").sec).toBeGreaterThanOrEqual(3); // 対照: 時間切れが止めているのであって、速く終わっているのではない
}, 30_000);

const fake = (list: () => Response | Promise<Response>) => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r, s) => {
  const u = new URL(r.url);
  if (u.pathname === "/ws") return s.upgrade(r) ? undefined : new Response("no", { status: 400 });
  if (u.pathname === "/json/list") return list();
  return new Response("{}");
}, websocket: { message(ws) { ws.send(JSON.stringify({ id: 1, result: { result: { value: true } } })); } } });

test("H8: sw が居ない → 締切で『理由 1 行』の失敗", async () => {
  const s = fake(() => Response.json([{ type: "page", url: "http://x/" }]));
  const t = Date.now();
  await expect(findSw({ port: s.port!, deadlineMs: 1500 })).rejects.toThrow(/見つかりません.*page/);
  expect(Date.now() - t).toBeLessThan(4000);
  s.stop(true);
});
test("H8: /json/list が返らない → 1 回ごとの時間切れで締切に間に合う", async () => {
  const s = fake(() => new Promise<Response>(() => {}));
  const t = Date.now();
  await expect(findSw({ port: s.port!, deadlineMs: 1500, callMs: 400 })).rejects.toThrow(/見つかりません/);
  expect(Date.now() - t).toBeLessThan(4000);
  s.stop(true);
});
test("H8: sw が居れば返す", async () => {
  const s = fake(() => Response.json([{ type: "service_worker", url: "chrome-extension://x/sw.js", webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` }]));
  expect((await findSw({ port: s.port!, deadlineMs: 3000 })).url).toContain("sw.js");
  s.stop(true);
});

// holes-5: 拡張は CDP Extensions.loadUnpacked で入れる。入らなければ『入っていない』を原文つきで言う
const fakeExt = (reply: (p: any) => any, sw = false) => {
  const calls: any[] = [];
  const s: any = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r, sv) => {
    const u = new URL(r.url);
    if (u.pathname === "/ws") return sv.upgrade(r) ? undefined : new Response("no", { status: 400 });
    if (u.pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` });
    if (u.pathname === "/json/list") return Response.json(sw && calls.length ? [{ type: "service_worker", url: "chrome-extension://x/sw.js", webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` }] : []);
    return new Response("{}");
  }, websocket: { message(ws, m) { const j = JSON.parse(String(m)); calls.push(j); ws.send(JSON.stringify(j.method === "Extensions.loadUnpacked" ? { id: j.id, ...reply(j.params) } : { id: 1, result: { result: { value: true } } })); } } });
  return Object.assign(s, { calls });
};
test("H9: installExtension は loadUnpacked を打ち、id を返す", async () => {
  const s = fakeExt((p) => ({ result: { id: "abc" + p.path.length } }));
  expect(await installExtension(s.port!, "/x/ext")).toBe("abc6");
  expect(s.calls[0].params.path).toBe("/x/ext");
  s.stop(true);
});
test("H9: 入らなかった時は『拡張が入っていない』と原文を言う（締切の理由にも出る）", async () => {
  const s = fakeExt(() => ({ error: { code: -32601, message: "Method not found" } }));
  await expect(installExtension(s.port!, "/x/ext")).rejects.toThrow(/拡張が入っていない.*Method not found/);
  await expect(findSw({ port: s.port!, deadlineMs: 1500, extensionDir: "/x/ext" })).rejects.toThrow(/見つかりません.*拡張が入っていない.*Method not found/);
  s.stop(true);
});
test("H9: extensionDir を渡すと入れてから sw を探す（渡さなければ sw は出ない対照）", async () => {
  const s = fakeExt(() => ({ result: { id: "abc" } }), true);
  expect((await findSw({ port: s.port!, deadlineMs: 3000, extensionDir: "/x/ext" })).url).toContain("sw.js");
  const s2 = fakeExt(() => ({ result: { id: "abc" } }), true);
  await expect(findSw({ port: s2.port, deadlineMs: 1500 })).rejects.toThrow(/見つかりません/);
  s.stop(true); s2.stop(true);
}, 15_000);

// W80（H9 の根）: 本物の sw は繋ぐたびに Inspector.workerScriptLoaded を先に送る。返事は id で拾う／--load-extension の sw が居れば入れ直さない
const fakeSw = (list: () => any[]) => {
  const calls: any[] = [];
  const s: any = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r, sv) => {
    const u = new URL(r.url);
    if (u.pathname === "/ws") return sv.upgrade(r) ? undefined : new Response("no", { status: 400 });
    if (u.pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` });
    if (u.pathname === "/json/list") return Response.json(list().map((t) => ({ ...t, webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` })));
    return new Response("{}");
  }, websocket: {
    open(ws) { ws.send(JSON.stringify({ method: "Inspector.workerScriptLoaded", params: {} })); },
    message(ws, m) { const j = JSON.parse(String(m)); calls.push(j.method); ws.send(JSON.stringify(j.method === "Runtime.evaluate" ? { id: j.id, result: { result: { value: true } } } : { id: j.id, result: j.method === "Extensions.loadUnpacked" ? { id: "abc" } : {} })); },
  } });
  return Object.assign(s, { calls });
};
test("W80: evalIn は先に来る event を返事と取り違えない（id で拾う）", async () => {
  const s = fakeSw(() => []);
  expect(await evalIn(`ws://127.0.0.1:${s.port}/ws`, "1", 2000)).toBe(true);
  s.stop(true);
});
test("W80: 入れ直す前に居た sw（--load-extension の古い方）は、入れ直した後も一覧に残っていても掴まない", async () => {
  const s = fakeSw(() => [{ type: "service_worker", id: "OLD", url: "chrome-extension://x/sw.js" }]); // 新しい方がまだ出ない間（偽物の eval は真を返す）
  await expect(findSw({ port: s.port!, deadlineMs: 1500, extensionDir: "/x/ext" })).rejects.toThrow(/見つかりません.*拡張 abc は入った/);
  expect(s.calls).toContain("Extensions.loadUnpacked");
  s.stop(true);
});
test("W80: 入れ直した後に出た sw は掴む", async () => {
  const s: any = fakeSw(() => [{ type: "service_worker", id: s.calls.includes("Extensions.loadUnpacked") ? "NEW" : "OLD", url: "chrome-extension://x/sw.js" }]);
  expect((await findSw({ port: s.port!, deadlineMs: 3000, extensionDir: "/x/ext" })).url).toContain("sw.js");
  s.stop(true);
});
test("W80: 同じ url の sw が 2 つ並ぶ間（入れ直しの途中）は掴まない", async () => {
  const two = [{ type: "service_worker", id: "OLD", url: "chrome-extension://x/sw.js" }, { type: "service_worker", id: "NEW", url: "chrome-extension://x/sw.js" }];
  const s = fakeSw(() => two);
  await expect(findSw({ port: s.port!, deadlineMs: 1500 })).rejects.toThrow(/同じ sw が 2 個/);
  s.stop(true);
});

// orphan-lock: 子が先に終わっても、時間切れの番犬の sleep が孤児で残って pipe を握らない（runner の suite-53794b7 が出力できなくなった）
test("orphan-lock: 子が先に終わったら、番犬の sleep は残らない（終わり方 2 つ）", async () => {
  const sec = "7391";
  const L = join(mktmp("holes3"), "lock");
  const p = Bun.spawn(["sh", lock, "sleep", "30"], { env: { ...process.env, E2E_LOCK: L, E2E_TIMEOUT_SEC: sec, E2E_LOCK_GRACE: "2" }, stdout: "ignore", stderr: "ignore" });
  const nap = await waitNap(p.pid); // 数えるのは自分の番犬の sleep の pid だけ
  expect(nap).toBeGreaterThan(0); // 対照: 番犬は確かに居る
  p.kill("SIGTERM"); await p.exited; // 外の手で止める（release 経由）
  expect(await until(() => !alive(nap), 5000)).toBe(true);
}, 30_000);
