// 人の口（panel / Bar と同じ /ws）から常駐へ 1 件送る試験用の道具。unix socket は agent の口なので、人が押す op（src/main.ts の HUMAN_OPS）はここから送る
import { readFileSync } from "node:fs";

// 送る id は m.id があればそれ（approvalAnswer などは card の id が message の id を兼ねる・返事の id もそれ）
export function humanAsk(barFile: string) {
  const once = (m: Record<string, unknown>): Promise<any> => new Promise((resolve, reject) => {
    const { port, token } = JSON.parse(readFileSync(barFile, "utf8"));
    const id = (m.id as string | undefined) ?? crypto.randomUUID(), ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => ws.send(JSON.stringify({ ...m, id }));
    ws.onmessage = (e) => { const j = JSON.parse(String(e.data)); if (j.id === id) { ws.close(); resolve(j); } }; // id の無い push（roots など）は読み飛ばす
    ws.onerror = () => reject(new Error("人の口（/ws）に繋がりません"));
  });
  // 常駐を起こし直した直後は bar.json が古い・まだ無い（listen の後に書く）。少し待って送り直す
  return async (m: Record<string, unknown>): Promise<any> => { for (let i = 0; ; i++) { try { return await once(m); } catch (e) { if (i >= 20) throw e; await Bun.sleep(250); } } };
}
