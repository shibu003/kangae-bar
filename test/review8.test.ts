// review8: W8g-4 の安全を破りに行く攻撃 test（偽の bw・偽の CDP。本物の金庫は起こさない）
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cdp } from "../src/carry.ts";
import { makeVault } from "../src/vault.ts";
import { sharedExe } from "./exe";

const SECRET = "hunter2-VAULT-VALUE-7731";
const KEY = "fake-session-key-abc";

function setup(o: { url?: string; items?: unknown[]; sendThrows?: boolean } = {}) {
  const dir = mktmp("r8");
  writeFileSync(join(dir, "items.json"), JSON.stringify(o.items ?? [{ id: "i1", login: { uris: [{ uri: "https://example.com/" }] } }]));
  const bin = sharedExe("bw", `#!/bin/sh\n[ "$BW_SESSION" = "${KEY}" ] || exit 1\nif [ "$1" = list ]; then cat "$FAKEBW_DIR/items.json"; else echo "$@" >> "$FAKEBW_DIR/get.log"; printf '%s\\n' '${SECRET}'; fi\n`); // holes-29: 同じ fake を 1 度だけ作る（作る度の初回 exec が load 280 で 3〜8 秒）
  process.env.FAKEBW_DIR = dir;
  const sent: string[] = [];
  const url = o.url ?? "https://example.com/login";
  const cdp: Cdp = {
    send: async (method, params: any = {}) => {
      sent.push(method);
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "t0", type: "page", url }] };
      if (method === "Target.attachToTarget") return { sessionId: "t0" };
      if (method === "Input.insertText" && o.sendThrows) throw new Error(`boom ${KEY} ${params.text}`);
      if (method === "Runtime.evaluate") return { result: { value: String(params.expression) === "location.hostname" ? new URL(url).hostname : String(params.expression).includes("e.value.length") ? 5 : 1 } };
      return {};
    },
    close() {},
  };
  const v = makeVault({ browserUrl: async () => "http://127.0.0.1:1", connect: async () => cdp, bin: () => bin, session: () => KEY, approvalMs: 3000 });
  const card = async () => { for (const end = Date.now() + 5000; Date.now() < end && !v.cards().length;) await Bun.sleep(5); return v.cards()[0]!; };
  return { v, sent, card, dir };
}
const ins = (s: { sent: string[] }) => s.sent.filter((m) => m === "Input.insertText").length;

test("常駐の env の BW_SESSION / KANGAE_BW_SESSION は makeVault で memory に移して env から消す（agent の子 process に継がれない）", () => {
  process.env.BW_SESSION = "leak-A"; process.env.KANGAE_BW_SESSION = "leak-B";
  const v = makeVault({ browserUrl: async () => null });
  expect(process.env.BW_SESSION).toBeUndefined();
  expect(process.env.KANGAE_BW_SESSION).toBeUndefined();
  expect(v.unlocked()).toBe(true);
});

test("項目が example.com・tab が evil.example.com（子 domain）なら入れない", async () => {
  const s = setup({ url: "https://evil.example.com/login" });
  const p = s.v.fill("s:1", "https://example.com/login");
  const r = await Promise.race([p, s.card().then((c) => { s.v.answer(c.id, true, true); return p; })]);
  expect(r.ok).toBe(false);
  expect(ins(s)).toBe(0);
});

test("http の頁（暗号化なし）には入れない", async () => {
  const s = setup({ url: "http://example.com/login" });
  const p = s.v.fill("s:1", "https://example.com/login");
  const r = await Promise.race([p, s.card().then((c) => { s.v.answer(c.id, true, true); return p; })]);
  expect(r.ok).toBe(false);
  expect(ins(s)).toBe(0);
});

test("承諾を待つ間に vault-lock されたら入れない", async () => {
  const s = setup();
  const p = s.v.fill("s:1", "https://example.com/login");
  const c = await s.card();
  s.v.lock();
  s.v.answer(c.id, true, true);
  const r = await p;
  expect(r.ok).toBe(false);
  expect(ins(s)).toBe(0);
});

test("項目 id が - で始まる（bw の option に化ける）なら get しない", async () => {
  const s = setup({ items: [{ id: "--session", login: { uris: [{ uri: "https://example.com/" }] } }] });
  const p = s.v.fill("s:1", "https://example.com/login");
  const c = await s.card();
  s.v.answer(c.id, true, true);
  const r = await p;
  expect(r.ok).toBe(false);
  expect(await Bun.file(join(s.dir, "get.log")).exists()).toBe(false);
});

test("CDP の error 文に鍵と値が混ざっても、返事には出ない", async () => {
  const s = setup({ sendThrows: true });
  const p = s.v.fill("s:1", "https://example.com/login");
  const c = await s.card();
  s.v.answer(c.id, true, true);
  const r = JSON.stringify(await p);
  expect(r).not.toContain(KEY);
  expect(r).not.toContain(SECRET);
});
