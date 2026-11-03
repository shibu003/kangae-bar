import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setAside } from "./aside.ts";

export type Win = { x: number; y: number; w: number; h: number; open: boolean };
export type Card = { key: string; kind: "session" | "tab" | "terminal"; rootId?: number; url?: string; title?: string; icon?: string; x: number; y: number; win?: Win };

const file = (home: string) => join(home, "desktop.json");
const unit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
const web = (u: unknown) => typeof u === "string" && /^https?:\/\//.test(u);

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
export function winOf(v: any): Win | null {
  const x = num(v?.x, -10000, 10000), y = num(v?.y, -10000, 10000), w = num(v?.w, 120, 10000), h = num(v?.h, 80, 10000);
  return x === null || y === null || w === null || h === null || typeof v.open !== "boolean" ? null : { x, y, w, h, open: v.open };
}

// 壊れた file・形の違う札は空から始める（札を数えられなくなる事より、置き直せる事を選ぶ）
export function readDesktop(home: string): Card[] {
  try {
    const raw = JSON.parse(readFileSync(file(home), "utf8"));
    if (!Array.isArray(raw)) { setAside(file(home), "机の配置"); return []; }
    const seen = new Set<string>();
    const cards = raw.flatMap((c: any): Card[] => {
      const x = unit(c?.x), y = unit(c?.y);
      if (x === null || y === null) return [];
      const card: Card | null =
        c.kind === "session" && Number.isInteger(c.rootId) ? { key: `s:${c.rootId}`, kind: "session", rootId: c.rootId, x, y }
        : c.kind === "terminal" && Number.isInteger(c.rootId) ? { key: `x:${c.rootId}`, kind: "terminal", rootId: c.rootId, x, y }
        : c.kind === "tab" && web(c.url) ? { key: `t:${c.url}`, kind: "tab", url: c.url, title: String(c.title ?? ""), ...(web(c.icon) ? { icon: c.icon } : {}), x, y }
        : null;
      if (!card || seen.has(card.key)) return [];
      seen.add(card.key);
      const win = winOf(c.win);
      return [win ? { ...card, win } : card];
    });
    if (cards.length < raw.length) setAside(file(home), "机の配置", { copy: true }); // 札を落とした（次に置く時に上書きされる）前の写しを取る
    return cards;
  } catch (e) {
    if (e instanceof SyntaxError) setAside(file(home), "机の配置"); // 無い file は新規。在るのに JSON でない物だけ取っておく
    return [];
  }
}

export function writeDesktop(home: string, cards: Card[]) {
  const tmp = `${file(home)}.tmp`;
  writeFileSync(tmp, JSON.stringify(cards));
  renameSync(tmp, file(home));
}

export const unitOf = unit;
export const isWeb = web;

// 札（幅 140px・高さ 36px 前後）が窓で重ならない、左上から詰めた空き位置。満杯なら 1 枚ずつずらす
export function freeSpot(cards: Card[]): { x: number; y: number } {
  for (let j = 0; j < 7; j++)
    for (let i = 0; i < 5; i++) {
      const x = 0.03 + i * 0.2, y = 0.04 + j * 0.14;
      if (!cards.some((c) => Math.abs(c.x - x) < 0.12 && Math.abs(c.y - y) < 0.1)) return { x, y };
    }
  const n = cards.length % 20;
  return { x: 0.05 + n * 0.02, y: 0.05 + n * 0.02 };
}
