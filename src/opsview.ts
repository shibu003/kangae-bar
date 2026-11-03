// 人が裏の仕事を見る面（W50）: ops.jsonl（W42a の記録）から、agent ごとの直近の操作を「どの tab / 窓で・何を・どうなった」の 1 行にする。
// 読むのは人の panel だけ（常駐の op opsRecent は agent の呼びを断る）。値は記録が伏せたまま（secure は〈伏せ〉）・ここでも長さを切る。内部の語（面・世代・lease）は使わない
import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import type { OpRecord } from "./lease.ts";

export const OPS_SHOWN = 5;
export const OPS_MAX_BYTES = 2 * 1024 * 1024; // 記録の file はこの大きさで .1 に送る（W50b: 追記だけで伸び続けない）
export const OPS_KEEP = 2; // .1 と .2 の 2 世代まで（それより古い記録は消える）

// 回転だけを別 process と直列にする file lock（W60c）。`<file>.lock` を O_EXCL で作る（中身は持ち主の pid・時刻）。持ち主が死んでいる・古い（5 秒）lock は奪う。
// ponytail: 古い lock を 2 人が同時に奪うと両方が入りうる（回転は lock の中で大きさを見直すので 2 度送りにはならない）。取れなければ回さない（足すだけ・記録は失わない・次の追記でもう一度試す）。足す側（O_APPEND の 1 回の write）は lock なしで他と混ざらない
const LOCK_STALE_MS = 5000, LOCK_WAIT_MS = 1000;
const pause = (ms: number) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 待てなければ急いで回す */ } };
function withLock<T>(file: string, fn: () => T): T | undefined {
  const lock = `${file}.lock`;
  for (const end = Date.now() + LOCK_WAIT_MS; ; pause(10)) {
    try { const fd = openSync(lock, "wx", 0o600); try { writeSync(fd, `${process.pid} ${Date.now()}`); } finally { closeSync(fd); } break; }
    catch (e: any) {
      if (e?.code !== "EEXIST") return undefined;
      try { // 持ち主が居ない・古い lock は奪う（rename は 1 人だけ勝つ）
        const [pid = 0, at = Date.now()] = readFileSync(lock, "utf8").split(" ").map(Number);
        let dead = !Number.isInteger(pid) || pid <= 0; if (dead) dead = Date.now() - statSync(lock).mtimeMs > 2 * LOCK_WAIT_MS; /* 作った直後で pid をまだ書いていない lock は奪わない */ else try { process.kill(pid, 0); } catch (k: any) { dead = k?.code !== "EPERM"; }
        if (dead || Date.now() - at > LOCK_STALE_MS) { const mine = `${lock}.${process.pid}.stale`; renameSync(lock, mine); rmSync(mine, { force: true }); continue; }
      } catch { /* 読めない・もう無い: もう一度試す */ }
      if (Date.now() >= end) return undefined;
    }
  }
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}
// 記録の 1 行を足す（0600）。大きくなっていたら先に回す: ops.jsonl.1 → .2・ops.jsonl → .1。回す間は lock（別 process が同時に回すと、回したばかりの世代をもう 1 度送って 1 世代早く消す）。lock の中で大きさを見直す
export function rotateOps(file: string, keep = OPS_KEEP): void {
  for (let i = keep; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`, to = `${file}.${i}`;
    if (!existsSync(from)) continue;
    try { renameSync(from, to); chmodSync(to, 0o600); } catch { return; /* 途中で止める（review28: 続けると、動かせなかった古い世代の上に今の file を重ねて消す）。次の追記でもう一度試す */ }
  }
}
export function appendOps(file: string, line: string, max = OPS_MAX_BYTES): void {
  try { if (existsSync(file)) { const st = statSync(file); if (st.mode & 0o077) chmodSync(file, 0o600); /* review28: 前から在る file の緩い権限も締める */ if (st.size >= max) withLock(file, () => { if (existsSync(file) && statSync(file).size >= max) rotateOps(file); }); } } catch { /* 大きさを見られなくても足す */ }
  appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`, { mode: 0o600 });
}
const TAIL_BYTES = 256 * 1024; // 記録は追記だけで伸びる。新しい側だけ読む
export const MAX_READ = 4 * 1024 * 1024; // 読む幅の上限
export const LINE_MAX = 4096; // 1 行の長さの上限（記録は 1 行 1KB 未満。これを超える行は読まない）

const DO: Record<string, string> = { click: "押した", double_click: "ダブルクリックした", right_click: "右クリックした", type_text: "文字を入れた", press_key: "キーを押した", hotkey: "ショートカットを押した", set_value: "値を書き換えた", drag: "ドラッグした", scroll: "スクロールした", fill: "欄に入れた", press_button: "ボタンを押した", select_option: "選択肢を選んだ", get_window_state: "画面を読んだ", fetch_url: "同じ site の頁を読んだ", render_url: "頁を描いて読んだ", open_tab: "新しい tab を開いた", open_app: "app を開いた", window_image: "窓の絵を読んだ", web_op: "頁の操作をした" };
const WHY: Record<string, string> = { human: "人の確認が要るので止まった", waiting: "あなたが見ている間は待った", gen: "取り戻されたので止まった", exp: "貸した時間が切れた", surface: "その tab / 窓がもう無かった", tool: "その操作は使えない", busy: "別の会話が使っていた", denied: "あなたが断った", mod: "読むだけの設定で止まった", owner: "別の会話の tab / 窓なので止まった", unknown: "知らない操作で止まった", bad: "操作の形が違って止まった", "no-floor": "取り戻し直後なので止まった", off: "この tab / 窓は読むだけの設定", timeout: "時間切れ", driver: "ブラウザや app が答えなかった", result: "結果が確かめられなかった" };

export const whereOf = (r: OpRecord) => `${String(r.face).startsWith("tab:") || r.app === "web" ? "tab" : "窓"}${r.where ? `「${String(r.where).slice(0, 40)}」` : r.app ? `（${String(r.app).slice(0, 40)}）` : ""}`; // 長さはここでも切る（手で足された行でも 1 行を肥大させない）

// 1 行: <どの tab / 窓> で <何を>（値）→ <どうなった>
export function lineOf(r: OpRecord): string {
  const where = r.face ? whereOf(r) : "面を持たずに";
  if (r.op.startsWith("draft:")) return `${where}: 「${r.op.slice(6, 40)}」は自動でやらず、下書きにして止めた${r.value ? `（欄: ${r.value.slice(0, 60)}）` : ""}`;
  if (r.op === "remote:resume") return `スマホから再開を頼まれた: ${r.value.slice(0, 60)}`;
  if (r.op === "remote:launch") return `スマホから Kangae を裏で開くよう頼まれた: ${r.value.slice(0, 60)}`;
  if (r.op.startsWith("remote:")) return `スマホから${r.op === "remote:allow" ? "許した（今回だけ）" : "断った"}: ${r.value.slice(0, 60)}`; // R2: 承認に答えた端末
  const what = DO[r.op] ?? `${r.op.slice(0, 30)} をした`;
  const v = r.value && !/^\{.*\}$/.test(r.value) ? (r.value === "〈伏せ〉" ? "（中身は伏せ）" : `（${r.value.slice(0, 40)}）`) : "";
  const res = r.result === "ok" ? "できた" : r.result === "error" ? "うまくいかなかった" : r.result.startsWith("refused:") ? WHY[r.result.slice(8)] ?? "断られた" : r.result.slice(0, 30);
  return `${where}で${what}${v} → ${res}`;
}

// その会話（s:N）の直近 n 件（新しい順）。file が無い・読めない・壊れた行は黙って飛ばす
function recentOne(file: string, owner: string, n: number): { at: number; line: string }[] {
  if (!existsSync(file)) return [];
  const out: { at: number; line: string }[] = [];
  let size = 0;
  try { size = statSync(file).size; } catch { return []; }
  // 新しい側から読む。肥大した行が最新を押し流しても（読み幅を 4 倍ずつ広げて）手前の記録まで届く・上限 MAX_READ
  for (let bytes = TAIL_BYTES; ; bytes *= 4) {
    out.length = 0;
    const from = Math.max(0, size - bytes);
    let text = "";
    try {
      const buf = Buffer.alloc(size - from), fd = openSync(file, "r");
      try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
      text = buf.toString("utf8");
    } catch { return []; }
    for (const l of text.split("\n").reverse()) {
      if (out.length >= n) break;
      if (l.length > LINE_MAX) continue; // 肥大した行（古い記録・手で足された行）は読まずに飛ばす
      try { const r = JSON.parse(l) as OpRecord; if (r.owner === owner && typeof r.op === "string" && typeof r.result === "string") out.push({ at: Number(r.at) || 0, line: lineOf(r) }); } catch { /* 先頭の欠けた行・壊れた行は飛ばす */ }
    }
    if (out.length >= n || from === 0 || bytes >= MAX_READ) break;
  }
  return out;
}

// その会話（s:N）の直近 n 件（新しい順）。今の file → .1 → .2 の順に、足りるまで読む（回転で古い側に移った記録も出す）
export function recentFor(file: string, owner: string, n = OPS_SHOWN): { at: number; line: string }[] {
  if (!/^s:\d+$/.test(owner)) return [];
  const out: { at: number; line: string }[] = [];
  for (const f of [file, ...Array.from({ length: OPS_KEEP }, (_, i) => `${file}.${i + 1}`)]) {
    if (out.length >= n) break;
    out.push(...recentOne(f, owner, n - out.length));
  }
  return out;
}
