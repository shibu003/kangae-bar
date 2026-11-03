// W64: Android の「手」。adb の pair・devices・UI tree の読み・tap を型つきで。Android を面（lease）にするのは別の片（ここは手だけ）。
// adb の path と env は deps で差し替える（試験は fake の adb だけ。この Mac では本物の adb server が生きている）。番号・host・座標は log に出さない。
export type AdbRun = { code: number | null; out: string; err: string };
export type AdbDeps = {
  adb: string; env: Record<string, string>; serial?: string;
  spawn?: (argv: string[], o: { env: Record<string, string>; stdin?: string }) => Promise<AdbRun>;
};
export type Res<T> = ({ ok: true } & T) | { ok: false; hint: string };
export type Device = { serial: string; state: string; model?: string; product?: string; device?: string };
export type El = { id: string; text: string; desc: string; bounds: [number, number, number, number] };

const TIMEOUT_MS = 20_000;
const defaultSpawn: NonNullable<AdbDeps["spawn"]> = async (argv, o) => {
  const p = Bun.spawn(argv, { env: o.env, stdin: o.stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (o.stdin !== undefined) { p.stdin!.write(o.stdin); await p.stdin!.end(); }
  const timer = setTimeout(() => p.kill(9), TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  } finally { clearTimeout(timer); }
};
async function adb(d: AdbDeps, args: string[], stdin?: string): Promise<Res<{ run: AdbRun }>> {
  const argv = [d.adb, ...(d.serial ? ["-s", d.serial] : []), ...args];
  try { return { ok: true, run: await (d.spawn ?? defaultSpawn)(argv, { env: d.env, stdin }) }; }
  catch { return { ok: false, hint: "adb を起こせませんでした。adb が入っているか（Android の道具）を確かめてください" }; }
}

const HOSTPORT = /^(\d{1,3})(\.\d{1,3}){3}:(\d{1,5})$/;
const octetsOk = (hp: string) => hp.split(":")[0]!.split(".").every((x) => +x <= 255) && +hp.split(":")[1]! <= 65535 && +hp.split(":")[1]! > 0;
// 番号は stdin で渡す（引数に出すと ps に残る）。返事に「Successfully paired」が在れば ok。hint に番号も host も出さない
export async function adbPair(hostPort: string, code: string, d: AdbDeps): Promise<Res<{}>> {
  if (!HOSTPORT.test(hostPort) || !octetsOk(hostPort)) return { ok: false, hint: "携帯のペア設定の画面に出ている「IP アドレスとポート」の形が違います（例 192.168.1.23:37099）。画面の数字をそのまま写してください" };
  if (!/^\d{6}$/.test(code)) return { ok: false, hint: "ペア設定コードは 6 桁の数字です。携帯の画面に出ている番号を確かめてください" };
  const r = await adb(d, ["pair", hostPort], code + "\n");
  if (!r.ok) return r;
  if (r.run.out.includes("Successfully paired")) return { ok: true };
  return { ok: false, hint: "携帯とつなげませんでした。ペア設定の画面を開いたままか、番号が新しいかを確かめて、もう一度試してください" };
}

export async function adbDevices(d: AdbDeps): Promise<Res<{ devices: Device[] }>> {
  const r = await adb(d, ["devices", "-l"]);
  if (!r.ok) return r;
  if (r.run.code !== 0) return { ok: false, hint: "つながっている携帯を読めませんでした（adb が動いているか確かめてください）" };
  const devices: Device[] = [];
  for (const line of r.run.out.split("\n").slice(1)) {
    const [serial, state, ...rest] = line.trim().split(/\s+/);
    if (!serial || !state) continue;
    const kv = Object.fromEntries(rest.filter((x) => x.includes(":")).map((x) => [x.slice(0, x.indexOf(":")), x.slice(x.indexOf(":") + 1)]));
    devices.push({ serial, state, ...(kv.model ? { model: kv.model } : {}), ...(kv.product ? { product: kv.product } : {}), ...(kv.device ? { device: kv.device } : {}) });
  }
  return { ok: true, devices };
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unesc = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e]!);
// 最小の parser: <node …> の属性だけ。外の library は足さない。bounds が読めない node は捨てる
export function parseUi(xml: string): El[] {
  const els: El[] = [];
  for (const m of xml.matchAll(/<node\b((?:\s+[\w:.-]+="[^"]*")*)\s*\/?>/g)) {
    const a: Record<string, string> = {};
    for (const x of m[1]!.matchAll(/([\w:.-]+)="([^"]*)"/g)) a[x[1]!] = unesc(x[2]!);
    const b = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(a.bounds ?? "");
    if (!b) continue;
    els.push({ id: a["resource-id"] ?? "", text: a.text ?? "", desc: a["content-desc"] ?? "", bounds: [+b[1]!, +b[2]!, +b[3]!, +b[4]!] });
  }
  return els;
}
export async function uiDump(d: AdbDeps): Promise<Res<{ els: El[] }>> {
  let r = await adb(d, ["exec-out", "uiautomator", "dump", "/dev/tty"]);
  if (!r.ok) return r;
  let xml = r.run.out;
  if (!xml.includes("<hierarchy")) { // /dev/tty に出せない機種: file に書いて読む
    const w = await adb(d, ["shell", "uiautomator", "dump", "/sdcard/ui.xml"]);
    if (!w.ok) return w;
    r = await adb(d, ["exec-out", "cat", "/sdcard/ui.xml"]);
    if (!r.ok) return r;
    xml = r.run.out;
  }
  if (!xml.includes("<hierarchy")) return { ok: false, hint: "携帯の画面を読めませんでした（画面が消えていないか・つながっているかを確かめてください）" };
  return { ok: true, els: parseUi(xml.slice(0, xml.lastIndexOf("</hierarchy>") + 12)) };
}

// 条件は全部一致（完全一致）。条件が 1 つも無ければ何も選ばない
export function findEl(els: El[], q: { text?: string; id?: string; desc?: string }): El | undefined {
  if (q.text === undefined && q.id === undefined && q.desc === undefined) return undefined;
  return els.find((e) => (q.text === undefined || e.text === q.text) && (q.id === undefined || e.id === q.id) && (q.desc === undefined || e.desc === q.desc));
}
export async function tap(el: El, d: AdbDeps): Promise<Res<{}>> {
  const [x1, y1, x2, y2] = el.bounds;
  const r = await adb(d, ["shell", "input", "tap", String(Math.floor((x1 + x2) / 2)), String(Math.floor((y1 + y2) / 2))]);
  if (!r.ok) return r;
  return r.run.code === 0 ? { ok: true } : { ok: false, hint: "携帯の画面を押せませんでした（つながっているか確かめてください）" };
}
