// W62 AC7〜9: 常駐の口 `press`（agent の呼びは list / run だけ）・turn の終わりの「押す操作にしますか」・一覧の画面の文。面は fake Driver（test/w6b.test.ts と同じ形）
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { pressArgv, pressOffer } from "../src/press-cli.ts";
import { extractPress, readPresses, savePress, type AimedRecord } from "../src/press.ts";
import type { Driver } from "../src/lease.ts";

function setup() {
  const procs: { end: () => void }[] = [];
  const spawn = () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
    const exited = new Promise<number>((r) => (done = r));
    procs.push({ end: () => { ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ type: "result", result: "書きました" }) + "\n")); ctrl.close(); done(0); } });
    return { stdout, exited, kill: () => { try { ctrl.close(); } catch {} done(143); } };
  };
  const acted: string[] = [];
  const driver: Driver = { call: async (tool) => {
    if (tool !== "list_windows" && tool !== "tab_state" && !tool.startsWith("gate_")) acted.push(tool);
    return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 7 }, { pid: 20, window_id: 2 }] } : tool === "get_window_state" ? { snapshot_id: "s1", elements: [{ element_token: "e1", role: "AXButton", label: "保存", value: "" }, { element_token: "e2", role: "AXTextField", label: "題", value: "" }] } : null };
  }, close() {} };
  const s = openStore(":memory:"), home = mktmp("kangae-ui");
  const h = makeHandler(s, async () => [], undefined,
    { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn: spawn as any, browserUrl: async () => null },
    { uiHome: home, leaseDriver: () => driver, modsRoot: mktmp("mods") });
  return { h: h as (m: any, owner?: unknown) => Promise<any>, s, procs, home, acted };
}
type S = ReturnType<typeof setup>;

// 会話に窓を渡し・agent を起こし・act を並べ・turn を終える（w6b.test.ts の run と同じ）
async function turn(t: S, root: number, acts: [string, any][], pid = 10) {
  await t.h({ op: "leaseMode", app: "ScratchPad", mode: "allow" });
  expect((await t.h({ op: "leaseGive", rootId: root, pid, windowId: pid === 10 ? 7 : 2, app: "ScratchPad", title: "" })).ok).toBe(true);
  const n = t.procs.length;
  expect((await t.h({ op: "send", rootId: root, text: "書いて" })).ok).toBe(true);
  const l = (await t.h({ op: "leaseList" })).leases.find((x: any) => x.owner === `s:${root}`);
  const tok = `${l.key}|${l.gen}|${l.owner}`;
  for (const [tool, args] of acts) expect((await t.h({ op: "act", lease: tok, tool, args })).ok).toBe(true);
  t.procs[n]!.end();
  for (let i = 0; i < 100; i++) {
    if ((await t.h({ op: "runs", nodeIds: [root] })).runs.every((r: any) => r.status !== "running")) break;
    await Bun.sleep(10);
  }
  await Bun.sleep(20);
}
const offered = (t: S, root: number) => t.s.children(root).filter((n) => n.text.startsWith("🧷 この仕事を押す操作にしますか"));

test("AC8: turn の記録が 2 件以上 → 会話に「押す操作にしますか」が 1 行・1 件以下なら出ない", async () => {
  const t = setup();
  const a = t.s.add(null, "user", "会議の予定を足す", true), b = t.s.add(null, "user", "読むだけ", true);
  await turn(t, a.id, [["get_window_state", {}], ["click", { element_token: "e1" }]]);
  expect(offered(t, a.id).map((n) => n.text)).toEqual(["🧷 この仕事を押す操作にしますか（2 手・欄 0）。一覧の「押す操作にする」を押すと保存します"]);
  expect((await t.h({ op: "press", action: "list", rootId: a.id })).offer).toMatchObject({ name: "会議の予定を足す", stages: [{ n: 1 }, { n: 2 }] });
  expect(readPresses(t.home)).toEqual([]); // 押すまで file に書かない
  await turn(t, b.id, [["get_window_state", {}]], 20);
  expect(offered(t, b.id)).toEqual([]);
});

test("AC8 の前の turn の記録は数えない（turn の時刻で絞る）", () => {
  const home = mktmp("press-offer");
  const rec = (at: number, op: string) => JSON.stringify({ at, face: "", app: "Calc", owner: "s:5", where: "", gen: 1, op, value: "", result: "ok" });
  writeFileSync(join(home, "ops.jsonl"), [rec(100, "click"), rec(200, "click"), rec(300, "click"), JSON.stringify({ at: 400, owner: "s:6", op: "click", result: "ok" })].join("\n") + "\n");
  expect(pressOffer(join(home, "ops.jsonl"), 5, 250, "x")).toBeNull();
  expect(pressOffer(join(home, "ops.jsonl"), 5, 150, "x")!.offer.press.stages.length).toBe(2);
});

test("通し: 押す操作にする → 一覧 → 押す（同じ門で再生・受領証）→ 再現率 1/1", async () => {
  const t = setup();
  const a = t.s.add(null, "user", "保存を押す", true);
  await turn(t, a.id, [["get_window_state", {}], ["click", { element_token: "e1" }]]);
  const sv = await t.h({ op: "press", action: "save", rootId: a.id, name: "保存を押す仕事" });
  expect(sv).toMatchObject({ ok: true });
  const p = JSON.parse(readFileSync(join(t.home, "presses", `${sv.press}.json`), "utf8"));
  expect(p.stages[1].way).toEqual({ kind: "act", app: "ScratchPad", tool: "click", args: { element_token: { const: "e1" } } }); // W72: 記録の的（押した要素）が way に残る
  expect(p.stages[1].goal).toBe("ScratchPadで押す（保存）"); // 名前は直前の get_window_state の読みから（button 類だけ）
  const ls = await t.h({ op: "press", action: "list", rootId: a.id });
  expect(ls.offer).toBeNull();
  expect(ls.presses.map((p: any) => p.name)).toEqual(["保存を押す仕事"]);
  t.acted.length = 0;
  const r = await t.h({ op: "press", action: "run", rootId: a.id, press: sv.press, fields: {}, wait: true });
  expect(r).toMatchObject({ ok: true, clean: true, stopped: false });
  expect(r.receipts.map((x: any) => x.result)).toEqual(["ok", "ok"]);
  expect(t.acted).toEqual(["get_window_state", "click"]); // 同じ門（leases.act → driver）を通った
  expect(readPresses(t.home)[0]!.runs).toMatchObject({ total: 1, clean: 1 });
  expect(t.s.children(a.id).some((n) => n.text.includes("全部の段が済みました"))).toBe(true);
});

test("AC7: agent の呼び（owner つき・CLI の口）は save / rm / answer を断り、list / run は通す", async () => {
  const t = setup();
  const cli = { write() {} };
  for (const action of ["save", "rm", "answer"]) {
    expect(await t.h({ op: "press", action, owner: "s:1", press: "a1b2c3d4" })).toMatchObject({ ok: false, code: "bad" });
    expect(await t.h({ op: "press", action, press: "a1b2c3d4" }, cli)).toMatchObject({ ok: false, code: "bad" });
  }
  expect(await t.h({ op: "press", action: "list", owner: "s:1" })).toMatchObject({ ok: true, presses: [] });
  const run = await t.h({ op: "press", action: "run", owner: "s:1", press: "a1b2c3d4" });
  expect(run).toEqual({ ok: false, hint: "その押す操作は見つかりません" }); // 口は通った（中身が無いだけ）
  expect((await t.h({ op: "press", action: "rm", press: "a1b2c3d4" })).code).toBeUndefined(); // 人の panel は通る
});

test("止まった段: 探し直しでも済まない → 人が一覧で「やめる」を答える（answer）・走っている間の二度押しは断る", async () => {
  const t = setup();
  const a = t.s.add(null, "user", "保存を押す", true);
  await turn(t, a.id, [["get_window_state", {}], ["click", { element_token: "e1" }]]);
  const sv = await t.h({ op: "press", action: "save", rootId: a.id });
  const f = join(t.home, "presses", `${sv.press}.json`), p = JSON.parse(readFileSync(f, "utf8"));
  p.stages[0].post = { kind: "elements", names: ["送信済み"] }; // 面に出ない結果 → 通った手でも探し直しでも済まない
  writeFileSync(f, JSON.stringify(p));
  const n = t.procs.length;
  const r = await t.h({ op: "press", action: "run", rootId: a.id, press: sv.press, fields: {} });
  expect(r).toMatchObject({ ok: true });
  expect(await t.h({ op: "press", action: "run", rootId: a.id, press: sv.press, fields: {} })).toEqual({ ok: false, hint: "この押す操作はいま走っています。終わってから押してください" }); // 送り直し・二度押し
  for (let i = 0; i < 300 && t.procs.length === n; i++) await Bun.sleep(10);
  t.procs[n]!.end(); // 探し直しの 1 turn（その会話の agent）が終わる
  let asks: any[] = [];
  for (let i = 0; i < 300 && !asks.length; i++) { asks = (await t.h({ op: "press", action: "list", rootId: a.id })).asks; await Bun.sleep(10); }
  expect(asks[0]).toMatchObject({ n: 1, run: r.run });
  expect(t.s.children(a.id).some((x) => x.text.includes("段 1") && x.text.includes("止まりました"))).toBe(true);
  expect(await t.h({ op: "press", action: "answer", run: r.run, yes: false })).toEqual({ ok: true });
  for (let i = 0; i < 300 && (await t.h({ op: "press", action: "list" })).active.length; i++) await Bun.sleep(10);
  expect(readPresses(t.home)[0]!.runs).toMatchObject({ total: 1, clean: 0 });
});

test("CLI: list / show は file だけ・rm は agent の env で断る・run は常駐の答えを段ごとに出す", async () => {
  const home = mktmp("press-cli"), out: string[] = [], err: string[] = [];
  const io = { home, out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  expect(await pressArgv(["list"], { ...io, send: async () => ({ ok: false }) })).toBe(0);
  expect(out.pop()).toContain("まだありません");
  expect(await pressArgv(["rm", "a1b2c3d4"], { ...io, owner: "s:3", send: async () => ({ ok: false }) })).toBe(1);
  expect(err.pop()).toContain("人です");
  let sent: any;
  const code = await pressArgv(["run", "a1b2c3d4", "title=会議"], { ...io, owner: "s:3", send: async (m) => { sent = m; return { ok: true, stopped: false, receipts: [{ at: 1, run: "r", stage: 1, result: "ok", note: "通った手で済んだ" }] }; } });
  expect(code).toBe(0);
  expect(sent).toEqual({ op: "press", action: "run", press: "a1b2c3d4", fields: { title: "会議" }, owner: "s:3", wait: true });
  expect(out.pop()).toBe("段 1: 済んだ（通った手で済んだ）");
});

const pressScreen = () => {
  const html = readFileSync(join(import.meta.dir, "../extension/panel.html"), "utf8");
  const a = html.indexOf('<section id="press"');
  const b = html.indexOf('<section id="chat"');
  return html.slice(a, b).replace(/<[^>]*>/g, " ");
};

test("AC9: 一覧の画面の文に内部語が無い・press.js は innerHTML を使わない", () => {
  const html = pressScreen();
  const js = readFileSync(join(import.meta.dir, "../extension/press.js"), "utf8");
  const shown = [html, ...[...js.matchAll(/"([^"\n]*[぀-ヿ一-鿿][^"\n]*)"|`([^`\n]*[぀-ヿ一-鿿][^`\n]*)`/g)].map((m) => m[1] ?? m[2])].join("\n");
  for (const w of ["lease", "gen", "token", "CDP", "DOM", "世代"]) expect(shown).not.toContain(w);
  expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test("W81 AC2: 一覧の文（渡す・受け取るを含む）に禁止語が無い", async () => {
  const { checkCardText } = await import("../src/press-card.ts");
  const html = pressScreen();
  const js = readFileSync(join(import.meta.dir, "../extension/press.js"), "utf8");
  const shown = [html, ...[...js.matchAll(/"([^"\n]*[぀-ヿ一-鿿][^"\n]*)"|`([^`\n]*[぀-ヿ一-鿿][^`\n]*)`/g)].map((m) => m[1] ?? m[2]!)];
  expect(shown.join("\n")).toContain("渡す");
  expect(shown.join("\n")).toContain("受け取る");
  expect(checkCardText({ title: "", lines: shown, steps: [] })).toEqual({ ok: true });
});

// W72 AC1: share / import の口（W63 の exportPress / importPress を CLI と常駐の press から）
const made = (home: string) => {
  const p = extractPress([{ at: 1, face: "f", app: "ScratchPad", gen: 1, op: "fill", value: "会議", result: "ok", owner: "s:1", target: "題" }, { at: 2, face: "f", app: "ScratchPad", gen: 1, op: "press_button", value: "", result: "ok", owner: "s:1", target: "保存" }] as AimedRecord[], { owner: "s:1", name: "予定を足す" });
  savePress(home, p);
  return p;
};

test("W72 AC1: kangae press share が署名つき file を書き・別の home で kangae press import が検証 → 環境 → card → 保存", async () => {
  const a = mktmp("press-a"), b = mktmp("press-b"), out: string[] = [], err: string[] = [];
  const p = made(a), file = join(mktmp("press-file"), "x.kangae-press.json");
  expect(await pressArgv(["share", p.id, file], { home: a, out: (s) => out.push(s), err: (s) => err.push(s), send: async () => ({ ok: false }) })).toBe(0);
  const j = JSON.parse(readFileSync(file, "utf8"));
  expect(typeof j.sig).toBe("string");
  expect(JSON.stringify(j)).not.toContain("会議"); // 入れた値は渡さない
  expect(j.press.stages[0].way.args.field).toEqual({ const: "題" }); // 的は渡る
  let asked: any;
  expect(await pressArgv(["import", file], { home: b, out: (s) => out.push(s), err: (s) => err.push(s), send: async (m) => { asked = m; return { ok: true, ext: true }; } })).toBe(0);
  expect(asked).toEqual({ op: "press", action: "list" }); // 拡張の有無だけ常駐に聞く
  expect(out.pop()).toContain("読み込みました");
  expect(readPresses(b).map((x) => [x.name, x.madeBy?.fp.length])).toEqual([["予定を足す", 16]]);
  writeFileSync(file, readFileSync(file, "utf8").replace("予定を足す", "予定を消す")); // 負の対照: 書き換えた file は読まない
  expect(await pressArgv(["import", file], { home: mktmp("press-c"), out: (s) => out.push(s), err: (s) => err.push(s), send: async () => ({ ok: true }) })).toBe(1);
  expect(err.pop()).toContain("署名が合いません");
});

test("W72 AC1: import は人だけ（agent の env の CLI・owner つき・CLI の口は断る）・人の一覧は常駐の press import で通る", async () => {
  const t = setup(), src = mktmp("press-src"), file = join(mktmp("press-file"), "y.kangae-press.json"), err: string[] = [];
  const p = made(src);
  expect(await pressArgv(["share", p.id, file], { home: src, out() {}, err() {}, send: async () => ({ ok: false }) })).toBe(0);
  expect(await pressArgv(["import", file], { home: t.home, owner: "s:3", out() {}, err: (s) => err.push(s), send: async () => ({ ok: true }) })).toBe(1);
  expect(err.pop()).toContain("人です");
  expect(await t.h({ op: "press", action: "import", owner: "s:1", path: file })).toMatchObject({ ok: false, code: "bad" });
  expect(await t.h({ op: "press", action: "import", path: file }, { write() {} })).toMatchObject({ ok: false, code: "bad" });
  expect(readPresses(t.home)).toEqual([]);
  expect(await t.h({ op: "press", action: "import", path: "rel.json" })).toMatchObject({ ok: false });
  const r = await t.h({ op: "press", action: "import", path: ` "file://${file}" ` }); // 欄に貼った形（引用符・file://）も受ける
  expect(r).toMatchObject({ ok: true, cardOk: true });
  expect(r.card.title).toBe("「予定を足す」を押す");
  expect(readPresses(t.home)).toEqual([]); // W81: card を見せるだけ。「始める」まで保存しない
  expect(await t.h({ op: "press", action: "import", key: r.key }, { write() {} })).toMatchObject({ ok: false, code: "bad" }); // agent の口から「始める」は押せない
  expect(await t.h({ op: "press", action: "import", key: "nope" })).toMatchObject({ ok: false });
  expect(await t.h({ op: "press", action: "import", key: r.key })).toMatchObject({ ok: true });
  expect(readPresses(t.home).map((x) => x.name)).toEqual(["予定を足す"]);
  expect(await t.h({ op: "press", action: "import", key: r.key })).toMatchObject({ ok: false }); // 1 回だけ
});

// W81 AC2 / AC3: 一覧の「渡す」= 常駐が ~/Downloads/<名前>.kangae-press.json に書く（場所は人も agent も選ばない）・同じ名前は (2)・agent の呼びは断る
test("W81: 常駐の press share は ~/Downloads に書き・別の home の press import → card →「始める」で一覧に入る", async () => {
  const t = setup(), fake = mktmp("press-home"), was = process.env.HOME;
  process.env.HOME = fake;
  try {
    const p = made(t.home);
    expect(await t.h({ op: "press", action: "share", press: p.id, owner: "s:1" })).toMatchObject({ ok: false, code: "bad" });
    expect(await t.h({ op: "press", action: "share", press: p.id }, { write() {} })).toMatchObject({ ok: false, code: "bad" });
    expect(await t.h({ op: "press", action: "share", press: p.id, path: "/tmp/x.json" })).toMatchObject({ ok: true, path: join(fake, "Downloads", "予定を足す.kangae-press.json") }); // path は渡しても使わない
    expect((await t.h({ op: "press", action: "share", press: p.id })).path).toBe(join(fake, "Downloads", "予定を足す (2).kangae-press.json"));
    expect(await t.h({ op: "press", action: "share", press: "ffffffff" })).toMatchObject({ ok: false });
    const u = setup(), r = await u.h({ op: "press", action: "import", path: "~/Downloads/予定を足す.kangae-press.json" });
    expect(r).toMatchObject({ ok: true, cardOk: true });
    expect(r.card.lines.join("\n")).not.toContain("会議");
    expect(await u.h({ op: "press", action: "import", key: r.key })).toMatchObject({ ok: true });
    expect(readPresses(u.home)[0]!.madeBy?.fp).toHaveLength(16);
  } finally { process.env.HOME = was; }
});

// W81 AC1: link の文字（頁の中身）は goal にも const にも書き出しにも入らない・書き出しの goal は 80 字で制御文字なし
test("W81: click した link の文字は書き出しの file に無い・button の名前は残る", async () => {
  const { makeAims } = await import("../src/press-cli.ts");
  const { exportPress } = await import("../src/press-share.ts");
  const secret = "山田様 請求書 口座 1234567 金額 120000円 ".repeat(4), aims = makeAims(), tok = "tab:9|3|s:1", recs: AimedRecord[] = [];
  const rec = (op: string): AimedRecord => ({ at: 1, face: "tab:9", app: "Chrome", gen: 3, op, value: "{}", result: "ok", owner: "s:1" });
  const gate = { act: async (_t: string, tool: string) => { recs.push(aims.tag(rec(tool))); return tool === "get_window_state" ? { ok: true, isError: false, text: ["snapshot", `e1\tAXLink\t${secret}`, "e2\tlink\t別の件名", "e3\tAXButton\t送信"].join("\n") } : { ok: true, isError: false, text: "ok" }; } };
  await aims.act(gate, tok, "get_window_state", {});
  for (const e of ["e1", "e2", "e3"]) await aims.act(gate, tok, "click", { element_token: e });
  const home = mktmp("press-link"), p = extractPress(recs, { owner: "s:1", name: "請求を送る" });
  savePress(home, p);
  const file = join(mktmp("press-file"), "l.kangae-press.json");
  expect(exportPress(home, p.id, file).ok).toBe(true);
  const body = readFileSync(file, "utf8");
  for (const w of ["山田様", "1234567", "別の件名"]) expect(body).not.toContain(w);
  expect(JSON.parse(body).press.stages.map((s: any) => s.goal)).toEqual(["Chromeで操作する", "Chromeで押す", "Chromeで押す", "Chromeで押す（送信）"]);
});

test("W81: 書き出しの goal は 80 字・制御文字なし（記録の外から来た長い goal も）", async () => {
  const { exportPress } = await import("../src/press-share.ts");
  const home = mktmp("press-goal"), p = made(home), file = join(mktmp("press-file"), "g.kangae-press.json");
  savePress(home, { ...p, stages: p.stages.map((s) => ({ ...s, goal: `頭\u0007\u202e${"中身".repeat(100)}尻` })) });
  expect(exportPress(home, p.id, file).ok).toBe(true);
  const goals = JSON.parse(readFileSync(file, "utf8")).press.stages.map((s: any) => s.goal as string);
  for (const g of goals) { expect(g.length).toBeLessThanOrEqual(80); expect(g).not.toMatch(/[\p{Cc}\p{Cf}]/u); expect(g).not.toContain("尻"); }
});
