import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_HINT, chooseEngine, judgeClaudeStatus, judgeGemini, judgeStop, parseReset, type Billing, type Cli } from "../src/engine-choice.ts";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import type { Driver } from "../src/lease.ts";

const C: Billing = { kind: "contract" };
const M: Billing = { kind: "metered", source: "ANTHROPIC_API_KEY" };
const N: Billing = { kind: "not-logged-in" };
const U: Billing = { kind: "unknown" };
const NOW = new Date("2026-10-07T12:00:00").getTime();
const base = { current: "claude" as Cli, order: ["claude", "gemini"] as Cli[], billing: {}, failed: "limit" as const, until: null };

// AC-2 判定の表: keep / switch / wait / refuse × 理由 5 つ
test("W5 判定: 契約で使える別の AI があれば替える（理由 = 止まった理由）", () => {
  expect(chooseEngine({ ...base, billing: { gemini: C } }, NOW)).toEqual({ kind: "switch", to: "gemini", reason: "limit" });
  expect(chooseEngine({ ...base, failed: "login", billing: { gemini: C } }, NOW)).toEqual({ kind: "switch", to: "gemini", reason: "login" });
  expect(chooseEngine({ ...base, billing: { gemini: C }, unusable: ["claude"] }, NOW)).toMatchObject({ kind: "switch" }); // 自分は元から除く
  expect(chooseEngine({ ...base, current: "gemini", billing: { claude: C }, unusable: [] }, NOW)).toMatchObject({ kind: "switch", to: "claude" });
});
test("W5 判定: 止まっていなければ keep", () => {
  expect(chooseEngine({ ...base, failed: null, billing: { claude: C } }, NOW)).toEqual({ kind: "keep" });
  expect(chooseEngine({ ...base, failed: null, billing: { claude: M } }, NOW)).not.toEqual({ kind: "keep" }); // 従量は keep でもない
});
test("W5 判定: unknown では替えない（確かめられない物は使える物に数えない）", () => {
  const c = chooseEngine({ ...base, billing: { gemini: U } }, NOW);
  expect(c).toMatchObject({ kind: "refuse", reason: "limit" });
  expect((c as any).line).toContain("確かめられない");
  expect(chooseEngine({ ...base, billing: {} }, NOW).kind).toBe("refuse"); // 読みが無い = unknown
});
test("W5 判定: 従量課金は人が許すまで替えない・許したら替える", () => {
  const c = chooseEngine({ ...base, billing: { gemini: { kind: "metered", source: "GEMINI_API_KEY" } } }, NOW);
  expect(c).toMatchObject({ kind: "refuse", reason: "metered" });
  expect((c as any).line).toContain("従量");
  expect(chooseEngine({ ...base, billing: { gemini: M }, allowed: new Set<Cli>(["gemini"]) }, NOW)).toMatchObject({ kind: "switch", to: "gemini" });
});
test("W5 判定: 替え先の login が切れていれば、そちらの login を名指して止める", () => {
  const c = chooseEngine({ ...base, billing: { gemini: N } }, NOW);
  expect(c).toMatchObject({ kind: "refuse", reason: "login" });
  expect((c as any).line).toContain("gemini の login");
});
test("W5 判定: 戻る時刻が別の日なら日付が付く（今を固定して確かめる）", () => {
  const w = chooseEngine({ ...base, order: ["claude"], until: new Date("2026-10-08T15:00:00").getTime() }, NOW);
  expect((w as any).line).toContain("10/8 15:00 に戻ります");
  expect((w as any).line).not.toContain("（15:00");
});
test("W5 判定: 他の AI が無い。上限で戻る時刻が分かれば wait・無ければ refuse（次の一手つき・何も実行しない）", () => {
  const w = chooseEngine({ ...base, order: ["claude"], until: NOW + 3 * 3600_000 }, NOW);
  expect(w).toMatchObject({ kind: "wait", until: NOW + 3 * 3600_000 });
  expect((w as any).line).toContain("15:00 に戻ります");
  expect((w as any).line).toContain("codex を入れると替われます");
  const r = chooseEngine({ ...base, order: ["claude"] }, NOW);
  expect(r).toMatchObject({ kind: "refuse", reason: "limit" });
  expect((r as any).line).toContain("戻る時刻は分かりません");
  const l = chooseEngine({ ...base, order: ["claude"], failed: "login" }, NOW);
  expect(l).toMatchObject({ kind: "refuse", reason: "login" });
  expect((l as any).line).toContain("claude の login が切れています");
});
test("W5 判定: 替え先が直前に止まっていれば使わない（start-failed / 往復しない）", () => {
  expect(chooseEngine({ ...base, billing: { gemini: C }, unusable: ["gemini"] }, NOW).kind).not.toBe("switch");
});

test("W5 止まりの読み取り: 上限・login・戻る時刻・長い答えの中の語は止まりではない", () => {
  expect(judgeStop("You've hit your limit · resets 3pm", true, NOW)).toEqual({ failed: "limit", until: new Date("2026-10-07T15:00:00").getTime() });
  expect(judgeStop("Claude AI usage limit reached|1790000000", true, NOW)).toEqual({ failed: "limit", until: 1790000000_000 });
  expect(judgeStop("Not logged in · Please run /login", true, NOW)).toEqual({ failed: "login", until: null });
  expect(judgeStop("Quota exceeded for quota metric", false, NOW)?.failed).toBe("limit");
  expect(judgeStop("rate limit について説明します。" + "あ".repeat(400), false, NOW)).toBeNull(); // 長い答え
  expect(judgeStop("できました。", false, NOW)).toBeNull();
  expect(parseReset("resets 9am", NOW)).toBe(new Date("2026-10-08T09:00:00").getTime()); // 過ぎた時刻は翌日
  expect(parseReset("limit", NOW)).toBeNull();
});
test("W5 従量の見分け: claude の status / gemini の auth 種別と鍵の在る無し", () => {
  expect(judgeClaudeStatus(0, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }))).toEqual({ kind: "contract" });
  expect(judgeClaudeStatus(0, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" })).kind).toBe("metered"); // 鍵が env に有れば従量が勝つ
  expect(judgeClaudeStatus(1, JSON.stringify({ loggedIn: false }))).toEqual({ kind: "not-logged-in" });
  expect(judgeClaudeStatus(0, "garbage")).toEqual({ kind: "unknown" });
  expect(judgeGemini("oauth-personal", {}, true)).toEqual({ kind: "contract" });
  expect(judgeGemini("oauth-personal", {}, false)).toEqual({ kind: "not-logged-in" });
  expect(judgeGemini("oauth-personal", { GEMINI_API_KEY: "x" }, true).kind).toBe("metered");
  expect(judgeGemini(undefined, {}, true)).toEqual({ kind: "unknown" });
});

// ---- 常駐の中（偽の AI）----
type Out = { lines: string[]; code: number };
function setup(opts: { clis: Cli[]; billing: Partial<Record<Cli, Billing>>; out: (cli: Cli, cmd: string[]) => Out }) {
  const bin = mktmp("w5bin"); // 実在する path（gemini の実体を読める所へ戻す W11e-3 が realpath を引く）
  for (const c of opts.clis) closeSync(openSync(join(bin, c), "w"));
  const calls: { cli: Cli; cmd: string[] }[] = [];
  const spawn = (cmd: string[]) => {
    const cli = (cmd.find((c) => /\/(claude|gemini|codex)$/.test(c)) ?? "").split("/").pop() as Cli;
    calls.push({ cli, cmd });
    const o = opts.out(cli, cmd);
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(new TextEncoder().encode(o.lines.join("\n") + "\n")); c.close(); } });
    return { stdout, exited: Promise.resolve(o.code), kill() {} };
  };
  const acted: string[] = [];
  const driver: Driver = { call: async (tool) => { if (tool !== "list_windows") acted.push(tool); return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }] } : null }; }, close() {} };
  const s = openStore(":memory:");
  const h = makeHandler(s, async () => [], undefined,
    { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => opts.clis.map((c) => ({ cli: c, path: join(bin, c), env: {} })), spawn, browserUrl: async () => null, billing: async (f) => opts.billing[f.cli as Cli] ?? U },
    { uiHome: mktmp("kangae-ui"), leaseDriver: () => driver });
  return { h, s, calls, acted };
}
const ok = (t: string): Out => ({ lines: [JSON.stringify({ type: "result", result: t })], code: 0 });
const limitClaude = (): Out => ({ lines: [JSON.stringify({ type: "result", is_error: true, result: "You've hit your limit · resets 3pm" })], code: 1 });
const settle = () => new Promise((r) => setTimeout(r, 60));
const runOf = async (h: any, id: number) => (((await h({ op: "runs", nodeIds: [id] })) as any).runs.at(-1));

test("W5 UC-p1 相当: claude が上限 → gemini に替わり、前の頼み・今の頼みを渡され、一望に 1 行・面は人に戻る", async () => {
  const { h, s, calls, acted } = setup({ clis: ["claude", "gemini"], billing: { gemini: C }, out: (c) => (c === "claude" ? limitClaude() : ok("続きを書きました")) });
  const root = s.add(null, "user", "請求書の整理", true);
  s.add(root.id, "user", "まず一覧を作って", true);
  const g: any = await h({ op: "leaseGive", rootId: root.id, pid: 10, windowId: 1, app: "Calc", title: "" });
  expect(g.ok).toBe(true);
  const sent: any = await h({ op: "send", rootId: root.id, text: "次に合計を足して" });
  expect(sent.ok).toBe(true);
  await settle();
  expect(calls.map((c) => c.cli)).toEqual(["claude", "gemini"]);
  const prompt = calls[1]!.cmd.find((c) => c.includes("NOW DO THIS"))!;
  expect(prompt).toContain("まず一覧を作って"); // 渡された履歴
  expect(prompt).toContain("次に合計を足して"); // 今の頼み
  expect(prompt).not.toContain("窓が渡されています"); // 面の使い方は替え先に渡さない
  expect(calls[1]!.cmd).toContain("auto_edit");
  expect(calls[1]!.cmd.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]); // 替え先は OS の sandbox の中で起こす
  const run = await runOf(h, root.id);
  expect(run.cli).toBe("gemini");
  expect(run.status).toBe("idle");
  expect(run.switched.line).toMatch(/^gemini に替わりました（claude が上限・(\d+\/\d+ )?15:00 に戻ります）$/);
  expect(run.switched.limits).toContain("渡された面の操作");
  expect(run.switched.limits).toContain("持っていた面はあなたに戻しました");
  expect(((await h({ op: "leaseList" })) as any).leases).toEqual([]); // 面は人に戻った（黙って失敗させない）
  expect(acted).toEqual([]);
});

test("W5 UC-p2 相当: 未ログインでも替わる・login の一言が残る", async () => {
  const { h, s, calls } = setup({ clis: ["claude", "gemini"], billing: { gemini: C }, out: (c) => (c === "claude" ? { lines: [JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" })], code: 1 } : ok("続き")) });
  const root = s.add(null, "user", "x", true);
  await h({ op: "send", rootId: root.id, text: "やって" });
  await settle();
  expect(calls.map((c) => c.cli)).toEqual(["claude", "gemini"]);
  expect((await runOf(h, root.id)).switched.line).toContain("claude の login が切れています");
});

test("W5 UC-p3 相当: 他の AI が無ければ替えず・止めて理由と次の一手（実行は 1 回だけ）", async () => {
  const { h, s, calls } = setup({ clis: ["claude"], billing: {}, out: () => limitClaude() });
  const root = s.add(null, "user", "x", true);
  await h({ op: "send", rootId: root.id, text: "やって" });
  await settle();
  expect(calls).toHaveLength(1);
  const run = await runOf(h, root.id);
  expect(run.status).toBe("failed");
  expect(run.switched).toBeUndefined();
  expect(run.stop.line).toMatch(/claude が上限です（(\d+\/\d+ )?15:00 に戻ります）/); // 15:00 が翌日になる時間帯は日付が付く
  expect(run.stop.line).toContain("codex を入れると替われます");
});

test("W5 UC-p4 相当: 替え先が従量なら替えず、許した後の次の頼みで替わる", async () => {
  const { h, s, calls } = setup({ clis: ["claude", "gemini"], billing: { gemini: { kind: "metered", source: "GEMINI_API_KEY" } }, out: (c) => (c === "claude" ? limitClaude() : ok("続き")) });
  const root = s.add(null, "user", "x", true);
  await h({ op: "send", rootId: root.id, text: "やって" });
  await settle();
  expect(calls.map((c) => c.cli)).toEqual(["claude"]);
  const run = await runOf(h, root.id);
  expect(run.stop).toMatchObject({ reason: "metered", engine: "gemini" });
  expect(run.stop.line).toContain("従量");
  await h({ op: "allowMetered", engine: "gemini" });
  await h({ op: "send", rootId: root.id, text: "もう一度" });
  await settle();
  expect(calls.map((c) => c.cli)).toEqual(["claude", "claude", "gemini"]);
});

test("W5 往復しない: 替え先も上限なら止める（無限に替えない）", async () => {
  const { h, s, calls } = setup({ clis: ["claude", "gemini"], billing: { claude: C, gemini: C }, out: () => limitClaude() });
  const root = s.add(null, "user", "x", true);
  await h({ op: "send", rootId: root.id, text: "やって" });
  await settle();
  expect(calls.map((c) => c.cli)).toEqual(["claude", "gemini"]);
  expect((await runOf(h, root.id)).status).toBe("failed");
});

test("W5 記憶: 替えた先にも覚え書きの枠を渡す", async () => {
  const { h, s, calls } = setup({ clis: ["claude", "gemini"], billing: { gemini: C }, out: (c) => (c === "claude" ? limitClaude() : ok("続き")) });
  const root = s.add(null, "user", "x", true);
  await h({ op: "agentName", rootId: root.id, name: "請求係" });
  await h({ op: "remember", name: "請求係", text: "請求書は請求/ に置く", by: "人" });
  await h({ op: "send", rootId: root.id, text: "やって" });
  await settle();
  expect(calls[1]!.cmd.find((c) => c.includes("覚え書き"))).toContain("請求書は請求/ に置く");
});

// 替え先が作業場所の外に書けない事（OS の sandbox・実測）
test("W5 gemini の書き込み: 作業場所の中は書け、外は OS が拒む（sandbox-exec を実際に回す）", async () => {
  const { writeSandbox } = await import("../src/main.ts");
  const dir = mktmp("w5sb");
  const out = join(process.env.HOME!, `w5-outside-${Date.now()}.txt`);
  const run = (target: string) => Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", writeSandbox(dir), "/bin/sh", "-c", `echo x > '${target}'`], { stderr: "pipe" });
  expect(run(join(dir, "in.txt")).exitCode).toBe(0);
  const o = run(out);
  expect(o.exitCode).not.toBe(0);
  expect(o.stderr.toString()).toContain("Operation not permitted");
  expect(await Bun.file(out).exists()).toBe(false);
});

// この Mac の実際: gemini は起動できない（IneligibleTierError）。替えた先が動かなければ、元に戻して原文つきで止める
test("W5 替えた先が起動できない（この Mac の gemini）: 元の AI に戻して、替え先の原文と元の理由を 1 行で言う・次の頼みは元の AI に行く", async () => {
  const bad = "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.";
  const { h, s, calls } = setup({ clis: ["claude", "gemini"], billing: { gemini: C }, out: (c) => (c === "claude" ? limitClaude() : { lines: [bad], code: 41 }) });
  const root = s.add(null, "user", "x", true);
  await h({ op: "send", rootId: root.id, text: "やって" });
  await settle();
  expect(calls.map((c) => c.cli)).toEqual(["claude", "gemini"]); // 1 回ずつ。往復しない
  const run = await runOf(h, root.id);
  expect(run).toMatchObject({ status: "failed", cli: "claude" });
  expect(run.switched).toBeUndefined();
  expect(run.stop.line).toContain("gemini に替えましたが");
  expect(run.stop.line).toContain("IneligibleTierError");
  expect(run.stop.line).toContain("元の claude は claude が上限です");
  await h({ op: "send", rootId: root.id, text: "もう一度" });
  await settle();
  expect(calls.map((c) => c.cli)).toEqual(["claude", "gemini", "claude"]); // 動かない替え先に送り続けない
});

// 2026-06-18: Google は個人向けの Gemini CLI を止めた。行き止まりへ人を連れて行かない
test("W5-2 人に勧める文言に、個人向けの gemini を勧める文が無い（使える物 = claude・codex だけ・gemini は有料の API key の時だけ）", async () => {
  const { readFileSync } = await import("node:fs");
  const texts = [
    INSTALL_HINT,
    (chooseEngine({ ...base, order: ["claude"] }, NOW) as any).line,
    (chooseEngine({ ...base, order: ["claude"], until: NOW + 3600_000 }, NOW) as any).line,
    (chooseEngine({ ...base, order: ["claude", "gemini"], billing: { gemini: U } }, NOW) as any).line,
    readFileSync(join(import.meta.dir, "../src/llm.ts"), "utf8").match(/送り先がありません[^"]*/)![0],
    (await import("../src/main.ts")).needOf("none", "")!.how,
  ];
  for (const t of texts) {
    expect(t).not.toMatch(/gemini[^。（]{0,12}(を入れ|も入れ|か codex を入れ)/); // 「gemini を入れて」「gemini か codex を入れる」
    expect(t).not.toMatch(/claude・codex・gemini/);
  }
  expect(texts[0]).toContain("有料の API key");
  expect(texts[1]).toContain("codex を入れると替われます");
  expect(texts[5]).toContain("claude か codex を入れてください");
});
test("W5-2 gemini が IneligibleTierError を返したら、その場で替え先から外し、理由を 1 行（次の上限でも gemini を試さない）", async () => {
  const bad = "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.";
  const { h, s, calls } = setup({ clis: ["claude", "gemini"], billing: { gemini: C }, out: (c) => (c === "claude" ? limitClaude() : { lines: ["Approval mode overridden to \"default\"", bad], code: 41 }) });
  const root = s.add(null, "user", "x", true);
  await h({ op: "send", rootId: root.id, text: "やって" });
  await settle();
  expect((await runOf(h, root.id)).stop.line).toContain("gemini は Google の個人向けの提供が終わりました（2026-06-18）");
  expect((await runOf(h, root.id)).stop.line).toContain("gemini に替えましたが"); // 元に戻して原文つきで止める（残す）
  expect(calls.map((c) => c.cli)).toEqual(["claude", "gemini"]);
  await h({ op: "send", rootId: root.id, text: "もう一度" });
  await settle();
  expect(calls.map((c) => c.cli)).toEqual(["claude", "gemini", "claude"]); // 2 回目は gemini を試さない
  const line = (await runOf(h, root.id)).stop.line as string;
  expect(line).toContain("claude が上限です");
  expect(line).not.toContain("gemini に替えましたが");
  expect(line).toContain("codex を入れると替われます");
});

test("W5-2b 替え先が無い時の勧めに、今止まった AI の名前が入らない（claude が上限なら codex だけ・括弧の入れ子なし）", () => {
  for (const [cur, other] of [["claude", "codex"], ["codex", "claude"], ["gemini", "codex"]] as const) {
    for (const extra of [{ until: NOW + 3600_000 }, {}]) {
      const line = (chooseEngine({ ...base, current: cur, order: [cur], ...extra }, NOW) as any).line as string;
      const hint = line.slice(line.indexOf("替えられる agent がありません"));
      expect(hint).toContain(`${other} を入れると替われます`);
      expect(hint).not.toMatch(new RegExp(`${cur} (か|を入れ)`)); // 止まった本人を勧めない
      expect(hint).not.toMatch(/（[^）]*（/); // 入れ子の括弧なし
    }
  }
  expect(INSTALL_HINT).toBe("claude か codex を入れてください。gemini は有料の API key がある時だけ使えます"); // 1 つも無い時だけ全部
});
