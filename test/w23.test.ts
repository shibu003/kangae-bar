// W23: 面を持たない agent A が open_app も run も使えず 6 分止まった（EXP-1 再走 run2）。A に open_app と run の道を案内し、面が無くても最初の open_app は承認 card つきで通り、Bash の「requires approval」で待たせない。読む file を literal で名指す: "src/main.ts" "src/lease.ts" "extension/panel.js"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCmd } from "../src/cmds.ts";
import { makeLeases, type Driver } from "../src/lease.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

let top: string, calls: { tool: string; args: Record<string, any> }[];
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const cua = (): Driver => ({
  call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "launch_app") return { text: "", isError: false, data: { pid: 30, windows: [{ pid: 30, window_id: 7, title: "ER_Triage_GUI — Preview", app_name: "Preview" }] } };
    return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 30, window_id: 7 }] } : null };
  },
  close() {},
});
const launched = () => calls.filter((c) => c.tool === "launch_app");
const waitCard = async (L: ReturnType<typeof makeLeases>) => { for (let i = 0; i < 300 && !L.approvals().length; i++) await tick(); return L.approvals()[0]!; };

beforeEach(() => { top = realpathSync(mktmp("w23")); calls = []; mkdirSync(join(top, "lease")); });
afterEach(() => rmSync(top, { recursive: true, force: true }));

test("W23-1 面を持たない会話でも最初の open_app は通る: 許す前は launch 0 件・card（open_app・danger・owner）が出て、許すと窓がその会話の最初の面になる", async () => {
  const L = makeLeases(join(top, "lease"), { driver: cua, defaultMode: "allow", approvalMs: 5000, windowMs: 200 });
  expect(L.facesOf("s:1")).toEqual([]);
  const p = L.openAppFree("s:1", { app: "Preview", path: top });
  const card = await waitCard(L);
  expect(card).toMatchObject({ tool: "open_app", owner: "s:1", danger: true });
  expect(card.what).toContain("Preview を裏で開きます");
  await tick(30);
  expect(launched()).toHaveLength(0);
  L.answer(card.id, true);
  const r = await p;
  expect(r).toMatchObject({ ok: true });
  expect(launched()).toEqual([{ tool: "launch_app", args: { name: "Preview" } }]);
  const faces = L.facesOf("s:1");
  expect(faces).toHaveLength(1);
  expect(faces[0]!.surface).toMatchObject({ pid: 30, windowId: 7, app: "Preview" });
  expect(L.list().some((l) => "pid" in l.surface && l.surface.pid === 0)).toBe(false); // 仮の「聞く側」は表に残らない
});

test("W23-2 断る・待つ間に turn が終わる・全停止・面が上限: 何も起こさず、面も増えない", async () => {
  for (const how of ["no", "endTurn", "stopAll"] as const) {
    calls = [];
    const L = makeLeases(join(top, "lease"), { driver: cua, defaultMode: "allow", approvalMs: 5000, windowMs: 200 });
    const p = L.openAppFree("s:1", { app: "Preview" });
    const card = await waitCard(L);
    if (how === "no") L.answer(card.id, false); else if (how === "endTurn") L.endTurn("s:1"); else L.stopAll();
    expect(await p).toMatchObject({ ok: false });
    expect(launched()).toHaveLength(0);
    expect(L.facesOf("s:1")).toEqual([]);
  }
  const L = makeLeases(join(top, "lease"), { driver: cua, defaultMode: "allow", windowMs: 200 });
  L.give({ pid: 1, windowId: 1, app: "A", title: "" }, "s:1"); L.give({ pid: 2, windowId: 2, app: "B", title: "" }, "s:1");
  expect(await L.openAppFree("s:1", { app: "Preview" })).toMatchObject({ ok: false, why: "busy" }); // 面が 2 枚＝聞く前に断る
  expect(L.approvals()).toEqual([]);
}, 60_000);

test("W23-3 別の会話の面は取らない・bundle_id と app の両方・実行 file は聞く前に断る（W16a の検査は面なしでも同じ）", async () => {
  const L = makeLeases(join(top, "lease"), { driver: cua, defaultMode: "allow", windowMs: 200 });
  expect(await L.openAppFree("s:1", { app: "Preview", bundle_id: "com.apple.Preview" })).toMatchObject({ ok: false, why: "tool" });
  expect(await L.openAppFree("s:1", { app: "Preview", path: join(top, "no-such") })).toMatchObject({ ok: false, why: "tool" });
  expect(L.approvals()).toEqual([]);
  expect(launched()).toHaveLength(0);
});

// ---- 常駐: 面の無い agent の turn の案内・tools・daemon op ----
const harness = (cmds = false) => {
  const calls2: string[][] = [];
  const spawn = (cmd: string[]) => { calls2.push(cmd); let done!: (c: number) => void; return { stdout: new ReadableStream<Uint8Array>({ start: () => {} }), exited: new Promise<number>((r) => (done = r)), kill: () => done(143) }; };
  const ui = join(top, "ui"), base = mktmp("ws");
  mkdirSync(ui, { recursive: true });
  if (cmds) { const proj = join(top, "proj"); mkdirSync(proj); const r = addCmd(ui, "build", proj, ["/bin/echo", "SECRET-ARGV"]); if (!r.ok) throw new Error(r.hint); }
  const s = openStore(":memory:");
  const H: any = makeHandler(s, async () => [], undefined,
    { dir: base, bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => "http://127.0.0.1:9" },
    { uiHome: ui, leaseDriver: () => cua() });
  const tools = (i: number) => calls2[i]![calls2[i]!.indexOf("--allowedTools") + 1]!;
  const files = (name: string): string[] => { const out: string[] = []; const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === name) out.push(readFileSync(p, "utf8")); } }; walk(base); return out; };
  return { H, s, calls2, tools, files };
};

test("W23-4 面の無い agent A に open_app と run と Bash の決まりが案内される: tools に act:* と run:*・頼みの頭に名前の一覧と使い方・AGENTS.md が「open_app で開く」に", async () => {
  const h = harness(true);
  const a = h.s.add(null, "user", "agentA は Preview で ER_Triage_GUI を build して", true);
  const r: any = await h.H({ op: "workspace", nodeId: a.id, agent: true, text: "go" });
  expect(r.ok).toBe(true);
  expect(h.H).toBeDefined();
  expect(h.tools(0)).toContain("/x/kangae act:*"); // 面が無くても open_app の入口がある
  expect(h.tools(0)).toContain("/x/kangae run:*");
  expect(h.tools(0)).not.toContain("Bash(/x/kangae step:*)"); // step は面を持つ turn だけ
  const prompt = h.calls2[0]!.join(" ");
  expect(prompt).toContain("人が登録した command: build");
  expect(prompt).toContain("run <名前>");
  expect(prompt).toContain("launch"); // 面が要る＝人に渡してもらうか登録した app を launch で起こす（W37: 編集器は開かない）
  expect(prompt).not.toContain("先に `/x/kangae act open_app`"); // 編集器を開く道を勧めない
  expect(prompt).not.toContain("SECRET-ARGV"); // 名前だけ
  const md = h.files("AGENTS.md")[0]!;
  expect(md).toContain("act open_app");
  expect(md).toContain("requires approval");
  expect(md).not.toContain("自分で GUI の app や窓を開かない（開いても人の画面を邪魔する）。窓の操作は人が渡した窓だけ");
  await h.H({ op: "stopRun", runId: r.run.id });
});

test("W23-5 登録が無い時は run:* も名前の案内も出さない（open_app の入口と AGENTS.md の規則は在る）", async () => {
  const h = harness(false);
  const a = h.s.add(null, "user", "agentA", true);
  await h.H({ op: "workspace", nodeId: a.id, agent: true, text: "go" });
  expect(h.tools(0)).not.toContain("run:*");
  expect(h.tools(0)).toContain("act:*");
  const prompt = h.calls2[0]!.join(" ");
  expect(prompt).not.toContain("人が登録した command"); // 登録が無ければ名前の案内は出ない（AGENTS.md の規則は在る）
  expect(h.files("AGENTS.md")[0]!).toContain("act open_app");
});

test("W23-6 daemon op: 面の無い会話の open_app は card を出して通り、それ以外の操作（click など）は面が無いので断る", async () => {
  const h = harness(false);
  const a = h.s.add(null, "user", "agentA", true);
  const owner = `s:${a.id}`;
  const bad: any = await h.H({ op: "act", owner, tool: "click", args: {} });
  expect(bad.ok).toBe(false);
  const p = h.H({ op: "act", owner, tool: "open_app", args: { app: "Preview" } });
  let card: any;
  for (let i = 0; i < 300 && !card; i++) { card = ((await h.H({ op: "leaseList" })) as any).approvals?.[0]; if (!card) await tick(); }
  expect(card).toMatchObject({ tool: "open_app", owner });
  expect(launched()).toHaveLength(0);
  expect(((await h.H({ op: "approvalAnswer", id: card.id, yes: true })) as any).ok).toBe(true);
  const r: any = await p;
  expect(r.ok).toBe(true);
  const leases: any[] = ((await h.H({ op: "leaseList" })) as any).leases;
  expect(leases.map((l) => [l.owner, l.surface.app])).toEqual([[owner, "Preview"]]);
});

test("W23-7 CLI と panel: 面の無い agent の `act open_app` は CLI で断られず常駐へ届く・card の題は「まだ窓を持っていない会話の頼みです」", () => {
  const main = readFileSync("src/main.ts", "utf8");
  expect(main.includes('const first = !hasTok && !on && (av[0] === "open_app" || av[0] === "open_tab") && process.env.KANGAE_OWNER;')).toBe(true);
  expect(main.includes("if (!hasTok && !late && !first)")).toBe(true);
  expect(readFileSync("extension/panel.js", "utf8").includes("まだ窓を持っていない会話の頼みです")).toBe(true);
});
