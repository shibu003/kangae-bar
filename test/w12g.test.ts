// W12-7: 台帳 W12-6 の上 3 つ＋次点。断られた理由が欄の下に出る・拡張の手順が英語 UI の Chrome でも読める・manifest の説明が今の製品・例が汎用
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstRunNeeds } from "../src/first-run.ts";
import { EXT_HANDOFF, EXT_STEPS } from "../src/lease.ts";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");

test("断られた理由は kg-toast（role=status・W77d で欄の下の 1 行から移した）に出て、title（hover）だけにしない。次に打てば消える", () => {
  const js = read("extension/panel.js"), html = read("extension/panel.html");
  expect(js).not.toMatch(/\.title = r\.hint/);
  expect(js.split("showErr(").length - 1).toBeGreaterThanOrEqual(7); // 定義 + 作成 / 名前変更 / agent 名の失敗と成功 + input で消す
  expect(js).toContain('addEventListener("input", () => showErr(');
  expect(html).toContain('<kg-toast id="toast"></kg-toast>');
  expect(html).not.toMatch(/id="(empty|send)-err"/); // 欄の下の赤い 1 行は無い（報せは toast 1 枚）
  expect(js).toContain('$("toast").hide("warn")'); // 入力し直すと失敗の報せだけ消える
});

test("拡張の手順: 日本語と英語の Chrome の語が併記され、extension フォルダの出し方（Finder の button）が文に出る。none / placed の両方で同じ文", () => {
  for (const w of ["デベロッパー モード（Developer mode）", "（Load unpacked）", "extension フォルダ", "拡張の置き場を Finder で開く", "デベロッパー モードの拡張機能を無効にしますか"]) expect(EXT_STEPS, w).toContain(w);
  for (const w of ["Developer mode", "Load unpacked", "拡張の置き場を Finder で開く"]) expect(EXT_HANDOFF, w).toContain(w);
  const base = { clis: ["claude"], claudeLogin: true, ax: true, refused: undefined } as const;
  for (const extension of ["none", "placed"] as const) {
    const n = firstRunNeeds({ ...base, extension }).find((x) => x.kind === "extension")!;
    expect(n.how, extension).toContain("Load unpacked");
    expect(n.how, extension).toContain("拡張の置き場を Finder で開く");
  }
});

test("manifest の説明は今の製品（AI が tab を許した範囲で操作する）を言う・例に開発者の project 名を出さない", () => {
  const m = JSON.parse(read("extension/manifest.json"));
  expect(m.description).toContain("AI");
  expect(m.description).toContain("tab");
  for (const f of ["src/main.ts", "src/cmds.ts", "extension/panel.js"]) expect(read(f), f).not.toContain("ER_Triage_GUI");
});

// W12-8: 人がターミナルで打つ kangae の案内は、PATH に頼らないフルパス（installer は他人の shell の設定を書き換えない）
import { CLI, registerLine } from "../src/cmds.ts";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";

test("W12-8 人が打つ案内（CLI 文言・panel・登録の行）は ~/.kangae/bin/kangae のフルパス。素の `kangae cmd-` を人に打たせない", () => { // rules-ok: 案内の文字列を見るだけ（owner の home は読まない）
  expect(CLI).toBe("~/.kangae/bin/kangae"); // rules-ok: 案内の文字列を見るだけ（owner の home は読まない）
  expect(registerLine("x")).toStartWith(`${CLI} cmd-add x`);
  for (const f of ["src/main.ts", "src/lease.ts", "src/cmds.ts", "extension/panel.js", "docs/verify/exp1/RUN.md"]) {
    const bad = read(f).split("\n").filter((l) => /(?<![\/\w.])kangae cmd-(add|rm|list)/.test(l) && !/^\s*\/\//.test(l));
    expect(bad, `${f}: ${bad[0]?.slice(0, 80)}`).toEqual([]);
  }
  expect(read("extension/panel.js")).toContain("~/.kangae/bin/kangae cmd-rm"); // W97: 空の例（cmd-add）は出さない。人が打つ残りの行は外す方。rules-ok: 案内の文字列を見るだけ（owner の home は読まない）
  for (const f of ["scripts/install.sh", "scripts/install-bar.sh"]) expect(read(f), f).toContain("ターミナルで kangae を打つ時は ~/.kangae/bin/kangae"); // rules-ok: 案内の文字列を見るだけ（owner の home は読まない）
});

test("W12-8 install-bar.sh は KANGAE_BIN に symlink を置く（試験で KANGAE_APPS だけ置き換えた時は本物の home に置かない）", () => {
  const t = mktmp("w12h"), apps = join(t, "Apps"), bin = join(t, "bin");
  mkdirSync(apps);
  // main の symlink 行だけを取り出して回す（zip を落とす所までは review16 の test が見る）
  const body = read("scripts/install-bar.sh");
  const m = /# 人がターミナルで kangae[^\n]*\nKBIN[^\n]*\nif [^\n]*; fi\n/.exec(body)![0];
  const run = (env: Record<string, string>) => spawnSync("sh", ["-c", `APPS="${apps}"\n${m}`], { env: { PATH: process.env.PATH!, HOME: join(t, "home"), ...env }, encoding: "utf8" });
  expect(run({ KANGAE_BIN: bin, KANGAE_APPS: apps }).status).toBe(0);
  expect(readlinkSync(join(bin, "kangae"))).toBe(join(apps, "Kangae Bar.app/Contents/Resources/bin/kangae"));
  const t2 = mktmp("w12h2");
  run({ KANGAE_APPS: apps, HOME: t2 }); // KANGAE_APPS だけ（試験の形）: 置かない
  expect(existsSync(join(t2, ".kangae"))).toBe(false); // rules-ok: temp の HOME の下
  const t3 = mktmp("w12h3");
  run({ HOME: t3 }); // 何も置き換えない（配る形）: HOME の下に置く
  expect(lstatSync(join(t3, ".kangae/bin/kangae")).isSymbolicLink()).toBe(true);
});

import { ensureCliLink } from "../src/cmds.ts";
import { readdirSync, readFileSync as rf, symlinkSync, unlinkSync, writeFileSync } from "node:fs";

test("W12-9 bar が起こす常駐が ~/.kangae/bin/kangae を置く: 無い時だけ・同梱の kangae の時だけ・他人の物は触らない・PATH / rc は触らない", () => { // rules-ok: temp の HOME の下
  const home = mktmp("w12i"), app = join(home, "Applications/Kangae Bar.app/Contents/Resources/bin"), exe = join(app, "kangae");
  mkdirSync(app, { recursive: true });
  writeFileSync(exe, "#!/bin/sh\n");
  const link = join(home, ".kangae/bin/kangae"); // rules-ok: temp の HOME の下
  expect(ensureCliLink(home, join(home, "dist/kangae"))).toBe("skipped"); // 開発の dist・bun からは置かない
  expect(ensureCliLink(home, "/usr/local/bin/bun")).toBe("skipped");
  expect(existsSync(join(home, ".kangae"))).toBe(false); // rules-ok: temp の HOME の下
  expect(ensureCliLink(home, exe)).toBe("linked");
  expect(readlinkSync(link)).toBe(exe);
  expect(ensureCliLink(home, exe)).toBe("exists"); // 何度呼んでも同じ
  expect(readdirSync(home).sort()).toEqual([".kangae", "Applications"]); // .zshrc / .profile などを作らない // rules-ok: temp の HOME の下
  // 他人の file は上書きしない
  unlinkSync(link);
  writeFileSync(link, "mine");
  expect(ensureCliLink(home, exe)).toBe("exists");
  expect(rf(link, "utf8")).toBe("mine");
  // 向き先が生きている symlink（別の kangae）も触らない
  unlinkSync(link);
  const other = join(home, "other-kangae");
  writeFileSync(other, "x");
  symlinkSync(other, link);
  expect(ensureCliLink(home, exe)).toBe("exists");
  expect(readlinkSync(link)).toBe(other);
  // 壊れた symlink: うちの物（app を移した跡）なら直す・そうでなければ触らない
  unlinkSync(link);
  const moved = join(home, "Old/Kangae Bar.app/Contents/Resources/bin/kangae");
  symlinkSync(moved, link);
  expect(ensureCliLink(home, exe)).toBe("repaired");
  expect(readlinkSync(link)).toBe(exe);
  unlinkSync(link);
  symlinkSync(join(home, "gone/other"), link);
  expect(ensureCliLink(home, exe)).toBe("exists");
  expect(readlinkSync(link)).toBe(join(home, "gone/other"));
  // 常駐の起動から呼ばれる
  expect(read("src/main.ts")).toMatch(/--daemon"\)\) \{\n\s+ensureCliLink\(homedir\(\), process\.execPath\)/);
});

// W12-10: 人の文から内部の語（常駐・面・操作権）を消す・agent に統一・承認 card に「確かめること」の 1 行
test("W12-10 人の目に出る文（panel・CLI・bar）に『常駐』『面』『操作権』が無い。AI と agent は agent に統一", () => {
  const strings = (f: string) => read(f).split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/.*$/, "")).join("\n");
  for (const f of ["extension/panel.js", "extension/panel.html"]) {
    const s = strings(f);
    for (const w of ["常駐", "操作権"]) expect(s.includes(w), `${f}: ${w}`).toBe(false);
    expect(/(?<![画場表帳方側地反書全前後正裏上下])面[のがをはに]|この面|渡している面/.test(s), `${f}: 面`).toBe(false); // 「画面」「場面」などは別の語
  }
  for (const f of ["bar/main.swift", "bar/Region.swift"]) expect(/(say|tell)\([^)]*常駐/.test(read(f)), f).toBe(false);
  expect(read("extension/sw.js")).not.toContain('?? "常駐');
  expect(read("src/main.ts")).not.toMatch(/console\.(log|error)\([^)]*常駐/);
  for (const f of ["extension/panel.js", "extension/rules.js", "src/first-run.ts"]) expect(/"[^"\n]*この AI[^"\n]*"|"AI に走らせ|"AI（claude）/.test(strings(f)), f).toBe(false);
  expect(strings("src/mods.ts")).not.toContain('"AI が書いた"'); // mod の出所の札（agent 向けの文の「この AI では使えません」は agent に読ませる文なので残す）
});

test("W12-10 承認 card（open_app / open_tab / run_cmd）の note（と op_read / op_write の card）に『確かめること:』の 1 行", () => {
  const s = read("src/lease.ts");
  expect(s.split("確かめること: ").length - 1).toBe(6); // open_app・open_tab・run_cmd・launch_app（W53）・op（op_read / op_write・review26）・api_tab（W47・login の中身を読ませる card）
  for (const w of ["開く app の名前と、開く file・folder の場所が、頼んだ事に合っているか", "開く先の URL が頼んだ事に合っているか", "実行する行が、あなたが登録した物のままか", "起こす行が、あなたが登録した物のままか", "実行する内容が頼んだ事に合っているか", "このサイトのログインの中身を、この agent に読ませてよいか"]) expect(s, w).toContain(w);
});
