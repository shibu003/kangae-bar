// holes-6: dm.e2e の手ごとの時間切れ（sockCall・cdpOpen の send/ev）。時間切れを外すと止まる事は「返事をしない相手」で示す。
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpOpen, sockCall } from "./cdp-sw.ts";

const sockPath = () => join(mktmp("holes6"), "s.sock");
const msg = async (p: Promise<any>) => p.then(() => "返った", (e) => (e as Error).message);

test("sockCall: 返事をしない daemon は「sockCall(op) が N 秒返らない」で切れる／返す daemon は返る（対照）", async () => {
  const silent = sockPath(), echo = sockPath();
  const a = Bun.listen({ unix: silent, socket: { data() {} } });
  const b = Bun.listen({ unix: echo, socket: { data(s, c) { s.write(JSON.stringify({ id: JSON.parse(new TextDecoder().decode(c)).id, ok: 1 }) + "\n"); } } });
  const t = Date.now();
  expect(await msg(sockCall(silent, { op: "add" }, 300))).toBe("sockCall(add) が 0.3 秒返らない");
  expect(Date.now() - t).toBeLessThan(3000);
  expect((await sockCall(echo, { op: "roots" }, 2000)).ok).toBe(1);
  a.stop(true); b.stop(true);
});

test("sockCall: socket が無い（ENOENT）は握りつぶさず原文で、返事の前に閉じても理由つきで落ちる", async () => {
  const none = sockPath();
  const m1 = await msg(sockCall(none, { op: "add" }, 5000));
  expect(m1).toContain("sockCall(add) が返らない: 接続できない");
  expect(m1).toContain("ENOENT");
  expect(m1).toContain("socket の file が無い");
  const closing = sockPath();
  const c = Bun.listen({ unix: closing, socket: { data(s) { s.end(); } } });
  expect(await msg(sockCall(closing, { op: "add" }, 5000))).toContain("返事の前に socket が閉じた");
  c.stop(true);
});

test("cdpOpen: CDP が返事をしない頁は「CDP Page.enable が N 秒返らない」で切れる／debug port が無いなら理由つき", async () => {
  let wsUrl = "";
  const srv: { port?: number; stop(force?: boolean): void } = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(r, s) {
      const u = new URL(r.url);
      if (u.pathname === "/ws") return s.upgrade(r) ? undefined : new Response("no", { status: 400 });
      if (u.pathname === "/json/version") return Response.json({});
      return Response.json({ id: "x", webSocketDebuggerUrl: wsUrl });
    },
    websocket: { message() {} }, // 開くが一切答えない
  });
  wsUrl = `ws://127.0.0.1:${srv.port}/ws`;
  const t = Date.now();
  expect(await msg(cdpOpen(srv.port!, "about:blank", { callMs: 400 }))).toBe("CDP Page.enable が 0.4 秒返らない");
  expect(Date.now() - t).toBeLessThan(5000);
  srv.stop(true);
  // 対照: 全部に {} で答える頁は開けて、ev は値を返す
  let okPort = 0;
  const ok = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(r, s) { const u = new URL(r.url); if (u.pathname === "/ws") return s.upgrade(r) ? undefined : new Response("no"); if (u.pathname === "/json/version") return Response.json({}); return Response.json({ id: "y", webSocketDebuggerUrl: `ws://127.0.0.1:${okPort}/ws` }); },
    websocket: { message(ws, m) { ws.send(JSON.stringify({ id: JSON.parse(String(m)).id, result: { result: { value: 42 } } })); } },
  });
  okPort = ok.port!;
  const page = await cdpOpen(ok.port!, "about:blank", { callMs: 2000 });
  expect(await page.ev("1+1")).toBe(42);
  page.close(); ok.stop(true);
}, 20_000);

test("cdpOpen: Chrome が落ちて ws が閉じたら、待っている send は時間切れを待たず理由つきで落ちる", async () => {
  let wsUrl = "";
  const srv: { port?: number; stop(force?: boolean): void } = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(r, s) { const u = new URL(r.url); if (u.pathname === "/ws") return s.upgrade(r) ? undefined : new Response("no"); if (u.pathname === "/json/version") return Response.json({}); return Response.json({ id: "z", webSocketDebuggerUrl: wsUrl }); },
    websocket: { message(ws) { ws.close(); } },
  });
  wsUrl = `ws://127.0.0.1:${srv.port}/ws`;
  const t = Date.now();
  expect(await msg(cdpOpen(srv.port!, "about:blank", { callMs: 15_000 }))).toContain("返らない: ws が閉じた");
  expect(Date.now() - t).toBeLessThan(5000);
  srv.stop(true);
}, 20_000);

// holes-14: cdpOpen は頁を about:blank で作り、url へは Page.navigate を 1 回だけ送る（url で直に開くと呼ぶ側の navigate と二重になり dm.e2e が 60 秒返らなかった）
test("cdpOpen: /json/new は about:blank・url への Page.navigate は 1 回", async () => {
  const opened: string[] = [], sent: { method: string; params: any }[] = [];
  const srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, s) {
      const u = new URL(req.url);
      if (u.pathname === "/ws") return s.upgrade(req) ? undefined : new Response("no", { status: 400 });
      if (u.pathname === "/json/new") { opened.push(decodeURIComponent(u.search.slice(1))); return Response.json({ id: "t1", webSocketDebuggerUrl: `ws://127.0.0.1:${u.port}/ws` }); }
      return Response.json({});
    },
    websocket: { message(ws, raw) { const m = JSON.parse(String(raw)); sent.push({ method: m.method, params: m.params }); ws.send(JSON.stringify({ id: m.id, result: {} })); } },
  });
  const page = await cdpOpen(srv.port!, "http://127.0.0.1:1/panel?x=1");
  page.close(); srv.stop(true);
  expect(opened).toEqual(["about:blank"]);
  expect(sent.filter((m) => m.method === "Page.navigate").map((m) => m.params.url).filter((u) => !u.startsWith("data:"))).toEqual(["http://127.0.0.1:1/panel?x=1"]); // data: は holes-17 の温め
});
