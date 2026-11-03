// W42a S1: カタログに無い操作の「下書き」。agent は画面操作に落とさず、操作名・欄の名前・理由を人に残して止まる（docs/design-no-fallback.md）。
// 値の中身は保存しない（欄の名前だけ）。実行は 0。人だけが一覧を見る・捨てる（昇格は次の片）
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Draft = { id: string; owner: string; face: string; gen: number | null; op: string; fields: string[]; why: string; at: number };
const NAME = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX = 50;
const file = (home: string) => join(home, "drafts.json");
export const readDrafts = (home: string): Draft[] => { try { const j = JSON.parse(readFileSync(file(home), "utf8")); return Array.isArray(j) ? j.filter((d) => d && typeof d.op === "string") : []; } catch { return []; } };
const save = (home: string, ds: Draft[]) => { writeFileSync(file(home) + ".tmp", JSON.stringify(ds), { mode: 0o600 }); renameSync(file(home) + ".tmp", file(home)); };

// fields は { 欄の名前: 値 } のうち名前だけを残す。名前・操作名が形に合わなければ断る（agent が任意の文を操作名にして人の画面に出さない）
export function addDraft(home: string, d: { owner: string; face: string; gen: number | null; op: string; fields: Record<string, unknown>; why: string }, now = Date.now()): { ok: true; draft: Draft } | { ok: false; hint: string } {
  if (!NAME.test(d.op)) return { ok: false, hint: "操作名は英数字・_ . - の 40 字までです（例: gift-wrap-toggle）" };
  const fields = Object.keys(d.fields);
  if (fields.length > 20 || fields.some((k) => !NAME.test(k))) return { ok: false, hint: "欄の名前は英数字・_ . - の 40 字まで・20 個までです（値は保存しません）" };
  const why = d.why.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 200);
  if (!why) return { ok: false, hint: "理由（--why）が要ります。なぜその操作が要るかを 1 文で" };
  const draft: Draft = { id: crypto.randomUUID().slice(0, 8), owner: d.owner, face: d.face.slice(0, 60), gen: d.gen, op: d.op, fields, why, at: now };
  save(home, [...readDrafts(home), draft].slice(-MAX));
  return { ok: true, draft };
}
export const dropDraft = (home: string, id: string): boolean => { const ds = readDrafts(home); const r = ds.filter((d) => d.id !== id); if (r.length === ds.length) return false; save(home, r); return true; };
export const draftLine = (d: Draft) => `📝 下書き「${d.op}」（欄: ${d.fields.join(", ") || "なし"}）— ${d.why}。この操作を安全にやる道がまだ無いので、agent は画面を直接操作せず止まっています。続けるには、あなたが手で済ませるか、別のやり方を agent に頼んでください`;
export const hasDrafts = (home: string) => existsSync(file(home));
