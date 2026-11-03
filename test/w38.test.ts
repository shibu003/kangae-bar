// W38: Bar の agent の行の「見る」= その agent が触った folder を、人の選んだ app で前に開く（docs/BRIEF-w38.md §4）。
// 人の押しだけ（agent の CLI・owner つき・agent 印は断る）・path も app 名も panel から受けない・候補に無い app は Finder・開いた窓は agent の面にならない
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCmd } from "../src/cmds.ts";
import { makeLeases, type Driver } from "../src/lease.ts";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { listEditors, openArgs, readViewer, writeViewer } from "../src/viewer.ts";
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000); // sandbox を起こす test は混んだ機械で遅い（holes-30）

let top: string, ui: string, nodes: string, apps: string;
beforeEach(() => {
  top = realpathSync(mktmp("w38"));
  ui = join(top, "ui"); nodes = join(top, "nodes"); apps = join(top, "Applications");
  for (const d of [ui, nodes, apps, join(top, "lease")]) mkdirSync(d);
});
afterEach(() => rmSync(top, { recursive: true, force: true }));

const app = (name: string, o: { product?: boolean } = {}) => { const d = join(apps, `${name}.app`, "Contents/Resources/app"); mkdirSync(d, { recursive: true }); if (o.product) writeFileSync(join(d, "product.json"), "{}"); };

test("editors: 候補は /Applications を読むだけ（名前の表か product.json）。Finder・Terminal は常に先頭。候補に無い名前は書けず、読みは Finder に落ちる", () => {
  app("Zed"); app("Foo IDE", { product: true }); app("Calculator"); app("Safari");
  const list = listEditors([apps, join(top, "none")]);
  expect(list).toEqual(["Finder", "Terminal", "Foo IDE", "Zed"]);
  expect(readViewer(ui, list)).toBe("Finder"); // file 無し
  expect(writeViewer(ui, "Calculator", list)).toBe(false);
  expect(writeViewer(ui, "../x", list)).toBe(false);
  expect(existsSync(join(ui, "viewer.json"))).toBe(false); // 断った時は書かない
  expect(writeViewer(ui, "Zed", list)).toBe(true);
  expect(readViewer(ui, list)).toBe("Zed");
  writeFileSync(join(ui, "viewer.json"), JSON.stringify({ app: "Calculator" })); // 人が手で候補に無い物を書いても
  expect(readViewer(ui, list)).toBe("Finder");
  writeFileSync(join(ui, "viewer.json"), "{broken");
  expect(readViewer(ui, list)).toBe("Finder");
});

test("openArgs: Finder は 1 回で全 folder・Terminal は 1 folder ずつ・編集器は open -a <app> <dir…>。folder 0 なら何も打たない", () => { // rules-ok: W38 人が Bar で押した時だけ前に開く（agent の呼びは断る・docs/BRIEF-w38.md §3）
  expect(openArgs("Finder", ["/a", "/b"])).toEqual([["/a", "/b"]]);
  expect(openArgs("Terminal", ["/a", "/b"])).toEqual([["-a", "Terminal", "/a"], ["-a", "Terminal", "/b"]]);
  expect(openArgs("Zed", ["/a", "/b"])).toEqual([["-a", "Zed", "/a", "/b"]]);
  expect(openArgs("Zed", [])).toEqual([]);
});

const mkHandler = () => {
  const opened: string[][] = [];
  const ws = { ...defaultWorkspace(), dir: nodes, open: async (args: string[]) => { opened.push(args); return true; } };
  const H: any = makeHandler(openStore(":memory:"), async () => [], undefined, ws, { uiHome: ui, leaseDriver: () => null });
  return { H, opened };
};

test("openFolder: 人の押し（panel の owner は {}）だけ開く。agent の CLI（unix socket）・owner つき・agent 印は断り、open は 0 回。送られた path は無視され、常駐が引いた作業場所だけ開く", async () => {
  const { H, opened } = mkHandler();
  const root = (await H({ op: "add", parentId: null, kind: "user", text: "A" }, {})).node;
  const dir = join(nodes, `${root.id} A`);
  // まだ folder が無い
  expect(await H({ op: "openFolder", rootId: root.id }, {})).toMatchObject({ ok: false, hint: expect.stringContaining("まだ folder") });
  mkdirSync(dir);
  // 断る 3 つ（負の対照 1）
  const sock = { write() {} }; // agent の CLI が繋ぐ unix socket の形
  for (const [m, from] of [[{ op: "openFolder", rootId: root.id }, sock], [{ op: "openFolder", rootId: root.id, owner: "s:1" }, {}], [{ op: "openFolder", rootId: root.id, agent: true }, {}]] as const) {
    const r = await H(m, from);
    expect(r).toMatchObject({ ok: false, hint: expect.stringContaining("人が押す物です") });
  }
  expect(opened).toEqual([]);
  // 人の押し。path を足しても無視（負の対照 2）。選択が無いので Finder
  const r = await H({ op: "openFolder", rootId: root.id, path: "/etc", app: "Calculator" }, {});
  expect(r).toMatchObject({ ok: true, app: "Finder", opened: [dir] });
  expect(opened).toEqual([[dir]]);
  // 会話が無い番号
  expect(await H({ op: "openFolder", rootId: 999 }, {})).toMatchObject({ ok: false });
});

test("viewer: 人だけが選べる（agent の CLI・owner つきは断る）。候補に無い app は断り、選んだ app は openFolder で open -a に渡る", async () => { // rules-ok: W38 人が Bar で押した時だけ前に開く（agent の呼びは断る・docs/BRIEF-w38.md §3）
  const { H, opened } = mkHandler();
  const list = (await H({ op: "editors" }, {})) as { ok: boolean; editors: string[]; current: string };
  expect(list.ok).toBe(true);
  expect(list.editors.slice(0, 2)).toEqual(["Finder", "Terminal"]);
  expect(list.current).toBe("Finder");
  expect(await H({ op: "viewer", app: "Terminal" }, { write() {} })).toMatchObject({ ok: false });
  expect(await H({ op: "viewer", app: "Terminal", owner: "s:1" }, {})).toMatchObject({ ok: false });
  expect(await H({ op: "viewer", app: "Calculator" }, {})).toMatchObject({ ok: false, hint: expect.stringContaining("候補") });
  expect(await H({ op: "viewer", app: "Terminal" }, {})).toMatchObject({ ok: true });
  const root = (await H({ op: "add", parentId: null, kind: "user", text: "B" }, {})).node;
  const dir = join(nodes, `${root.id} B`);
  mkdirSync(dir);
  expect(await H({ op: "openFolder", rootId: root.id }, {})).toMatchObject({ ok: true, app: "Terminal", opened: [dir] });
  expect(opened).toEqual([["-a", "Terminal", dir]]);
});

test("touchedOf: run で人が許した登録の cwd だけが「触った folder」に入る（断った物・未承認の物は入らない・最後に触った物が先）", async () => {
  const proj = join(top, "proj"), proj2 = join(top, "proj2"), work = join(top, "work");
  for (const d of [proj, proj2, work]) mkdirSync(d);
  const driver = (): Driver => ({ call: async (tool) => ({ text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }), close() {} });
  const L = makeLeases(join(top, "lease"), { driver, defaultMode: "allow", approvalMs: 5000 });
  const g = L.give({ pid: 10, windowId: 1, app: "Preview", title: "" }, "s:1");
  if (!g.ok) throw new Error();
  const ctx = { uiHome: ui, workDir: work };
  for (const [n, c] of [["one", proj], ["two", proj2]] as const) { const r = addCmd(ui, n, c, ["/usr/bin/true"]); if (!r.ok) throw new Error(r.hint); }
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
  const answer = async (yes: boolean) => { for (let i = 0; i < 400 && !L.approvals().length; i++) await tick(); const a = L.approvals()[0]!; L.answer(a.id, yes); };
  expect(L.touchedOf("s:1")).toEqual([]);
  const p1 = L.runCmd("s:1", "one", ctx); await answer(false); await p1; // 断った → 入らない
  expect(L.touchedOf("s:1")).toEqual([]);
  const p2 = L.runCmd("s:1", "one", ctx); await answer(true); await p2;
  expect(L.touchedOf("s:1")).toEqual([proj]);
  const p3 = L.runCmd("s:1", "two", ctx); await answer(true); await p3;
  expect(L.touchedOf("s:1")).toEqual([proj2, proj]); // 最後に触った物が先・重複しない
  const p4 = L.runCmd("s:1", "one", ctx); await answer(true); await p4;
  expect(L.touchedOf("s:1")).toEqual([proj, proj2]);
  expect(L.touchedOf("s:2")).toEqual([]); // 他の会話には出ない
  L.touchedDrop("s:1"); // 会話が消えた（main.ts の remove）
  expect(L.touchedOf("s:1")).toEqual([]);
});

test("W39c cursorOverlay: 既定 off・人だけが切り替える（agent の CLI・owner つき・on が真偽でない物は断り、file は変わらない）・lease の showCursor と同じ file", async () => {
  const { H } = mkHandler();
  const f = join(ui, "cursor-overlay");
  expect(await H({ op: "cursorOverlay" }, {})).toMatchObject({ ok: true, on: false });
  expect(await H({ op: "cursorOverlay", on: true }, { write() {} })).toMatchObject({ ok: false });
  expect(await H({ op: "cursorOverlay", on: true, owner: "s:1" }, {})).toMatchObject({ ok: false });
  expect(await H({ op: "cursorOverlay", on: "yes" }, {})).toMatchObject({ ok: false });
  expect(existsSync(f)).toBe(false);
  expect(await H({ op: "cursorOverlay", on: true }, {})).toMatchObject({ ok: true, on: true });
  expect(existsSync(f)).toBe(true);
  expect(await H({ op: "cursorOverlay", on: false, owner: "s:1" }, {})).toMatchObject({ ok: false });
  expect(existsSync(f)).toBe(true); // agent は消せない
  expect(await H({ op: "cursorOverlay", on: false }, {})).toMatchObject({ ok: true, on: false });
  expect(existsSync(f)).toBe(false);
});
