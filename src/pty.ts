// デスクトップの terminal 窓の shell。Bun の PTY で起こし、出力は emit で流す。窓を閉じる・口が切れる・shell が終わるで必ず片付ける
export const PTY_LIMIT = 4;

type Pty = { proc: Bun.Subprocess; owner: unknown; tag: unknown };
export type PtyMsg = { type: "pty"; ptyId: number; data?: string; exit?: true };

const clampN = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d);

export function makePtys(emit: (m: PtyMsg) => void) {
  const all = new Map<number, Pty>();
  let next = 1;

  const kill = (p: Pty) => {
    try { p.proc.kill("SIGHUP"); } catch {}
    try { p.proc.terminal?.close(); } catch {}
    setTimeout(() => { if (p.proc.exitCode === null) try { p.proc.kill("SIGKILL"); } catch {} }, 1000).unref();
  };

  return {
    open(owner: unknown, tag: unknown, cwd: string, cols: unknown, rows: unknown) {
      if (all.size >= PTY_LIMIT) return { ok: false as const, hint: `同時に開けるターミナルは ${PTY_LIMIT} つまでです。どれかを閉じてから` };
      const id = next++;
      const dec = new TextDecoder();
      const shell = process.env.SHELL || "/bin/zsh";
      const proc = Bun.spawn([shell, "-l"], {
        cwd,
        env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" },
        terminal: { cols: clampN(cols, 2, 500, 80), rows: clampN(rows, 1, 200, 24), data: (_t, d) => emit({ type: "pty", ptyId: id, data: dec.decode(d, { stream: true }) }) },
      });
      const p = { proc, owner, tag };
      all.set(id, p);
      void proc.exited.then(() => { if (all.get(id) === p) { all.delete(id); emit({ type: "pty", ptyId: id, exit: true }); } });
      return { ok: true as const, ptyId: id, pid: proc.pid };
    },
    write: (id: number, data: unknown) => { const p = all.get(id); if (!p || typeof data !== "string") return false; p.proc.terminal?.write(data); return true; },
    resize: (id: number, cols: unknown, rows: unknown) => { const p = all.get(id); if (!p) return false; p.proc.terminal?.resize(clampN(cols, 2, 500, 80), clampN(rows, 1, 200, 24)); return true; },
    close: (id: number) => { const p = all.get(id); if (!p) return false; all.delete(id); kill(p); return true; },
    // tag を渡せば、その窓の持ち主（sw の port）が持つ物だけ。無ければその口の全部
    dropOwner: (owner: unknown, tag?: unknown) => { for (const [id, p] of all) if (p.owner === owner && (tag === undefined || p.tag === tag)) { all.delete(id); kill(p); } },
    count: () => all.size,
  };
}
