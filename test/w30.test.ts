// W30: 面なしで始めた turn の `act open_app` の返事は `act --on '<token>'` を案内するのに、常駐は on を名前（window）としてしか引かず「という面はありません」になった（GAPS 手 4）。持ち主が今持っている面の token と完全に一致する on だけを通す。読む file を literal で名指す: "src/main.ts" "src/lease.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickLease, tokenOf, type Driver } from "../src/lease.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

let top: string, calls: { tool: string; args: Record<string, any> }[];
const drv: Driver = { call: async (tool, args) => { calls.push({ tool, args }); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }, { pid: 20, window_id: 2 }] } : null }; }, close() {} };
beforeEach(() => { top = realpathSync(mktmp("w30")); mkdirSync(join(top, "ui")); calls = []; });
afterEach(() => rmSync(top, { recursive: true, force: true }));
const harness = () => {
  const s = openStore(":memory:");
  const H: any = makeHandler(s, async () => [], undefined, { dir: join(top, "nodes"), bin: "/x/kangae", open: async () => true, clis: async () => [], spawn: () => { throw new Error("no spawn"); }, browserUrl: async () => null }, { uiHome: join(top, "ui"), leaseDriver: () => drv });
  mkdirSync(join(top, "nodes"), { recursive: true });
  return { H, s };
};

test("W30-1 再現（GAPS 手 4）: 面の無い env の pickLease は on を見ず token 空を返す＝CLI は owner と on だけを常駐へ送る（lease を送れない）", () => {
  expect(pickLease({}, "10:1|1|s:1")).toEqual({ ok: true, token: "" });
  const src = readFileSync("src/main.ts", "utf8");
  expect(src.includes("const hasTok = pick.ok && pick.token !== \"\";")).toBe(true);
  expect(src.includes("const late = !hasTok && on && process.env.KANGAE_OWNER;")).toBe(true);
});

test("W30-2 常駐: owner が今持っている面の token（open_app の返事のとおり）を on に渡すと通る・名前（window）も従来どおり通る", async () => {
  const { H, s } = harness();
  const a = s.add(null, "user", "agentA", true);
  expect((await H({ op: "leaseGive", rootId: a.id, pid: 10, windowId: 1, app: "Zed", title: "" })).ok).toBe(true);
  const leases = ((await H({ op: "leaseList" })) as any).leases;
  const token: string = leases[0].token;
  const owner = `s:${a.id}`;
  const byToken: any = await H({ op: "act", owner, on: token, tool: "get_window_state", args: {} });
  expect(byToken.ok).toBe(true);
  const byName: any = await H({ op: "act", owner, on: "window", tool: "get_window_state", args: {} });
  expect(byName.ok).toBe(true);
  expect(calls.filter((c) => c.tool === "get_window_state").every((c) => c.args.pid === 10 && c.args.window_id === 1)).toBe(true);
});

test("W30-3 他の持ち主の token・世代の違う token・作った token は通らない（生の token を受けない境界は保つ）", async () => {
  const { H, s } = harness();
  const a = s.add(null, "user", "agentA", true), b = s.add(null, "user", "agentB", true);
  await H({ op: "leaseGive", rootId: a.id, pid: 10, windowId: 1, app: "Zed", title: "" });
  await H({ op: "leaseGive", rootId: b.id, pid: 20, windowId: 2, app: "Preview", title: "" });
  const ls = ((await H({ op: "leaseList" })) as any).leases as any[];
  const aTok = ls.find((l) => l.owner === `s:${a.id}`).token as string, bTok = ls.find((l) => l.owner === `s:${b.id}`).token as string;
  calls = [];
  for (const on of [bTok, aTok.replace(/\|\d+\|/, "|999|"), `10:1|1|s:${b.id}`, "10:1"]) {
    const r: any = await H({ op: "act", owner: `s:${a.id}`, on, tool: "get_window_state", args: {} });
    expect(r.ok).toBe(false);
    expect(r.hint).toContain("という面はありません");
  }
  expect(calls.filter((c) => c.tool === "get_window_state")).toEqual([]); // どれも窓へは届かない
  void tokenOf;
});
