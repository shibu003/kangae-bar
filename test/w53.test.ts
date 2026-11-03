// W53: EXP-1 の A と B の通り道で CEO が見る承認 card と Bar の文。実物の code から集めた文（docs/verify/w53/dump-cards.ts）に、内部の語が出ていないか・次の一手が文にあるかを見る。表は docs/verify/w53/CARDS.md
import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collect } from "../docs/verify/w53/dump-cards.ts";
import { INTERNAL } from "./internal-words.ts"; // 人に出る文に出してはいけない内部の語（W77e の panel の文言と同じ表）
setDefaultTimeout(120_000);

const root = join(import.meta.dir, "..");
const texts = (o: any, out: string[] = []): string[] => { if (typeof o === "string") out.push(o); else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) if (["what", "note", "label", "hint"].includes(k) || typeof v === "object" || typeof v === "string" && ["draft_line"].includes(k)) texts(v, out); return out; };

test("W53 card の what / note / 断られた時の文 / Bar の行 / 下書きの 1 行に、内部の語が出ない", async () => {
  const c: any = await collect();
  const human = [
    ...Object.entries(c).filter(([k]) => !["bar", "draft_line"].includes(k)).flatMap(([, v]) => texts(v)),
    ...Object.values(c.bar.refused) as string[], c.bar.ok, c.bar.error, c.bar.secure, c.bar.draft, c.bar.window, c.draft_line,
  ].filter((t) => !/^\/private|^場所:/.test(t));
  for (const t of human) expect(t, t).not.toMatch(INTERNAL);
});

test("W53 card の文: 何が起きるか（what）・確かめること・断ると何が起きるか・次にする事が入っている", async () => {
  const c: any = await collect();
  for (const k of ["open_tab", "api_tab", "open_app", "run_cmd", "launch_app", "op_read", "op_write"]) expect(c[k].s.note, k).toContain("確かめること: ");
  expect(c.open_tab.s.note).toContain("断ると何も開きません");
  expect(c.open_app.s.note).toContain("断ると何も開きません");
  expect(c.api_tab.s.note).toContain("やめたい時は、Bar の「全部止める」を押してください"); // 貸した後の止め方
  expect(c.docs_write.s.what).toContain("- 10-20 MATH200 Quiz 5"); // Doc に書く card は書く内容そのものを出す（見てから許す）
  expect(c.click_danger.s.what).toContain("画面の位置 1, 2"); // 押す先の名前が無い時は、どこを押すか
  expect(c.draft_line).toContain("あなたが手で済ませるか"); // 下書きは次の一手が 1 行に
  for (const k of ["open_app", "run_cmd", "launch_app", "click_danger", "docs_write", "op_read", "op_write"]) expect(c[k].after.hint, k).toContain("人に 1 行で伝え"); // 断られた agent は人に聞き直す
  expect(c.timeout.hint).toContain("もう一度頼んでよいか聞いてください");
});

test("W53 panel: card の文頭は app の無い card（tab を借りる・op）でも 1 文・tab の面は「web」と言わない・承認の button は CEO の要件（business/ai-browser-ui-requirements.md 要件 14）どおり always allow / allow / deny の 3 語・押す操作でない card に「押す前に」を出さない", () => {
  const js = readFileSync(join(root, "extension/panel.js"), "utf8");
  expect(js).toContain("!a.app ? `agent が ${a.what}`");
  expect(js).toContain('a.app === "web" ? "tab" : a.app');
  const kg = readFileSync(join(root, "extension/kg.js"), "utf8"); // W77b: 3 語は kg-approve の 1 か所・4 つの card（承認・金庫・運ぶ・予約）が同じ部品を通る
  expect(kg).toContain('always: "always allow", allow: "allow", deny: "deny"');
  expect(kg).toContain('"always,allow,deny"');
  expect(js.match(/approveEl\(/g)!.length).toBe(4);
  expect(js).not.toMatch(/いつも許す|\["許す"|\["断る"/);
  expect(js).toContain('"api_tab", "op_read", "op_write", "api_anything"');
});
