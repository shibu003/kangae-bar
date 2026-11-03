// W63: 押す操作を人に渡す（契約 = docs/SPEC-press.md §5）。値を落として ed25519 で署名した file に書き出し、読み込む側は署名・環境・card の文を見てから保存する
// 運ぶ道（link・QR・message）はここに無い: file が出入りするだけ
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { dirname, join } from "node:path";
import { readPress, savePress, type Check, type FieldRef, type FieldSpec, type Press, type Requirement, type Stage, type Way } from "./press";
import { resolveRequirements, type EnvDeps } from "./press-env";
import { cardText, checkCardText, clean, maskCard, type Card } from "./press-card";

const NAME = /^[A-Za-z0-9_.-]{1,40}$/; // drafts.ts:7 と同じ
const ID = /^[0-9a-f]{8}$/;
const REQ = /^(chromium-ext|brew|adb|bw|(login|app|cmd):[^\p{Cc}\p{Cf}]{1,200})$/u;
const FILE_MAX = 1024 * 1024;
const num = (n: unknown): number | undefined => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
// 頁の URL の query・fragment は渡す file に載せない（token=… が付く）。clean は制御文字 / 書式文字を落とした後の文に掛ける
const str = (v: unknown, n: number) => clean(clean(v, 2000).replace(/(\bhttps?:\/\/[^\s?#]*)[?#]\S*/gi, "$1"), n);

// ---- 正規化（key を sort・空白なし）と署名の鍵
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
const fpOf = (pubDer: Buffer) => createHash("sha256").update(pubDer).digest("hex").slice(0, 16);
const keyFile = (home: string) => join(home, "press-keys.json");

// 無ければ作る（O_EXCL で 1 人だけ）。壊れていたら作り直さず断る（人の鍵を黙って替えない）
export function loadKeys(home: string): { ok: true; priv: ReturnType<typeof createPrivateKey>; pub: string; fp: string } | { ok: false; hint: string } {
  const f = keyFile(home);
  if (!existsSync(f)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const body = JSON.stringify({ v: 1, priv: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") });
    try { writeFileSync(f, body, { mode: 0o600, flag: "wx" }); } catch (e: any) { if (e?.code !== "EEXIST") return { ok: false, hint: "署名の鍵を作れませんでした" }; }
  }
  try {
    if (statSync(f).mode & 0o077) chmodSync(f, 0o600);
    const j = JSON.parse(readFileSync(f, "utf8"));
    const priv = createPrivateKey({ key: Buffer.from(j.priv, "base64"), format: "der", type: "pkcs8" });
    const pubDer = createPublicKey(priv).export({ type: "spki", format: "der" });
    if (priv.asymmetricKeyType !== "ed25519" || !pubDer.equals(Buffer.from(j.pub, "base64"))) throw new Error("mismatch");
    return { ok: true, priv, pub: pubDer.toString("base64"), fp: fpOf(pubDer) };
  } catch { return { ok: false, hint: `署名の鍵の file（${f}）が壊れています。黙って作り直すと送り手の指紋が変わるので、確かめてから消してください` }; }
}

// ---- 型の絞り込み（書き出す時と、署名を確かめた後の保存の前に同じ物を通す＝知らない key・長すぎる文・形の違う欄は落ちる）
const field = (f: any): FieldSpec | null => {
  if (f && typeof f.fixed === "string") return { fixed: str(f.fixed, 500) };
  if (f && Array.isArray(f.range) && f.range.length === 2 && f.range.every((x: unknown) => typeof x === "string")) return { range: [str(f.range[0], 100), str(f.range[1], 100)] };
  if (f && Array.isArray(f.choice) && f.choice.length <= 50 && f.choice.every((x: unknown) => typeof x === "string")) return { choice: f.choice.map((x: string) => str(x, 200)) };
  if (f && f.ask === true) return { ask: true, ...(typeof f.label === "string" && str(f.label, 60) ? { label: str(f.label, 60) } : {}) };
  return null;
};
const refs = (r: any, drop?: string): Record<string, FieldRef> => {
  const out: Record<string, FieldRef> = {};
  for (const [k, v] of Object.entries(r && typeof r === "object" ? r : {}) as [string, any][]) {
    if (!NAME.test(k) || k === drop) continue;
    if (v && typeof v.field === "string" && NAME.test(v.field)) out[k] = { field: v.field };
    else if (v && typeof v.const === "string") out[k] = { const: str(v.const, 500) }; // maker が card で「固定」にした値だけ
  }
  return out;
};
const way = (w: any): Way | null => {
  if (!w) return null;
  if (w.kind === "act") return { kind: "act", app: str(w.app, 60), tool: str(w.tool, 40), args: refs(w.args, "element_token") };
  if (w.kind === "op") return { kind: "op", app: str(w.app, 60), name: str(w.name, 40), slots: refs(w.slots) };
  if (w.kind === "runCmd") return { kind: "runCmd", name: str(w.name, 40) };
  if (w.kind === "api") return { kind: "api", site: str(w.site, 100), op: str(w.op, 60), params: refs(w.params) };
  if (w.kind === "agent") return { kind: "agent", hint: str(w.hint, 300) };
  return null;
};
const check = (c: any): Check | null => {
  if (!c) return null;
  if (c.kind === "none") return { kind: "none" };
  if (c.kind === "face") return { kind: "face", app: str(c.app, 60), ...(typeof c.titleLike === "string" ? { titleLike: str(c.titleLike, 100) } : {}) };
  if (c.kind === "elements" && Array.isArray(c.names)) return { kind: "elements", names: c.names.slice(0, 20).map((x: unknown) => str(x, 80)) };
  if (c.kind === "cmd-exit0") return { kind: "cmd-exit0", name: str(c.name, 40) };
  if (c.kind === "result") return { kind: "result", like: str(c.like, 100) };
  return null;
};
// element_token は記録の時の面の要素の印＝受け取る人の面では別の要素を指すので書き出さない（受け取った click は門が断り、goal の名前で探し直しに落ちる）
// 値と経歴を落とす: 知らない key（cookie・値）は持ち越さない・runs は 0・madeBy は指紋だけ
export function plain(p: any, fp: string): Press | null {
  if (!p || p.v !== 1 || typeof p.id !== "string" || !ID.test(p.id) || !Array.isArray(p.stages) || p.stages.length > 50 || !p.fields || typeof p.fields !== "object") return null;
  const names = Object.keys(p.fields);
  if (names.length > 20 || names.some((k) => !NAME.test(k))) return null;
  const fields: Record<string, FieldSpec> = {};
  for (const k of names) { const f = field(p.fields[k]); if (!f) return null; fields[k] = f; }
  const stages: Stage[] = [];
  for (const s of p.stages) {
    const w = way(s?.way), post = check(s?.post);
    if (!w || !post || (s.kind !== "env" && s.kind !== "op") || num(s.n) == null) return null;
    const pre = s.pre ? check(s.pre) : undefined;
    stages.push({ n: s.n, kind: s.kind, goal: str(s.goal, 80), ...(Array.isArray(s.requires) ? { requires: s.requires.filter((r: unknown): r is Requirement => typeof r === "string" && REQ.test(r)).slice(0, 10) } : {}), ...(pre ? { pre } : {}), post, way: w });
  }
  const l = p.limits ?? {};
  return {
    v: 1, id: p.id, name: str(p.name, 60) || "名前なし", madeAt: num(p.madeAt) ?? 0, madeBy: { fp },
    fields, stages,
    expect: { result: str(p.expect?.result, 100), ...(typeof p.expect?.state === "string" ? { state: str(p.expect.state, 100) } : {}) },
    onMismatch: p.onMismatch === "skip" || p.onMismatch === "alt" ? p.onMismatch : "ask",
    limits: { ...(num(l.expires) != null ? { expires: num(l.expires) } : {}), ...(num(l.maxRuns) != null ? { maxRuns: num(l.maxRuns) } : {}), ...(num(l.priceMax) != null ? { priceMax: num(l.priceMax) } : {}) },
    ...(Array.isArray(p.alternatives) ? { alternatives: p.alternatives.filter((x: unknown): x is string => typeof x === "string" && ID.test(x)).slice(0, 10) } : {}),
    ...(Array.isArray(p.claims) ? { claims: p.claims.slice(0, 10).map((x: unknown) => str(x, 80)).filter(Boolean) } : {}),
    runs: { total: 0, clean: 0 },
  };
}

// ---- 書き出し
export function exportPress(home: string, id: string, outPath: string): { ok: true; path: string; fp: string } | { ok: false; hint: string } {
  const src = readPress(home, id);
  if (!src) return { ok: false, hint: "その押す操作が見つかりません" };
  const keys = loadKeys(home);
  if (!keys.ok) return keys;
  const press = plain(src, keys.fp);
  if (!press) return { ok: false, hint: "この押す操作は形が合わないので書き出せません" };
  const sig = sign(null, Buffer.from(canonical(press)), keys.priv).toString("base64");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ press, sig, pub: keys.pub }), { mode: 0o600 });
  return { ok: true, path: outPath, fp: keys.fp };
}

// ---- 読み込み: 署名 → 形 → 環境 → card（readShared は保存しない＝人が card を見てから keepShared）。落ちた物は保存しない
export type Shared = { ok: true; press: Press; card: Card; cardOk: boolean; bannedWords: string[]; missing: number } | { ok: false; hint: string };
export function readShared(filePath: string, env: EnvDeps): Shared {
  let j: any;
  let raw: string;
  try { if (statSync(filePath).size > FILE_MAX) return { ok: false, hint: "file が大きすぎます（1MB まで）。送り手に書き出し直してもらってください" }; raw = readFileSync(filePath, "utf8"); } catch { return { ok: false, hint: "その場所に file がありません。場所を確かめて、Finder の「パス名をコピー」で貼り直してください" }; }
  try { j = JSON.parse(raw); } catch { return { ok: false, hint: "押す操作の file ではありません（中身が読めません）。送り手が書き出した .kangae-press.json を選び直してください" }; }
  if (!j || typeof j.sig !== "string" || typeof j.pub !== "string" || !j.press) return { ok: false, hint: "押す操作の file ではありません。送り手が書き出した .kangae-press.json を選び直してください" };
  let fp: string;
  try {
    const pubDer = Buffer.from(j.pub, "base64");
    const pub = createPublicKey({ key: pubDer, format: "der", type: "spki" });
    const sig = Buffer.from(j.sig, "base64");
    if (pub.asymmetricKeyType !== "ed25519" || sig.length !== 64 || !verify(null, Buffer.from(canonical(j.press)), pub, sig)) throw new Error("bad");
    fp = fpOf(pubDer);
  } catch { return { ok: false, hint: "署名が合いません。送り手から渡された後で書き換えられた可能性があるので、保存しませんでした" }; }
  if (j.press?.madeBy?.fp !== fp) return { ok: false, hint: "送り手の指紋が署名の鍵と合いません。保存しませんでした" };
  const press = plain(j.press, fp);
  if (!press) return { ok: false, hint: "押す操作の形が合わないので保存しませんでした" };
  const resolved = resolveRequirements([...new Set(press.stages.flatMap((s) => s.requires ?? []))], env);
  const raw0 = cardText(press, resolved);
  const c = checkCardText(raw0);
  const card = c.ok ? raw0 : maskCard(raw0); // 禁止語は警告を付けて見せるのではなく、主画面の文から伏せる（detail は「詳しく」用にそのまま）
  return { ok: true, press, card, cardOk: c.ok, bannedWords: c.ok ? [] : c.words, missing: resolved.missing.length };
}
// 保存: 同じ id の別人の物を上書きしない（別の id にする）
export function keepShared(home: string, press: Press): Press | null {
  const have = readPress(home, press.id), p = have && have.madeBy?.fp !== press.madeBy?.fp ? { ...press, id: crypto.randomUUID().slice(0, 8) } : have ? { ...press, runs: have.runs } : press; // 同じ送り手の受け取り直しは中身だけ更新・再現率は残す
  return savePress(home, p) ? p : null;
}
export type Imported = Shared;
export function importPress(home: string, filePath: string, env: EnvDeps): Imported {
  const r = readShared(filePath, env);
  if (!r.ok) return r;
  const press = keepShared(home, r.press);
  return press ? { ...r, press } : { ok: false, hint: "保存できませんでした" };
}

// ---- 受領証（値なし）。運ぶ道は作らない: file だけ
export function writeReceipt(home: string, id: string, outPath: string, at = Date.now()): { ok: true; path: string } | { ok: false; hint: string } {
  const p = readPress(home, id);
  if (!p) return { ok: false, hint: "その押す操作が見つかりません" };
  const keys = loadKeys(home);
  if (!keys.ok) return keys;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ pressId: p.id, from: keys.fp, runs: { total: p.runs.total, clean: p.runs.clean }, at }), { mode: 0o600 });
  return { ok: true, path: outPath };
}
