// W11a: 操作権の 6 欄（vision §11-A）。capOf の各欄が、門（actNow）の実際の判定と一致する
import { mktmp } from "./tmp.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capOf, makeLeases, tokenOf, type Driver } from "../src/lease.ts";

let dir: string;
let calls: string[];
const fake = (): Driver => ({
  call: async (tool) => {
    calls.push(tool);
    return { text: "ok", isError: false, data: tool === "list_windows" ? { windows: [{ pid: 10, window_id: 1 }, { pid: 10, window_id: 2 }] } : tool === "tab_state" ? { exists: true, docId: "d" } : null };
  },
  close() {},
});
const A = { pid: 10, windowId: 1, app: "Calc", title: "電卓" };
const T = { tabId: 5, docId: "d", app: "web", title: "LinkedIn" };
const mk = (defaultMode: "allow" | "ask" | "off") => makeLeases(dir, { driver: fake, web: fake(), defaultMode, approvalMs: 50 });
const rights = (L: ReturnType<typeof mk>) => (L.list()[0] as any).rights as ReturnType<typeof capOf>;
const row = (r: ReturnType<typeof capOf>, k: string) => r.rows.find(([x]) => x === k)![1];
beforeEach(() => { dir = mktmp("w11a"); calls = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("6 行が決まった順で出る（面・読める・書ける・経路・資源・期限）", () => {
  const L = mk("ask");
  L.give(A, "s:1");
  expect(rights(L).rows.map(([k]) => k)).toEqual(["面", "読める", "書ける", "経路", "取り合う物", "期限"]);
  expect(row(rights(L), "面")).toContain("Calc");
});

test("書ける欄 = 門の判定: off は act が off で断られる / ask は聞く(timeout) / allow は通る / mod は mod で断られる", async () => {
  for (const [mode, why] of [["off", "off"], ["ask", "timeout"], ["allow", undefined]] as const) {
    const L = mk(mode);
    const g = L.give(A, "s:1");
    if (!g.ok) throw new Error();
    expect(rights(L).write).toBe(mode);
    const r = await L.act(tokenOf(g.lease), "type_text", { text: "a" });
    if (why) expect(r).toMatchObject({ ok: false, why }); else expect(r.ok).toBe(true);
    L.takeback("10:1");
  }
  const L = mk("allow");
  const g = L.give(A, "s:2");
  if (!g.ok) throw new Error();
  L.setCap("s:2", "read");
  expect(rights(L).write).toBe("mod");
  expect(await L.act(tokenOf(g.lease), "type_text", { text: "a" })).toMatchObject({ ok: false, why: "mod" });
});

test("この頼みの間(turn) は ask の時だけ・endTurn で消える・書ける欄に出る", () => {
  const L = mk("ask");
  const g = L.give(A, "s:1");
  if (!g.ok) throw new Error();
  g.lease.turnAllow = true;
  expect(rights(L).write).toBe("turn");
  expect(row(rights(L), "書ける")).toContain("この頼みの間");
  L.endTurn("s:1");
  expect(rights(L).write).toBe("ask");
});

test("書ける欄は何の設定が効いているかを言う（既定 / この窓だけ / app の全部の窓）・hold は「離れるまで始めない」", () => {
  const L = mk("allow");
  L.seeFront(10);
  L.give(A, "s:1");
  expect(row(rights(L), "書ける")).toContain("既定の設定");
  expect(row(rights(L), "書ける")).toContain("あなたが離れるまで始めません");
});

test("web の tab は経路が DOM・読める範囲が同じ site だけ / 窓は AX・前面入力なし", () => {
  const L = mk("ask");
  L.give(T, "s:1");
  const w = rights(L);
  expect(row(w, "読める")).toContain("同じ site");
  expect(row(w, "経路")).toContain("頁の中身");
  const M = mk("ask");
  const r = capOf({ surface: A, owner: "s:1", gen: 1, exp: 0, confirmed: true }, "ask", 0);
  expect(row(r, "経路")).toContain("窓のボタンや欄");
  expect(row(r, "経路")).toContain("マウス・キーボードは使わず");
  expect(M).toBeDefined();
});

test("期限欄: 残り分が出る・期限が切れると 0 分", () => {
  const r = (exp: number) => row(capOf({ surface: A, owner: "s:1", gen: 1, exp, confirmed: true }, "ask", 0), "期限");
  expect(r(30 * 60_000)).toContain("30 分");
  expect(r(-1)).toContain("0 分");
});

test("panel は rights の 6 行を読むだけ（自分で判定しない）", () => {
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(js).toContain("l.rights.rows.map");
  expect(js).not.toMatch(/rights.*mode ===/);
});

// vision §11-A の 5 例: 「面を越える変化」を今の門が止めているか / 止めていないか（止めていない物は資源の欄の文で人に見せる）
import { classify, resourceOf } from "../src/lease.ts";
test("§11-A 5 例: 止めている物・止めていない物を正直に固定する", () => {
  // 止めている: 取り返しがつかない文字（削除・退会・購入…）は承認の表が「許す」でも聞く
  expect(classify("click", {}, { role: "AXButton", label: "アカウントを削除" })).toBe("destructive");
  // W8a-2: LinkedIn のログアウト・アカウント設定は crossing（毎回聞く）
  for (const label of ["ログアウト", "アカウント設定"]) expect(classify("click", {}, { role: "AXButton", label })).toBe("crossing");
  // 止めていない: 他の設定変更・Docker の停止・REAPER の再生は write 扱い（表が「許す」なら聞かない）
  for (const label of ["Stop", "再生", "プライバシー設定を変更"]) expect(classify("click", {}, { role: "AXButton", label })).toBe("write");
  // 止めていない: 別々の 2 tab の同じ文書への書き込みは資源なし＝並行（入力がぶつからない事と結果がぶつからない事は別）
  expect(resourceOf("type_text", { text: "a" }, T)).toBeUndefined();
  expect(resourceOf("type_text", { text: "a" }, { ...T, tabId: 6 })).toBeUndefined();
  // 止めている: browser 自身の操作（tab の開閉・アドレスバー）は web の面から送れない
  // 人に見せる: 止めていない事を資源の欄が言う
  const web = capOf({ surface: T, owner: "s:1", gen: 1, exp: 0, confirmed: true }, "ask", 0);
  const win = capOf({ surface: A, owner: "s:1", gen: 1, exp: 0, confirmed: true }, "ask", 0);
  expect(row(web, "取り合う物")).toContain("この文書（別の tab が同じ頁を開いていると分かる時）の書き換え");
  expect(row(win, "取り合う物")).toContain("他の作業");
});

test("web の面でも browser 自身の操作(cmd+t)は門が断る（browser 全体への変化の一部は止めている）", async () => {
  const L = mk("allow");
  const g = L.give(T, "s:1");
  if (!g.ok) throw new Error();
  expect(await L.act(tokenOf(g.lease), "hotkey", { keys: ["cmd", "t"] })).toMatchObject({ ok: false, why: "tool" });
});

// W11a-2: 許しは面単位。同じ app の別の窓には広げない（vision §11-A）
const A2 = { pid: 10, windowId: 2, app: "Calc", title: "別の文書" };
test("W11a-2: ある窓で「許す」にしても同じ app の別の窓は聞く（面の許しは別の窓に効かない）", async () => {
  const L = mk("ask");
  const a = L.give(A, "s:1"), b = L.give(A2, "s:2");
  if (!a.ok || !b.ok) throw new Error();
  L.setMode("Calc", "allow", "10:1");
  expect(await L.act(tokenOf(a.lease), "type_text", { text: "a" })).toMatchObject({ ok: true });
  expect(await L.act(tokenOf(b.lease), "type_text", { text: "b" })).toMatchObject({ ok: false, why: "timeout" });
  const [ra, rb] = L.list().map((x: any) => x.rights as ReturnType<typeof capOf>) as [ReturnType<typeof capOf>, ReturnType<typeof capOf>];
  expect([ra.write, rb.write]).toEqual(["allow", "ask"]);
  expect(row(ra, "書ける")).toContain("この窓だけ");
});

test("W11a-2: app 単位は人が明示した時だけ（key 無し）・全部の窓に効き、文言もそう言う", async () => {
  const L = mk("ask");
  const a = L.give(A, "s:1"), b = L.give(A2, "s:2");
  if (!a.ok || !b.ok) throw new Error();
  L.setMode("Calc", "allow");
  expect((await L.act(tokenOf(b.lease), "type_text", { text: "b" })).ok).toBe(true);
  expect(row(L.list().map((x: any) => x.rights)[1], "書ける")).toContain("全部の窓");
  L.setMode("Calc", "off", "10:1"); // 面の設定が app の設定より先
  expect(await L.act(tokenOf(a.lease), "type_text", { text: "a" })).toMatchObject({ ok: false, why: "off" });
});

test("W11a-2: 保存済みの app 単位の設定はそのまま効く（移行なし・黙って消えない）・面の許しは面が無ければ持ち越さない", () => {
  writeFileSync(join(dir, "leases.json"), JSON.stringify({ floor: {}, leases: [], modes: { Calc: "allow" }, surfaceModes: { "10:1": "allow" } }));
  const L = mk("ask");
  L.give(A, "s:1");
  expect(rights(L).write).toBe("allow");
  expect(row(rights(L), "書ける")).toContain("全部の窓");
});

test("W11a-3: 口は既定が「この窓だけ」（key 付き）・「全部の窓」は checkbox を入れた時だけ key 無し・card と一望の行の両方に在る", async () => {
  const js = readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  const pick = js.slice(js.indexOf("function modePick"), js.indexOf("// 承認の card"));
  expect(pick).toContain('cb.checked ? {} : { key }'); // 入れた時だけ key を外す
  expect(pick).not.toMatch(/type:\s*"checkbox",\s*checked/); // 既定は入っていない
  expect(pick).toContain("の他の窓にも同じ許しが効きます");
  expect((js.match(/modePick\(/g) ?? []).length).toBe(3); // 定義 + card + 一望の行
  expect(js).toContain("if (!a.danger) c.append(modePick(a.app, a.key))");
  // list() の key をそのまま渡すと、その窓だけが許しになる
  const L = mk("ask");
  const a = L.give(A, "s:1"), b = L.give(A2, "s:2");
  if (!a.ok || !b.ok) throw new Error();
  const key = (L.list() as any[])[0].key;
  L.setMode("Calc", "allow", key);
  expect((L.list().map((x: any) => x.rights.write))).toEqual(["allow", "ask"]);
});
