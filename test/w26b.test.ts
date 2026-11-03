// W26b: 作業場所の path が替わると claude の --resume は前の session を見つけられない。(1) 「続きが見つからない」で失敗したら sessionId を捨てて同じ頼みで 1 回だけ新しく始める (2) 常駐の起動で、今の作業場所では続けられない session を捨てる（手で移した時も効く）。読む file を literal で名指す: "src/main.ts" "src/agents.ts"
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgents } from "../src/agents.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

let top: string;
beforeEach(() => { top = realpathSync(mktmp("w26b")); });
afterEach(() => rmSync(top, { recursive: true, force: true }));
const rec = (name: string, nodeId: number, extra: object = {}) => ({ name, nodeId, unread: false, createdAt: 1, ...extra }) as any;

test("W26b-1 forgetStale: 記録した作業場所が今と違えば捨て・同じなら残す。名前と記憶（agent.json の他の欄）は残る", () => {
  const a = makeAgents(join(top, "kh"));
  const NOW = join(top, "nodes-new"), OLD = join(top, "nodes-old");
  a.write(rec("same", 1, { sessionId: "s1", nodesDir: NOW }));
  a.write(rec("moved", 2, { sessionId: "s2", nodesDir: OLD, answer: "前の答え" }));
  a.write(rec("nosession", 3, { nodesDir: OLD }));
  expect(a.forgetStale(NOW, join(top, "projects"))).toBe(1);
  expect(a.read("same")!.sessionId).toBe("s1");
  expect(a.read("moved")!.sessionId).toBeUndefined();
  expect(a.read("moved")).toMatchObject({ name: "moved", nodeId: 2, answer: "前の答え" });
});

test("W26b-2 記録が無い古い agent: claude が session を置く場所（projects/<cwd の英数字以外を - に>/<sessionId>.jsonl）が今の作業場所の下に在れば残し、旧い場所の物・どこにも無い物は捨てる。projects が読めない時は決めつけない", () => {
  const a = makeAgents(join(top, "kh")), projects = join(top, "projects"), NOW = join(top, "nodes new");
  const enc = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(projects, enc(join(NOW, "1 a"))), { recursive: true }); writeFileSync(join(projects, enc(join(NOW, "1 a")), "ok-sid.jsonl"), "");
  mkdirSync(join(projects, "-Users-old-Documents------2-b"), { recursive: true }); writeFileSync(join(projects, "-Users-old-Documents------2-b", "old-sid.jsonl"), "");
  a.write(rec("fine", 1, { sessionId: "ok-sid" }));
  a.write(rec("oldplace", 2, { sessionId: "old-sid" }));
  a.write(rec("nowhere", 3, { sessionId: "gone-sid" }));
  expect(a.forgetStale(NOW, projects)).toBe(2);
  expect(a.read("fine")!.sessionId).toBe("ok-sid");
  expect(a.read("oldplace")!.sessionId).toBeUndefined();
  expect(a.read("nowhere")!.sessionId).toBeUndefined();
  a.write(rec("unknown", 4, { sessionId: "x" }));
  expect(a.forgetStale(NOW, join(top, "no-such-projects"))).toBe(0); // 読めない時は捨てない
  expect(a.read("unknown")!.sessionId).toBe("x");
});

// ---- fake の claude（stdout を 1 行ずつ流して終わる）----
const harness = () => {
  const calls: { cmd: string[]; finish: (lines: object[], code?: number) => void }[] = [];
  const spawn = (cmd: string[]) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>, done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
    const exited = new Promise<number>((r) => (done = r));
    calls.push({ cmd, finish: (lines, code = 0) => { for (const l of lines) ctrl.enqueue(new TextEncoder().encode(JSON.stringify(l) + "\n")); ctrl.close(); done(code); } });
    return { stdout, exited, kill: () => { try { ctrl.close(); } catch {} done(143); } };
  };
  const ui = join(top, "ui"); mkdirSync(ui, { recursive: true });
  const nodes = join(top, "nodes"); mkdirSync(nodes, { recursive: true });
  const s = openStore(":memory:");
  const H: any = makeHandler(s, async () => [], undefined,
    { dir: nodes, bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => "http://127.0.0.1:9" },
    { uiHome: ui });
  return { H, s, calls, ui, nodes };
};
const until = async (f: () => boolean) => { for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); return f(); };

test("W26b-3 --resume が「続きが見つからない」で失敗したら、sessionId を捨てて同じ頼みで 1 回だけやり直す（--resume 無し）・名前と記憶は残り・やり直しの session を記録する", async () => {
  const h = harness();
  const n = h.s.add(null, "user", "agentA の仕事", true);
  expect((await h.H({ op: "agentName", rootId: n.id, name: "agentA" })).ok).toBe(true);
  const ag = makeAgents(h.ui);
  ag.finish("agentA", { sessionId: "old-session", nodesDir: join(top, "elsewhere"), answer: "覚え書き" });
  const r: any = await h.H({ op: "workspace", nodeId: n.id, agent: true, text: "続きをやって" });
  expect(r.ok).toBe(true);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.cmd).toContain("--resume");
  expect(h.calls[0]!.cmd[h.calls[0]!.cmd.indexOf("--resume") + 1]).toBe("old-session");
  h.calls[0]!.finish([{ type: "result", is_error: true, result: "No conversation found with session ID: old-session" }], 1);
  expect(await until(() => h.calls.length === 2)).toBe(true); // 1 回だけやり直す
  expect(h.calls[1]!.cmd).not.toContain("--resume");
  expect(h.calls[1]!.cmd.join(" ")).toContain("続きをやって"); // 同じ頼み
  expect(ag.read("agentA")!.sessionId).toBeUndefined(); // 失敗した session は捨てた
  expect(ag.read("agentA")).toMatchObject({ name: "agentA", answer: "覚え書き" });
  h.calls[1]!.finish([{ type: "system", session_id: "new-session" }, { type: "result", is_error: false, result: "できました" }], 0);
  expect(await until(() => ag.read("agentA")?.sessionId === "new-session")).toBe(true);
  expect(ag.read("agentA")!.nodesDir).toBe(realpathSync(h.nodes)); // やり直しの session は今の作業場所で作った印つき
  expect(h.calls).toHaveLength(2);
  const log = ((await h.H({ op: "runs", nodeIds: [n.id] })) as any).runs[0].log.join("\n");
  expect(log).toContain("新しく始めます");
});

test("W26b-4 --resume を付けていない turn は、同じ文が出ても繰り返さない（無限に起こし直さない）", async () => {
  const h = harness();
  const n = h.s.add(null, "user", "新しい会話", true);
  const r: any = await h.H({ op: "workspace", nodeId: n.id, agent: true, text: "go" });
  expect(r.ok).toBe(true);
  expect(h.calls[0]!.cmd).not.toContain("--resume");
  h.calls[0]!.finish([{ type: "result", is_error: true, result: "No conversation found with session ID: zzz" }], 1);
  await new Promise((res) => setTimeout(res, 300));
  expect(h.calls).toHaveLength(1);
});

test("W26b-5 起動: 常駐の起動で forgetStale が走る・session を作った時の作業場所を記録する", () => {
  const src = readFileSync("src/main.ts", "utf8");
  expect(src.includes("makeAgents(home).forgetStale(")).toBe(true);
  expect(src.includes("nodesDir: nodesReal()")).toBe(true);
  expect(src.includes("RESUME_LOST.test(")).toBe(true);
});
