// W8g-5: 常駐の socket に繋いだ口が「browser が起こした拡張の native host」かを OS に聞く（webHello は言うだけなら誰でも言える＝
// 同じ user の process が拡張の振りをして、人が承諾した後の金庫の値を受け取れた）。秘密は使わない: 同じ user が file から読める物は秘密ではない。
// 確かめる 3 つ: socket の相手の pid（LOCAL_PEERPID）→ その argv に拡張の origin（Chrome は host を起こす時これを渡す）→ 親の走っている code が決まった browser の
// 署名の主（Team ID と Identifier）で、その --user-data-dir が「無い（人の Chrome）」か「製品の profile」。防げない物は REPORT-w8g.md W8g-5 と W13 に書く。
import { dlopen, FFIType, ptr } from "bun:ffi";
import { realpathSync, statSync } from "node:fs";

let lib: ReturnType<typeof open> | null = null;
const open = () =>
  dlopen("/usr/lib/libSystem.B.dylib", {
    getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    csops: { args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  }).symbols;
const c = () => (lib ??= open());

// unix socket の相手の pid（SOL_LOCAL=0・LOCAL_PEERPID=2）。取れなければ null
export function peerPid(fd: number): number | null {
  const v = new Int32Array(1), l = new Uint32Array([4]);
  return c().getsockopt(fd, 0, 2, ptr(v), ptr(l)) === 0 && v[0]! > 0 ? v[0]! : null;
}

// pid の実行 file（kernel が持つ path）・親の pid（proc_bsdinfo の pbi_ppid＝offset 16）・起動時刻（pbi_start_tvsec / usec＝offset 120 / 128・pid の再利用を見分ける）・argv（KERN_PROCARGS2）
export function proc(pid: number): { path: string; ppid: number; start: number; argv: string[] } | null {
  const b = Buffer.alloc(4096);
  const n = c().proc_pidpath(pid, ptr(b), 4096);
  const info = new Uint32Array(34); // sizeof(struct proc_bsdinfo) = 136
  if (n <= 0 || c().proc_pidinfo(pid, 3, 0n, ptr(info), 136) !== 136) return null;
  const mib = new Int32Array([1, 49, pid]), size = new BigUint64Array([0n]);
  if (c().sysctl(ptr(mib), 3, null, ptr(size), null, 0n) !== 0) return null;
  const a = Buffer.alloc(Number(size[0]));
  if (c().sysctl(ptr(mib), 3, ptr(a), ptr(size), null, 0n) !== 0) return null;
  const argc = a.readInt32LE(0);
  let i = a.indexOf(0, 4); // exec path の終わり
  while (a[i] === 0) i++; // 詰め物
  const argv: string[] = [];
  for (let k = 0; k < argc && i < Number(size[0]); k++) { const e = a.indexOf(0, i); argv.push(a.subarray(i, e).toString()); i = e + 1; }
  return { path: b.subarray(0, n).toString(), ppid: info[4]!, start: (info[30]! + info[31]! * 2 ** 32) * 1e6 + info[32]!, argv };
}

// 走っている process の署名の主（kernel が持つ・有効な署名の時だけ）= "<Team ID>/<Identifier>"。Team の無い署名（ad-hoc・未署名）は null。
// cdhash では比べない（review15）: browser の自動更新は disk の app を差し替え、走っている browser は再起動まで古い code のまま＝cdhash が食い違い、
// 人の Chrome が更新のたびに断られる（Info.plist の版は main の署名に入るので版ごとに cdhash が変わる・Chrome の Versions/ の 2 版で実測）
export function runningSigner(pid: number): string | null {
  const st = new Uint32Array(1);
  if (c().csops(pid, 0, ptr(st), 4n) !== 0 || !(st[0]! & 1)) return null; // CS_OPS_STATUS の CS_VALID
  const str = (op: number) => { const b = Buffer.alloc(264); return c().csops(pid, op, ptr(b), 264n) === 0 ? b.subarray(8).toString().replace(/\0.*$/s, "") : ""; }; // 8 byte の頭の後に文字列
  const team = str(14), id = str(11); // CS_OPS_TEAMID・CS_OPS_IDENTITY
  return team && id ? `${team}/${id}` : null;
}
// 置いてある app の署名の主（codesign が読む）。file が替わったら読み直す。codesign は待つ（混んだ機械で数秒・常駐の他の口を止めない）。
// CODESIGN_MS で打ち切る（固まった codesign で webHello と、それを待つ web の頼みを永久に止めない）。読めなかった（null）は覚えない＝次の口でまた読む（混雑の一度の失敗で browser を永久に断らない）
export const CODESIGN_MS = 30_000;
const disk = new Map<string, { mtime: number; who: Promise<string | null> }>();
export function fileSigner(path: string): Promise<string | null> {
  let mtime: number;
  try { mtime = statSync(path).mtimeMs; } catch { return Promise.resolve(null); }
  const hit = disk.get(path);
  if (hit?.mtime === mtime) return hit.who;
  const p = Bun.spawn(["/usr/bin/codesign", "-dv", path], { stdout: "ignore", stderr: "pipe" });
  const t = setTimeout(() => p.kill(9), CODESIGN_MS);
  const who = new Response(p.stderr).text().then((out) => {
    const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(out)?.[1], id = /^Identifier=(\S+)$/m.exec(out)?.[1];
    return team && id ? `${team}/${id}` : null;
  }, () => null).finally(() => clearTimeout(t));
  disk.set(path, { mtime, who });
  void who.then((w) => { if (w == null && disk.get(path)?.who === who) disk.delete(path); });
  return who;
}

// Chromium の switch の読み方に合わせる: "--" か "-" で始まり、同じ switch は後勝ち、"--" より後は switch でない（review15: 先頭の 1 つだけ見ると -user-data-dir= や 2 つ目で抜けられた）
export function lastSwitch(argv: string[], name: string): string | undefined {
  let v: string | undefined;
  for (const a of argv.slice(1)) {
    if (a === "--") break;
    const m = /^--?([^=]+)(?:=(.*))?$/s.exec(a);
    if (m?.[1] === name) v = m[2] ?? ""; // 値の無い --user-data-dir も後勝ち（空 = 製品の profile ではない）
  }
  return v;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

// 口（相手の pid と起動時刻の組）ごとの答え（W8g-5c）。同じ口の 2 回目は確かめ直さない。pid が再利用されても起動時刻が違えば別の口
export const hostSeen = new Map<string, Promise<{ ok: boolean; why: string; who?: { app: string; why: string }; retry?: true }>>();

// fd の相手が「allow.browsers の browser が、profile 無し か allow.profiles のどれかで起こした、allow.origin 宛ての host」なら ok。why は log 用の 1 行（値は含まない）
type Who = { app: string; why: string };
type Seen = { ok: boolean; why: string; who?: Who; retry?: true };
export async function browserHost(fd: unknown, allow: { browsers: string[]; profiles: string[]; origin: string }): Promise<{ ok: boolean; why: string; who?: Who; cached?: true }> {
  if (typeof fd !== "number") return { ok: false, why: "unix socket の口ではない", who: { app: "別のソフト", why: "拡張の口ではありません" } };
  const pid = peerPid(fd);
  const me = pid ? proc(pid) : null;
  if (!pid || !me) return { ok: false, why: "相手の process が分からない", who: { app: "別のソフト", why: "相手が分かりません" } };
  const key = `${pid}:${me.start}`, seen = hostSeen.get(key);
  if (seen) { const s = await seen; return { ok: s.ok, why: s.why, who: s.who, cached: true }; }
  const r = check(pid, me, allow);
  hostSeen.set(key, r);
  if (hostSeen.size > 256) hostSeen.delete(hostSeen.keys().next().value!); // 拡張は繋ぎ直す度に新しい host（新しい pid）＝古い口から捨てる
  const out = await r;
  if (out.retry) hostSeen.delete(key); // codesign が読めなかった（混雑）は答えにしない＝同じ口がもう一度言えば確かめ直す
  return { ok: out.ok, why: out.why, who: out.who };
}

async function check(pid: number, me: { path: string; ppid: number; argv: string[] }, allow: { browsers: string[]; profiles: string[]; origin: string }): Promise<Seen> {
  if (!me.argv.includes(allow.origin)) return { ok: false, why: `相手 ${pid} は拡張の host として起こされていない（${me.path}）`, who: { app: "別のソフト", why: "拡張の host として起こされた口ではありません" } };
  // 親の code が決まった browser と同じ署名の主か。path では比べない: Chromium は走る間 app を一時 folder の複製（code_sign_clone）から動かすので、
  // 親の実行 file の path は毎回違う（2026-10-08 製品の Chromium で実測）。kernel が持つ署名の主と、置いてある browser の署名の主を比べる
  const pa = proc(me.ppid), who = runningSigner(me.ppid);
  const signed = await Promise.all(allow.browsers.map(fileSigner));
  if (!pa || !who || !signed.includes(who)) return { ok: false, why: `相手 ${pid} の親 ${me.ppid} は決まった browser ではない（${pa?.path ?? "?"}・署名 ${who ?? "無し"}）`, who: { app: /([^/]+)\.app\//.exec(pa?.path ?? "")?.[1] ?? "別の browser", why: "決まった browser ではありません" }, ...(signed.every((h) => h == null) ? { retry: true as const } : {}) };
  const udd = lastSwitch(pa.argv, "user-data-dir");
  if (udd != null && !allow.profiles.map(real).includes(real(udd))) return { ok: false, why: `親 ${me.ppid} の profile が製品の物ではない（${udd.slice(0, 120)}）`, who: { app: /([^/]+)\.app\//.exec(pa.path)?.[1] ?? "別の browser", why: "別の profile です（いつもの profile ではありません）" } };
  return { ok: true, why: "" };
}
