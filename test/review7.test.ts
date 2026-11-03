// review7: holes-17 の温め・idle の記憶が別の Chrome（同じ port）を指さない／pollUntil は締切ちょうどで最後の 1 回を測る／crossing の語境界は _ 区切りの識別子を取りこぼさない／pre-commit は tsc が無ければ黙って通さない
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpOpen } from "./cdp-sw.ts";
import { classify } from "../src/lease.ts";
import { pollUntil } from "../src/wait.ts";

// 同じ port に別の Chrome（Browser の id が違う）が立つ fake。Chrome ごとに tab の id も違う
const fake = (port: number, browser: string) => {
  const sent: { method: string; url?: string }[] = [];
  const srv: ReturnType<typeof Bun.serve> = Bun.serve({
    port, hostname: "127.0.0.1",
    fetch(req, s) {
      const u = new URL(req.url);
      if (u.pathname === "/ws") return s.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      if (u.pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/${browser}` });
      if (u.pathname === "/json/new") return Response.json({ id: "tab-1", webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/ws` });
      if (u.pathname === "/json/list") return Response.json([{ id: "tab-1", type: "page", url: "", title: "" }]);
      return Response.json({});
    },
    websocket: { message(ws, raw) { const m = JSON.parse(String(raw)); sent.push({ method: m.method, url: m.params?.url }); ws.send(JSON.stringify({ id: m.id, result: {} })); } },
  });
  return { srv, sent };
};
const warms = (sent: { method: string; url?: string }[]) => sent.filter((m) => m.method === "Page.navigate" && m.url?.startsWith("data:")).length;

test("同じ port に立った別の Chrome は、前の Chrome が温まっていても温め直す（port だけを鍵にしない）", async () => {
  const a = fake(0, "AAAA");
  const port = a.srv.port!;
  (await cdpOpen(port, "http://127.0.0.1:1/a")).close();
  expect(warms(a.sent)).toBe(1);
  a.srv.stop(true);
  const b = fake(port, "BBBB"); // Chrome を起こし直した（同じ debug port・別の browser）
  (await cdpOpen(port, "http://127.0.0.1:1/b")).close();
  b.srv.stop(true);
  expect(warms(b.sent)).toBe(1);
});

test("同じ port の別の Chrome（tab の id が偶然同じ）に、前の Chrome の idle の tab（死んだ ws）を渡さない", async () => {
  const a = fake(0, "CCCC");
  const port = a.srv.port!;
  (await cdpOpen(port, "about:blank")).close();
  a.srv.stop(true);
  const b = fake(port, "DDDD");
  const p = await cdpOpen(port, "about:blank").then(() => "ok", (e) => (e as Error).message);
  b.srv.stop(true);
  expect(p).toBe("ok");
});

test("pollUntil: 最後の sleep が締切をまたいでも、締切の時点でもう 1 回測る", async () => {
  const t0 = Date.now();
  const v = await pollUntil(() => (Date.now() - t0 >= 100 ? "ok" : null), 150, 400); // 1 回目は 0ms・次は 400ms 後 = 締切の外
  expect(v).toBe("ok");
});

test("crossing: _ 区切りの識別子（/users/sign_out・do_logout）も取りこぼさず、語の途中（catalog out・Dialog outline）は誤検出しない", () => {
  const link = (value: string) => classify("click", {}, { role: "AXLink", label: "x", value });
  for (const v of ["https://a.example/users/sign_out", "https://a.example/do_logout", "https://a.example/Log_Off", "https://a.example/logout.php"]) expect(link(v)).toBe("crossing");
  for (const l of ["Sign out", "Log off", "ログ アウト", "ログアウト", "Sign-out"]) expect(classify("click", {}, { role: "AXButton", label: l })).toBe("crossing");
  for (const l of ["Dialog outline", "Design outline", "Catalog output", "Blog outing", "Signal outbox"]) expect(classify("click", {}, { role: "AXButton", label: l })).toBe("write");
});

test("pre-commit: node_modules/.bin/tsc が無い時は黙って通さず、未確認の 1 行を出す", () => {
  const dir = mktmp("review7");
  expect(dir).not.toBe(process.cwd());
  // hook の中で走ると GIT_DIR を継ぐ → 本物の repo に init / config を書く（2026-10-08 実測）。GIT_* を外す
  const clean = Object.fromEntries(Object.entries(process["env"]).filter(([k]) => !k.startsWith("GIT_")));
  const sh = (c: string) => spawnSync("sh", ["-c", c], { cwd: dir, encoding: "utf8", env: clean });
  sh(`git init -q . && git config user.email t@t && git config user.name t && mkdir -p tools src && echo 'process.exit(0)' > tools/affected.ts && echo 'process.exit(0)' > tools/rules-lint.ts && echo 'export const x = 1' > src/a.ts && git add src/a.ts tools/affected.ts`); // rules-ok: 使い捨ての tmpdir（GIT_* を外してある）
  const r = sh(`cp ${import.meta.dir}/../.githooks/pre-commit-heavy h.sh && sh h.sh`);
  expect(r.stderr).toMatch(/tsc.*(無い|未確認)/);
});
