// W8e 覗き窓: 渡した面の縮小絵を一望の行へ（撮る）／人が絵を押した時だけ前に出す。図 §50。
// 窓 = cua-driver の get_window_state(include_screenshot)（画面収録の許可を持つ側）を sips で幅 240 の JPEG に縮める。Kangae 自身は ScreenCaptureKit / CGWindowListCreateImage を呼ばない（許可の問い＝前面を取る）。
// tab = 拡張の tab_shot（見えている tab だけ・拡張の中で縮小済み）。撮れない時は絵なしで「絵は出せません: 理由」1 行。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxReader, Driver, Surface } from "./lease.ts";

export const PEEK_GRACE_MS = 3000; // 人が絵を押して前に出した直後の「人が触った」は取り戻しにしない（押したのは人の意思・agent は続ける）
export const PEEK_W = 240;
export const PEEK_BIG_W = 720; // 拡げた時の幅（縮めずに近い絵・native messaging の 1MB に収まる大きさ）
// 撮る間隔: 拡げている間 2 秒・閉じたら 4 秒・一望が見えていない時は撮らない（0）。panel の timer はこれを使う
export const peekEvery = (expanded: boolean, visible: boolean) => (!visible ? 0 : expanded ? 2000 : 4000);
export const PEEK_RETRY_MS = 30_000; // 撮れなかった（許可なし・裏の tab・縮小失敗）行だけ、これを超えたら 1 回撮り直す。撮れた絵は定期に撮り直さない（peek-lite: 変わった時と人が開いた・押した時だけ）
export type Shot = { ok: true; img: string; at: number } | { ok: false; hint: string };
const no = (why: string): Shot => ({ ok: false, hint: `絵は出せません: ${why}` });

// sips は macOS 標準。window の絵は retina の PNG なので縮めてから運ぶ（agent に渡す窓の絵も同じ道: lease.ts の window_image）
export const shrink = (b64: string, w: number) => {
  const dir = mkdtempSync(join(tmpdir(), "kangae-peek-"));
  try {
    writeFileSync(join(dir, "a.png"), Buffer.from(b64, "base64"));
    const r = Bun.spawnSync(["sips", "-Z", String(w), "-s", "format", "jpeg", "-s", "formatOptions", w > PEEK_W ? "60" : "40", join(dir, "a.png"), "--out", join(dir, "a.jpg")]);
    return r.exitCode === 0 ? readFileSync(join(dir, "a.jpg")).toString("base64") : null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

export function makePeek(d: { surface: (key: string) => Surface | undefined; win: () => Driver | null; web: () => Driver; raise: AxReader; read?: AxReader; now?: () => number }) {
  const now = d.now ?? Date.now;
  let cua: Driver | null | undefined;
  const fronted = new Map<string, number>(); // 面の key → 押した時刻
  const last = new Map<string, { sig: string | null; shot: Shot; at: number }>(); // key|幅 → 最後に撮った時の「変わったか」の印と絵（印が null＝文字では変化が読めない面。人が開いた・押した時だけ撮り直す）
  const stat = { shots: 0, skips: 0 };
  // 窓 = AX の木の要約（要素数 + hash・値は持たない）／ tab = 拡張が返す頁の要約の hash。読めない時は null（変化は文字では分からない＝定期には撮らない）
  const h = (t: string) => String(Bun.hash(t));
  const sigOf = async (s: Surface): Promise<string | null> => {
    if ("tabId" in s) { const r = await d.web().call("tab_sig", { tabId: s.tabId }); const g = (r.data as { sig?: string } | null)?.sig; return g ? h(g) : null; }
    const r = await d.read?.(s.pid, s.windowId);
    return r?.elements?.length ? `${r.elements.length}:${h(r.elements.map((e) => `${e.depth}${e.role}${e.label}${e.value}`).join("\n"))}` : null;
  };
  const take = async (s: Surface, w: number): Promise<Shot> => {
    if ("tabId" in s) {
      const r = await d.web().call("tab_shot", { tabId: s.tabId, w });
      const j = (r.data as { jpeg?: string } | null)?.jpeg;
      return j ? { ok: true, img: `data:image/jpeg;base64,${j}`, at: now() } : no(r.text.slice(0, 80) || "拡張が絵を返しませんでした（頁を開き直すと直ることがあります）");
    }
    cua ??= d.win();
    if (!cua) return no("画面を操作する部品（cua-driver）が見つかりません。入れ直してください");
    const r = await cua.call("get_window_state", { pid: s.pid, window_id: s.windowId, include_screenshot: true, max_elements: 1, timeout_ms: 4000 });
    if (!r.img) return no(r.isError ? r.text.slice(0, 80) : "画像が返りませんでした（システム設定の「画面収録」で許可されていないかもしれません）");
    const j = shrink(r.img.data, w);
    return j ? { ok: true, img: `data:image/jpeg;base64,${j}`, at: now() } : no("縮小に失敗しました");
  };
  return {
    stats: () => ({ ...stat }),
    // big = 一望の中で拡げている行（前面は変えない・撮る幅が広いだけ）。visible = panel が見えている（見えていない間は撮らない）。面が渡されていない時も撮らない
    async shot(key: string, visible: boolean, big = false): Promise<Shot> {
      const w = big ? PEEK_BIG_W : PEEK_W;
      if (!visible) return no("一望が見えていません");
      const s = d.surface(key);
      if (!s) { fronted.delete(key); for (const k of last.keys()) if (k.startsWith(`${key}|`)) last.delete(k); return no("その面はもう agent に渡されていません"); }
      const lk = `${key}|${w}`, prev = last.get(lk), sig = await sigOf(s);
      // 撮るのは (1) 初めて・人が拡げた（幅が別＝初めて）・人が押した後（front が印を捨てる） (2) 文字の要約が前回から変わった時だけ。それ以外は前の絵（定期の撮影はしない・peek-lite）
      if (prev && !(sig !== null && sig !== prev.sig) && !(!prev.shot.ok && now() - prev.at >= PEEK_RETRY_MS)) { stat.skips++; return prev.shot; }
      stat.shots++;
      const shot = await take(s, w);
      last.set(lk, { sig, shot, at: now() });
      return shot;
    },
    // 人が絵を押した時だけ呼ぶ。押した時刻を残す（直後の「人が触った」を取り戻しにしないため）
    async front(key: string): Promise<{ ok: boolean; hint?: string }> {
      const s = d.surface(key);
      if (!s) { fronted.delete(key); for (const k of last.keys()) if (k.startsWith(`${key}|`)) last.delete(k); return { ok: false, hint: "その面は渡されていません" }; }
      fronted.set(key, now());
      for (const k of last.keys()) if (k.startsWith(`${key}|`)) last.delete(k); // 人が押した＝次の撮りで 1 回撮り直す（前に出した窓は変わっている）
      if ("tabId" in s) { const r = await d.web().call("tab_front", { tabId: s.tabId }); return r.isError ? { ok: false, hint: r.text.slice(0, 80) } : { ok: true }; }
      const r = await d.raise(s.pid, s.windowId);
      return r?.raised ? { ok: true } : { ok: false, hint: `前に出せませんでした: ${r?.error ?? "窓を操作できません"}` };
    },
    // 人が触った（前面になった）通知が、絵を押した直後の物か
    justFronted: (key: string) => {
      const at = fronted.get(key);
      if (at === undefined) return false;
      if (now() - at < PEEK_GRACE_MS) return true;
      fronted.delete(key); // 猶予を過ぎた印は消す
      return false;
    },
    fronts: () => fronted.size,
    close: () => cua?.close(),
  };
}
