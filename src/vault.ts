// W8g-4: password を、agent に値を見せずに金庫（Bitwarden の CLI `bw`）から agent 用 Chrome の欄へ入れる（図 §49 の金庫の枝）。
// 鍵 = 人が自分の terminal で `bw unlock` して出た session key を、常駐の環境変数 KANGAE_BW_SESSION（無ければ BW_SESSION）に渡す。master password は受けない。
// 値は bw の stdout → 常駐の変数 → CDP Input.insertText だけを通り、入れたら捨てる。agent・log・out・error 文には出さない（scrub）。
import { type Cdp, cdpConnect, parseTarget, scrub } from "./carry.ts";
import type { Driver } from "./lease.ts";

export type VaultCard = { id: string; owner: string; host: string; at: number };
export const VAULT_MS = 90_000;

type Opts = {
  browserUrl: () => Promise<string | null>;
  bin?: () => string; session?: () => string | undefined; // 試験は偽の bw と偽の鍵
  web?: () => Driver; faces?: (owner: string) => { tabId: number; gen: number }[]; // W8g-4b: 人の Chrome の tab（渡している web の面）。拡張へ値を 1 回だけ送る
  connect?: (browserUrl: string) => Promise<Cdp>;
  onChange?: () => void; approvalMs?: number;
};
type Verdict = "yes" | "no" | "timeout" | "gone";

async function bw(bin: string, session: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== "KANGAE_BW_SESSION" && e[0] !== "BW_SESSION"));
    env.BW_SESSION = session; // 鍵は bw の子にだけ・常駐の env には置かない（review8）
    const p = Bun.spawn([bin, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const t = setTimeout(() => p.kill(9), 15_000);
    const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); // stderr は読んで捨てる（値は出さない）
    clearTimeout(t);
    return { ok: (await p.exited) === 0, out };
  } catch { return { ok: false, out: "" }; }
}

// 欄に focus だけ当てる（値は触らない）。見つかった password 欄の数を返す
const VIS = "[...document.querySelectorAll('input[type=password]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled&&!e.readOnly})";
const COUNT = `(()=>${VIS}.length)()`;
const FOCUS = `(()=>{const v=${VIS};if(v.length!==1)return v.length;v[0].focus();v[0].select();return document.activeElement===v[0]?1:0})()`;
const FILLED = `(()=>{const e=document.activeElement;return e&&e.type==='password'?e.value.length:0})()`;

export function makeVault(opts: Opts) {
  const waits = new Map<string, { card: VaultCard; settle: (v: Verdict) => void }>();
  const pending = new Set<string>();
  const epoch = new Map<string, number>(); // end / endAll のたびに +1。承諾の後（bw を引く間）に取り戻された・全部止めた fill が、後から欄に入れない印（carry と同じ・review14）
  const bump = (o: string) => epoch.set(o, (epoch.get(o) ?? 0) + 1);
  const connect = opts.connect ?? cdpConnect;
  const bin = () => opts.bin?.() ?? process.env.KANGAE_BW ?? "bw";
  let memKey = ""; // `bw unlock --raw | kangae vault-key` で stdin から来た鍵。memory だけ（file・log・env に書かない）。vault-lock で捨てる
  // 常駐の env に鍵があれば memory に移して env から消す（agent・terminal・bw 以外の子 process に継がれない）。bw へは spawn の env で明示して渡す
  const envKey = process.env.KANGAE_BW_SESSION || process.env.BW_SESSION || "";
  delete process.env.KANGAE_BW_SESSION; delete process.env.BW_SESSION;
  const session = () => memKey || (opts.session ? opts.session() : envKey) || "";

  const askHuman = (card: VaultCard) => new Promise<Verdict>((resolve) => {
    const settle = (v: Verdict) => { clearTimeout(t); waits.delete(card.id); opts.onChange?.(); resolve(v); };
    const t = setTimeout(() => settle("timeout"), opts.approvalMs ?? (Number(process.env.KANGAE_CARRY_MS) || VAULT_MS));
    waits.set(card.id, { card, settle });
    opts.onChange?.();
  });

  type Dest = { host: string; recheck: () => Promise<string | null>; put: (secret: string) => Promise<string | null> }; // null = 異常なし。文字は agent に返してよい（値を含めない）
  const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };

  // 人の Chrome の tab: この頼みに渡されている web の面のうち、いまの url が https で host 完全一致・見える password 欄が 1 つの tab。値は拡張へ 1 回だけ（常駐は log に出さない）
  const humanDest = async (owner: string, host: string, kind: "password" | "otp" = "password"): Promise<Dest | null> => {
    if (!opts.web || !opts.faces) return null;
    const web = opts.web();
    for (const f of opts.faces(owner)) {
      const info = (await web.call("tab_info", { tabId: f.tabId })).data as { url?: string } | null;
      if (!info?.url || !/^https:/.test(info.url) || hostOf(info.url) !== host) continue;
      const probe = await web.call("vault_fill", { tabId: f.tabId, host, gen: f.gen, kind });
      if (probe.isError || probe.data?.n !== 1) continue;
      const alive = () => opts.faces!(owner).some((x) => x.tabId === f.tabId && x.gen === f.gen);
      return {
        host,
        recheck: async () => alive() ? null : "取り戻されたので何も入れていません",
        put: async (secret) => {
          if (!alive()) return "取り戻されたので何も入れていません";
          const r = await web.call("vault_fill", { tabId: f.tabId, host, gen: f.gen, kind, value: secret });
          return r.isError || !r.data?.filled ? `入れられませんでした（${scrub(r.text || "拡張が応答しません", [secret, session()]).slice(0, 120)}）。人に入力を頼んでください` : null;
        },
      };
    }
    return null;
  };

  // agent 用 headless Chrome: いま password の欄が 1 つだけ見えている https の tab のうち、実 host が合う物（子 domain は別 site）
  const cdpDest = async (cdp: Cdp, host: string): Promise<Dest | { hint: string }> => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const tabs = (targetInfos as { targetId: string; type: string; url: string }[]).filter((x) => x.type === "page" && /^https:/.test(x.url));
    const cands: { sessionId: string; host: string }[] = [];
    for (const x of tabs) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: x.targetId, flatten: true });
      const n = (await cdp.send("Runtime.evaluate", { expression: COUNT, returnByValue: true }, sessionId)).result?.value;
      if (n === 1) cands.push({ sessionId, host: hostOf(x.url) });
    }
    if (!cands.length) return { hint: "password の欄が 1 つだけ見えている頁が、agent 用ブラウザに見つかりません。何も入れていません" };
    const tab = cands.find((c) => c.host === host);
    if (!tab) return { hint: `いま欄がある頁の site（${cands.map((c) => c.host).join("、")}）と、渡された ${host} が違います。何も入れていません` };
    const ev = async (expression: string) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, tab.sessionId)).result?.value;
    return {
      host: tab.host,
      recheck: async () => null,
      put: async (secret) => {
        if (String(await ev("location.hostname")).toLowerCase() !== tab.host) return "承諾を待つ間に頁が別の site に移ったので、何も入れていません";
        if ((await ev(FOCUS)) !== 1) return "password の欄が見つからなくなりました。何も入れていません";
        await cdp.send("Input.insertText", { text: secret }, tab.sessionId);
        return (await ev(FILLED)) ? null : "欄に入りませんでした（頁が受け付けない）。人に入力を頼んでください";
      },
    };
  };

  return {
    setKey: (k: string) => { const t = k.trim(); if (!t || /\s/.test(t) || t.length > 512) return false; memKey = t; return true; },
    lock: () => { memKey = ""; for (const w of [...waits.values()]) w.settle("gone"); },
    unlocked: () => !!session(),
    cards: () => [...waits.values()].map((w) => w.card),
    // checkbox（金庫から入れる）が on の「進める」だけが承諾。off のまま押したら断りと同じ
    answer: (id: string, yes: boolean, vault = false) => { const w = waits.get(id); if (!w) return false; w.settle(yes && vault === true ? "yes" : "no"); return true; },
    end: (owner: string) => { bump(owner); for (const w of [...waits.values()]) if (w.card.owner === owner) w.settle("gone"); },
    endAll: () => { for (const o of pending) bump(o); for (const w of [...waits.values()]) w.settle("gone"); },

    // W76c: approved = 人が認証 card で allow / always allow を選んだ（その場の承諾が済んでいる）。kind = otp は bw の TOTP（人の Chrome の面にだけ・agent 用ブラウザには入れない）
    // W76d: 登録の時に人へ見せる候補。host に URL が合う項目の id と名前だけ（list は他の値も返すので、ここで捨てる）。値は読まない
    async candidates(host: string): Promise<{ ok: true; items: { id: string; name: string }[] } | { ok: false; hint: string }> {
      const key = session();
      if (!key) return { ok: false, hint: "金庫（Bitwarden）がまだ開かれていません。先に金庫を開いてください" };
      const h = host.toLowerCase();
      const listed = await bw(bin(), key, ["list", "items", "--url", `https://${h}/`]);
      let items: { id: string; name: string }[] = [];
      try {
        items = (JSON.parse(listed.out) as { id?: string; name?: string; login?: { uris?: { uri?: string }[] } }[])
          .filter((i) => i.id && /^[0-9a-z][\w-]*$/i.test(i.id) && (i.login?.uris ?? []).some((u) => hostOf(String(u.uri)) === h))
          .map((i) => ({ id: String(i.id), name: [...String(i.name ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ")].slice(0, 60).join("") }));
      } catch { /* 読めない = 0 件 */ }
      listed.out = "";
      return listed.ok ? { ok: true, items } : { ok: false, hint: "金庫から探せませんでした（金庫が閉じた・bw が動かない）" };
    },
    async fill(owner: string, target: string, o: { approved?: boolean; kind?: "password" | "otp"; itemId?: string } = {}): Promise<{ ok: true; text: string } | { ok: false; hint: string }> {
      const kind = o.kind ?? "password";
      const t = parseTarget(target);
      if (!t) return { ok: false, hint: "login の頁の URL を渡してください（例: kangae vault-fill https://example.com/login）" };
      if (pending.has(owner)) return { ok: false, hint: "この頼みの承諾を、人がまだ答えていません" };
      pending.add(owner);
      const e0 = epoch.get(owner) ?? 0;
      let secret = "";
      try {
        const key = session();
        if (!key) return { ok: false, hint: "金庫（Bitwarden）がまだ開かれていません（人が金庫を開くまで入れられません）。人に「パスワードの入力が要るので、金庫を開いてください」と 1 行で伝えて終えてください" };
        // 入れる先は 2 通り: 人の Chrome の tab（渡している web の面・拡張が入れる）→ 無ければ agent 用 headless Chrome の tab（CDP）。どちらも「tab のいまの実 host」だけを信じ、agent が渡した URL は照合にだけ使う
        let dest = await humanDest(owner, t.host, kind);
        let cdp: Cdp | null = null;
        if (!dest && kind === "otp") return { ok: false, hint: "認証コードを入れられる画面（人の Chrome の渡された tab）が見つかりません。何も入れていません" };
        if (!dest) {
          const browser = await opts.browserUrl();
          if (!browser) return { ok: false, hint: "agent 用のブラウザ（headless Chrome）と、人の Chrome の渡された tab のどちらにも、password の欄が見つかりません" };
          cdp = await connect(browser);
          const r = await cdpDest(cdp, t.host).catch((e) => { cdp!.close(); throw e; });
          if ("hint" in r) { cdp.close(); return { ok: false, hint: r.hint }; }
          dest = r;
        }
        try {
          const tab = dest;
          const card: VaultCard = { id: crypto.randomUUID(), owner, host: tab.host, at: Date.now() };
          const v = o.approved ? "yes" : await askHuman(card);
          if (v !== "yes") return { ok: false, hint: v === "no" ? "人が金庫から入れるのを断りました。人に入力を頼んでください" : v === "timeout" ? "時間内に答えがありませんでした。何も入れていません" : "取り戻されたので何も入れていません" };
          // 項目 = tab の host に URL が合う物が 1 件だけの時だけ（0 件・複数＝曖昧は入れない）。list は他の項目の値も返すので、id と URL 以外はここで捨てる
          const listed = await bw(bin(), key, ["list", "items", "--url", `https://${tab.host}/`]);
          let ids: string[] = [];
          try {
            ids = (JSON.parse(listed.out) as { id?: string; login?: { uris?: { uri?: string }[] } }[])
              .filter((i) => i.id && /^[0-9a-z][\w-]*$/i.test(i.id) && (i.login?.uris ?? []).some((u) => hostOf(String(u.uri)) === tab.host))
              .map((i) => String(i.id));
          } catch { /* 読めない = 0 件 */ }
          listed.out = "";
          if (!listed.ok) return { ok: false, hint: "金庫から探せませんでした（金庫が閉じた・金庫の道具 bw が動かない）。何も入れていません。人に入力を頼んでください" };
          if (o.itemId) ids = ids.includes(o.itemId) ? [o.itemId] : []; // 登録した項目だけ（その host の項目でなくなっていたら入れない）
          if (ids.length !== 1) return { ok: false, hint: ids.length ? `${tab.host} の項目が ${ids.length} 件あり、どれか決められません。何も入れていません。人に入力を頼んでください` : `金庫に ${tab.host} の項目がありません。何も入れていません` };
          const got = await bw(bin(), key, ["get", kind === "otp" ? "totp" : "password", ids[0]!]);
          secret = got.out.replace(/\r?\n$/, "");
          got.out = "";
          if (!got.ok || !secret || (kind === "otp" && !/^\d{6,8}$/.test(secret))) { secret = ""; return { ok: false, hint: `金庫から${kind === "otp" ? "認証コード" : " password "}を取れませんでした。何も入れていません。人に入力を頼んでください` }; }
          if (session() !== key) return { ok: false, hint: "承諾を待つ間に金庫が閉じられたので、何も入れていません" };
          if ((epoch.get(owner) ?? 0) !== e0) return { ok: false, hint: "取り戻されたので何も入れていません" };
          // 承諾を待つ間に頁が動いた・取り戻された かもしれない: 入れる直前にもう一度見て、そのまま入れる
          const bad = (await tab.recheck()) ?? (await tab.put(secret));
          if (bad) return { ok: false, hint: bad };
          return { ok: true, text: `${tab.host} の${kind === "otp" ? "認証コード" : " password "}を金庫から入れました（値は見せていません）。送信は自分で押してください` };
        } finally { cdp?.close(); }
      } catch (e: any) {
        return { ok: false, hint: `入れられませんでした: ${scrub(String(e?.message ?? e), [secret, session()]).slice(0, 160)}` };
      } finally {
        secret = "";
        pending.delete(owner);
      }
    },
  };
}
