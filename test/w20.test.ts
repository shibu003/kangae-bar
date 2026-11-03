// W20-name: 製品の名前は Kangae（CEO「仮でkangaeでいい」）。人の目に出る所に「考えの空」を残さない（データの置き場 Documents/考えの空 と、前の名前の物を消す行は識別子なので残す）
import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { png } from "../tools/make-icons.ts";

const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

test("人の目に出る所（拡張・案内・installer・agent に渡す文）に『考えの空』が無い（識別子 2 つだけ残す）", () => {
  const OLD = "考えの空";
  const allow = (f: string, l: string) => (/Documents\/考えの空/.test(l)) || (f === "scripts/install.sh" && l.includes('rm -rf "$APPS/考えの空.app"'));
  for (const f of ["extension/manifest.json", "extension/panel.html", "extension/panel.js", "extension/newtab.html", "extension/newtab.js", "extension/sw.js", "src/main.ts", "src/ui.ts", "src/launch.ts", "src/first-run.ts", "src/paths.ts", "src/lease.ts", "src/cmds.ts", "scripts/install.sh", "scripts/install-bar.sh"]) {
    const bad = read(f).split("\n").filter((l) => l.includes(OLD) && !allow(f, l));
    expect(bad, `${f}: ${bad[0]?.trim().slice(0, 80)}`).toEqual([]);
  }
});

test("拡張: name は Kangae・icons 16 / 48 / 128 が manifest に書かれ、実在する PNG（寸法が合う）", () => {
  const m = JSON.parse(read("extension/manifest.json"));
  expect(m.name).toBe("Kangae");
  for (const s of [16, 48, 128]) {
    expect(m.icons[String(s)]).toBe(`icons/${s}.png`);
    expect(m.action.default_icon[String(s)]).toBe(`icons/${s}.png`);
    const b = readFileSync(join(root, "extension", `icons/${s}.png`));
    expect(b.subarray(1, 4).toString()).toBe("PNG");
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([s, s]); // IHDR の幅・高さ
    expect(statSync(join(root, "extension", `icons/${s}.png`)).size).toBeGreaterThan(60);
    expect(b.equals(png(s))).toBe(true); // tools/make-icons.ts で作り直せる（仮の icon）
  }
});

test("新しいタブの題（newtab.html の title）と sw.js が見分ける題が同じ（ずれると新しいタブを取り違える）", () => {
  const title = /<title>(.*?)<\/title>/.exec(read("extension/newtab.html"))![1];
  expect(title).toBe("Kangae");
  expect(read("extension/sw.js")).toContain(`t.title === "${title}"`);
  expect(read("src/ui.ts")).toContain(`const BUNDLED = "${title}"`);
});
