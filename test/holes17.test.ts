// holes-17: 試験の Chrome の最初の navigate が 60 秒超（メモリの逼迫）。温め・swap つきの 1 行・tab の使い回し。外すと赤くなる事は「navigate に返事をしない Chrome」と送信順で示す。
import { expect, test } from "bun:test";
import { cdpOpen } from "./cdp-sw.ts";

type Sent = { method: string; url?: string };
const fake = (o: { hangData?: boolean } = {}) => {
  const opened: string[] = [], sent: Sent[] = [];
  const srv: ReturnType<typeof Bun.serve<undefined>> = Bun.serve<undefined>({
    port: 0, hostname: "127.0.0.1",
    fetch(req, s) {
      const u = new URL(req.url);
      if (u.pathname === "/ws") return s.upgrade(req) ? undefined : new Response("no", { status: 400 });
      if (u.pathname === "/json/new") { opened.push(decodeURIComponent(u.search.slice(1))); return Response.json({ id: "t1", webSocketDebuggerUrl: `ws://127.0.0.1:${u.port}/ws` }); }
      if (u.pathname === "/json/list") return Response.json([{ id: "t1", type: "page", url: "", title: "" }]);
      return Response.json({});
    },
    websocket: { message(ws, raw) { const m = JSON.parse(String(raw)); sent.push({ method: m.method, url: m.params?.url }); if (o.hangData && m.params?.url?.startsWith("data:")) return; ws.send(JSON.stringify({ id: m.id, result: {} })); } },
  });
  return { srv, opened, sent };
};

test("温め: 最初の navigate より前に data: の頁へ 1 回 navigate し、2 回目の cdpOpen（同じ Chrome）では温めず、同じ tab を使い回す", async () => {
  const { srv, opened, sent } = fake();
  const a = await cdpOpen(srv.port!, "http://127.0.0.1:1/a");
  a.close();
  const b = await cdpOpen(srv.port!, "http://127.0.0.1:1/b");
  b.close(); srv.stop(true);
  const navs = sent.filter((m) => m.method === "Page.navigate").map((m) => m.url!);
  expect(navs.map((u) => (u.startsWith("data:") ? "warm" : u))).toEqual(["warm", "http://127.0.0.1:1/a", "http://127.0.0.1:1/b"]);
  expect(opened).toEqual(["about:blank"]); // 2 枚目は開かず idle の 1 枚を使った
});

test("温めが締切を越えたら「新しい頁の process が N 秒起きない」+ swap の原文の 1 行で落ちる／温めの前は長い締切（navMs ではない）", async () => {
  const { srv } = fake({ hangData: true });
  const t = Date.now();
  const m = await cdpOpen(srv.port!, "http://127.0.0.1:1/x", { warmMs: 600 }).then(() => "返った", (e) => (e as Error).message);
  srv.stop(true);
  expect(m).toMatch(/^Chrome の新しい頁の process が \d+ 秒起きない（メモリの逼迫の疑い: swap .*total = .*・load \d+）$/);
  expect(Date.now() - t).toBeLessThan(5000);
});

test("同時に 2 枚要る時は 2 枚目だけ新しく開く（使い回しは idle の頁だけ）", async () => {
  const { srv, opened } = fake();
  const a = await cdpOpen(srv.port!, "about:blank");
  const b = await cdpOpen(srv.port!, "about:blank");
  a.close(); b.close(); srv.stop(true);
  expect(opened.length).toBe(2);
});
