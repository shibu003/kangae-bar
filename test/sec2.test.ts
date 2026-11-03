// sec2: 窓を渡す（leaseGive）・渡した窓の再確認（leaseReconfirm）・鍵の保存（setKey）・画面の操作の任せ先（screenEngine）は、agent が自分に権限を足せる口＝人が押す op（src/main.ts の HUMAN_OPS）。
// agent の口（unix socket・owner つき・agent 印）からは断られ、人の口（panel / Bar の owner {}）と常駐の中の呼び（modRun → handle の leaseGive）は通る。leaseTakeback（人が取り返す）は権限が減るだけなので集合に入れない。
// 正本 docs/BRIEF-sec2.md / docs/diagrams.md §S1。読む file を literal で名指す: "src/main.ts"
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HUMAN_OPS, makeHandler } from "../src/main.ts";
import { type Driver } from "../src/lease.ts";
import { readEngine } from "../src/screen.ts";
import { openStore } from "../src/store.ts";

const agentMouths = () => [[{}, { write() {} }], [{ owner: "s:1" }, {}], [{ owner: "" }, {}], [{ agent: true }, {}]] as const; // unix socket・owner つき・owner ""・agent 印
const refusal = (op: string) => `${HUMAN_OPS[op]}は人が押す物です（agent からは押せません）`;

function setup() {
  const driver: Driver = { call: async (tool) => ({ text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 7 }] } : null }), close() {} };
  const uiHome = mktmp("kangae-ui"), modsRoot = mktmp("mods");
  const saved: [string, string][] = [];
  const s = openStore(":memory:");
  const spawn = () => ({ stdout: new ReadableStream<Uint8Array>(), exited: new Promise<number>(() => {}), kill() {} });
  const h: any = makeHandler(s, async () => [], async (p, k) => { saved.push([p, k]); },
    { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn: spawn as any, browserUrl: async () => null },
    { uiHome, leaseDriver: () => driver, modsRoot });
  return { h, s, uiHome, modsRoot, saved };
}
const give = { op: "leaseGive", pid: 10, windowId: 7, app: "Zed", title: "" };

test("sec2-1 集合: 自己付与の 4 つは入り、人が取り返すだけの leaseTakeback は入らない", () => {
  for (const op of ["leaseGive", "leaseReconfirm", "setKey", "screenEngine"]) expect(Object.hasOwn(HUMAN_OPS, op)).toBe(true);
  expect(Object.hasOwn(HUMAN_OPS, "leaseTakeback")).toBe(false);
});

test("sec2-2 通し: agent の口が自分に窓を渡そうとしても断られ lease は増えない・人（owner {}）が渡すと通り、agent の口からでも取り返しは通る", async () => {
  const { h, s } = setup();
  const root = s.add(null, "user", "会話", true);
  for (const [extra, from] of agentMouths()) {
    expect(await h({ ...give, rootId: root.id, ...extra }, from)).toMatchObject({ ok: false, code: "bad", hint: refusal("leaseGive") });
    expect((await h({ op: "leaseList" })).leases).toEqual([]); // 渡っていない
  }
  const g = await h({ ...give, rootId: root.id }, {});
  expect(g).toMatchObject({ ok: true, rootId: root.id });
  expect((await h({ op: "leaseList" })).leases).toHaveLength(1);
  expect(await h({ op: "leaseTakeback", key: g.lease.key ?? "10:7" }, { write() {} })).toMatchObject({ ok: true }); // 権限が減るだけの口は agent からも通る
  expect((await h({ op: "leaseList" })).leases).toEqual([]);
});

test("sec2-3 leaseReconfirm: agent の口は世代も期限も動かせない・人は戻せる", async () => {
  const { h, s } = setup();
  const root = s.add(null, "user", "会話", true);
  await h({ ...give, rootId: root.id }, {});
  const l0 = (await h({ op: "leaseList" })).leases[0], before = { gen: l0.gen, exp: l0.exp }; // 表の lease は同じ object（あとで書き換わる）なので数値で控える
  for (const [extra, from] of agentMouths()) expect(await h({ op: "leaseReconfirm", key: l0.key, ...extra }, from)).toMatchObject({ ok: false, hint: refusal("leaseReconfirm") });
  expect((await h({ op: "leaseList" })).leases[0]).toMatchObject(before);
  const r = await h({ op: "leaseReconfirm", key: l0.key }, {});
  expect(r).toMatchObject({ ok: true });
  expect(r.lease.gen).toBeGreaterThan(before.gen);
});

test("sec2-4 setKey: agent の口は鍵を書き換えられない（保存の関数が呼ばれない）・人は書ける", async () => {
  const { h, saved } = setup();
  for (const [extra, from] of agentMouths()) expect(await h({ op: "setKey", provider: "anthropic", key: "sk-agent", ...extra }, from)).toMatchObject({ ok: false, hint: refusal("setKey") });
  expect(saved).toEqual([]);
  expect(await h({ op: "setKey", provider: "anthropic", key: "sk-human" }, {})).toMatchObject({ ok: true });
  expect(saved).toEqual([["anthropic", "sk-human"]]);
});

test("sec2-5 screenEngine: agent の口は窓の文字が外へ出る相手（d1）に替えられない・読みも断る・人は替えられる", async () => {
  const { h, uiHome } = setup();
  for (const [extra, from] of agentMouths()) expect(await h({ op: "screenEngine", engine: "d1", ...extra }, from)).toMatchObject({ ok: false, hint: refusal("screenEngine") });
  expect(readEngine(uiHome)).toBe("claude");
  expect(await h({ op: "screenEngine", engine: "d1" }, {})).toMatchObject({ ok: true, engine: "d1" });
  expect(readEngine(uiHome)).toBe("d1");
});

test("sec2-6 常駐の中の呼び: 人が mod の札を押す（modRun）と、中で呼ぶ leaseGive は集合に入っていても断られず窓が渡る・agent の口の modRun は断られ何も渡らない", async () => {
  const { h, s, modsRoot } = setup();
  const d = join(modsRoot, "Zed", "greet");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "mod.json"), JSON.stringify({ label: "挨拶", permission: "write" }));
  writeFileSync(join(d, "prompt.md"), "Zed に挨拶を 1 行書く");
  const root = s.add(null, "user", "会話", true);
  const run = { op: "modRun", key: "Zed/greet", rootId: root.id, pid: 10, app: "Zed", title: "" };
  expect(await h({ op: "modOn", key: "Zed/greet", yes: true }, {})).toMatchObject({ ok: true });
  expect(await h(run, { write() {} })).toMatchObject({ ok: false, hint: refusal("modRun") });
  expect((await h({ op: "leaseList" })).leases).toEqual([]);
  expect(await h(run, {})).toMatchObject({ ok: true });
  expect((await h({ op: "leaseList" })).leases[0].surface).toMatchObject({ pid: 10, windowId: 7, app: "Zed" });
});
