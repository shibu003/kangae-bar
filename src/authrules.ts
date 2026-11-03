// W76c: 認証の自動化の登録（要件 29・30）。<uiHome>/auth-rules.json に {host: {password|otp: {always, at}}} だけ（値・鍵は持たない・0600・tmp → rename）。
// 書けるのは人（panel の authAnswer）だけ。agent の op には書く口が無い。登録（register）は W76d の画面が呼ぶ・always allow は登録済みの host×口にだけ付く
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AutoKind = "password" | "otp";
type Rule = { always: boolean; at: number; item?: string }; // item = 金庫（Bitwarden）の項目の id（参照だけ・値は持たない）
const file = (home: string) => join(home, "auth-rules.json");
const read = (home: string): Record<string, Partial<Record<AutoKind, Rule>>> => { try { const j = JSON.parse(readFileSync(file(home), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; } };
const save = (home: string, all: object) => { const f = file(home); writeFileSync(`${f}.tmp`, JSON.stringify(all), { mode: 0o600 }); renameSync(`${f}.tmp`, f); };
// host は hostname（小文字）。URL の origin でも渡せる
export const hostKey = (h: string): string => { try { return new URL(h).hostname.toLowerCase(); } catch { return h.toLowerCase().replace(/[^a-z0-9.-]/g, ""); } };

export const ruleOf = (home: string, host: string, kind: AutoKind): Rule | null => read(home)[hostKey(host)]?.[kind] ?? null;
export const isRegistered = (home: string, host: string, kind: AutoKind) => !!ruleOf(home, host, kind);
export const isAlways = (home: string, host: string, kind: AutoKind) => ruleOf(home, host, kind)?.always === true;
export const ITEM_RE = /^[0-9a-z][\w-]{0,63}$/i;
// W76d: 登録 = この host×口 を金庫の項目（id の参照）に結ぶ。値・鍵は持たない。人の画面の authAnswer だけが呼ぶ
export function register(home: string, host: string, kind: AutoKind, item?: string): boolean {
  const all = read(home), h = hostKey(host);
  if (!h || (item !== undefined && !ITEM_RE.test(item))) return false;
  all[h] = { ...all[h], [kind]: { always: all[h]?.[kind]?.always === true, at: Date.now(), ...(item ? { item } : {}) } };
  save(home, all);
  return true;
}
// 登録済みの host×口にだけ。未登録は付けない（always を先に付ける口を作らない）
export function setAlways(home: string, host: string, kind: AutoKind, on: boolean): boolean {
  const all = read(home), h = hostKey(host), r = all[h]?.[kind];
  if (!r) return false;
  all[h] = { ...all[h], [kind]: { ...r, always: on } };
  save(home, all);
  return true;
}
// W78p: 「覚えた許し」の一覧に出す物 = always が付いた host×口だけ（host と口の種類だけ・値も鍵も無い）
export const alwaysList = (home: string): { host: string; kind: AutoKind }[] =>
  Object.entries(read(home)).flatMap(([host, r]) => (["password", "otp"] as const).filter((k) => r?.[k]?.always === true).map((kind) => ({ host, kind })));
