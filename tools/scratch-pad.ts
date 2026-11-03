// 試験の的 app（tools/scratch-pad.swift）を使い捨ての dir に組んで、前に出さずに起こす。owner の home・本物の app の状態には触らない。
// 返す stop() は自分が起こした pid だけを止める。窓は cua-driver の list_windows で題から探す（`find`）。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Driver } from "../src/lease.ts";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ScratchPad</string><key>CFBundleIdentifier</key><string>jp.kangae.scratch-pad</string><key>CFBundleName</key><string>ScratchPad</string><key>CFBundlePackageType</key><string>APPL</string><key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>`;

export function buildScratchPad(dir: string) {
  const app = join(dir, "ScratchPad.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  const sw = Bun.spawnSync(["swiftc", "-O", join(import.meta.dir, "scratch-pad.swift"), "-o", join(app, "Contents/MacOS/ScratchPad")]);
  if (sw.exitCode !== 0) throw new Error("swiftc: " + sw.stderr.toString());
  writeFileSync(join(app, "Contents/Info.plist"), PLIST);
  Bun.spawnSync(["codesign", "--force", "-s", "-", app]);
  return app;
}

export async function launchScratchPad(dir: string, title: string, probe: Driver, extraArgs: string[] = ["--ghost", "--accessory"]) { // 既定 = 透明・Dock に出ない・前にもキーの先にもならない窓（人の打鍵を飲まない・I-5）。見える窓が要る probe だけ [] を明示で渡す
  const app = buildScratchPad(dir);
  Bun.spawnSync(["open", "-g", "-n", "-a", app, "--args", title, ...extraArgs]); // -g = 前に出さない・-n = 毎回新しい process
  let win: { pid: number; window_id: number; title?: string; on_current_space?: boolean; space_ids?: number[]; current_space_id?: number } | undefined;
  for (let i = 0; i < 30 && !win; i++) {
    await Bun.sleep(1000);
    win = ((await probe.call("list_windows", {})).data?.windows as any[] | undefined)?.find((w) => String(w.title ?? "") === title);
  }
  const stop = async () => {
    if (!win) return;
    try { process.kill(win.pid, "SIGTERM"); } catch {}
    await Bun.sleep(800);
    try { process.kill(win.pid, 0); process.kill(win.pid, "SIGKILL"); } catch {}
  };
  return { win, pid: win?.pid ?? 0, stop };
}

// 的の窓の本文（TextArea の value）を AX で読む。UC 3 本が同じ旧版を写していた（holes-3 の診断は 1 本にしか入らず、w8f-1 は理由の無い「読めない」で落ちた）ので 1 関数に寄せる。
// 1 回ごとに 20 秒で諦め（混雑で call が戻らない時に 90 秒の締切を越えて居座らない）・締切は 90 秒・失敗は「要素数・role・窓の Space の原文」を理由にする。
export async function readPadText(probe: Driver, pid: number, windowId: number, ms = 90_000): Promise<string> {
  const t0 = Date.now();
  let last = "(未応答)";
  while (Date.now() - t0 < ms) {
    const r = await Promise.race([probe.call("get_window_state", { pid, window_id: windowId, include_screenshot: false, max_elements: 300, max_depth: 40, timeout_ms: 8000 }), Bun.sleep(20_000).then(() => null)]);
    if (!r) last = "get_window_state が 20 秒返らない";
    else {
      const els = (r.data?.elements as any[] | undefined) ?? [];
      const ta = els.find((e) => /TextArea/.test(String(e.role)));
      if (ta) return String(ta.value ?? "");
      last = `要素 ${els.length} 件・role=[${[...new Set(els.map((e) => String(e.role)))].slice(0, 8).join(",")}]・${JSON.stringify(r).slice(0, 160)}`;
    }
    await Bun.sleep(2000);
  }
  const lw = await probe.call("list_windows", {}).then((x) => (x.data?.windows as any[] | undefined)?.find((w) => w.window_id === windowId) ?? "(list_windows に窓が無い)").catch((e) => String(e));
  throw new Error(`的の窓を読めない: ${last} ｜ 窓: ${JSON.stringify(lw).slice(0, 400)}`); // 窓 = on_current_space・space_ids・is_on_screen の原文（別 Space の窓は要素 0 — W4h）
}
