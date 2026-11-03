// 試験の「前面 0」の判定（H6）。tools/front-watch の変わった行（pid= path= 付き・bd45398）を読み、
// 我々の pid（試験が起こした Chrome・常駐・ScratchPad・bar・reader）が前面に来た回数だけを赤にする。
// 人の app の切り替えや別 project の dialog は赤にせず「人 / 他: N 回（app 名だけ）」と並べる。pid と path が読めない行は我々として数える（取りこぼして緑にしない）。
const ours = new Set<number>();
// 後始末の前に呼ぶ: 自分の隔離 dir D を command line に持つ process（試験の Chrome・常駐・ScratchPad）の pid を覚える
export function rememberOurs(D: string, extra: number[] = []) {
  for (const p of Bun.spawnSync(["pgrep", "-f", D]).stdout.toString().split("\n")) if (Number(p) > 0) ours.add(Number(p));
  for (const p of extra) ours.add(p);
}

const LINE = /^\s*[\d.]+s\s+(.+?) -> (.+?)(?:\s{2}pid=(\d+) path=(.*))?$/;
export function judgeFront(out: string, o: { pids?: Iterable<number>; paths?: string[] } = {}) {
  const pids = new Set([...ours, ...(o.pids ?? [])]);
  const paths = (o.paths ?? []).filter(Boolean);
  const mine: string[] = [];
  const others: string[] = [];
  for (const l of out.split("\n")) {
    const m = LINE.exec(l);
    if (!m) continue;
    const [, , to, pid, path] = m;
    const isOurs = pid === undefined || pids.has(Number(pid)) || paths.some((p) => path!.startsWith(p));
    (isOurs ? mine : others).push(to!);
  }
  const detail = `我々 ${mine.length} 回${mine.length ? "（" + mine.join(", ") + "）" : ""} / 人・他 ${others.length} 回${others.length ? "（" + others.join(", ") + "）" : ""}`;
  const wins = judgeWins(out, o); // 前面は替わらない OS の dialog・非 activating の窓（holes-27b: 我々と表の窓以外は赤）
  return { ok: mine.length === 0 && wins.ok, ours: mine.length, others: others.length, wins: wins.count, detail: wins.count ? `${detail} / ${wins.detail}` : detail };
}

// 新しく出た窓（front-watch の "+win" 行・holes-27/27b）。OS の dialog（CoreServicesUIAgent 等）は前面を替えずに窓だけ出す。
// 許す窓 = 我々（試験が起こした pid / path）・表 ALLOW_WIN_OWNERS（W15 の丸い icon を出す製品の bar）・front-watch --allow が "+win(許可)" と出した物。それ以外は赤。
// path の照合は ps の command（process が既に居ない等で読めない窓は許さない＝取りこぼして緑にしない）。
export const ALLOW_WIN_OWNERS = ["Kangae Bar", "KangaeBar"];
const WIN = /^\s*[\d.]+s\s+\+win owner=(.+?) pid=(-?\d+) layer=(-?\d+) size=(\d+)x(\d+)$/;
export function judgeWins(out: string, o: { pids?: Iterable<number>; paths?: string[]; owners?: string[] } = {}) {
  const pids = new Set([...ours, ...(o.pids ?? [])]);
  const paths = (o.paths ?? []).filter(Boolean);
  const owners = new Set([...ALLOW_WIN_OWNERS, ...(o.owners ?? [])]);
  const bad: string[] = [];
  for (const l of out.split("\n")) {
    const m = WIN.exec(l);
    if (!m) continue;
    const [, owner, pid] = m;
    const cmd = paths.length && !pids.has(Number(pid)) ? Bun.spawnSync(["ps", "-o", "command=", "-p", pid!]).stdout.toString() : "";
    if (owners.has(owner!) || pids.has(Number(pid)) || paths.some((p) => cmd.includes(p))) continue;
    bad.push(owner!);
  }
  return { ok: bad.length === 0, count: bad.length, detail: bad.length ? `許可外の新しい窓 ${bad.length} 枚（${bad.join(", ")}）` : "許可外の新しい窓 0" };
}

// UC が front-watch 全文を「回数=0」の regex で見ていた所の置き換え（holes-27b）: 前面の変化 0 かつ 許可外の新しい窓 0
export const frontOk = (out: string, o: Parameters<typeof judgeWins>[1] = {}) => /前面が変わった回数=0/.test(out) && judgeWins(out, o).ok;
