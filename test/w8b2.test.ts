// W8b-2: 指紋・passkey・認証コード・CAPTCHA で止まって人を呼ぶ（図 §47）。門の判定・止まる・推測で入れない・「続けて」で読み直してから・WebAuthn の見張りは持っている間だけ
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humanGate, makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { gateHook } from "../extension/gate.js";

let dir: string;
let sent: { tool: string; args: any }[];
let els: any[];
let extra: Record<string, unknown> | null;
const web: Driver = {
  call: async (tool, args) => {
    sent.push({ tool, args });
    if (tool === "tab_state") return { text: "", isError: false, data: { exists: true, docId: "d1" } };
    if (tool === "tab_info") return { text: "", isError: false, data: { docId: "d1", url: "http://shop.test/login" } };
    if (tool === "get_window_state") return { text: "", isError: false, data: { snapshot_id: "s", elements: els, ...(extra ?? {}) } };
    return { text: "ok", isError: false, data: extra };
  },
  close() {},
};
const writes = () => sent.filter((c) => ["type_text", "click", "set_value", "press_key"].includes(c.tool));
const mk = () => makeLeases(dir, { web, defaultMode: "allow" });
const S = { tabId: 7, docId: "d1", app: "Chrome", title: "login" };
beforeEach(() => { dir = mktmp("w8b2"); sent = []; extra = null; els = [{ element_token: "d1", role: "textbox", label: "コード", value: "", gate: "otp" }]; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const give = (L: ReturnType<typeof mk>) => { const g = L.give(S, "s:1"); if (!g.ok) throw new Error(); g.lease.hold = false; return tokenOf(g.lease); };

test("見分け: web の gate・AX の secure 欄・label の語。ふつうの欄・見出しは止めない", () => {
  expect(humanGate({ role: "textbox", label: "x", gate: "otp" })).toBe("認証コード（SMS や認証アプリの数字）の欄");
  expect(humanGate({ role: "element", label: "", gate: "captcha" })).toBe("CAPTCHA（人かどうかの確認）");
  expect(humanGate({ role: "AXSecureTextField", label: "" })).toBe("パスワードの欄");
  expect(humanGate({ role: "button", label: "パスキーでログイン" })).toBe("指紋・顔・passkey の確認");
  expect(humanGate({ role: "AXButton", label: "Use Touch ID" })).toBe("指紋・顔・passkey の確認");
  expect(humanGate({ role: "textbox", label: "認証コード" })).toBe("認証コード（SMS や認証アプリの数字）の欄");
  expect(humanGate({ role: "textbox", label: "メール" })).toBeNull();
  expect(humanGate({ role: "heading", label: "認証コードを入力" })).toBeNull(); // 見出しの文字だけでは止めない（欄が止める）
});

test("UC-h4: one-time-code の欄が出たら入れずに止まる・書き換え 0 件・hint が handoff を頼む", async () => {
  const L = mk(); const t = give(L);
  const r: any = await L.act(t, "get_window_state", {});
  expect(r.ok).toBe(true);
  expect(r.text).toContain("[[handoff:");
  const w = await L.act(t, "type_text", { element_token: "d1", text: "123456" });
  expect(w).toMatchObject({ ok: false, why: "human" });
  expect((await L.act(t, "click", { element_token: "d1" }))).toMatchObject({ ok: false, why: "human" });
  expect(writes().length).toBe(0);
  expect((await L.act(t, "get_window_state", {})).ok).toBe(true); // 読むのは通る
});

test("UC-h5: 偽の captcha → 押した回数 0", async () => {
  els = [{ element_token: "d1", role: "element", label: "", value: "", gate: "captcha" }, { element_token: "d2", role: "button", label: "続ける", value: "" }];
  const L = mk(); const t = give(L);
  await L.act(t, "get_window_state", {});
  expect((await L.act(t, "click", { element_token: "d2" })).ok).toBe(false);
  expect(writes().length).toBe(0);
});

test("WebAuthn: 頁が credentials を呼んだ（読む前でも）→ 返事の gate で止まる", async () => {
  els = [{ element_token: "d1", role: "button", label: "ログイン", value: "" }];
  const L = mk(); const t = give(L);
  extra = { gate: "webauthn" };
  expect((await L.act(t, "get_window_state", {})).ok).toBe(true);
  extra = null;
  expect(await L.act(t, "click", { element_token: "d1" })).toMatchObject({ ok: false, why: "human" });
  expect(writes().length).toBe(0);
});

test("UC-h6: 人が「続けて」→ 読み直すまで書けない → まだ出ていればまた止まる・消えていれば続けられる", async () => {
  const L = mk(); const t = give(L);
  await L.act(t, "get_window_state", {});
  expect(L.humanDone("s:1")).toBe(1);
  expect(await L.act(t, "click", { element_token: "d1" })).toMatchObject({ ok: false, why: "result" }); // 読み直せと言われる（旗は落ちたが木は古い）
  await L.act(t, "get_window_state", {}); // まだ欄が出ている → 立ち直す
  expect(await L.act(t, "click", { element_token: "d1" })).toMatchObject({ ok: false, why: "human" });
  L.humanDone("s:1");
  els = [{ element_token: "d2", role: "button", label: "次へ", value: "" }]; // 人が済ませて画面が進んだ
  await L.act(t, "get_window_state", {});
  expect((await L.act(t, "click", { element_token: "d2" })).ok).toBe(true);
  expect(writes().length).toBe(1);
});

test("推測で入れない: 人が済ませる前に別の欄経由・別 tool でも書けない（type_text / set_value / press_key / hotkey）", async () => {
  const L = mk(); const t = give(L);
  await L.act(t, "get_window_state", {});
  for (const [tool, a] of [["type_text", { text: "1" }], ["set_value", { element_token: "d1", value: "1" }], ["press_key", { key: "return" }], ["hotkey", { keys: ["cmd", "k"] }]] as const)
    expect(await L.act(t, tool, a)).toMatchObject({ ok: false, why: "human" });
  expect(await L.act(t, "hotkey", { keys: ["cmd", "v"] })).toMatchObject({ ok: false, why: "tool" }); // W46-A: 貼り付けの key はクリップボードの経路として門が先に断る（人の確認より前・書き込みは 0）
  expect(writes().length).toBe(0);
});

test("WebAuthn の見張りは渡した tab にだけ入り、取り戻す / 全部止めるで外れる", async () => {
  const L = mk(); give(L);
  await Bun.sleep(5);
  expect(sent.filter((c) => c.tool === "gate_on").map((c) => c.args.tabId)).toEqual([7]);
  L.stopAll();
  await Bun.sleep(5);
  expect(sent.filter((c) => c.tool === "gate_off").map((c) => c.args.tabId)).toEqual([7]);
});

test("gateHook: 入れると publicKey の get/create は断られ印が残る・外すと元の関数に戻る・publicKey 以外は素通し", async () => {
  const orig = { get: async () => "orig-get", create: async () => "orig-create" };
  const doc: Record<string, string> = {};
  (globalThis as any).navigator = { credentials: { ...orig } };
  (globalThis as any).document = { documentElement: { setAttribute: (k: string, v: string) => (doc[k] = v), removeAttribute: (k: string) => delete doc[k] } };
  (globalThis as any).DOMException = class extends Error { constructor(m: string, public override name: string) { super(m); } };
  const C = (globalThis as any).navigator.credentials;
  expect(gateHook(true)).toBe("on");
  expect(C.get).not.toBe(orig.get);
  await expect(C.get({ publicKey: {} })).rejects.toMatchObject({ name: "NotAllowedError" });
  expect(doc["data-kangae-gate"]).toBe("webauthn");
  expect(await C.get({ password: true })).toBe("orig-get"); // passkey 以外は邪魔しない
  expect(gateHook(true)).toBe("on"); // 二重に入れても元を失わない
  expect(gateHook(false)).toBe("off");
  expect(C.get).toBe(orig.get);
  expect(C.create).toBe(orig.create);
  expect(doc["data-kangae-gate"]).toBeUndefined();
  expect(await C.get({ publicKey: {} })).toBe("orig-get"); // 人が自分の passkey を使える
});

// ---- W8b-2 fix2: sw が眠ると memory の一覧が空になる → storage.session から張り直す・張るまで書き換えは断る ----
async function wake(store: Record<string, unknown>, armOk: () => boolean) {
  const calls: string[] = [];
  (globalThis as any).chrome = {
    storage: { session: { get: async (k: string) => ({ [k]: store[k] }), set: async (o: Record<string, unknown>) => void Object.assign(store, o) } },
    tabs: { get: async (id: number) => ({ id, active: true, windowId: 1 }), onRemoved: { addListener() {} } },
    webNavigation: { onCommitted: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    scripting: { executeScript: async (o: any) => { if (o.world === "MAIN") { calls.push(`arm:${o.target.tabId}:${o.args[0]}`); if (!armOk()) throw new Error("no"); return [{ result: o.args[0] ? "on" : "off" }]; } calls.push("page"); return [{ result: { text: "ok" } }]; } },
  };
  const mod = await import(`../extension/web.js?wake=${Math.random()}`); // 新しい module = 眠って起き直した sw（memory が空）
  return { webRun: mod.webRun as (t: string, a: any) => Promise<any>, calls };
}

test("眠り: memory を空にして起こすと、渡している tab に見張りが戻る・戻るまで書き換えは断る・戻れば通る", async () => {
  const store: Record<string, unknown> = {};
  let ok = true;
  const s1 = await wake(store, () => ok);
  await s1.webRun("gate_on", { tabId: 7 });
  expect(store.kangaeGated).toEqual([7]); // 一覧は storage に出ている
  ok = false; // 起きた直後は張れない
  const s2 = await wake(store, () => ok); // 新しい sw（memory 空）
  await Bun.sleep(5);
  expect(s2.calls).toContain("arm:7:true"); // 起きた時に自分から張り直しに行く
  const refused = await s2.webRun("click", { tabId: 7, element_token: "d1" });
  expect(refused.error).toBe(true);
  expect(s2.calls).not.toContain("page"); // 書き換えは tab に届いていない
  expect((await s2.webRun("get_window_state", { tabId: 7 })).error).toBe(false); // 読むのは通る
  ok = true;
  expect((await s2.webRun("click", { tabId: 7, element_token: "d1" })).error).toBe(false);
});

test("眠り: 取り戻し（gate_off）で一覧から消え、眠って起きても張り直さない", async () => {
  const store: Record<string, unknown> = {};
  const s1 = await wake(store, () => true);
  await s1.webRun("gate_on", { tabId: 7 });
  await s1.webRun("gate_off", { tabId: 7 });
  expect(store.kangaeGated).toEqual([]);
  const s2 = await wake(store, () => true);
  await Bun.sleep(5);
  expect(s2.calls.filter((c) => c.startsWith("arm:"))).toEqual([]);
});
