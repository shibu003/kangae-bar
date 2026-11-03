// holes-19: 頁は読み込まれているのに Page.navigate の返事だけ届かない（holes17-1: title=warm なのに 30 秒）。
// 偽の CDP: 返事が先 / 遅れて来る / 来ない（頁は着いている）/ 来ない（頁も着いていない）の 4 つ。
import { expect, test } from "bun:test";
import { cdpOpen } from "./cdp-sw.ts";

type Mode = "first" | "late" | "never-arrived" | "never-stuck" | "never-encoded" | "ignore-first" | "ignore-all";
const fake = (mode: Mode) => {
  let url = "about:blank", navs = 0;
  const srv: Bun.Server<undefined> = Bun.serve<undefined>({
    port: 0, hostname: "127.0.0.1",
    fetch(req, s): Response | undefined {
      const u = new URL(req.url);
      if (u.pathname === "/ws") return s.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      if (u.pathname === "/json/new") return Response.json({ id: "t1", webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/ws` });
      if (u.pathname === "/json/list") return Response.json([{ id: "t1", type: "page", url, title: url.startsWith("data:") ? "warm" : "x" }]);
      return Response.json({});
    },
    websocket: {
      message(ws, raw): void {
        const m = JSON.parse(String(raw)), reply = () => ws.send(JSON.stringify({ id: m.id, result: {} }));
        if (m.method !== "Page.navigate") return void reply();
        navs++;
        if (mode === "ignore-first" && navs === 1) return; // 1 回目は無視（移動が起きない）
        if (mode === "ignore-first") { url = m.params.url; return void reply(); }
        if (mode === "ignore-all") return;
        if (mode === "first") { url = m.params.url; return void reply(); }
        if (mode === "late") { url = m.params.url; return void setTimeout(reply, 400); }
        if (mode === "never-arrived") url = m.params.url; // 返事は無いが頁は着いた
        if (mode === "never-encoded") url = encodeURI(m.params.url); // 返事は無く、Chrome が url の表記（エンコード）を変えて返す
      },
    },
  });
  return srv;
};
const open = (mode: Mode, ms = {}) => { const srv = fake(mode); return cdpOpen(srv.port!, "http://127.0.0.1:1/a", { graceMs: 300, resendMs: 600, warmMs: 3_000, navMs: 1_500, ...ms }).then((p) => { p.close(); return "通った"; }, (e) => (e as Error).message).finally(() => srv.stop(true)); };

test("返事が先に来る・遅れて来る → 通る", async () => {
  expect(await open("first")).toBe("通った");
  expect(await open("late")).toBe("通った");
});
test("返事が来なくても、頁が行き先に着いていれば進む（外すと温めで落ちる）", async () => {
  expect(await open("never-arrived")).toBe("通った");
});
test("返事が来ず頁も着いていなければ、時間切れの 1 行で落ちる", async () => {
  expect(await open("never-stuck", { resendMs: 60_000 })).toMatch(/process が \d+ 秒起きない/);
});
test("返事が来ず、Chrome が data: の url をエンコードして返しても進む（温めの道・外すと温めで落ちる）", async () => {
  expect(await open("never-encoded")).toBe("通った");
});

test("1 回目の navigate を無視されても、送り直して進む（外すと温めで落ちる）", async () => {
  expect(await open("ignore-first", { warmMs: 6_000, navMs: 6_000 })).toBe("通った");
});
test("2 回とも無視されたら、理由つきの 1 行で落ちる", async () => {
  expect(await open("ignore-all", { warmMs: 6_000, navMs: 6_000 })).toMatch(/頁の移動が始まらない（target は about:blank のまま・Page.navigate を 2 回送った・swap /);
});
