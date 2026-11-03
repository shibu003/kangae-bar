import { expect, test } from "bun:test";
import { judge } from "../tools/front-read.ts";

const head = "start front=Orca  pid=1 path=/Applications/Orca.app  t0=2026-10-09 10:00:00";
const base = [head, "  5.00s  Orca -> REAPER  pid=9 path=/Applications/REAPER.app", "  6.00s  +win owner=Control Center pid=4 layer=25 size=40x24", "  7.00s  +win owner=CoreServicesUIAgent pid=447 layer=3 size=400x70"].join("\n");
const MARK = Date.parse("2026-10-09T10:01:00") / 1000; // t=60s

test("人の普段使い（REAPER・メニューバー・基線の CoreServicesUIAgent）は、起こす前なら緑", () => {
  expect(judge(base, { mark: MARK }).ok).toBe(true);
});

test("起こした直後に基線の 400x70 は緑・大きい CoreServicesUIAgent の窓が出たら赤（Gatekeeper の dialog・除外表に関わらず）", () => {
  const t = `${base}\n 61.50s  +win owner=CoreServicesUIAgent pid=447 layer=3 size=420x220`;
  expect(judge(`${base}\n 61.00s  +win owner=CoreServicesUIAgent pid=447 layer=3 size=400x70`, { mark: MARK }).ok).toBe(true); // 基線
  const r = judge(t, { mark: MARK });
  expect(r.ok).toBe(false);
  expect(r.lines.join()).toContain("CoreServicesUIAgent 420x220");
});

test("起こした直後の知らない app の窓も赤・人の app（REAPER）の前面は赤にしない", () => {
  expect(judge(`${base}\n 62.00s  +win owner=Mystery pid=77 layer=0 size=300x200`, { mark: MARK }).ok).toBe(false);
  expect(judge(`${base}\n 62.00s  Orca -> REAPER  pid=9 path=/x`, { mark: MARK }).ok).toBe(true);
});

test("我々（Kangae Bar）が前面に来たら、時刻に関わらず赤・我々の窓は並べるだけ", () => {
  expect(judge(`${base}\n 10.00s  Orca -> Kangae Bar  pid=500 path=/x`, {}).ok).toBe(false);
  const w = judge(`${base}\n 61.00s  +win owner=Kangae Bar pid=500 layer=25 size=48x48`, { mark: MARK });
  expect(w.ok).toBe(true);
  expect(w.lines[1]).toContain("1 枚");
});

test("終わった見張りの後の mark は、何も見ていないので赤（緑にしない）", () => {
  const ended = `${base}\nend front=Orca  前面が変わった回数=1  新しい窓=2`;
  const late = Date.parse("2026-10-09T13:00:00") / 1000;
  const r = judge(ended, { mark: late });
  expect(r.ok).toBe(false);
  expect(r.lines[0]).toContain("見張りは mark の前に終わっている");
  expect(judge(ended, { mark: MARK }).ok).toBe(true); // mark が見張りの生きていた間なら今まで通り
});

test("--human: 人の app の pid の窓は除外・同じ owner 名でも別 pid（製品が起こした物）は赤のまま", () => {
  const humanWin = " 61.00s  +win owner=Google Chrome pid=459 layer=103 size=200x19";
  const ourChrome = " 62.00s  +win owner=Google Chrome pid=888 layer=0 size=800x600";
  expect(judge(`${base}\n${humanWin}`, { mark: MARK }).ok).toBe(false);
  expect(judge(`${base}\n${humanWin}`, { mark: MARK, human: [459] }).ok).toBe(true);
  expect(judge(`${base}\n${humanWin}\n${ourChrome}`, { mark: MARK, human: [459] }).ok).toBe(false);
});
