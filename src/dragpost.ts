// W54b: 裏の窓へ pid 宛ての drag の列を送る helper（tools/drag-post.swift）の口。呼べるのは lease の配信（src/lease.ts）だけ・送り先はその会話に貸した窓だけ（pid・窓番号は貸した面から取り、agent の引数は見ない）。
// 起動時の自己確認（--selfcheck）で効かなければ ready が false のまま＝配信しない＝cua の拒否のまま「drag 以外の道 / 下書き」で止まる（本物のポインタの道に落ちない）。
// 実行は owner の許可が出てから（SLEventPostToPid は非公開 API）。設計 docs/design-dragpost.md
import { join } from "node:path";

// 欄の番号は上流 cua の background drag と同じ（mouse.rs:1543-1590・docs/verify/w54/SOURCES.md §2）。tools/drag-post.swift の定数と test が突き合わせる
export const FIELDS = { clickState: 1, buttonNumber: 3, subtype: 7, windowNumber: 51, clickGroup: 58, windowUnderPointer: 91, windowUnderPointerCanHandle: 92, targetPid: 40 } as const;
export type DragReq = { pid: number; windowNumber: number; from: [number, number]; to: [number, number]; steps?: number; durationMs?: number };
export type DragResult = { ok: boolean; text: string; pointerMoved?: boolean };
export type DragPost = { ready(): boolean; init(): Promise<boolean>; send(r: DragReq): Promise<DragResult> };
export type Run = (args: string[], ms: number) => Promise<{ code: number; out: string }>;

export const dragPostBin = (home: string) => join(home, "bin/Kangae Bar 注入.app/Contents/MacOS/KangaeDragPost");
export const SELFCHECK_MS = 8000, SEND_MS = 15000;
const num = (n: number) => String(Math.round(n * 100) / 100);

export function makeDragPost(o: { run: Run }): DragPost {
  let ok = false, broken = false;
  const parse = (out: string): any => { try { return JSON.parse(out.trim().split("\n").at(-1) ?? ""); } catch { return null; } };
  return {
    // 自己確認が通り、かつ本物のポインタを動かした事が無い間だけ true
    ready: () => ok && !broken,
    async init() {
      const r = await o.run(["--selfcheck"], SELFCHECK_MS).catch(() => ({ code: -1, out: "" }));
      const j = parse(r.out);
      ok = r.code === 0 && j?.ok === true;
      return ok;
    },
    async send(q) {
      if (!ok || broken) return { ok: false, text: "pid 宛ての drag は使えません（自己確認が通っていません）" };
      const finite = [q.pid, q.windowNumber, ...q.from, ...q.to].every((n) => Number.isFinite(n));
      if (!finite || !Number.isInteger(q.pid) || !Number.isInteger(q.windowNumber) || q.pid <= 0 || q.windowNumber <= 0) return { ok: false, text: "pid・窓番号・座標が不正です（何も送っていません）" };
      const r = await o.run(["drag", String(q.pid), String(q.windowNumber), num(q.from[0]), num(q.from[1]), num(q.to[0]), num(q.to[1]), String(Math.max(1, Math.min(60, q.steps ?? 20))), String(Math.max(0, Math.min(3000, q.durationMs ?? 500)))], SEND_MS).catch(() => ({ code: -1, out: "" }));
      const j = parse(r.out);
      if (r.code !== 0 || !j) return { ok: false, text: "helper が答えませんでした" };
      const moved = JSON.stringify(j.pointer?.before) !== JSON.stringify(j.pointer?.after);
      if (moved) { broken = true; return { ok: false, pointerMoved: true, text: "drag の間に本物のポインタが動きました（人が動かしたか、この道が使えないかです）。この道は止めます" }; }
      return j.ok === true ? { ok: true, text: "dragged（pid 宛て・窓を前面にせず、本物のポインタは動かしていません）" } : { ok: false, text: String(j.why || "送れませんでした") };
    },
  };
}

// 常駐の起動時の準備（W54c）。.app が無い・試験・KANGAE_NO_DRAGPOST=1 の時は undefined＝今のまま。在れば自己確認を 1 回起動時に走らせる（通るまで ready は false）
export function openDragPost(o: { home: string; env: Record<string, string | undefined>; exists: (p: string) => boolean; runApp: (app: string, args: string[], ms: number) => Promise<{ code: number; out: string }> }): DragPost | undefined {
  if (o.env.NODE_ENV === "test" || o.env.KANGAE_NO_DRAGPOST === "1") return undefined;
  const bin = dragPostBin(o.home);
  if (!o.exists(bin)) return undefined;
  const app = bin.replace(/\/Contents\/MacOS\/.*$/, "");
  const dp = makeDragPost({ run: (args, ms) => o.runApp(app, args, ms) });
  void dp.init();
  return dp;
}
