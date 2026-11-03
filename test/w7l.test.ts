import { expect, test } from "bun:test";
import { firstCards, firstName } from "../extension/groups.js";
import { firstRunNeeds, type FirstInput } from "../src/first-run.ts";

const base: FirstInput = { clis: ["claude"], claudeLogin: true, extension: "connected", ax: true };
const refused = { app: "Brave", why: "別の browser", at: 0 };
const cards = (o: Partial<FirstInput>) => firstCards(firstRunNeeds({ ...base, ...o }));

// 拡張 4 状態 × claude の有無（無し / login 前 / 済み）: 出る題・button が決まった物になる
const BTN = "拡張の置き場を Finder で開く";
test("拡張 4 状態: 繋がった=何も出ない / 置いた・無い=あなたの番です+button / 断った=知らせ(頭に付けない)+button", () => {
  expect(cards({})).toEqual([]);
  for (const [e, what] of [["none", "ブラウザの拡張が入っていません"], ["placed", "拡張はまだ Chrome から繋がっていません"]] as const) {
    const [c] = cards({ extension: e });
    expect(c.title).toBe(`あなたの番です — ${what}`);
    expect(c.button).toBe(BTN);
    expect(c.how).toContain("この窓だけで話せます");
  }
  const [r] = cards({ extension: "refused", refused });
  expect(r.title.startsWith("あなたの番です")).toBe(false);
  expect(r.title).toContain("Brave から繋がろうとしましたが、断りました");
  expect(r.button).toBe(BTN);
});

test("claude の有無: 無い=入れる 1 行 / login 前=claude と打つ 1 行・button は拡張の物にだけ", () => {
  for (const e of ["none", "placed", "refused", "connected"] as const) {
    const ext = { extension: e, refused };
    const none = cards({ ...ext, clis: [], claudeLogin: null });
    expect(none[0].title).toBe("あなたの番です — agent（claude）が入っていません");
    expect(none[0].how).toContain("claude を入れて");
    expect(none[0].button).toBeNull();
    const login = cards({ ...ext, claudeLogin: false });
    expect(login[0].title).toBe("あなたの番です — claude の login がまだです");
    expect(login[0].how).toBe("ターミナルで claude と打って login してください");
    expect(login[0].button).toBeNull();
    expect(cards(ext).length).toBe(e === "connected" ? 0 : 1);
    expect(cards({ ...ext, claudeLogin: false }).length).toBe(e === "connected" ? 1 : 2);
  }
});

test("session の有無: 一言目から付ける名前は頭の 30 字（前後の空白は除く・絵文字を割らない）", () => {
  expect(firstName("  今日のメールを整理して ")).toBe("今日のメールを整理して");
  expect(firstName("あ".repeat(40))).toBe("あ".repeat(30));
  expect([...firstName("😀".repeat(31))].length).toBe(30);
});
