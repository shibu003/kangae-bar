// W60b2（CEO 10-14: 「ユーザーは grok bot のようにどの teammate が動いているかだけ分かればいい。bot に名前があるように。chief of staff・marketing operator・sns・implementer… その時どきの担当名を短く」）
// 会話ごとの担当名: agent が最初に付け（kangae role）・人は Bar で付け直せて（人が付けた名前は agent が変えられない）・一覧にはこの名前と「動いている」だけ（面の題は出さない）
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { ROLE_MAX, roleOf, roleOk, rolesOf, setRole } from "../src/roles.ts";
import { openStore } from "../src/store.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(60_000);

let top: string, ui: string, nodes: string;
beforeEach(() => { top = realpathSync(mktmp("w60b2")); ui = join(top, "ui"); nodes = join(top, "nodes"); mkdirSync(ui); mkdirSync(nodes); });
afterEach(() => rmSync(top, { recursive: true, force: true }));
const src = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");

test("W60b2 担当名の形: 短い名前だけ（20 字・向きを変える / 見えない / 制御文字・区切りは断る・空白は 1 つに）", () => {
  for (const ok of ["sns", "implementer", "chief of staff", "marketing operator", "請求係", "  sns   bot  "]) expect(roleOk(ok), ok).not.toBeNull();
  expect(roleOk("  sns   bot  ")).toBe("sns bot");
  expect(roleOk("a".repeat(ROLE_MAX))).not.toBeNull();
  for (const bad of ["a".repeat(ROLE_MAX + 1), "", "   ", "‮evil", "a​b", "a\u0007b", "a/b", "a:b", "a\\b", "...", "😀", 5, null, undefined]) expect(roleOk(bad as any), String(bad)).toBeNull();
  expect(roleOk("a\nb")).toBe("a b"); // 改行は空白に（1 行）
});

test("W60b2 付けた名前は残る（0600）・agent は自分で付け直せるが、人が付けた名前は agent が変えられない・人は消せる", () => {
  expect(setRole(ui, 7, "sns", "agent")).toEqual({ ok: true, role: "sns" });
  expect(roleOf(ui, 7)).toBe("sns");
  expect(setRole(ui, 7, "marketing operator", "agent")).toMatchObject({ ok: true }); // 自分の名前は付け直せる
  expect(setRole(ui, 7, "chief of staff", "human")).toMatchObject({ ok: true });
  const r = setRole(ui, 7, "sns", "agent");
  expect(r).toMatchObject({ ok: false }); expect((r as any).hint).toContain("人が");
  expect(roleOf(ui, 7)).toBe("chief of staff");
  expect(statSync(join(ui, "roles.json")).mode & 0o777).toBe(0o600);
  expect(setRole(ui, 8, "implementer", "agent").ok).toBe(true);
  expect([...rolesOf(ui)]).toEqual([[7, "chief of staff"], [8, "implementer"]]);
  expect(setRole(ui, 7, "", "human")).toEqual({ ok: true, role: null }); // 人は消せる（空）
  expect(roleOf(ui, 7)).toBeUndefined();
  expect(setRole(ui, 7, "sns", "agent").ok).toBe(true); // 消えた後は agent がまた付けられる
  expect(setRole(ui, 9, "x‮", "agent").ok).toBe(false);
});

test("W60b2 常駐: 一覧（roots）に担当名が載る・人が Bar から付け直せる・agent の呼びは動いている自分の会話だけ・変えられるのは自分の会話の名前だけ", async () => {
  const store = openStore(":memory:");
  const H: any = makeHandler(store, async () => [], undefined, { ...defaultWorkspace(), dir: nodes }, { uiHome: ui, leaseDriver: () => null });
  const root = store.add(null, "user", "調べ物", true);
  expect((await H({ op: "roots" }, {})).roots[0].role).toBeNull();
  expect(await H({ op: "role", rootId: root.id, role: "sns" }, {})).toMatchObject({ ok: true, role: "sns" });
  expect((await H({ op: "roots" }, {})).roots[0]).toMatchObject({ role: "sns", text: "調べ物" });
  expect(await H({ op: "role", rootId: root.id, role: "a/b" }, {})).toMatchObject({ ok: false });
  expect(await H({ op: "role", rootId: 9999, role: "sns" }, {})).toMatchObject({ ok: false });
  // agent（CLI の口・owner つき）: 動いていない頼み・別の形の owner は断る・人が付けた名前は変えられない
  expect(await H({ op: "role", owner: "s:1", role: "x" }, { write() {} })).toMatchObject({ ok: false });
  expect(await H({ op: "role", owner: "oops", role: "x" }, { write() {} })).toMatchObject({ ok: false });
  expect(roleOf(ui, root.id)).toBe("sns");
  expect(await H({ op: "role", rootId: root.id, role: "" }, {})).toMatchObject({ ok: true, role: null });
  expect((await H({ op: "roots" }, {})).roots[0].role).toBeNull();
});

test("W60b2 panel: 一覧は担当名（agent の名前 → 担当名 → 会話の名前）と状態だけ・面の題を出さない・人は「名前を変える」で担当名を直せる（空で消える・agent 名は同じ値）", () => {
  const js = src("extension/panel.js"), html = src("extension/panel.html");
  expect(js).toContain("plain(r.agent?.name ?? r.role ?? r.text, 60)");
  const fill = js.slice(js.indexOf("function fillRootButton"), js.indexOf("function markSeen"));
  expect(fill).not.toMatch(/surface\.title|🔒/); // 一覧の行に面の題・面を持っている文を出さない
  expect(fill).toContain('app: l.surface.app === "web" ? "tab" : l.surface.app'); // W77c: 面は icon の種類と app 名だけ（題は渡さない）
  expect(html).toContain('id="rename">名前を変える');
  expect(html).not.toContain('id="role-name"');
  expect(js).toContain('call("role", { rootId, role: text })');
  expect(js).toContain('call("agentName", { rootId, name: text })');
  expect(js).toContain("W60b2: 担当名");
  expect(html.match(/<button[^>]*id="rename"[^>]*>[^<]*<\/button>/)![0]).not.toMatch(/lease|token|op\b|常駐/);
});

test("W60b2 agent への案内: 最初に 1 回 kangae role で担当名を付ける・例・人が付けた名前は変えられない（CLI が使える）・断る文に担当名が入る（W60b1 の口）", () => {
  const m = src("src/main.ts");
  for (const w of ["role <短い名前>", "sns・implementer・chief of staff・marketing operator", "人が付けた名前は変えられません"]) expect(m, w).toContain(w);
  expect(m).toContain('process.argv[2] === "role"');
  expect(m).toContain("nameOf: (o) =>");
});
