// W114: 承認 card の押下中（全選択肢 disabled・aria-busy・失敗で戻る）と、承認待ちの間の送る quiet。DESIGN.md §6 承認card・§7 押した直後。
// 描画は test/domshim.ts（本物のブラウザには触れない）。実機（見た目）は未測。読む file を literal で名指す: "extension/panel.js" "extension/panel.css"
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom, mount } from "./domshim.ts";

beforeAll(async () => {
  await installDom();
});
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const btns = (k: any) => k.querySelectorAll("button");
const by = (k: any, c: string) => btns(k).find((b: any) => b.dataset.choice === c);
const answers = (k: any) => { const got: any[] = []; k.addEventListener("kg-answer", (e: any) => got.push(e.detail)); return got; };

test("W114 AC1/2: 1 つ押すと全 button が disabled・aria-busy=true・2 度目は送らない。busy(false) で全部戻る", () => {
  const k = mount("kg-approve") as any;
  expect(btns(k).map((b: any) => b.dataset.choice)).toEqual(["always", "allow", "deny"]);
  const got = answers(k);
  by(k, "allow").click();
  expect(btns(k).every((b: any) => b.disabled)).toBe(true);
  expect(k.getAttribute("aria-busy")).toBe("true");
  by(k, "deny").click();
  by(k, "allow").disabled = false; // 何かの拍子に disabled が外れても、busy の間は 2 つ目を送らない
  by(k, "allow").click();
  expect(got).toEqual([{ choice: "allow" }]);
  k.busy(false);
  expect(btns(k).every((b: any) => !b.disabled)).toBe(true);
  expect(k.getAttribute("aria-busy")).toBeNull();
  by(k, "deny").click();
  expect(got).toEqual([{ choice: "allow" }, { choice: "deny" }]);
});

test("W114: 受け手が足した button（次から覚えない）も止まり、元から disabled の物は戻しても disabled のまま", () => {
  const k = mount("kg-approve") as any;
  const f = (globalThis as any).document.createElement("button");
  f.dataset.x = "1";
  k.append(f);
  const pre = (globalThis as any).document.createElement("button");
  pre.disabled = true;
  k.append(pre);
  by(k, "allow").click();
  expect(f.disabled).toBe(true);
  k.busy(false);
  expect(f.disabled).toBe(false);
  expect(pre.disabled).toBe(true);
});

test("W114: choice の「これで」を押すと radio・自由記述・これで が止まり、busy(false) で選んだ状態のまま押し直せる", () => {
  const k = mount("kg-approve", { kind: "choice", "data-options": "a\nb", free: "" }) as any;
  const radios = k.querySelectorAll("input").filter((n: any) => n.type === "radio");
  const go = btns(k).find((b: any) => "go" in b.dataset);
  const got = answers(k);
  radios[0].click();
  go.click();
  expect(k.getAttribute("aria-busy")).toBe("true");
  expect(k.querySelectorAll("input").every((n: any) => n.disabled)).toBe(true);
  expect(go.disabled).toBe(true);
  k.busy(false);
  expect(k.querySelectorAll("input").every((n: any) => !n.disabled)).toBe(true);
  expect(go.disabled).toBe(false);
  go.click();
  expect(got.length).toBe(2);
});

// panel.js から onAnswer〜syncSendQuiet を取り出して、本物の部品と繋ぐ
function harness() {
  const js = read("extension/panel.js");
  const src = js.slice(js.indexOf("const onAnswer ="), js.indexOf("// card 1 枚。"));
  const log: string[] = [];
  const quiet = { on: false };
  const approve: any = { has: false, querySelector: (_s: string) => (approve.has ? {} : null) };
  const $ = (id: string) => (id === "send-btn" ? { classList: { toggle: (c: string, on: boolean) => { if (c === "quiet") quiet.on = on; } } } : approve);
  const make = new Function("answerLine", "busy", "rootId", "once", "sendChat", "showErr", "toast", "$", "document", `${src}\nreturn { onAnswer, approveEl, syncSendQuiet };`);
  const h = make(() => "", false, 1, (f: any) => f(), async () => {}, (_f: unknown, m: unknown) => log.push(`err:${m}`), (t: string) => log.push(`toast:${t}`), $, (globalThis as any).document);
  return { ...h, log, quiet, approve };
}

test("W114 AC1/2: onAnswer は失敗なら全部戻して既存の error 文を toast・成功なら操作部を消して中立の toast", async () => {
  const h = harness();
  let result: any = { ok: false };
  const k = h.approveEl(async () => result);
  const root = mount("div");
  root.append(k);
  (k as any).connectedCallback?.();
  const p = (k as any);
  p.paint?.();
  by(p, "allow").click();
  expect(p.getAttribute("aria-busy")).toBe("true");
  await Bun.sleep(0);
  expect(p.getAttribute("aria-busy")).toBeNull();
  expect(btns(p).every((b: any) => !b.disabled)).toBe(true);
  expect(h.log).toEqual(["err:undefined"]);
  result = { ok: true };
  by(p, "deny").click();
  await Bun.sleep(0);
  expect(h.log).toEqual(["err:undefined", "toast:deny"]);
  expect(root.querySelectorAll("kg-approve").length).toBe(0);
});

test("W114 AC3: 未処理の承認が #approve に在る間だけ #send-btn が quiet・無くなれば外れる", () => {
  const h = harness();
  h.approve.has = true;
  h.syncSendQuiet();
  expect(h.quiet.on).toBe(true);
  h.approve.has = false;
  h.syncSendQuiet();
  expect(h.quiet.on).toBe(false);
  const js = read("extension/panel.js");
  expect(js).toContain('querySelector("kg-approve, .auth-card, .more-cards")');
  expect(read("extension/kg.js")).not.toMatch(/querySelectorAll\([^)]*\)\.(find|some|filter|map)\(/); // 本物の NodeList に find / some / filter は無い（domshim は配列を返すので緑になってしまう）
  expect(js).toMatch(/renderApprove\(r\.approvals[^\n]*\n\s*syncSendQuiet\(\);/);
});

test("W114 css: 3 つは 1.4 : 1 : 1・各 44px（--hit）・折り返しで横 scroll 無し・送る quiet は token だけ", () => {
  const css = read("extension/panel.css");
  const i = css.indexOf("/* W114:");
  const block = css.slice(i, css.indexOf(".receipt", i));
  for (const s of ["flex:1 1 0", "flex:1.4 1 0", "min-height:var(--hit)", "gap:var(--button-gap)", "white-space:nowrap", "max-width:100%"]) expect(block, s).toContain(s);
  const quiet = css.slice(css.indexOf("/* W114: 承認待ち"), css.indexOf("#send-form #send-btn .ic"));
  expect(quiet).toContain("#send-form #send-btn.quiet { background:transparent; color:var(--fg); }");
  expect(`${block}${quiet}`).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(|\d+px/);
});
