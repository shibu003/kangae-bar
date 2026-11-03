// W8g-4b: 金庫から値を見せずに、人の Chrome の tab（渡した web の面）の password 欄へ。偽の bw・偽の chrome・偽の web driver（本物の金庫・Chrome の profile には触らない）
import { mktmp } from "./tmp.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "../src/lease.ts";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { makeVault } from "../src/vault.ts";
import { installChrome, load } from "./fake-chrome";
import { sharedExe } from "./exe";

const SECRET = "hunter2-VAULT-VALUE-7731";
const KEY = "fake-session-key-abc";

function fakeBw() {
  const dir = mktmp("w8g4b");
  writeFileSync(join(dir, "items.json"), JSON.stringify([{ id: "i1", login: { uris: [{ uri: "https://app.example.com/" }] } }]));
  const bin = sharedExe("bw", `#!/bin/sh\necho "$1 $2" >> "$FAKEBW_DIR/calls.log"\n[ "$BW_SESSION" = "${KEY}" ] || exit 1\nif [ "$1" = list ]; then cat "$FAKEBW_DIR/items.json"; else printf '%s\\n' '${SECRET}'; fi\n`);
  process.env.FAKEBW_DIR = dir; // 同じ script を使い回すので、作業 dir は env で渡す（常駐の bw 起動が env を引き継ぐ）
  return { bin, dir, called: () => Bun.file(join(dir, "calls.log")).exists() };
}

type Face = { tabId: number; gen: number };
// 偽の web driver: 拡張の代わり。値つきの vault_fill を数える
function setup(o: { url?: string; faces?: Face[]; fillError?: string } = {}) {
  const bw = fakeBw();
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let faces: Face[] = o.faces ?? [{ tabId: 1, gen: 3 }];
  const web: Driver = {
    call: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === "tab_info") return { text: "", isError: false, data: { url: o.url ?? "https://app.example.com/login" } };
      if (tool === "vault_fill" && typeof args.value === "string") return o.fillError ? { text: o.fillError, isError: true, data: null } : { text: "filled", isError: false, data: { filled: SECRET.length } };
      return { text: "probe", isError: false, data: { n: 1 } };
    },
    close() {},
  };
  const v = makeVault({ web: () => web, faces: () => faces, browserUrl: async () => null, bin: () => bw.bin, session: () => KEY, approvalMs: 3000 });
  return { v, bw, calls, setFaces: (f: Face[]) => (faces = f), puts: () => calls.filter((c) => c.tool === "vault_fill" && typeof c.args.value === "string") };
}
const nextCard = async (v: ReturnType<typeof makeVault>) => { for (const end = Date.now() + 5000; Date.now() < end && !v.cards().length;) await Bun.sleep(5); return v.cards()[0]!; };
async function run(s: ReturnType<typeof setup>, answer?: (id: string) => void) {
  const p = s.v.fill("s:1", "https://app.example.com/login");
  if (answer) answer((await nextCard(s.v)).id);
  return p;
}
const leaks = (outs: string[]) => outs.filter((o) => o.includes(SECRET)).length;

test("承諾（checkbox on）→ 人の tab へ値が 1 回だけ・gen つき。返事・card・bw の log・probe に値は 0 件（わざと出すと赤）", async () => {
  const s = setup();
  const r = await run(s, (id) => s.v.answer(id, true, true));
  expect(r.ok).toBe(true);
  expect(s.puts().length).toBe(1);
  expect(s.puts()[0]!.args).toMatchObject({ tabId: 1, host: "app.example.com", gen: 3, value: SECRET });
  const outs = [JSON.stringify(r), JSON.stringify(s.v.cards()), JSON.stringify(s.calls.filter((c) => c !== s.puts()[0]))];
  expect(leaks(outs)).toBe(0);
  expect(leaks([...outs, `log ${SECRET}`])).toBe(1);
});

test("checkbox off・断り・時間切れ・取り戻し（end）→ 値を送らず bw も起こさない", async () => {
  for (const how of ["off", "no", "timeout", "gone"] as const) {
    const s = setup();
    const v = how === "timeout" ? makeVault({ web: () => ({ call: async () => ({ text: "", isError: false, data: { url: "https://app.example.com/", n: 1 } }), close() {} }), faces: () => [{ tabId: 1, gen: 1 }], browserUrl: async () => null, bin: () => s.bw.bin, session: () => KEY, approvalMs: 60 }) : s.v;
    const r = await (async () => { const p = v.fill("s:1", "https://app.example.com/"); if (how !== "timeout") { const c = await nextCard(v); how === "off" ? v.answer(c.id, true, false) : how === "no" ? v.answer(c.id, false, true) : v.end("s:1"); } return p; })();
    expect(r.ok).toBe(false);
    expect(s.puts().length).toBe(0);
    expect(await s.bw.called()).toBe(false);
  }
});

test("tab の今の host が違う（別 site・子 domain・親 domain）/ http → card も出さず値を送らない", async () => {
  for (const url of ["https://evil.example.net/login", "https://blog.app.example.com/", "https://example.com/", "http://app.example.com/login"]) {
    const s = setup({ url });
    const p = s.v.fill("s:1", "https://app.example.com/login");
    await Bun.sleep(100);
    expect(s.v.cards().length).toBe(0);
    s.v.cards().forEach((c) => s.v.answer(c.id, true, true));
    expect((await p).ok).toBe(false);
    expect(s.puts().length).toBe(0);
  }
});

test("承諾を待つ間に操作権が取り戻された（面が無い・gen が変わった）/ vault-lock → 値を送らない", async () => {
  for (const how of ["takeback", "regen", "lock"] as const) {
    const s = setup();
    const r = await run(s, (id) => { how === "takeback" ? s.setFaces([]) : how === "regen" ? s.setFaces([{ tabId: 1, gen: 4 }]) : s.v.lock(); s.v.answer(id, true, true); });
    expect(r.ok).toBe(false);
    expect(s.puts().length).toBe(0);
  }
});

test("拡張の error 文に値と鍵が混ざっても、返事には出ない", async () => {
  const s = setup({ fillError: `boom ${SECRET} ${KEY}` });
  const r = JSON.stringify(await run(s, (id) => s.v.answer(id, true, true)));
  expect(r).not.toContain(SECRET);
  expect(r).not.toContain(KEY);
});

// ---- 常駐: 値つきの依頼は webHello した拡張の口だけへ（全 peer の broadcast に載せない）----
test("常駐: vault_fill の値は unicast だけで broadcast に 0 件・agent の CLI が peer でも値は届かない", async () => {
  const bw = fakeBw();
  process.env.KANGAE_BW = bw.bin;
  const s = openStore(":memory:");
  const broadcast: string[] = [], uni: string[] = [];
  const ext = {};
  let h: ReturnType<typeof makeHandler>;
  const reply = (m: any) => {
    if (m.type !== "web") return;
    const data = m.tool === "tab_info" ? { docId: "d1", title: "t", url: "https://app.example.com/login" } : m.tool === "vault_fill" ? (typeof m.args.value === "string" ? { filled: SECRET.length } : { n: 1 }) : null;
    queueMicrotask(() => void h({ op: "webResult", callId: m.id, text: "", data }, ext));
  };
  h = makeHandler(s, async () => [], undefined, undefined, { awaitWebPeer: true, isExtension: () => true, broadcast: (m) => { broadcast.push(JSON.stringify(m)); reply(m); }, unicast: (to, m) => { expect(to.has(ext)).toBe(true); uni.push(JSON.stringify(m)); reply(m); }, carryMs: 3000 });
  const root = s.add(null, "user", "課題", true);
  await h({ op: "webHello" }, ext);
  expect(await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" })).toMatchObject({ ok: true });
  expect(await h({ op: "vaultKey", key: KEY })).toMatchObject({ ok: true });
  const p = h({ op: "vaultFill", owner: `s:${root.id}`, url: "https://app.example.com/login" });
  let card: any; for (const end = Date.now() + 5000; !card && Date.now() < end; await Bun.sleep(5)) card = ((await h({ op: "leaseList" })) as any).carries.find((c: any) => c.vault);
  await h({ op: "carryAnswer", id: card.id, yes: true, vault: true });
  expect(await p).toMatchObject({ ok: true });
  expect(uni.filter((x) => x.includes(SECRET)).length).toBe(1);
  expect(broadcast.filter((x) => x.includes(SECRET)).length).toBe(0);
  expect(JSON.stringify(await h({ op: "leaseList" }))).not.toContain(SECRET);
  delete process.env.KANGAE_BW;
});

test("常駐: cookie_get（値つきの返事を頼む依頼）も unicast だけ・broadcast に 0 件（外すと赤）", async () => {
  const s = openStore(":memory:");
  const broadcast: string[] = [], uni: string[] = [];
  const ext = {};
  let h: ReturnType<typeof makeHandler>;
  const jar = [{ name: "sid", value: SECRET, domain: "app.example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax" }];
  const reply = (m: any) => {
    if (m.type !== "web") return;
    const data = m.tool === "tab_info" ? { docId: "d1", title: "t", url: "https://app.example.com/" } : m.tool === "cookie_names" ? { cookies: jar.map(({ name, domain, path }) => ({ name, domain, path })) } : m.tool === "cookie_get" ? { cookies: jar } : null;
    queueMicrotask(() => void h({ op: "webResult", callId: m.id, text: "", data }, ext));
  };
  const ws = { ...defaultWorkspace(), browserUrl: async () => "http://127.0.0.1:1" };
  h = makeHandler(s, async () => [], undefined, ws, { awaitWebPeer: true, isExtension: () => true, broadcast: (m) => { broadcast.push(JSON.stringify(m)); reply(m); }, unicast: (to, m) => { expect(to.has(ext)).toBe(true); uni.push(JSON.stringify(m)); reply(m); }, carryMs: 3000 });
  const root = s.add(null, "user", "課題", true);
  await h({ op: "webHello" }, ext);
  expect(await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" })).toMatchObject({ ok: true });
  const p = h({ op: "carry", owner: `s:${root.id}`, host: "app.example.com" });
  let card: any; for (const end = Date.now() + 5000; !card && Date.now() < end; await Bun.sleep(5)) card = ((await h({ op: "leaseList" })) as any).carries.find((c: any) => !c.vault);
  await h({ op: "carryAnswer", id: card.id, yes: true });
  await p;
  expect(uni.filter((x) => x.includes('"cookie_get"')).length).toBe(1);
  expect(broadcast.filter((x) => x.includes('"cookie_get"')).length).toBe(0);
});

test("常駐: 口の送り方（unicast）が無ければ値つきの依頼は送らない（broadcast に落とさない）", async () => {
  const s = openStore(":memory:");
  const seen: string[] = [];
  const ext = {};
  const h = makeHandler(s, async () => [], undefined, undefined, { awaitWebPeer: true, isExtension: () => true, broadcast: (m) => seen.push(JSON.stringify(m)) });
  await h({ op: "webHello" }, ext);
  // vault_fill は web driver の call から来る。leaseGive 経由でなく、値つきの call が broadcast に出ない事だけを見る
  expect(seen.filter((x) => x.includes(SECRET)).length).toBe(0);
});

// ---- 拡張（偽の chrome の上で、tab の中の関数は偽の DOM の上で本物を動かす）----
afterEach(() => { for (const k of ["location", "document", "HTMLInputElement"]) delete (globalThis as any)[k]; });
function ext(o: { tabUrl?: string; pageHost?: string; inputs?: number; throwWith?: string } = {}) {
  const c = installChrome({ tabs: [1] });
  const real = (globalThis as any).chrome;
  real.tabs.get = async (id: number) => (id === 1 ? { id, active: true, windowId: 1, url: o.tabUrl ?? "https://app.example.com/login" } : Promise.reject(new Error("no tab")));
  const injected: any[][] = [];
  const base = real.scripting.executeScript;
  const inputs: any[] = [];
  real.scripting.executeScript = async (spec: any) => {
    if (spec.func.name !== "fillPassword") return base(spec);
    injected.push(spec.args);
    if (o.throwWith) throw new Error(`Cannot access contents ${JSON.stringify(spec.args)} ${o.throwWith}`);
    class In { _v = ""; focus() {} getBoundingClientRect() { return { width: 10, height: 10 }; } dispatchEvent() { return true; } }
    Object.defineProperty(In.prototype, "value", { get() { return this._v; }, set(x) { this._v = x; }, configurable: true });
    for (let i = 0; i < (o.inputs ?? 1); i++) inputs.push(new In());
    Object.assign(globalThis, { HTMLInputElement: In, location: { protocol: "https:", hostname: o.pageHost ?? "app.example.com" }, document: { querySelectorAll: () => inputs } });
    return [{ result: spec.func(...spec.args) }];
  };
  return { c, injected, inputs };
}
const fill = { tabId: 1, host: "app.example.com", gen: 3 };

test("拡張: 値は欄に入り、返事は {filled} だけ（値を返さない）・top frame だけに注入・引数は host と値", async () => {
  const x = ext();
  const { webRun } = await load("web");
  const r = await webRun("vault_fill", { ...fill, value: SECRET });
  expect(r.error).toBeFalsy();
  expect(JSON.stringify(r)).not.toContain(SECRET);
  expect(r.data).toEqual({ filled: SECRET.length });
  expect(x.inputs[0]._v).toBe(SECRET);
  expect(x.injected).toEqual([["app.example.com", SECRET]]);
});

test("拡張: tab の host が違う・http・頁が動いた・欄が 0 / 2 つ → 入れない", async () => {
  for (const o of [{ tabUrl: "https://evil.example.net/" }, { tabUrl: "http://app.example.com/" }, { tabUrl: "https://blog.app.example.com/" }, { pageHost: "evil.example.net" }, { inputs: 0 }, { inputs: 2 }]) {
    const x = ext(o);
    const { webRun } = await load("web");
    const r = await webRun("vault_fill", { ...fill, value: SECRET });
    expect(r.error).toBe(true);
    expect(x.inputs.every((i) => i._v === "")).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  }
});

test("拡張: 取り戻された gen（floors より古い）は executeScript の前に断る", async () => {
  const x = ext();
  const { webRun } = await load("web");
  await webRun("gate_off", { tabId: 1, minGen: 5 });
  const r = await webRun("vault_fill", { ...fill, gen: 4, value: SECRET });
  expect(r.error).toBe(true);
  expect(x.injected.length).toBe(0);
  expect((await webRun("vault_fill", { ...fill, gen: 5, value: SECRET })).error).toBeFalsy();
});

test("拡張: executeScript が例外を投げて message に引数が載っても、返事と console に値は出ない", async () => {
  const logs = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn")];
  ext({ throwWith: "boom" });
  const { webRun } = await load("web");
  const r = await webRun("vault_fill", { ...fill, value: SECRET });
  expect(r.error).toBe(true);
  expect(JSON.stringify(r)).not.toContain(SECRET);
  expect(logs.flatMap((l) => l.mock.calls).join("\n")).not.toContain(SECRET);
  logs.forEach((l) => l.mockRestore());
});
