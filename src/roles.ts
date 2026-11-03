// W60b2: 会話ごとの担当名（chief of staff・marketing operator・sns・implementer…）。Bar の一覧は「どの担当が動いているか」だけを、この短い名前で並べる（面の題は出さない・CEO 10-14）。
// agent が自分の仕事を表す名前を 1 回付け（kangae role）、人は Bar でいつでも付け直せる。人が付けた名前を agent は上書きしない。<uiHome>/roles.json に {nodeId: {role, by}} で残す（0600・tmp → rename）
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROLE_MAX = 20;
// 他人（agent）が決める文字: 向きを変える・見えない・制御文字・区切りを除き、空白は 1 つに、字が 1 つは要る。通れば整えた名前、だめなら null
export const roleOk = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const t = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!t || [...t].length > ROLE_MAX || /[\p{Cc}\p{Cf}\u2028\u2029\u00ad/\\:]/u.test(t) || !/[\p{L}\p{N}]/u.test(t)) return null;
  return t;
};
export const ROLE_HINT = `担当名は ${ROLE_MAX} 字までの短い名前です（例: sns・implementer・chief of staff・marketing operator）。/ : \\ 改行・制御文字・見えない文字は使えません`;

type Rec = { role: string; by: "agent" | "human" };
const file = (home: string) => join(home, "roles.json");
const read = (home: string): Record<string, Rec> => { try { const j = JSON.parse(readFileSync(file(home), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; } };
const save = (home: string, all: Record<string, Rec>) => { const f = file(home); writeFileSync(`${f}.tmp`, JSON.stringify(all), { mode: 0o600 }); renameSync(`${f}.tmp`, f); };

export const rolesOf = (home: string): Map<number, string> => new Map(Object.entries(read(home)).filter(([, v]) => typeof v?.role === "string").map(([k, v]) => [Number(k), v.role]));
export const roleOf = (home: string, nodeId: number): string | undefined => read(home)[String(nodeId)]?.role;
// agent が付ける（人が付けた名前は上書きしない）。human が付ける（空で消す）
export function setRole(home: string, nodeId: number, raw: unknown, by: "agent" | "human"): { ok: true; role: string | null } | { ok: false; hint: string } {
  const all = read(home), cur = all[String(nodeId)];
  if (by === "human" && (raw === "" || raw == null)) { delete all[String(nodeId)]; save(home, all); return { ok: true, role: null }; }
  const role = roleOk(raw);
  if (!role) return { ok: false, hint: ROLE_HINT };
  if (by === "agent" && cur?.by === "human") return { ok: false, hint: `この会話の担当名は人が「${cur.role}」と付けています。変えられません（そのまま続けてください）` };
  all[String(nodeId)] = { role, by };
  save(home, all);
  return { ok: true, role };
}
export const rolesExist = (home: string) => existsSync(file(home));
