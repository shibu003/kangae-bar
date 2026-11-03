// W76a: 認証で人の手が要る時の card（図 §108・docs/design-auth-handoff.md）。gate（W8b: 認証コード・CAPTCHA・passkey・パスワード欄）が立つと常駐が面ごとに 1 枚作る。
// 持つのは「種類・host（origin か app 名）・時刻」だけ（画面の文字・面の題・値は持たない）。選択肢は種類と登録の状態から決める（押せない選択肢は出さない）。
// 自動認証（allow / always allow）は W76c・「登録する」は W76d が autoReady / canRegister を true にするまで出ない。
export type GateKind = "otp" | "captcha" | "webauthn" | "password" | "other";
export type AuthChoice = "done" | "deny" | "allow" | "always" | "register";
export type AuthOption = { id: AuthChoice; label: string };
export type AuthCard = { id: string; owner: string; key: string; kind: GateKind; reason: string; host: string; at: number; options: AuthOption[]; fronted: number | null; web: boolean }; // web = 人の Chrome の tab の面（自動認証は web の面だけ） // fronted = 人が絵を押して面を前に出した時刻（W76b・人がその面を操作している間）

// humanGate が返す理由の文（lease.ts）から種類を決める。画面の文字は見ない
export const kindOfReason = (reason: string): GateKind =>
  /認証コード/.test(reason) ? "otp" : /CAPTCHA/i.test(reason) ? "captcha" : /passkey|指紋|顔/.test(reason) ? "webauthn" : /パスワード/.test(reason) ? "password" : "other";

// 自動にできるのは password と認証コードだけ（passkey・指紋・CAPTCHA は人の体の確認）。送信・支払いの gate はここに来ない（gate は「入力欄」だけ）ので always を出してよい
export function authOptions(o: { kind: GateKind; registered: boolean; autoReady: boolean; canRegister: boolean }): AuthOption[] {
  const out: AuthOption[] = [{ id: "done", label: "自分でやる（済んだら押す）" }];
  const auto = o.kind === "password" || o.kind === "otp";
  if (auto && o.registered && o.autoReady) out.push({ id: "allow", label: "allow（今回だけ local agent が）" }, { id: "always", label: "always allow（この site は毎回 local agent が）" });
  else if (auto && !o.registered && o.canRegister) out.push({ id: "register", label: "登録する（この site の入力を local agent に任せる）" });
  out.push({ id: "deny", label: "deny（やめる）" });
  return out;
}

export const AUTH_TTL_MS = 30 * 60_000; // 押し忘れで card を残し続けない（gate は次の読みでも立ち直す）
type Deps = { now?: () => number; onChange?: () => void; registered?: (host: string, kind: GateKind) => boolean; autoReady?: () => boolean; canRegister?: () => boolean; ttlMs?: number };

export function makeAuthCards(d: Deps = {}) {
  const now = d.now ?? Date.now;
  const cards = new Map<string, AuthCard>(); // 面の key → card（1 面 1 枚）
  let seq = 0;
  const live = () => { for (const [k, c] of cards) if (now() - c.at > (d.ttlMs ?? AUTH_TTL_MS)) cards.delete(k); };
  // 選択肢は読む時に今の状態（登録・local agent が使えるか）で決め直す（金庫を後で開いた・登録した後でも古いまま出さない）。自動は人の Chrome の tab の面だけ
  const fresh = (c: AuthCard): AuthCard => { c.options = authOptions({ kind: c.kind, registered: d.registered?.(c.host, c.kind) ?? false, autoReady: c.web && (d.autoReady?.() ?? false), canRegister: c.web && (d.canRegister?.() ?? false) }); return c; };
  return {
    // gate が立った時。同じ面に既に在れば足さない（再検出で増やさない）。host は origin か app 名だけ
    add(i: { owner: string; key: string; reason: string; host: string }): AuthCard {
      live();
      const have = cards.get(i.key);
      if (have && have.owner === i.owner) return have;
      const kind = kindOfReason(i.reason);
      const host = i.host.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 120);
      const c: AuthCard = { id: `auth${++seq}-${now().toString(36)}`, owner: i.owner, key: i.key, kind, reason: i.reason, host, at: now(), fronted: null, web: i.key.startsWith("tab:"), options: authOptions({ kind, registered: d.registered?.(host, kind) ?? false, autoReady: d.autoReady?.() ?? false, canRegister: d.canRegister?.() ?? false }) };
      cards.set(i.key, c);
      d.onChange?.();
      return c;
    },
    list(): AuthCard[] { live(); return [...cards.values()].map(fresh); },
    get(id: string): AuthCard | undefined { live(); const c = [...cards.values()].find((x) => x.id === id); return c && fresh(c); },
    // W76b: 人が card の絵を押して面を前に出した。以後その card は「人が操作中」（人にしかできない確認の旗は残る＝agent は書けないまま）
    markFronted(key: string): boolean { live(); const c = cards.get(key); if (!c || c.fronted) return !!c; c.fronted = now(); d.onChange?.(); return true; },
    byKey(key: string): AuthCard | undefined { live(); return cards.get(key); },
    dismissKey(key: string): boolean { const r = cards.delete(key); if (r) d.onChange?.(); return r; },
    dismissOwner(owner: string): number { let n = 0; for (const [k, c] of [...cards]) if (c.owner === owner) { cards.delete(k); n++; } if (n) d.onChange?.(); return n; },
    // 選んだ物が、その card の選択肢に在る時だけ通す（出していない選択肢は押せない）
    take(id: string, choice: unknown): { ok: true; card: AuthCard; choice: AuthChoice } | { ok: false; hint: string } {
      const c = this.get(id);
      if (!c) return { ok: false, hint: "その確認はもう終わっています" };
      const o = c.options.find((x) => x.id === choice);
      if (!o) return { ok: false, hint: "その選択肢は使えません" };
      return { ok: true, card: c, choice: o.id };
    },
  };
}
