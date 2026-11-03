// W125（docs/BRIEF-w125.md）: 歯車の appShotOff toggle・部屋の broadcast で開いている thread を読み直す。
// 常駐（src/）は触らない。panel.js の該当部分を切り出し、call を偽物にして確かめる。実機（見た目）は未測。
// 読む file を literal で名指す: "extension/panel.js" "extension/panel.html" "extension/sw.js"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const between = (s: string, a: string, b: string) => { const i = s.indexOf(a); expect(i).toBeGreaterThan(-1); const j = s.indexOf(b, i); expect(j).toBeGreaterThan(i); return s.slice(i, j); };

type Call = { op: string; args?: Record<string, unknown> };
function harness(reply: (c: Call) => any) {
  const js = code(read("extension/panel.js"));
  const toggle = between(js, "async function loadAppShotOff", "async function loadCursor");
  const thread = between(js, "let threadRoom", 'for (const id of ["hd-list"');
  const room = js.split("\n").find((l) => l.includes('res.type === "room"'))!.trim();
  const calls: Call[] = [], toasts: unknown[][] = [], handlers = new Map<string, (e: any) => unknown>();
  const el: Record<string, any> = {
    "app-shot-off": { on: false, disabled: false, addEventListener: (t: string, f: (e: any) => unknown) => handlers.set(t, f) },
    "thread-log": { data: null },
  };
  const nav = {
    stack: ["list"] as string[],
    top() { return this.stack[this.stack.length - 1]; },
    push(s: string) { if (this.top() !== s) this.stack.push(s); },
    show() {},
    back() { this.stack.pop(); },
  };
  const call = async (op: string, args?: Record<string, unknown>) => { calls.push({ op, args }); return reply({ op, args }); };
  const toast = (...a: unknown[]) => toasts.push(a);
  const api = new Function("call", "$", "nav", "toast", `${toggle}\n${thread}\nconst onRoom = (res) => { ${room}\n};\nreturn { openThread, onRoom };`)(call, (id: string) => el[id], nav, toast) as { openThread: (id: string) => Promise<void>; onRoom: (res: any) => void };
  return { api, calls, toasts, nav, el, handlers };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("W125 AC1: 歯車に app-shot-off の toggle・label・説明（内部の語なし）・開くたびに今の値を読み直す", () => {
  const html = read("extension/panel.html");
  const tag = html.match(/<kg-toggle id="app-shot-off"[^>]*>/)![0];
  expect(tag).toContain('label="op のある app では窓の写真を撮らせない"');
  expect(tag).toContain('hint="この Mac に操作の口がある app では、agent に窓の写真を撮らせません"');
  expect(html.indexOf(tag)).toBeGreaterThan(html.indexOf("<summary>画面の操作</summary>")); // 「画面の操作」の節の中
  expect(read("extension/panel.js")).toContain("void loadAppShotOff();");
});

test("W125 AC2: toggle の on で appShotOff {on:true}・ok:false なら off に戻して toast・古い常駐（ok:false）は disabled", async () => {
  let ok = true;
  const h = harness((c) => (c.args && "on" in c.args ? { ok, on: c.args.on } : { ok, on: ok ? false : undefined }));
  const t = h.el["app-shot-off"];
  await h.handlers.get("kg-toggle")!({ detail: { on: true } });
  expect(h.calls.at(-1)).toEqual({ op: "appShotOff", args: { on: true } });
  expect(h.toasts).toHaveLength(0);
  ok = false; t.on = true; // 常駐が断った → 画面は元の値（off）に戻る
  await h.handlers.get("kg-toggle")!({ detail: { on: true } });
  expect(t.on).toBe(false);
  expect(t.disabled).toBe(true);
  expect(h.toasts).toHaveLength(1);
});

test("W125 AC3: 開いている部屋の room で roomLog を 1 回・別の部屋と thread 以外では呼ばず・stack は増えない", async () => {
  const h = harness(() => ({ ok: true, room: { members: [] }, rows: [{ from: "A", to: "B", text: "x", at: 1 }] }));
  h.api.onRoom({ type: "room", roomId: "r1" }); // thread を開く前は何もしない
  await tick();
  expect(h.calls).toHaveLength(0);
  await h.api.openThread("r1");
  expect(h.calls).toEqual([{ op: "roomLog", args: { roomId: "r1" } }]);
  const depth = h.nav.stack.length;
  h.api.onRoom({ type: "room", roomId: "r2" });
  await tick();
  expect(h.calls).toHaveLength(1); // 別の部屋
  h.el["thread-log"].data = null;
  h.api.onRoom({ type: "room", roomId: "r1" });
  await tick();
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]).toEqual({ op: "roomLog", args: { roomId: "r1" } });
  expect(h.el["thread-log"].data.rows).toHaveLength(1);
  expect(h.nav.stack.length).toBe(depth);
  h.nav.back(); // thread を閉じた後は読み直さない
  h.api.onRoom({ type: "room", roomId: "r1" });
  await tick();
  expect(h.calls).toHaveLength(2);
});

test("W125 読み直しの失敗は今の画面を残す（戻らない）・初回の失敗は今まで通り toast して戻る", async () => {
  let ok = true;
  const h = harness(() => (ok ? { ok: true, room: { members: [] }, rows: [] } : { ok: false }));
  await h.api.openThread("r1");
  ok = false;
  h.api.onRoom({ type: "room", roomId: "r1" });
  await tick();
  expect(h.nav.top()).toBe("thread");
  expect(h.toasts).toHaveLength(0);
  await h.api.openThread("r1"); // 初回
  expect(h.toasts).toHaveLength(1);
  expect(h.nav.top()).toBe("list");
});

test("W125 拡張の中継（sw.js）は id 無しの room を全 port へ配る", () => {
  expect(read("extension/sw.js")).toContain('res.type === "history" || res.type === "room" || res.type === "pty"');
});
