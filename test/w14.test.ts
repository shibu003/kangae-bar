import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";

// W14: bar の一番上の「全部止める」→ 常駐の stopAll。全部の面が取り戻され、承認待ち・資源の順番待ちも消える（実行は 0 件）
let dir: string, log: string[], hold: Map<string, () => void>;
const MENU = { element_token: "m1" };
const drv = (): Driver => ({
  call: async (tool, args) => {
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }, { pid: 10, window_id: 2 }, { pid: 20, window_id: 3 }] } };
    if (tool === "get_window_state") return { text: "", isError: false, data: { snapshot_id: "s", elements: [{ element_token: "m1", role: "AXMenuItem", label: "Save" }] } };
    const id = `${args.pid}:${args.window_id}:${tool}${args.element_token ?? ""}`;
    log.push(`start ${id}`);
    await new Promise<void>((r) => hold.set(id, r));
    log.push(`end ${id}`);
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
const W1 = { pid: 10, windowId: 1, app: "Pad", title: "a" }, W2 = { pid: 10, windowId: 2, app: "Pad", title: "b" }, X = { pid: 20, windowId: 3, app: "Other", title: "c" };
const tick = () => Bun.sleep(20);
const open = async (L: ReturnType<typeof makeLeases>, s: typeof W1, owner: string) => { const g = L.give(s, owner); if (!g.ok) throw new Error(); await L.act(tokenOf(g.lease), "get_window_state", {}); return tokenOf(g.lease); };

beforeEach(() => { dir = mktmp("w14"); log = []; hold = new Map(); });
afterEach(() => { for (const f of hold.values()) f(); rmSync(dir, { recursive: true, force: true }); });

test("stopAll: 3 つの面を一度に取り戻す・資源待ち（menu の順番）と承認待ちも消えて、後から何も実行されない", async () => {
  const revoked: string[] = [];
  const L = makeLeases(dir, { driver: drv, defaultMode: "allow", resourceMs: 5000, onRevoke: (o) => { revoked.push(o); } });
  L.setMode("Other", "ask");
  const a = await open(L, W1, "s:A"), b = await open(L, W2, "s:B"), x = await open(L, X, "s:C");
  const pa = L.act(a, "click", MENU); // menu を持って走っている
  await tick();
  const t0 = Date.now();
  const pb = L.act(b, "click", MENU); // 同じ app の menu の順番待ち
  const px = L.act(x, "type_text", { text: "z" }); // 承認待ち
  await tick();
  expect(L.approvals().length).toBe(1);
  expect(L.stopAll()).toBe(3);
  expect(await pb).toMatchObject({ ok: false, why: "gen" });
  expect(await px).toMatchObject({ ok: false, why: "gen" });
  expect(Date.now() - t0).toBeLessThan(1000); // 5 秒の時間切れを待たずに消える
  expect(L.approvals()).toEqual([]);
  expect(L.list()).toEqual([]);
  expect(log).toEqual(["start 10:1:clickm1"]); // 順番待ちだった B と承認待ちだった X は 1 度も driver に届かない
  expect(revoked.sort()).toEqual(["s:A", "s:B", "s:C"]);
  expect(L.recoveries().map((r) => r.key).sort()).toEqual(["10:1", "10:2", "20:3"]); // 取り戻しの行が 3 つ出る
  hold.get("10:1:clickm1")?.(); await pa;
});

test("panel: 「全部止める」は bar を開いた一番上（#app の最初の子）にあり、行の中（#approve の末尾）には無い", () => {
  const html = readFileSync(join(import.meta.dir, "../extension/panel.html"), "utf8");
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(html.indexOf('id="stop-all"')).toBeGreaterThan(html.indexOf('<div id="app"'));
  expect(html.indexOf('id="stop-all"')).toBeLessThan(html.indexOf('id="leases"'));
  expect(js).toContain('$("stop-all")');
  expect(js).not.toMatch(/txt\("button", "btn stopall"/); // #approve の末尾に作る古い口が残っていない
  expect(js.slice(js.indexOf("sa.onclick"), js.indexOf("sa.onclick") + 120)).toContain('call("stopAll")');
});
