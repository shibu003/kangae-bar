import { copyFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { openStore } from "./store.ts";

// 古い版の home の file が今の版で読めない時、黙って捨てず（空から始めて上書きせず）取っておき、最初の画面（/first）に 1 行と次の一手を出す（W7m）
export type Notice = { what: string; how: string };
const notices: Notice[] = [];
const done = new Set<string>();
export const asideNotices = (): readonly Notice[] => notices;

// copy = 読めた分は使い続ける file（一部の札だけ落とした時）。無ければ rename（元の場所は空から始める）。返すのは取っておいた path
export function setAside(file: string, label: string, o: { copy?: boolean; now?: Date } = {}): string | null {
  if (!existsSync(file) || done.has(file)) return null;
  done.add(file);
  const kept = `${file}.unreadable-${(o.now ?? new Date()).toISOString().replace(/\D/g, "").slice(0, 14)}`;
  // 写しを全部揃えてから元を消す（-wal・-shm が先・本体が最後）。rename を 1 つずつだと、本体だけ移った所で落ちると次の起動の空の記録が残った -wal を 0 に潰す＝写しにも元にも無くなる（review16 で実測）
  const parts = o.copy ? [""] : ["", "-wal", "-shm"].filter((s) => existsSync(file + s));
  const copied: string[] = [];
  try {
    for (const s of parts) { copyFileSync(file + s, kept + s); copied.push(s); }
  } catch { for (const s of copied) rmSync(kept + s, { force: true }); return null; } // 写しが揃わなければ元に触らない
  if (!o.copy) try { for (const s of [...parts].reverse()) unlinkSync(file + s); } catch { return null; }
  notices.push({
    what: o.copy ? `前の版の ${label} の一部が読めませんでした` : `前の版の ${label} が読めませんでした`,
    how: `消してはいません。${basename(kept)} に取ってあります（Kangae の置き場の中）。${o.copy ? "読めた分はそのまま使えます" : "今は空から始まっています"}。戻したい時は、その file を添えて作った人に知らせてください`,
  });
  return kept;
}

// 記録（kangae.db）を開く。取り置くのは SQLite が「DB ではない / 壊れている」と言った時だけ。鍵が取れない（別の常駐が移行中）・満杯・権限は壊れていない記録なので、取り置かず落ちる（review16: BUSY で健全な記録を取り置き、空から始めていた）
export function openStoreKeeping(file: string): ReturnType<typeof openStore> {
  try { return openStore(file); } catch (e) {
    if (!/^SQLITE_(NOTADB|CORRUPT)/.test(String((e as { code?: unknown })?.code ?? ""))) throw e;
    setAside(file, "記録（kangae.db）");
    return openStore(file);
  }
}
