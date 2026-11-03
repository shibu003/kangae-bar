// W39p: tools/w39-probe.sh（実機のポインタ前後比較）。実機で 8 本とも道具を通していなかった（docs/verify/w39-run/RESULT.md・impl/w43 の 49db1d8）直し:
//  (1) 全角括弧の前の素の $VAR で落ちない (2) 各道具の前に同じ窓の get_window_state (3) is_on_screen=true の窓だけ (4) 拒否された本は「不変」と数えず「未測（拒否: 理由）」・drag の拒否の原文を残す
// 偽の cua-driver（sh）の上で回す。実機は実験役（CEO 不在の時）
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(120_000);

const script = join(import.meta.dir, "../tools/w39-probe.sh");
let top: string, cua: string, out: string, log: string;
// 偽の cua: 呼びを log に残す。click 系は直前に get_window_state が無いと screenshot_context_missing・drag は background を拒否・MODE で振る舞いを替える
const fake = (mode: string) => `#!/bin/sh
shift # 先頭は call（cua-driver call <道具> <JSON>）
echo "$1" >> "${top}/calls.log"
st="${top}/state"; pf="${top}/pos"
case "$1" in
  list_windows) echo '{"windows":[{"pid":10,"window_id":1,"is_on_screen":${mode === "offscreen" ? "false" : "true"}}]}';;
  get_window_state) : > "$st"; echo '{"ok":true}';;
  get_cursor_position) [ -f "$pf" ] && cat "$pf" || echo '{"x":427,"y":599}';;
  click|double_click|right_click|scroll)
    if [ "${mode}" = "allrefuse" ] || [ ! -f "$st" ]; then echo '{"code":"screenshot_context_missing","pid":10,"window_id":1}'; exit 1; fi
    rm -f "$st"; [ "${mode}" = "moves" ] && [ "$1" = "click" ] && echo '{"x":500,"y":500}' > "$pf"; echo '{"ok":true}';;
  drag) echo '{"code":"background_unavailable","message":"macOS has no background drag route; drag moves the physical pointer"}'; exit 1;;
  type_text|press_key|hotkey)
    if [ "${mode}" = "allrefuse" ]; then echo '{"effect":"unverifiable","delivery_failed":true}'; exit 0; fi
    echo '{"ok":true}';;
esac
`;
const run = (mode: string, args: string[] = ["10", "1"], pre: string[] = []) => {
  writeFileSync(cua, fake(mode)); chmodSync(cua, 0o755);
  const r = Bun.spawnSync(["sh", script, ...pre, ...args], { env: { ...Bun.env, KANGAE_CUA: cua, KANGAE_W39_OUT: out } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, text: r.stdout.toString() + r.stderr.toString(), calls: (() => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return [] as string[]; } })() };
};
beforeEach(() => { top = realpathSync(mktmp("w39p")); cua = join(top, "cua"); out = join(top, "out"); log = join(top, "calls.log"); });
afterEach(() => rmSync(top, { recursive: true, force: true }));

test("W39p 道具が実行された 7 本は「不変」・拒否された drag は「未測（拒否: 理由）」で原文が残り、不変と数えない・全角括弧で落ちない", () => {
  const r = run("ok");
  expect(r.text).not.toContain("unbound variable");
  for (const t of ["click", "double_click", "right_click", "scroll", "type_text", "press_key", "hotkey"]) expect(r.text).toMatch(new RegExp(`${t} 前=\\{[^ ]*\\} 後=\\{[^ ]*\\} 不変`));
  expect(r.text).toContain("drag 前=");
  expect(r.text).toContain("未測（拒否: background_unavailable）");
  expect(r.text).not.toMatch(/drag [^\n]*不変/);
  expect(r.text).toContain("macOS has no background drag route; drag moves the physical pointer"); // cua の原文
  expect(r.text).toContain("動いた道具: 0（");
  expect(r.text).toContain("不変（道具が実行されて動かなかった）: 7／未測（拒否）: 1");
  expect(r.code).toBe(0);
  expect(readFileSync(join(out, "drag.out"), "utf8")).toContain("physical pointer");
});

test("W39p 各道具の直前に同じ窓の get_window_state を取る（click 系が screenshot_context_missing にならない）", () => {
  const r = run("ok");
  const seq = r.calls.filter((c) => c !== "get_cursor_position" && c !== "list_windows");
  expect(seq).toEqual(["get_window_state", "click", "get_window_state", "double_click", "get_window_state", "right_click", "get_window_state", "scroll", "get_window_state", "drag", "get_window_state", "type_text", "get_window_state", "press_key", "get_window_state", "hotkey"]);
});

test("W39p 画面上に無い窓（is_on_screen=false）は道具を 1 本も呼ばず「未測」で止まる", () => {
  const r = run("offscreen");
  expect(r.code).toBe(3);
  expect(r.text).toContain("未測（対象の窓が画面上に無い");
  expect(r.calls.filter((c) => !["list_windows"].includes(c))).toEqual([]);
});

test("W39p 全部拒否された時は「不変」と言わず『判定できません』（exit 4）", () => {
  const r = run("allrefuse");
  expect(r.code).toBe(4);
  expect(r.text).toContain("判定できません");
  expect(r.text).not.toMatch(/ 不変\n/);
  expect(r.text).toContain("未測（拒否: screenshot_context_missing）");
  expect(r.text).toContain("未測（拒否: unverifiable）");
});

test("W39p 実行された道具がポインタを動かしたら「動いた」・exit 1（検出力）", () => {
  const r = run("moves");
  expect(r.text).toMatch(/click 前=\{[^ ]*\} 後=\{[^ ]*\} 動いた/);
  expect(r.text).toContain("動いた道具: 1（");
  expect(r.code).toBe(1);
});

test("W39p --dry-run: cua を 1 回も呼ばず、8 本の手順（state → 前 → 道具 → 後）だけ出す", () => {
  const r = run("ok", ["10", "1"], ["--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.calls).toEqual([]);
  expect(r.text.split("\n").filter((l) => l.startsWith("DRY: get_window_state")).length).toBe(8);
  expect(r.text).toContain("DRY: list_windows で pid=10 window_id=1 が is_on_screen=true か確かめる");
});
