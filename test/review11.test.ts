// review11 の攻撃: W8g-4b の値の宛先（unicast）。偽の bw・偽の口（本物の金庫・Chrome には触らない）
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

const SECRET = "hunter2-R11-VALUE-4408";
const KEY = "fake-session-key-r11";

function bwBin() {
  const dir = mktmp("r11");
  writeFileSync(join(dir, "items.json"), JSON.stringify([{ id: "i1", login: { uris: [{ uri: "https://app.example.com/" }] } }]));
  const bin = join(dir, "bw");
  writeFileSync(bin, `#!/bin/sh\n[ "$BW_SESSION" = "${KEY}" ] || exit 1\nif [ "$1" = list ]; then cat "${dir}/items.json"; else printf '%s\\n' '${SECRET}'; fi\n`);
  armExe(bin);
  return bin;
}

// peers: name → その口が probe / tab_info にどう答えるか（"has" = tab を持つ拡張・"none" = tab が無い拡張・"silent" = 黙って待つだけの口・"liar" = 偽の返事で先に答える口）
async function scenario(peers: Record<string, "has" | "none" | "silent" | "liar">, fakes: string[] = []) {
  process.env.KANGAE_BW = bwBin();
  const s = openStore(":memory:");
  const sock: Record<string, object> = Object.fromEntries(Object.keys(peers).map((k) => [k, {}]));
  const got: Record<string, string[]> = Object.fromEntries(Object.keys(peers).map((k) => [k, []]));
  let h: ReturnType<typeof makeHandler>;
  const answer = (name: string, m: any) => {
    const kind = peers[name]!;
    if (kind === "silent") return;
    let data: any = null, error = false;
    const has = kind === "has" || kind === "liar";
    if (!has) error = true;
    else if (m.tool === "tab_info") data = { docId: "d1", title: "t", url: "https://app.example.com/login" };
    else if (m.tool === "vault_fill") data = typeof m.args.value === "string" ? { filled: SECRET.length } : { n: 1 };
    queueMicrotask(() => void h({ op: "webResult", callId: m.id, text: error ? "その tab はもうありません" : "", error, data }, sock[name]!));
  };
  const deliver = (names: string[], m: any) => { for (const n of names) { got[n]!.push(JSON.stringify(m)); answer(n, m); } };
  h = makeHandler(s, async () => [], undefined, undefined, {
    awaitWebPeer: true, carryMs: 3000,
    isExtension: (o) => !fakes.some((n) => sock[n] === o), // 本物の口か（常駐では src/peer.ts が OS に聞く）
    broadcast: (m) => deliver(Object.keys(peers), m),
    unicast: (to, m) => deliver(Object.keys(peers).filter((n) => to.has(sock[n])), m),
  });
  const root = s.add(null, "user", "課題", true);
  for (const n of Object.keys(peers)) await h({ op: "webHello" }, sock[n]);
  expect(await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" })).toMatchObject({ ok: true });
  expect(await h({ op: "vaultKey", key: KEY })).toMatchObject({ ok: true });
  const p = h({ op: "vaultFill", owner: `s:${root.id}`, url: "https://app.example.com/login" });
  let card: any; for (const end = Date.now() + 5000; !card && Date.now() < end; await Bun.sleep(5)) card = ((await h({ op: "leaseList" })) as any).carries.find((c: any) => c.vault);
  if (card) await h({ op: "carryAnswer", id: card.id, yes: true, vault: true });
  const r = await p;
  delete process.env.KANGAE_BW;
  return { r, leaked: (n: string) => got[n]!.filter((x) => x.includes(SECRET)).length };
}

test("同じ拡張が 2 つの browser に居る: tab を持たない方の口には値を送らない", async () => {
  const { r, leaked } = await scenario({ mine: "has", other: "none" });
  expect(r).toMatchObject({ ok: true });
  expect(leaked("mine")).toBe(1);
  expect(leaked("other")).toBe(0);
});

test("webHello しただけで下見に答えない口（agent の CLI が webHello した形）には値を送らない", async () => {
  const { r, leaked } = await scenario({ mine: "has", lurker: "silent" });
  expect(r).toMatchObject({ ok: true });
  expect(leaked("lurker")).toBe(0);
  expect(leaked("mine")).toBe(1);
});

// review11 の【穴】（W8g-5 で塞いだ）: 拡張の振りをした口が webHello して、偽の返事で下見に本物より先に答えても、値の宛先にならない。
// webHello は口の確かめ（isExtension）を通った口だけを webPeers に入れる＝偽の口の webResult は捨てられ、下見に答えた事にならない
test("偽の口が先に下見に答えても値は本物の口へだけ（webHello の確かめを外すと liar に 1 件・mine に 0 件で赤）", async () => {
  const { r, leaked } = await scenario({ liar: "liar", mine: "has" }, ["liar"]);
  expect(r).toMatchObject({ ok: true });
  expect(leaked("liar")).toBe(0);
  expect(leaked("mine")).toBe(1);
});

test("偽の口だけの時: webHello は断られ、web の依頼は誰にも送られない", async () => {
  const s = openStore(":memory:");
  const fake = {}, sent: unknown[] = [];
  const h = makeHandler(s, async () => [], undefined, undefined, { awaitWebPeer: true, webPeerMs: 50, isExtension: (o) => o !== fake, broadcast: (m) => sent.push(m) });
  expect(await h({ op: "webHello" }, fake)).toMatchObject({ ok: false });
  expect(await h({ op: "webResult", callId: "x", data: { n: 1 } }, fake)).toMatchObject({ ok: false });
  expect(await h({ op: "webSeen", tab: 7 }, fake)).toMatchObject({ ok: false });
  const root = s.add(null, "user", "課題", true);
  expect(await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" })).toMatchObject({ ok: false });
  expect(sent.filter((m: any) => m.type === "web")).toHaveLength(0);
});

test("確かめる道を渡さない handler（既定）は webHello を受けない", async () => {
  const h = makeHandler(openStore(":memory:"), async () => []);
  expect(await h({ op: "webHello" }, {})).toMatchObject({ ok: false });
});

// ---- affectedfast: まとめて回した時に赤を取りこぼさないか ----
import { completed } from "../tools/affected.ts";
test("試験が途中で process.exit(0) すると、まとめた bun test は exit 0 で後ろの赤が走らない＝「最後まで走った」と言えない（実際の bun で）", async () => {
  const d = mktmp("r11b");
  const t = (n: string, body: string) => writeFileSync(join(d, `${n}.test.ts`), `import {test,expect} from "bun:test"; ${body}`);
  t("c", `test("c",()=>{expect(1).toBe(1)});`);
  t("d", `test("d",()=>{process.exit(0)});`);
  t("e", `test("e-red",()=>{expect(1).toBe(3)});`);
  const bun = async (...f: string[]) => {
    const p = Bun.spawn(["bun", "test", ...f.map((x) => `./${x}.test.ts`)], { cwd: d, stdout: "pipe", stderr: "pipe", env: { ...process.env, FORCE_COLOR: "0" } });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    return { code: await p.exited, out };
  };
  const batch = await bun("c", "d", "e");
  expect(batch.code).toBe(0); // 偽の緑の元
  expect(completed(batch.out, 3)).toBe(false); // これで ok=false → 単独で再走
  const e = await bun("e");
  expect(e.code).not.toBe(0);
  expect(completed(e.out, 1)).toBe(true);
  const c = await bun("c");
  expect(c.code).toBe(0);
  expect(completed(c.out, 1)).toBe(true);
  expect(completed((await bun("c", "e")).out, 2)).toBe(true);
}, 60_000);

test("affected 本体: 途中で exit 0 する file がまとめの中に居ても、後ろの赤い file は FAIL と出て exit 非 0（使い捨ての repo）", async () => {
  const d = mktmp("r11c");
  const { mkdirSync, copyFileSync } = await import("node:fs");
  mkdirSync(join(d, "tools")); mkdirSync(join(d, "test")); mkdirSync(join(d, "docs/verify"), { recursive: true });
  copyFileSync(join(import.meta.dir, "../tools/affected.ts"), join(d, "tools/affected.ts"));
  copyFileSync(join(import.meta.dir, "../tools/test-timeout.ts"), join(d, "tools/test-timeout.ts")); // affected.ts が import する
  const t = (n: string, body: string) => writeFileSync(join(d, `test/${n}.test.ts`), `import {test,expect} from "bun:test"; ${body}`);
  t("c", `test("c",()=>{expect(1).toBe(1)});`);
  t("d", `test("d",()=>{process.exit(0)});`);
  t("e", `test("e-red",()=>{expect(1).toBe(3)});`);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")) as [string, string][]);
  const g = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: d, env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  g("init", "-q", "-b", "impl/w1a"); g("add", "-A"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
  const p = Bun.spawn(["bun", "tools/affected.ts", "--files", "test/c.test.ts,test/d.test.ts,test/e.test.ts"], { cwd: d, stdout: "pipe", stderr: "pipe", env });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  const code = await p.exited;
  expect(out).toMatch(/FAIL\s+test\/e\.test\.ts/);
  expect(out).toMatch(/FAIL\s+test\/d\.test\.ts/); // 最後まで走らない file も緑にしない
  expect(code).not.toBe(0);
}, 60000);

// ---- W8e-5: 変わった時だけ撮る ----
import type { Driver } from "../src/lease.ts";
import { makePeek } from "../src/peek.ts";
import { installChrome, load } from "./fake-chrome";
import { armExe } from "./exe";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const WINS = { pid: 10, windowId: 7, app: "A", title: "t" } as const;

test("AX の木が空（found:true・elements:[]＝AX を出さない app）の窓は、文字では変化が読めない＝定期には撮らず、初回と人が押した後だけ撮る（peek-lite）", async () => {
  let shots = 0;
  const win: Driver = { call: async () => { shots++; return { text: "", isError: false, data: null, img: { data: PNG, mime: "image/png" } }; }, close() {} };
  const p = makePeek({ surface: () => WINS, win: () => win, web: () => win, raise: async () => ({}), read: async () => ({ found: true, elements: [] }), now: () => 1000 });
  for (let i = 0; i < 3; i++) await p.shot("w", true);
  expect(shots).toBe(1);
  await p.front("w"); await p.shot("w", true); await p.shot("w", true);
  expect(shots).toBe(2); // 押した後の 1 回だけ
});

test("面が外れたら前の絵を捨てる（同じ key を別の窓が使っても古い絵を返さない）", async () => {
  let shots = 0, on = true;
  const win: Driver = { call: async () => { shots++; return { text: "", isError: false, data: null, img: { data: PNG, mime: "image/png" } }; }, close() {} };
  const p = makePeek({ surface: () => (on ? WINS : undefined), win: () => win, web: () => win, raise: async () => ({}), read: async () => ({ found: true, elements: [{ depth: 0, role: "b", label: "x", value: "" }] }), now: () => 1000 });
  await p.shot("w", true);
  on = false; expect((await p.shot("w", true)).ok).toBe(false);
  on = true; await p.shot("w", true);
  expect(shots).toBe(2);
});

// tab の要約は頁の中の関数 tabSig（偽の DOM の上で本物を動かす）。同じ長さの文字の入れ替え・入力欄の中身が変われば別の印になり、本文・値そのものは印に入らない
async function sigFor(o: { text: string; inputs?: { type: string; value?: string; checked?: boolean }[] }) {
  installChrome({ tabs: [1] });
  const real = (globalThis as any).chrome;
  let out = "";
  real.scripting.executeScript = async (spec: any) => {
    Object.assign(globalThis, { location: { href: "https://a.example/" }, scrollY: 0, document: { title: "T", body: { innerText: o.text }, getElementsByTagName: () => [1, 2, 3], querySelectorAll: () => o.inputs ?? [] } });
    out = spec.func();
    return [{ result: out }];
  };
  const { webRun } = await load("web");
  const r = await webRun("tab_sig", { tabId: 1 });
  for (const k of ["location", "document", "scrollY"]) delete (globalThis as any)[k];
  return (r as any).data.sig as string;
}
test("tab_sig: 同じ長さの本文の入れ替え・入力欄の中身・check の切り替えで印が変わる。本文・値・password の中身は印に出ない", async () => {
  const a = await sigFor({ text: "残り 12 分" }), b = await sigFor({ text: "残り 13 分" });
  expect(a).not.toBe(b);
  const i1 = await sigFor({ text: "x", inputs: [{ type: "text", value: "abc" }] }), i2 = await sigFor({ text: "x", inputs: [{ type: "text", value: "abd" }] });
  expect(i1).not.toBe(i2);
  const c1 = await sigFor({ text: "x", inputs: [{ type: "checkbox", checked: false }] }), c2 = await sigFor({ text: "x", inputs: [{ type: "checkbox", checked: true }] });
  expect(c1).not.toBe(c2);
  const sec = await sigFor({ text: "本文ひみつ", inputs: [{ type: "password", value: "PASSWORD-777" }, { type: "text", value: "TYPED-VALUE-9" }] });
  for (const raw of ["PASSWORD-777", "TYPED-VALUE-9", "本文ひみつ"]) expect(sec).not.toContain(raw);
  // password の中身の入れ替えは（長さが同じなら）印に出ない＝値を hash にさえしない
  expect(await sigFor({ text: "x", inputs: [{ type: "password", value: "aaaa" }] })).toBe(await sigFor({ text: "x", inputs: [{ type: "password", value: "bbbb" }] }));
});
