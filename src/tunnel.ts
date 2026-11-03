// Mac から外へ出る cloudflared の quick tunnel（アカウントなし・ポート開放なし・自前の中継なし）。
// 受けた通信は 127.0.0.1 の小さな server に届く。edge が見るのは暗号文だけ（鍵は QR の # の後ろ＝edge に届かない）。
// URL は呼び元へ返すだけで、log には出さない。cloudflared が無い・落ちた時は why を返す（呼び元が LAN に落ちる）。第三者の物を勝手に入れない。
import { existsSync } from "node:fs";

export type TunnelResult = { ok: true; url: string; stop: () => void } | { ok: false; why: string };

// KANGAE_CLOUDFLARED: 試験の差し替え（空 = 無い扱い）
export function findCloudflared(env: Record<string, string | undefined> = process.env): string | null {
  if (env.KANGAE_CLOUDFLARED !== undefined) return env.KANGAE_CLOUDFLARED && existsSync(env.KANGAE_CLOUDFLARED) ? env.KANGAE_CLOUDFLARED : null;
  return ["/usr/local/bin/cloudflared", "/opt/homebrew/bin/cloudflared"].find(existsSync) ?? Bun.which("cloudflared");
}

export async function startTunnel(port: number, onExit: () => void = () => {}, o: { bin?: string | null; timeoutMs?: number; probeMs?: number } = {}): Promise<TunnelResult> {
  const bin = o.bin === undefined ? findCloudflared() : o.bin;
  if (!bin) return { ok: false, why: "cloudflared が入っていません" };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  } catch {
    return { ok: false, why: "cloudflared を起こせませんでした" };
  }
  const stop = () => { try { proc.kill(); } catch {} };
  let found = false;
  const url = await new Promise<string | null>((resolve) => {
    const t = setTimeout(() => resolve(null), o.timeoutMs ?? 30_000);
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      // URL を拾った後も stderr を読み捨てる（読まないと pipe が詰まって cloudflared が止まる）
      for await (const c of proc.stderr as ReadableStream<Uint8Array>) {
        if (found) continue;
        buf = (buf + dec.decode(c)).slice(-4000);
        const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) { found = true; clearTimeout(t); resolve(m[0]); }
      }
      clearTimeout(t);
      resolve(null);
    })().catch(() => resolve(null));
  });
  void proc.exited.then(() => { if (found) onExit(); });
  if (!url) { stop(); return { ok: false, why: "cloudflared から URL が返りませんでした" }; }
  // edge に道が張られるまで数秒かかる。先に DNS（DoH）に名前が出るのを待つ: 出る前に Mac の resolver で引くと「無い」を覚えてしまい、後で本物のスマホ側ではなく Mac 自身が開けなくなる。
  // そのあと Mac から /healthz を 1 回通して、通ってから「出来た」と言う（上限 probeMs・通らなくても URL は返す）
  const until = Date.now() + (o.probeMs ?? 25_000), host = new URL(url).host;
  let named = false;
  while (Date.now() < until) {
    try {
      if (!named) {
        const d = (await (await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(3000) })).json()) as { Answer?: unknown[] };
        named = !!d.Answer?.length;
      }
      if (named) {
        const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
        if (r.ok && (await r.text()) === "kangae") break;
      }
    } catch {}
    await Bun.sleep(750);
  }
  return { ok: true, url, stop };
}
