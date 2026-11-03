// W54: 裏で動けるカーソル。macOS の裏の窓への drag は、cua が「本物のポインタを動かす」と拒否する（上流 drag.rs:233-234）。製品はその拒否を、本物のポインタを動かす道（前面に出す foreground）へ落とさず、
// 代わりの道を言って止まる。click・キー・scroll は pid 宛てで本物のポインタを使わない（docs/verify/w54/RESULT.md）。ここは配信の門の振る舞い
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let dir: string, calls: { tool: string; args: Record<string, unknown> }[];
beforeEach(() => { dir = mktmp("w54"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
// 偽の cua: drag は上流どおり background_unavailable（原文）で拒否する・他は成功
const cua = (): Driver => ({
  call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "list_windows") return { text: "", isError: false, data: { windows: [{ pid: 10, window_id: 1 }] } };
    if (tool === "drag") return { text: '{"code":"background_unavailable","message":"macOS has no background drag route; drag moves the physical pointer","effect":"refused"}', isError: true, data: { code: "background_unavailable", effect: "refused" } };
    return { text: "ok", isError: false, data: null };
  },
  close() {},
});
const mk = () => { const L: ReturnType<typeof makeLeases> = makeLeases(dir, { driver: cua, defaultMode: "allow", approvalMs: 2000, onChange: () => queueMicrotask(() => L.approvals().forEach((a) => L.answer(a.id, true))) }); return L; };
const A = { pid: 10, windowId: 1, app: "Zed", title: "" };

test("W54 裏の窓への drag は cua が拒否 → 製品は前面に出す道へ落とさず、代わりの道を言って止まる（drag は 1 回だけ送り・delivery_mode は渡さない）", async () => {
  const L = mk();
  const g = L.give(A, "s:1"); if (!g.ok) throw new Error();
  const r = await L.act(tokenOf(g.lease), "drag", { from_x: 1, from_y: 2, to_x: 30, to_y: 40, delivery_mode: "foreground" });
  expect(r).toMatchObject({ ok: false, why: "tool" });
  const hint = (r as any).hint as string;
  for (const w of ["人のポインタを動かさずに送る道がありません", "ポインタを動かす道には落としません", "set_value", "上へ / 下へ", "kangae draft"]) expect(hint, w).toContain(w);
  const drags = calls.filter((c) => c.tool === "drag");
  expect(drags).toHaveLength(1);
  expect(Object.keys(drags[0]!.args)).not.toContain("delivery_mode"); // 前面化 + 本物のポインタの道（foreground）は門が渡さない
  expect(calls.filter((c) => /front|raise|activate|move_cursor/.test(c.tool))).toEqual([]);
});

test("W54 drag 以外の拒否・他の道具には触らない（click は成功のまま・drag の別の失敗はそのまま返る）", async () => {
  const L = mk();
  const g = L.give(A, "s:1"); if (!g.ok) throw new Error();
  expect((await L.act(tokenOf(g.lease), "click", { x: 5, y: 6 })).ok).toBe(true);
});

test("W54 web の drag は経路を刻んで pointer / mouse を送り、draggable は HTML5 の drag and drop（dragover も経路の点ごと）・untrusted のまま（実 Chrome の比較は docs/verify/w54/web-drag.e2e.ts: 変更前 slider の値 null → 後 96）", () => {
  const js = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../extension/web.js"), "utf8");
  const at = js.indexOf('if (tool === "drag")');
  const body = js.slice(at, at + 2200);
  for (const w of ['"pointerdown"', '"pointermove"', '"pointerup"', "N = 8", "document.elementFromPoint", 'dnd(t, "dragover")', 'dnd(to, "drop")']) expect(body, w).toContain(w);
  expect(body).not.toMatch(/chrome\.debugger|Input\.dispatch/); // 人の Chrome に黄色い帯を出す道は使わない
});
