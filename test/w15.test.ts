import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgents } from "../src/agents.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

// W15: bar の丸い icon の赤い数 = op "unread"。終わると増え、開く（agentRead）と減り、0 で空
test("W15 unread: 終わった agent の数を新しい順で返し、既読で減る", async () => {
  const uiHome = mktmp("w15");
  const store = openStore(":memory:");
  const h = makeHandler(store, async () => [], undefined,
    { dir: uiHome, bin: "/x/kangae", open: async () => true, clis: async () => [], spawn: (() => { throw new Error("no spawn"); }) as any, browserUrl: async () => null },
    { uiHome, broadcast: () => {} });
  const A = store.add(null, "user", "A", true), B = store.add(null, "user", "B", true);
  await h({ op: "agentName", rootId: A.id, name: "甲" });
  await h({ op: "agentName", rootId: B.id, name: "乙" });
  expect(await h({ op: "unread" })).toEqual({ ok: true, n: 0, rootIds: [] });
  const ag = makeAgents(uiHome); // 同じ home の同じ file（終わりの印は agents.finish が書く）
  ag.finish("甲", { unread: true, answeredAt: 100 });
  ag.finish("乙", { unread: true, answeredAt: 200 });
  expect(await h({ op: "unread" })).toEqual({ ok: true, n: 2, rootIds: [B.id, A.id] });
  await h({ op: "agentRead", rootId: B.id });
  expect(await h({ op: "unread" })).toEqual({ ok: true, n: 1, rootIds: [A.id] });
  await h({ op: "agentRead", rootId: A.id });
  expect((await h({ op: "unread" }) as any).n).toBe(0);
}, 120_000); // holes-30: 固定の sleep は無い。load 600 超で process の起動待ちが 30 秒を食った時だけ割れる＝締切を実の時間に
