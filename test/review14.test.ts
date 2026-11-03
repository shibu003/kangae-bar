// review14: 10-08 午前の片（W14・W11e-2・W11e-3・w8g1fix2）を破りに行く攻撃。偽の口・偽の bw・偽の CDP・偽の spawn（本物の Chrome・金庫・人の home の鍵には触らない）
import { mktmp } from "./tmp.ts";
import { setDefaultTimeout } from "bun:test";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cdp } from "../src/carry.ts";
import type { Driver } from "../src/lease.ts";
import { defaultWorkspace, geminiReadDirs, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { makeVault } from "../src/vault.ts";
import { sharedExe } from "./exe";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// --- 1. w8g1fix2: 拡張が繋ぎ直した後も、口が 1 つなら carry は通る（切れた口が tab の持ち主に残ると永久に「口が分かりません」）
test("w8g1fix2: tab の持ち主だった口が切れて新しい口が繋いだら、cookie_names・cookie_get は新しい口へ届く", async () => {
  const s = openStore(":memory:");
  const old = {}, now = {};
  const live = new Set<object>();
  const got: string[] = [];
  let h: ReturnType<typeof makeHandler>;
  const answer = (sock: object, m: any) => {
    if (m.type !== "web" || !live.has(sock)) return;
    if (sock === now) got.push(m.tool);
    const data = m.tool === "tab_info" ? { docId: "d1", title: "t", url: "https://app.example.com/login" } : m.tool === "cookie_names" ? { cookies: [{ name: "sid", domain: "app.example.com", path: "/" }] } : m.tool === "cookie_get" ? { cookies: [] } : null;
    queueMicrotask(() => void h({ op: "webResult", callId: m.id, text: "", data }, sock));
  };
  h = makeHandler(s, async () => [], undefined, { ...defaultWorkspace(), browserUrl: async () => "http://127.0.0.1:1" }, {
    awaitWebPeer: true, isExtension: () => true, carryMs: 3000,
    broadcast: (m) => { for (const k of live) answer(k, m); },
    unicast: (to, m) => { for (const k of live) if (to.has(k)) answer(k, m); },
  });
  const root = s.add(null, "user", "課題", true);
  live.add(old); await h({ op: "webHello" }, old);
  expect(await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" })).toMatchObject({ ok: true }); // tab_info に old が答える = old が tab 7 の持ち主
  live.delete(old); h.dropOwner(old); // Chrome を起こし直した（native host の socket が替わる）
  live.add(now); await h({ op: "webHello" }, now);
  const p = h({ op: "carry", owner: `s:${root.id}`, host: "app.example.com" });
  let card: any; for (const end = Date.now() + 3000; !card && Date.now() < end; await tick(5)) card = ((await h({ op: "leaseList" })) as any).carries[0];
  if (card) await h({ op: "carryAnswer", id: card.id, yes: true });
  const r = await p;
  expect(JSON.stringify(r)).not.toContain("口が分かりません");
  expect(got).toContain("cookie_names");
  expect(got).toContain("cookie_get");
});

// --- 2. W14 / vault: 承諾の後（bw を引いている間）に「全部止める」・取り戻しが来たら、headless の欄に入れない
const SECRET = "review14-VAULT-VALUE-5521", KEY = "fake-session-key-r14";
setDefaultTimeout(120_000); // holes-30: fake bw の初回 exec は load が高いと 4〜10 秒＝既定の 30 秒を、混み倍率×実測の余裕に
function slowBw() {
  const dir = mktmp("r14bw");
  writeFileSync(join(dir, "items.json"), JSON.stringify([{ id: "i1", login: { uris: [{ uri: "https://app.example.com/login" }] } }]));
  const bin = sharedExe("bw-slow", `#!/bin/sh\nsleep 0.4\nif [ "$1" = list ]; then cat "$FAKEBW_DIR/items.json"; else printf '%s\\n' '${SECRET}'; fi\n`); // holes-29 と同じ: 新しい inode の初回 exec は load が高いと数秒＝作る度に待たない
  process.env.FAKEBW_DIR = dir;
  return bin;
}
const fakeCdp = () => {
  const sent: string[] = [];
  const cdp: Cdp = {
    send: async (method, params: any = {}) => {
      sent.push(method);
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "t0", type: "page", url: "https://app.example.com/login" }] };
      if (method === "Target.attachToTarget") return { sessionId: "t0" };
      if (method === "Runtime.evaluate") return { result: { value: String(params.expression) === "location.hostname" ? "app.example.com" : 1 } };
      return {};
    },
    close() {},
  };
  return { cdp, sent };
};
for (const how of ["endAll", "end"] as const) {
  test(`W14 vault: 承諾の後・入れる前に ${how}（全部止める / 取り戻し）が来たら、欄に何も入れない`, async () => {
    const f = fakeCdp();
    const v = makeVault({ browserUrl: async () => "http://127.0.0.1:1", connect: async () => f.cdp, bin: slowBw, session: () => KEY, approvalMs: 3000 });
    const p = v.fill("s:1", "https://app.example.com/login");
    for (const end = Date.now() + 3000; !v.cards().length && Date.now() < end;) await tick(5);
    expect(v.answer(v.cards()[0]!.id, true, true)).toBe(true);
    await tick(150); // bw list が走っている間
    if (how === "endAll") v.endAll(); else v.end("s:1");
    const r = await p;
    expect(r.ok).toBe(false);
    expect(f.sent).not.toContain("Input.insertText");
  });
}

// --- 3. W11e-2: 面を持つ turn は、任意の URL へ移れる agent 用ブラウザ（mcp__browser）も持たない（WebFetch を外しても browser で同じ事ができる）
test("W11e-2: 面を持つ turn は WebFetch も mcp__browser も無い・面の無い turn は両方ある", async () => {
  const calls: string[][] = [];
  const spawn = (cmd: string[]) => {
    calls.push(cmd);
    let done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: () => {} });
    return { stdout, exited: new Promise<number>((r) => (done = r)), kill: () => done(143) };
  };
  const driver: Driver = { call: async (tool) => ({ text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }), close() {} };
  const s = openStore(":memory:");
  const h = makeHandler(s, async () => [], undefined,
    { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => "http://127.0.0.1:9" },
    { uiHome: mktmp("kangae-ui"), leaseDriver: () => driver });
  const a = s.add(null, "user", "調べる", true);
  const r0: any = await h({ op: "workspace", nodeId: a.id, agent: true, text: "go" });
  const tools = (i: number) => calls[i]![calls[i]!.indexOf("--allowedTools") + 1]!;
  expect(tools(0)).toContain("mcp__browser");
  expect(tools(0)).toContain("WebFetch");
  await h({ op: "stopRun", runId: r0.run.id });
  expect(((await h({ op: "leaseGive", rootId: a.id, pid: 10, windowId: 1, app: "Bank", title: "" })) as any).ok).toBe(true);
  await h({ op: "resume", rootId: a.id });
  expect(tools(1)).toContain("act:*");
  expect(tools(1)).not.toContain("WebFetch");
  expect(tools(1)).not.toContain("mcp__browser");
  expect(calls[1]!.join(" ")).not.toContain("browser-mcp.json");
});

// --- 4. W11e-3: gemini の実体の置き場が home（や / ）になる時は、読みを戻さない（後勝ちの allow が home の deny を丸ごと消す）
test("W11e-3: ~/bin/gemini のように dirname 2 回が home 以上になる置き場は null（替え先にしない）", () => {
  const top = mktmp("r14g");
  const g = join(top, "gemini"); writeFileSync(g, "");
  expect(geminiReadDirs(g, g)).toHaveLength(2); // 普通の置き場は今まで通り
  // ~/bin/gemini（dirname 2 回 = ~）と同じ形を、人の home に file を置かずに作る: /bin/sh は dirname 2 回 = /（home の祖先）
  expect(geminiReadDirs("/bin/sh", g)).toBeNull();
  expect(geminiReadDirs(g, "/bin/sh")).toBeNull();
});
