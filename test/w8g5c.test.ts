// W8g-5c: 口の確認（codesign）が重い時に、拡張の頼みが 8 秒で「応答しません」にならない・同じ口は 1 回だけ確かめる・pid の再利用は別の口。本物の Chrome・金庫には触らない（偽の browser = この試験の bun）
import { mktmp } from "./tmp.ts";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT_ORIGIN, extensionPeer, makeHandler } from "../src/main.ts";
import { browserHost, hostSeen, peerPid, proc } from "../src/peer.ts";
import { openStore } from "../src/store.ts";


// sock: 名前 → 口。answer = tab_info に即答する口。verify の済んでいない口の返事は常駐が捨てる（W8g-5）
function rig(peers: Record<string, { answer: boolean; slow: boolean }>, verifyMs: number, webPeerMs?: number) {
  const s = openStore(":memory:");
  const sock: Record<string, object> = Object.fromEntries(Object.keys(peers).map((k) => [k, {}]));
  const sent: string[] = [];
  let h: ReturnType<typeof makeHandler>;
  h = makeHandler(s, async () => [], undefined, undefined, {
    awaitWebPeer: true, webPeerMs,
    isExtension: async (o) => { const n = Object.keys(sock).find((k) => sock[k] === o)!; if (peers[n]!.slow) await Bun.sleep(verifyMs); return true; },
    broadcast: (m: any) => {
      if (m.type !== "web") return;
      sent.push(m.tool);
      for (const [n, p] of Object.entries(peers)) if (p.answer) queueMicrotask(() => void h({ op: "webResult", callId: m.id, text: "", data: { docId: "d1", title: "t", url: "https://a.example/" } }, sock[n]!));
    },
  });
  return { h, sock, sent, root: s.add(null, "user", "課題", true) };
}

test("確認に 3 秒かかる新しい口が居る時、その口の返事は捨てられず「応答しません」にならない（前から居る口は黙っている）", async () => {
  const { h, sock, root } = rig({ old: { answer: false, slow: false }, fresh: { answer: true, slow: true } }, 3000);
  await h({ op: "webHello" }, sock.old!);
  void h({ op: "webHello" }, sock.fresh!);
  const t0 = Date.now();
  expect(await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" })).toMatchObject({ ok: true });
  expect(Date.now() - t0).toBeLessThan(8000); // 確認中の口の返事を捨てると、8 秒の締切で送り直してから通る
}, 40_000);

test("確認が 8 秒を越えても、頼みは確認の後に 1 回だけ送る（確認の時間を返事の 8 秒に数えない）", async () => {
  const { h, sock, sent, root } = rig({ old: { answer: false, slow: false }, fresh: { answer: true, slow: true } }, 9000);
  await h({ op: "webHello" }, sock.old!);
  void h({ op: "webHello" }, sock.fresh!);
  expect(await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" })).toMatchObject({ ok: true });
  expect(sent.filter((t) => t === "tab_info")).toHaveLength(1); // 先に送ると 8 秒で「応答しません」→ 送り直しで 2 回
}, 40_000);

test("まだ口が 1 つも無く、確認が拡張を待つ時間（webPeerMs）より長くても、確認が済めば頼みは通る", async () => {
  const { h, sock, root } = rig({ fresh: { answer: true, slow: true } }, 3000, 500);
  void h({ op: "webHello" }, sock.fresh!);
  expect(await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" })).toMatchObject({ ok: true });
}, 40_000);

test("確認に落ちた口しか無ければ、確認の後に「繋がっていません」（待ち続けない）", async () => {
  const s = openStore(":memory:");
  const fake = {};
  const h = makeHandler(s, async () => [], undefined, undefined, { awaitWebPeer: true, webPeerMs: 100, isExtension: async () => { await Bun.sleep(300); return false; }, broadcast: () => {} });
  void h({ op: "webHello" }, fake);
  const r = await h({ op: "leaseGive", rootId: s.add(null, "user", "課題", true).id, tabId: 7, title: "t" });
  expect(r).toMatchObject({ ok: false, hint: expect.stringContaining("繋がっていません") });
});

// 試験の bun を「browser」に見立てる（w8g5.test.ts と同じ形）: 親（mid）が子（host）を起こし、子が socket に繋ぐ。fd を受けた所で use を呼ぶ
async function withHost<T>(use: (fd: number) => Promise<T>): Promise<T> {
  const d = mktmp("w8g5c");
  const sock = join(d, "s.sock");
  const got = new Promise<T>((res, rej) => {
    const srv = Bun.listen({ unix: sock, socket: { open(s) { use((s as unknown as { fd: number }).fd).then(res, rej).finally(() => srv.stop(true)); }, data() {} } });
  });
  writeFileSync(join(d, "host.ts"), `await Bun.connect({ unix: ${JSON.stringify(sock)}, socket: { data() {} } }); await Bun.sleep(8000);`);
  writeFileSync(join(d, "mid.ts"), `const p = Bun.spawn([process.execPath, ${JSON.stringify(join(d, "host.ts"))}, ${JSON.stringify(EXT_ORIGIN)}]); await p.exited;`);
  const p = Bun.spawn([process.execPath, join(d, "mid.ts")], { stdout: "ignore", stderr: "ignore" });
  try { return await got; } finally { p.kill(); }
}
const ok = { browsers: [process.execPath], profiles: [], origin: EXT_ORIGIN };
const wrong = { browsers: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"], profiles: [], origin: EXT_ORIGIN };

test("同じ口の 2 回目は確かめ直さない（2 回目に決まりを変えても 1 回目の答え）", async () => {
  const [a, b] = await withHost(async (fd) => [await browserHost(fd, ok), await browserHost(fd, wrong)] as const);
  expect(a).toEqual({ ok: true, why: "" });
  expect(b).toEqual({ ok: true, why: "", cached: true });
});

test("pid が再利用された（起動時刻が違う）口は別の口として確かめる・起動時刻が同じなら前の答え", async () => {
  const [other, same] = await withHost(async (fd) => {
    const pid = peerPid(fd)!, start = proc(pid)!.start;
    hostSeen.set(`${pid}:${start - 1}`, Promise.resolve({ ok: true, why: "" })); // 前に同じ pid を使っていた別の process の答え
    const other = await browserHost(fd, wrong);
    hostSeen.set(`${pid}:${start}`, Promise.resolve({ ok: true, why: "" }));
    return [other, await browserHost(fd, wrong)] as const;
  });
  expect(other.ok).toBe(false);
  expect(same).toEqual({ ok: true, why: "", cached: true });
});

test("確認の時間を ms で log に 1 行（通した / 断った と理由）", async () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    await extensionPeer({}, {}, false, mktmp("w8g5c-home"));
    expect(err.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/^webHello の口の確認 \d+ms: 断った: unix socket の口ではない$/));
  } finally { err.mockRestore(); }
});
