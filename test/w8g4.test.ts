// W8g-4: 金庫（偽の bw）から password を入れる。承諾が無ければ入れない・tab の host と項目の URL が合わなければ入れない・値が出力に 0 件
import { mktmp } from "./tmp.ts";
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cdp } from "../src/carry.ts";
import { makeVault } from "../src/vault.ts";
import { sharedExe } from "./exe";

const SECRET = "hunter2-VAULT-VALUE-7731";
const OTHERPW = "other-site-PW-0042";
const KEY = "fake-session-key-abc";
setDefaultTimeout(120_000); // holes-30: 混んだ機械で fake の初回 exec が 10 秒かかる＝既定の 30 秒を、混み倍率×実測の余裕に（--timeout より後に効く）

// 偽の bw: 呼ばれた args と BW_SESSION の有無を log に残す。list は items.json、get は SECRET を返す（本物の bw・金庫は起こさない）
function fakeBw(items: unknown[]) {
  const dir = mktmp("w8g4");
  writeFileSync(join(dir, "items.json"), JSON.stringify(items));
  // holes-30: 新しい inode の初回 exec は load が高いと 4〜10 秒（load 230 の実測）＝test ごと・ループで作る度に待たない。fake は process に 1 つ・作業 dir は env で渡す
  const bin = sharedExe("bw-w8g4", `#!/bin/sh\necho "$1 $2 session=$([ "$BW_SESSION" = "${KEY}" ] && echo ok || echo bad)" >> "$FAKEBW_DIR/calls.log"\n[ "$BW_SESSION" = "${KEY}" ] || exit 1\nif [ "$1" = list ]; then cat "$FAKEBW_DIR/items.json"; else printf '%s\\n' '${SECRET}'; fi\n`);
  process.env.FAKEBW_DIR = dir;
  return { bin, calls: () => { try { return readFileSync(join(dir, "calls.log"), "utf8"); } catch { return ""; } } };
}
const item = (id: string, uri: string) => ({ id, name: id, login: { uris: [{ uri }], password: OTHERPW } });

type Tab = { url: string; pw?: number; movedTo?: string };
function fakeCdp(tabs: Tab[]) {
  const sent: { method: string; params: any }[] = [];
  const cdp: Cdp = {
    send: async (method, params: any = {}, sessionId) => {
      sent.push({ method, params });
      const tab = tabs[Number(String(sessionId ?? params.targetId ?? "0").replace(/\D/g, "") || 0)];
      if (method === "Target.getTargets") return { targetInfos: tabs.map((t, i) => ({ targetId: `t${i}`, type: "page", url: t.url })) };
      if (method === "Target.attachToTarget") return { sessionId: params.targetId };
      if (method === "Runtime.evaluate") {
        const e = String(params.expression);
        if (e === "location.hostname") return { result: { value: new URL(tab?.movedTo ?? tab!.url).hostname } };
        if (e.includes("focus()")) return { result: { value: tab?.pw ?? 1 } };
        if (e.includes("e.value.length")) return { result: { value: SECRET.length } };
        return { result: { value: tab?.pw ?? 1 } };
      }
      return {};
    },
    close() {},
  };
  return { cdp, sent };
}

const setup = (o: { tabs?: Tab[]; items?: unknown[]; key?: string; approvalMs?: number } = {}) => {
  const bw = fakeBw(o.items ?? [item("i1", "https://app.example.com/login")]);
  const f = fakeCdp(o.tabs ?? [{ url: "https://app.example.com/login" }]);
  const v = makeVault({ browserUrl: async () => "http://127.0.0.1:1", connect: async () => f.cdp, bin: () => bw.bin, session: () => o.key ?? KEY, approvalMs: o.approvalMs ?? 3000 });
  return { v, bw, f };
};
const nextCard = async (v: ReturnType<typeof makeVault>) => { for (const end = Date.now() + 5000; Date.now() < end && !v.cards().length;) await Bun.sleep(5); return v.cards()[0]!; };
const leaks = (outs: string[]) => outs.filter((o) => o.includes(SECRET) || o.includes(OTHERPW)).length;
const inserted = (f: ReturnType<typeof fakeCdp>) => f.sent.filter((s) => s.method === "Input.insertText");

async function run(s: ReturnType<typeof setup>, url: string, answer?: (id: string) => void) {
  const p = s.v.fill("s:1", url);
  if (answer) { const c = await nextCard(s.v); answer(c.id); }
  return p;
}

test("承諾（checkbox on）→ 金庫から欄へ入る。値は入れた 1 回の CDP 以外・返事・card・bw の log のどこにも出ない（わざと出すと赤）", async () => {
  const s = setup();
  const r = await run(s, "https://app.example.com/login", (id) => expect(s.v.answer(id, true, true)).toBe(true));
  expect(r.ok).toBe(true);
  expect(inserted(s.f).length).toBe(1);
  expect(inserted(s.f)[0]!.params.text).toBe(SECRET);
  const outs = [JSON.stringify(r), JSON.stringify(s.v.cards()), s.bw.calls(), JSON.stringify(s.f.sent.filter((x) => x.method !== "Input.insertText"))];
  expect(leaks(outs)).toBe(0);
  expect(leaks([...outs, `log: ${SECRET}`])).toBe(1); // 検査が赤くなれる事
  expect(s.bw.calls()).toContain("get password session=ok"); // 鍵は env で渡る（argv には出ない）
  expect(s.bw.calls()).not.toContain(KEY);
});

test("checkbox が off のまま押した・断り・時間切れ・取り戻し → bw を起こさず何も入れない", async () => {
  for (const how of ["off", "no", "timeout", "gone"] as const) {
    const s = setup({ approvalMs: how === "timeout" ? 60 : 3000 });
    const r = await run(s, "https://app.example.com/login", how === "off" ? (id) => s.v.answer(id, true, false) : how === "no" ? (id) => s.v.answer(id, false, true) : how === "gone" ? () => s.v.end("s:1") : undefined);
    expect(r.ok).toBe(false);
    expect(inserted(s.f).length).toBe(0);
    expect(s.bw.calls()).toBe("");
  }
});

test("agent が渡した URL の host と、欄がある tab の実際の host が違う → card も出さず入れない（頁の文に誘導されても別 site に入れない）", async () => {
  const s = setup({ tabs: [{ url: "https://evil.example.net/login" }], items: [item("i1", "https://app.example.com/login"), item("i2", "https://evil.example.net/")] });
  const p = s.v.fill("s:1", "https://app.example.com/login");
  await Bun.sleep(150);
  expect(s.v.cards().length).toBe(0); // card を出す前に断る
  s.v.cards().forEach((c) => s.v.answer(c.id, true, true)); // 出ていたら承諾されてしまう（照合を外した時に赤くする）
  const r = await p;
  expect(r.ok).toBe(false);
  expect(s.bw.calls()).toBe("");
  expect(inserted(s.f).length).toBe(0);
});

test("項目の URL が tab の host に合わない / 0 件 / 2 件 → 入れない（get password も打たない）", async () => {
  for (const items of [[item("i1", "https://other.com/")], [], [item("a", "https://app.example.com/"), item("b", "https://app.example.com/x")]]) {
    const s = setup({ items });
    const r = await run(s, "https://app.example.com/login", (id) => s.v.answer(id, true, true));
    expect(r.ok).toBe(false);
    expect(inserted(s.f).length).toBe(0);
    expect(s.bw.calls()).not.toContain("get password");
  }
});

test("鍵が無い・間違っている → 入れない。欄が 0 / 2 つ・承諾の間に別 site へ移った → 入れない", async () => {
  expect((await setup({ key: "" }).v.fill("s:1", "https://app.example.com/")).ok).toBe(false);
  const wrong = setup({ key: "wrong" });
  expect((await run(wrong, "https://app.example.com/", (id) => wrong.v.answer(id, true, true))).ok).toBe(false);
  expect(inserted(wrong.f).length).toBe(0);
  for (const pw of [0, 2]) expect((await setup({ tabs: [{ url: "https://app.example.com/", pw }] }).v.fill("s:1", "https://app.example.com/")).ok).toBe(false);
  const moved = setup({ tabs: [{ url: "https://app.example.com/", movedTo: "https://evil.example.net/" }] });
  expect((await run(moved, "https://app.example.com/", (id) => moved.v.answer(id, true, true))).ok).toBe(false);
  expect(inserted(moved.f).length).toBe(0);
});

test("鍵は stdin 経由で memory に入り、vault-lock で捨てると入れられない。1 つの頼みに承諾待ちは 1 本", async () => {
  const bw = fakeBw([item("i1", "https://app.example.com/")]);
  const f = fakeCdp([{ url: "https://app.example.com/" }]);
  const v = makeVault({ browserUrl: async () => "x", connect: async () => f.cdp, bin: () => bw.bin, session: () => undefined, approvalMs: 3000 });
  expect(v.setKey("has space")).toBe(false);
  expect((await v.fill("s:1", "https://app.example.com/")).ok).toBe(false); // 鍵なし
  expect(v.setKey(KEY)).toBe(true);
  const p = v.fill("s:1", "https://app.example.com/");
  const c = await nextCard(v);
  expect((await v.fill("s:1", "https://app.example.com/")).ok).toBe(false); // 二重
  v.answer(c.id, true, true);
  expect((await p).ok).toBe(true);
  v.lock();
  expect((await v.fill("s:1", "https://app.example.com/")).ok).toBe(false);
});
