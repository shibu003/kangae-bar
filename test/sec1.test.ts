// sec1: 人が押す op（src/main.ts の HUMAN_OPS）は agent の口（unix socket の CLI・owner つき・agent 印）から呼べない。人の口（panel の owner {}・スマホの remoteBridge・拡張の native host）からは今まで通り通る。
// 正本 docs/BRIEF-sec1.md / docs/diagrams.md §S1。読む file を literal で名指す: "src/main.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HUMAN_OPS, makeHandler, remoteBridge } from "../src/main.ts";
import { type Driver } from "../src/lease.ts";
import { openStore } from "../src/store.ts";
import { humanAsk } from "./human-ask.ts";
import { spawnDaemon, waitDaemon } from "./spawn-daemon";
setDefaultTimeout(120_000);

const agentMouth = () => ({ write() {} }); // agent の CLI が繋ぐ unix socket の形
const refusal = (op: string) => `${HUMAN_OPS[op]}は人が押す物です（agent からは押せません）`;
const tick = () => new Promise((r) => setTimeout(r, 5));

let D: string, home: string;
beforeEach(() => { D = mktmp("sec1"); home = join(D, "home"); mkdirSync(home); });
afterEach(() => rmSync(D, { recursive: true, force: true }));

// 承認 card が出る組み立て: web の tab を 1 枚渡した会話の agent が、その tab で操作する（拡張の返事は固定）
const mk = (o: { isExtension?: (x: unknown) => boolean } = {}) => {
  const driver: Driver = { call: async (tool) => ({ text: "ok", isError: false, data: tool === "tab_info" ? { docId: "d", title: "課題", url: "https://canvas.example/courses/1" } : tool === "tab_state" ? { exists: true, docId: "d" } : null }), close() {} };
  const s = openStore(":memory:");
  const ws = { dir: join(D, "ws"), bin: "/x/kangae", open: async () => true, clis: async () => [], spawn: (() => { throw new Error("spawn しない"); }) as any, browserUrl: async () => null };
  const h: any = makeHandler(s, async () => [], undefined, ws, { uiHome: home, webDriver: driver, leaseDriver: () => null, isExtension: o.isExtension });
  return { s, h };
};
const withCard = async (h: any, s: ReturnType<typeof openStore>, tool = "type_text") => {
  const root = s.add(null, "user", "課題", true);
  expect((await h({ op: "leaseGive", rootId: root.id, tabId: 1 }, {})).ok).toBe(true);
  const lease = (await h({ op: "leaseList" })).leases[0];
  const act = h({ op: "act", lease: lease.token, tool, args: { text: "こんにちは" } });
  for (let i = 0; i < 200 && !(await h({ op: "leaseList" })).approvals.length; i++) await tick();
  return { root, act, card: (await h({ op: "leaseList" })).approvals[0] };
};

test("sec1-1 集合の全部: agent の口（unix socket・owner つき・agent 印）はどの op も同じ 1 種類の文で断られ、人の口（owner {}）は入口で断られない", async () => {
  const { h } = mk();
  expect(Object.keys(HUMAN_OPS)).toEqual(expect.arrayContaining(["approvalAnswer", "routineAnswer", "carryAnswer", "carryForget", "leaseMode", "vaultKey", "vaultLock", "distillMake"]));
  for (const op of Object.keys(HUMAN_OPS)) {
    for (const [m, from] of [[{ op }, agentMouth()], [{ op, owner: "s:1" }, {}], [{ op, owner: "" }, {}], [{ op, agent: true }, {}]] as const) {
      const r = await h(m, from);
      expect({ op, r }).toEqual({ op, r: { ok: false, code: "bad", hint: refusal(op), id: undefined } });
    }
    const human = await h({ op }, {}); // 人の口: 中身の検査（引数が空）で断られる事はあっても、入口の文では断られない
    expect(String(human.hint ?? "")).not.toContain("人が押す物です");
  }
});

test("sec1-2 通し: agent の口が自分の承認 card に答えても断られて card は残る・人（panel の owner {}）が押すと通って card が消え、agent の操作が進む", async () => {
  const { s, h } = mk();
  await h({ op: "leaseMode", app: "web", mode: "ask" }, {});
  const { act, card } = await withCard(h, s);
  expect(card).toMatchObject({ tool: "type_text" });
  const r = await h({ op: "approvalAnswer", id: card.id, yes: true }, agentMouth());
  expect(r).toMatchObject({ ok: false, hint: refusal("approvalAnswer") });
  expect((await h({ op: "leaseList" })).approvals.map((a: any) => a.id)).toEqual([card.id]); // 答えは届いていない
  expect(await h({ op: "approvalAnswer", id: card.id, yes: true }, {})).toMatchObject({ ok: true });
  expect((await h({ op: "leaseList" })).approvals).toEqual([]);
  expect(await act).toMatchObject({ ok: true });
});

test("sec1-2b 先回り: agent の口が card の id を message の id にして別の op（ping）や断られる答えを先に送っても、後から押した人の答えは控えに塞がれず通る（approvalAnswer の id は card の id）", async () => {
  const { s, h } = mk();
  await h({ op: "leaseMode", app: "web", mode: "ask" }, {});
  const { act, card } = await withCard(h, s);
  expect(await h({ op: "ping", id: card.id }, agentMouth())).toMatchObject({ ok: true }); // 同じ id で別の op の控えを作る
  expect(await h({ op: "approvalAnswer", id: card.id, yes: true }, agentMouth())).toMatchObject({ ok: false }); // 断りも控えに残らない
  expect(await h({ op: "approvalAnswer", id: card.id, yes: true }, {})).toMatchObject({ ok: true });
  expect((await h({ op: "leaseList" })).approvals).toEqual([]); // 塞がれていれば card が残る（act を待つ前に赤にする）
  expect(await act).toMatchObject({ ok: true });
});

test("sec1-3 leaseMode: agent の口からは表を書き換えられない（allow にして自分の承認を飛ばせない）・人は変えられる", async () => {
  const { h } = mk();
  expect(await h({ op: "leaseMode", app: "*", mode: "allow" }, agentMouth())).toMatchObject({ ok: false, hint: refusal("leaseMode") });
  expect((await h({ op: "leaseList" })).modes).not.toMatchObject({ default: "allow" });
  expect(await h({ op: "leaseMode", app: "web", mode: "allow" }, {})).toMatchObject({ ok: true, modes: { web: "allow" } });
});

test("sec1-4 拡張: webHello で OS に確かめた native host の 1 本の口は人の口。確かめていない別の口は agent の口のまま", async () => {
  const ext = agentMouth(), other = agentMouth(); // どちらも unix socket の形（拡張の panel は native host の unix socket から来る）
  const { s, h } = mk({ isExtension: (o) => o === ext });
  await h({ op: "leaseMode", app: "web", mode: "ask" }, {});
  expect(await h({ op: "webHello", id: "w:hello" }, ext)).toMatchObject({ ok: true });
  const { act, card } = await withCard(h, s);
  expect(await h({ op: "approvalAnswer", id: card.id, yes: true }, other)).toMatchObject({ ok: false, hint: refusal("approvalAnswer") });
  expect((await h({ op: "leaseList" })).approvals).toHaveLength(1);
  expect(await h({ op: "approvalAnswer", id: card.id, yes: true }, ext)).toMatchObject({ ok: true });
  expect(await act).toMatchObject({ ok: true });
});

test("sec1-5 スマホ（R2 の remoteBridge）は人の道として通る: owner 無しで approvalAnswer を呼び、今回の 1 件に答える・agent の口で同じ id に答えても断られる", async () => {
  const { s, h } = mk();
  await h({ op: "leaseMode", app: "web", mode: "ask" }, {});
  const { root, act, card } = await withCard(h, s);
  expect(card.danger).toBeFalsy(); // danger はスマホから答えられない（Mac でだけ）ので、非 danger の card で測る
  const bridge = remoteBridge(s, () => h, home);
  expect(await h({ op: "approvalAnswer", id: card.id, yes: true }, agentMouth())).toMatchObject({ ok: false });
  expect(await bridge.answer(root.id, card.id, true, Number(card.at), { id: "dev-sec1-xxxx", name: "iPhone" })).toBe("answered");
  expect(await act).toMatchObject({ ok: true });
});

test("sec1-6 本物の常駐: unix socket から 承認 / 表 / 金庫の鍵 を送っても断られて何も変わらず、/ws（bar.json の port と token）なら通る。CLI の vault-key は人の口へ送る・agent の turn の中（KANGAE_OWNER）では打たない", async () => {
  const sock = join(D, "m.sock"), bar = join(D, "bar.json");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_BAR: bar, KANGAE_NODES_DIR: join(D, "nodes") };
  delete env.KANGAE_LEASES; delete env.KANGAE_LEASE;
  const daemon = spawnDaemon(["bun", "src/main.ts", "--daemon"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  try {
    await waitDaemon(daemon, { bar, sock });
    const ask = (m: Record<string, unknown>): Promise<any> => new Promise((resolve) => {
      const id = (m.id as string | undefined) ?? crypto.randomUUID(); let buf = ""; // approvalAnswer の id は card の id（返事の id もそれ）
      Bun.connect({ unix: sock, socket: { data(s, c) { buf += new TextDecoder().decode(c); for (const l of buf.split("\n")) { try { const j = JSON.parse(l); if (j.id === id) { s.end(); resolve(j); } } catch {} } }, error() {} } }).then((s) => s.write(JSON.stringify({ ...m, id }) + "\n"));
    });
    const human = humanAsk(bar);
    const cli = (owner: string | undefined, stdin: string, ...a: string[]) => { const p = Bun.spawn(["bun", "src/main.ts", ...a], { env: owner ? { ...env, KANGAE_OWNER: owner } : env, stdin: new Response(stdin), stdout: "pipe", stderr: "pipe" }); return p; };
    // 面の無い agent の `act open_app` → 承認 card（W25 と同じ入口）
    const a = (await human({ op: "add", text: "agentA の仕事" })).node;
    const p = cli(`s:${a.id}`, "", "act", "open_app", JSON.stringify({ app: "Preview" }));
    let c: any = null;
    for (let i = 0; i < 200 && !c; i++) { c = (await ask({ op: "leaseList" })).approvals?.[0]; if (!c) await Bun.sleep(100); }
    expect(c).toMatchObject({ tool: "open_app", owner: `s:${a.id}` });
    // agent の口（生の unix socket）: 承認・表・金庫の鍵・金庫を閉じる は断られ、card は残り、表は変わらない
    expect(await ask({ op: "approvalAnswer", id: c.id, yes: true })).toMatchObject({ ok: false, hint: refusal("approvalAnswer") });
    expect(await ask({ op: "leaseMode", app: "*", mode: "allow" })).toMatchObject({ ok: false, hint: refusal("leaseMode") });
    expect(await ask({ op: "vaultKey", key: "fake-session-key" })).toMatchObject({ ok: false, hint: refusal("vaultKey") });
    expect(await ask({ op: "vaultLock" })).toMatchObject({ ok: false, hint: refusal("vaultLock") });
    const after = await ask({ op: "leaseList" });
    expect(after.approvals.map((x: any) => x.id)).toEqual([c.id]);
    expect(after.modes).not.toMatchObject({ "*": "allow" });
    // CLI の vault-key: agent の turn の中では打てず、人の shell なら /ws 経由で鍵が入る（unix socket の agent の口は使わない）
    const inTurn = cli(`s:${a.id}`, "fake-session-key\n", "vault-key");
    expect(await inTurn.exited).toBe(1);
    expect(await new Response(inTurn.stderr).text()).toContain("あなた（人）が自分のターミナルで打ちます");
    const mine = cli(undefined, "fake-session-key\n", "vault-key");
    expect(await mine.exited).toBe(0);
    expect(await new Response(mine.stdout).text()).toContain("金庫の鍵を本体に渡しました");
    const lock = cli(undefined, "", "vault-lock");
    expect(await lock.exited).toBe(0);
    // 人の口（/ws）で断ると、止まっていた CLI が「拒否(denied)」で終わる
    expect(await human({ op: "approvalAnswer", id: c.id, yes: false })).toMatchObject({ ok: true });
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toContain("拒否(denied)");
  } finally { try { daemon.kill(); } catch {} }
}, 150_000);
