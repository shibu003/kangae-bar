import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// text は同梱と違う時だけ付ける。色が無い上書きは color キーを付けない（無ければ塗りの側が色を消す）
export type UiState = { color?: string | null; text?: string | null; hasOverride: boolean };

const none: UiState = { color: null, hasOverride: false };
const BUNDLED = "Kangae";
const TEXT_MAX = 40;
export const UI_HINT = "見出しは「新しいタブの見出しを青にして」か「新しいタブの見出しを『今週の募集』にして」のように、文ごと書いてください";
const BAD = /[{};]|position|display|z-index/i;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const COLOR_LINE = /^h1 \{ color: ([^;]*); \}(?: (.*))?$/s;
const TEXT_LINE = /^h1 \{ \} (.*)$/s;
const LONG = "新しいタブの見出しを";
const SHORT = "新しいタブを";
const TAG = /<\/?[a-zA-Z!][^>]*>/;

// 長い名前を先に（ピンクがピンに食われない）。英語は小文字で持つ
const NAMES: [string, string][] = [
  ["ピンク", "pink"],
  ["yellow", "yellow"],
  ["purple", "purple"],
  ["orange", "orange"],
  ["black", "black"],
  ["white", "white"],
  ["green", "green"],
  ["blue", "blue"],
  ["pink", "pink"],
  ["gray", "gray"],
  ["grey", "gray"],
  ["red", "red"],
  ["青", "blue"],
  ["赤", "red"],
  ["緑", "green"],
  ["黄", "yellow"],
  ["紫", "purple"],
  ["橙", "orange"],
  ["黒", "black"],
  ["白", "white"],
  ["灰", "gray"],
];

export function parseColor(value: string): string | null {
  const v = value.trim();
  if (!v || BAD.test(v)) return null;
  if (HEX.test(v)) return v.toLowerCase();
  const lower = v.toLowerCase();
  for (const [name, css] of NAMES) if (name === v || name === lower) return css;
  return null;
}

export const overridePath = (home: string) => join(home, "ui", "override.css");

function keptText(text: string | null | undefined): string | null {
  if (text == null || text === "" || text === BUNDLED) return null;
  return text;
}

function uiState(color: string | null, text: string | null | undefined): UiState {
  const t = keptText(text);
  if (!color && !t) return none;
  if (!color) return { text: t!, hasOverride: true };
  if (!t) return { color, hasOverride: true };
  return { color, text: t, hasOverride: true };
}

export function readUi(home: string): UiState {
  const p = overridePath(home);
  if (!existsSync(p)) return none;
  const raw = readFileSync(p, "utf8").replace(/\r?\n$/, "");
  if (raw.includes("\n") || raw.includes("\r")) return none;
  const color = COLOR_LINE.exec(raw);
  if (color) {
    const x = (color[1] ?? "").trim();
    if (!x || x === "{" || x === ";") return none;
    const c = parseColor(x);
    return c ? uiState(c, color[2]) : none;
  }
  const text = TEXT_LINE.exec(raw);
  if (text && text[1]) return uiState(null, text[1]);
  return none;
}

function lineOf(color: string | null, text: string | null): string | null {
  const t = keptText(text);
  if (!color && !t) return null;
  const head = color ? `h1 { color: ${color}; }` : "h1 { }";
  return (t ? `${head} ${t}` : head) + "\n";
}

export function writeUi(home: string, color: string | null, text?: string | null): UiState | null {
  let nextColor: string | null;
  let nextText: string | null;
  if (typeof color === "string") {
    const c = parseColor(color);
    if (!c) return null;
    nextColor = c;
    nextText = text === undefined ? (readUi(home).text ?? null) : text;
  } else {
    if (text == null) return null;
    nextColor = readUi(home).color ?? null;
    nextText = text;
  }
  if (nextText != null && (nextText.includes("\n") || nextText.includes("\r") || nextText.includes("{") || TAG.test(nextText))) return null;
  const body = lineOf(nextColor, nextText);
  mkdirSync(join(home, "ui"), { recursive: true });
  const p = overridePath(home);
  if (!body) {
    if (existsSync(p)) unlinkSync(p);
    return none;
  }
  writeFileSync(p, body);
  const st = uiState(nextColor, nextText);
  // 文字を同梱へ戻した時は、保存の行に文字を書かない（§3）が、配る形には text: null を付けて、開いている新しいタブの h1 も戻す
  return text !== undefined && !("text" in st) ? { ...st, text: null } : st;
}

export function clearUi(home: string): UiState {
  const p = overridePath(home);
  if (existsSync(p)) unlinkSync(p);
  return none;
}

export type UiPlan =
  | { kind: "color"; color: string }
  | { kind: "text"; text: string }
  | { kind: "fail" }
  | { kind: "work" };

const plain = (x: string) => (x && x === x.trim() ? parseColor(x) : null);
const colorToken = (s: string) => plain(s) ?? (s.endsWith("く") ? plain(s.slice(0, -1)) : null);

// 「」『』の組を取り出す。閉じない開きは 1 字の文字として残す
function quoted(s: string): { pairs: string[]; rest: string } {
  const pairs: string[] = [];
  let rest = "";
  let i = 0;
  for (;;) {
    const a = s.indexOf("「", i);
    const b = s.indexOf("『", i);
    const open = a < 0 ? b : b < 0 ? a : Math.min(a, b);
    if (open < 0) return { pairs, rest: rest + s.slice(i) };
    rest += s.slice(i, open);
    const close = s.indexOf(s[open] === "「" ? "」" : "』", open + 1);
    if (close < 0) { rest += s[open]; i = open + 1; continue; }
    pairs.push(s.slice(open + 1, close));
    i = close + 1;
  }
}

function classifyLong(middle: string): UiPlan {
  const { pairs, rest } = quoted(middle);
  if (pairs.length === 0) {
    const color = colorToken(middle);
    return color ? { kind: "color", color } : { kind: "fail" };
  }
  const text = pairs[0]!.trim();
  const n = [...text].length;
  const bad = pairs.length > 1 || rest !== "" || n < 1 || n > TEXT_MAX || /[{\r\n]/.test(pairs[0]!) || TAG.test(text);
  return bad ? { kind: "fail" } : { kind: "text", text };
}

function prepare(raw: string): string | null {
  let s = raw.trim();
  const outside = quoted(s).rest;
  if (outside.includes("。")) {
    if (outside.indexOf("。") !== outside.length - 1) return null;
    s = s.slice(0, -1);
  }
  if (s.endsWith("ください")) s = s.slice(0, -"ください".length);
  else if (s.endsWith("下さい")) s = s.slice(0, -"下さい".length);
  return s;
}

function ending(rest: string): string | null {
  if (rest.endsWith("にして")) return rest.slice(0, -"にして".length);
  if (rest.endsWith("して")) return rest.slice(0, -"して".length);
  return null;
}

export function planUi(text: string): UiPlan {
  const s = prepare(text);
  if (s == null) return { kind: "work" };
  if (s.startsWith(LONG)) {
    const mid = ending(s.slice(LONG.length));
    if (mid == null) return { kind: "work" };
    return classifyLong(mid);
  }
  if (s.startsWith(SHORT)) {
    const mid = ending(s.slice(SHORT.length));
    if (mid == null) return { kind: "work" };
    const color = colorToken(mid);
    return color ? { kind: "color", color } : { kind: "work" };
  }
  return { kind: "work" };
}
