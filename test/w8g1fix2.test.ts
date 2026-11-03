// w8g1fix2: 値つきの依頼（cookie_get・history_get）は「その tab を持つ拡張の口」1 つだけへ。偽の口・偽の chrome（本物の Chrome・金庫には触らない）
import { expect, test } from "bun:test";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

const SECRET = "sid-VALUE-w8g1fix2-7731";
const jar = [{ name: "sid", value: SECRET, domain: "app.example.com", path: "/", secure: true, httpOnly: true, sameSite: "lax" }];

// peers: has = tab を持つ拡張 / none = tab が無い拡張（別 profile）/ forger = 送られていない callId に偽の返事を重ねる口
async function scenario(peers: Record<string, "has" | "none" | "forger">, o: { lease?: boolean; hist?: boolean; spoof?: boolean } = {}) {
  const s = openStore(":memory:");
  const sock: Record<string, object> = Object.fromEntries(Object.keys(peers).map((k) => [k, {}]));
  const got: Record<string, string[]> = Object.fromEntries(Object.keys(peers).map((k) => [k, []]));
  let h: ReturnType<typeof makeHandler>;
  const answer = (name: string, m: any) => {
    if (m.type !== "web") return;
    const kind = peers[name]!;
    const has = kind === "has";
    const data = !has ? null : m.tool === "tab_info" ? { docId: "d1", title: "t", url: "https://app.example.com/login" } : m.tool === "cookie_names" ? { cookies: jar.map(({ name, domain, path }) => ({ name, domain, path })) } : m.tool === "cookie_get" ? { cookies: jar } : m.tool === "history_get" ? { items: [{ url: "https://app.example.com/x", title: "x" }] } : null;
    queueMicrotask(() => void h({ op: "webResult", callId: m.id, text: has ? "" : "その tab はありません", error: !has, data }, sock[name]!));
  };
  const spoofed: unknown[] = [];
  const deliver = (names: string[], m: any) => {
    for (const n of names) { got[n]!.push(JSON.stringify(m)); answer(n, m); }
    // 別の口が、送られていない口の callId に偽の返事を重ねる
    if (o.spoof && m.tool === "cookie_get") void h({ op: "webResult", callId: m.id, text: "", data: { cookies: [] } }, sock.other!).then((x) => spoofed.push(x));
  };
  const ws = { ...defaultWorkspace(), browserUrl: async () => "http://127.0.0.1:1" };
  h = makeHandler(s, async () => [], undefined, ws, {
    awaitWebPeer: true, isExtension: () => true, carryMs: 3000,
    broadcast: (m) => deliver(Object.keys(peers), m),
    unicast: (to, m) => deliver(Object.keys(peers).filter((n) => to.has(sock[n])), m),
  });
  const root = s.add(null, "user", "課題", true);
  for (const n of Object.keys(peers)) await h({ op: "webHello" }, sock[n]);
  if (o.lease !== false) expect(await h({ op: "leaseGive", rootId: root.id, tabId: 7, title: "t" })).toMatchObject({ ok: true });
  const p = h({ op: "carry", owner: `s:${root.id}`, host: "app.example.com" });
  let card: any; for (const end = Date.now() + 3000; !card && Date.now() < end; await Bun.sleep(5)) card = ((await h({ op: "leaseList" })) as any).carries.find((c: any) => !c.vault);
  if (card) await h({ op: "carryAnswer", id: card.id, yes: true, history: !!o.hist });
  const r = await p;
  return { r, spoofed, n: (name: string, tool: string) => got[name]!.filter((x) => x.includes(`"${tool}"`)).length };
}

test("拡張が 2 つ（別 profile）: cookie_get・history_get・cookie_names は tab を持つ口だけへ", async () => {
  const { n } = await scenario({ mine: "has", other: "none" }, { hist: true });
  for (const t of ["cookie_get", "history_get", "cookie_names"]) { expect(n("mine", t)).toBe(1); expect(n("other", t)).toBe(0); }
});

test("tab の持ち主が分からず口が 2 つ以上なら、値つきの依頼を誰にも送らない", async () => {
  const { r, n } = await scenario({ mine: "has", other: "has" }, { lease: false });
  expect(JSON.stringify(r)).toContain("口が分かりません");
  for (const t of ["cookie_get", "history_get"]) { expect(n("mine", t)).toBe(0); expect(n("other", t)).toBe(0); }
});

test("口が 1 つだけなら、tab を渡していない carry も通る（今まで通り）", async () => {
  const { n } = await scenario({ mine: "has" }, { lease: false });
  expect(n("mine", "cookie_get")).toBe(1);
});

test("送った口と別の口からの返事は捨てる（偽の返事で cookie を差し替えさせない）", async () => {
  const { spoofed } = await scenario({ mine: "has", other: "forger" }, { spoof: true });
  expect(spoofed).toEqual([{ ok: false }]);
});
