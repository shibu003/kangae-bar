// front-watch の記録を、人の普段使いの中で読む（EXP-1 の基線: 2026-10-09 製品を起こさない 98 分で、前面 9 回・CoreServicesUIAgent の窓 数十枚・メニューバーの窓が一斉に出た）。
// 使い方: bun tools/front-read.ts <front-watch の出力> [--mark "HH:MM:SS"] [--window 60] [--pids 1,2] [--owners "Kangae Bar,..."] [--human <人の app の pid,..>] [--t0 "YYYY-MM-DD HH:MM:SS"]
// 判定表:
//  ① 我々 = pid が --pids か owner が --owners（既定 Kangae Bar・KangaeBar）。記録の全体で、我々が前面に来た回数 = 0 でなければ赤。我々の窓は並べる（W15 の丸い icon 等は許す物として数に入れない）。
//  ② 起こした時刻（--mark）の前 2 秒〜後 --window 秒の間に出た、我々以外の新しい窓・前面の変化。③ の除外を引いた残りが 0 でなければ赤。
//     ただし CoreServicesUIAgent / UserNotificationCenter の窓は ③ に関わらず赤（Gatekeeper の dialog の出し手＝EXP-1 の原因）。例外は基線（baseline 関数: 400x70 と高さ 30 以下）。ponytail: 大きさの 2 つで見分ける粗い表＝基線が変わったら表を直す。--mark が無ければ ② は読まない。
//  ③ 除外 = 人の app と OS の常駐: Problem Reporter・REAPER・Orca・Finder・Dock・Window Server・Control Center・Spotlight・メニューバーの窓（layer 24/25）・menu bar 常駐。
// 終了コード: 0 = 緑 / 1 = 赤。窓の中身・題は読まない（front-watch が出していない）。
import { readFileSync } from "node:fs";

export const OURS_OWNERS = ["Kangae Bar", "KangaeBar"];
export const HUMAN_OS = ["Problem Reporter", "REAPER", "Orca", "Finder", "Dock", "Window Server", "Control Center", "Spotlight", "TextInputMenuAgent", "GlobalProtect", "AeroSpace", "Citrix Workspace", "PostgresMenuHelper", "Alfred", "OSDUIHelper", "SystemUIServer", "Notification Center"];
export const DIALOG_MAKERS = ["CoreServicesUIAgent", "UserNotificationCenter"];
// CEO の Mac の基線（2026-10-09・製品を起こさない 98 分で数十回）: CoreServicesUIAgent の 400x70 と、高さ 30 以下の細い窓は常時出ている＝dialog ではない。それより大きい窓だけ dialog とみなす
export const baseline = (e: { owner: string; size?: string }) => e.owner === "CoreServicesUIAgent" && (e.size === "400x70" || Number(e.size?.split("x")[1] ?? 999) <= 30);

type Ev = { t: number; kind: "front" | "win"; owner: string; pid: number; layer?: number; size?: string };
const FRONT = /^\s*([\d.]+)s\s+(.+?) -> (.+?)(?:\s{2}pid=(\d+) path=(.*))?$/;
const WIN = /^\s*([\d.]+)s\s+\+win(?:\(許可\))? owner=(.+?) pid=(-?\d+) layer=(-?\d+) size=(\d+x\d+)$/;

export function parse(text: string): { t0?: number; events: Ev[] } {
  let t0: number | undefined;
  const events: Ev[] = [];
  for (const l of text.split("\n")) {
    const m0 = /(?:t0=|差し替え |start )(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(l);
    if (m0 && t0 === undefined) t0 = Date.parse(m0[1]!.replace(" ", "T")) / 1000;
    let m = WIN.exec(l);
    if (m) { events.push({ t: +m[1]!, kind: "win", owner: m[2]!, pid: +m[3]!, layer: +m[4]!, size: m[5]! }); continue; }
    m = FRONT.exec(l);
    if (m) events.push({ t: +m[1]!, kind: "front", owner: m[3]!, pid: m[4] ? +m[4] : -1 });
  }
  return { t0, events };
}

export function judge(text: string, o: { mark?: number; window?: number; pids?: number[]; owners?: string[]; t0?: number; human?: number[] } = {}) {
  const p = parse(text);
  const t0 = o.t0 ?? p.t0;
  const ours = (e: Ev) => (o.pids ?? []).includes(e.pid) || [...OURS_OWNERS, ...(o.owners ?? [])].includes(e.owner);
  const mine = p.events.filter(ours);
  const oursFront = mine.filter((e) => e.kind === "front");
  // 見張りが mark の時刻に生きていたか: 「end front=」で終わった記録の最後の時刻より後の mark は、何も見ていない＝緑にしない（2026-10-09 EXP-1: 6 時間で止まった見張りを、止まった後の 3 回の再走に当てて「緑」と読んだ）
  const ended = /^end front=/m.test(text);
  const lastT = p.events.reduce((m, e) => Math.max(m, e.t), 0);
  const blind = o.mark !== undefined && t0 !== undefined && ended && o.mark - t0 > lastT + 120;
  const lines: string[] = [`我々が前面に来た回数 ${oursFront.length}`, `我々の窓 ${mine.filter((e) => e.kind === "win").length} 枚（許す物・並べるだけ）`];
  let red = oursFront.length > 0 || blind;
  if (blind) lines.unshift("赤: 見張りは mark の前に終わっている（end front= の後の時刻は何も見ていない）");
  if (o.mark !== undefined && t0 !== undefined) {
    const from = o.mark - t0 - 2, to = o.mark - t0 + (o.window ?? 60);
    const inWin = p.events.filter((e) => e.t >= from && e.t <= to && !ours(e) && !(o.human ?? []).includes(e.pid)); // human = 人の app の pid（--human・例: CEO の Chrome）。pid で指す＝owner 名（Google Chrome）だと製品が起こした物まで除外してしまう
    const bad = inWin.filter((e) => !baseline(e) && (DIALOG_MAKERS.includes(e.owner) || !(HUMAN_OS.includes(e.owner) || (e.layer !== undefined && (e.layer === 24 || e.layer === 25)))));
    lines.push(`起こした時刻の前後（-2〜+${o.window ?? 60} 秒）: 我々以外 ${inWin.length} 件のうち 除外後 ${bad.length} 件${bad.length ? "（" + bad.map((e) => `${e.owner}${e.size ? " " + e.size : ""}`).join(", ") + "）" : ""}`);
    red ||= bad.length > 0;
  } else lines.push("起こした時刻（--mark）が無い／記録に t0 が無いので ② は読まない");
  return { ok: !red, lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const file = a.find((x) => !x.startsWith("--") && a.indexOf(x) === 0) ?? "";
  const text = readFileSync(file, "utf8");
  const t0 = opt("--t0") ? Date.parse(opt("--t0")!.replace(" ", "T")) / 1000 : undefined;
  const day = (parse(text).t0 ?? t0) !== undefined ? new Date(((parse(text).t0 ?? t0)!) * 1000) : undefined;
  const mark = opt("--mark") && day ? Date.parse(`${day.toLocaleDateString("sv")}T${opt("--mark")}`) / 1000 : undefined;
  const r = judge(text, { mark, window: opt("--window") ? +opt("--window")! : undefined, pids: opt("--pids")?.split(",").map(Number), owners: opt("--owners")?.split(","), human: opt("--human")?.split(",").map(Number), t0 });
  console.log(r.lines.join("\n") + `\n${r.ok ? "緑" : "赤"}`);
  process.exit(r.ok ? 0 : 1);
}
