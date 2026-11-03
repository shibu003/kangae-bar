// W11b の通し（手で回す: bun test/w11b.e2e.ts）。自作 ScratchPad（--ghost --accessory・同じ app の窓 2 枚 + --menu）に本物の cua-driver で。
// 2 つの会話が 1 つずつ窓を持つ → 窓の書き込みは並行 / menu（cmd+k）は app 単位で順番待ち / clipboard（cmd+c・cmd+x）は機械全体で 1 本。
// 人の clipboard の中身は読まない（cmd+v は使わない・選択が空の cmd+c / cmd+x は何も変えない）。owner の home・app には触らない。
import { mktmp } from "./tmp.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cuaDriver, makeLeases, tokenOf, type Driver } from "../src/lease.ts";
import { launchScratchPad } from "../tools/scratch-pad.ts";

const D = mktmp("kangae-w11b");
const logFile = join(D, "pad.log");
const fails: string[] = [];
const t0 = Date.now();
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const check = (name: string, ok: boolean, detail = "") => { say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) fails.push(name); };
const spans: { id: string; s: number; e: number }[] = [];
const timed = (d: Driver): Driver => ({ call: async (tool, args) => { const s = Date.now(); try { return await d.call(tool, args); } finally { if (tool !== "list_windows" && tool !== "get_window_state") spans.push({ id: `${tool}:${args.window_id}:${(args.keys as string[] | undefined)?.join("+") ?? ""}`, s, e: Date.now() }); } }, close: () => d.close() });
const overlap = (a: { s: number; e: number }, b: { s: number; e: number }) => a.s < b.e && b.s < a.e;

let stop: (() => Promise<void>) | undefined;
try {
  const probe = cuaDriver("w11b-probe");
  if (!probe) throw new Error("cua-driver が無い");
  const pad = await launchScratchPad(D, "W11b-A", probe, ["--ghost", "--accessory", "--second=W11b-B", "--menu", `--log=${logFile}`]);
  stop = pad.stop;
  let winB: any;
  for (let i = 0; i < 20 && !winB; i++) { winB = ((await probe.call("list_windows", {})).data?.windows as any[])?.find((w) => w.title === "W11b-B" && w.pid === pad.pid); if (!winB) await Bun.sleep(500); }
  if (!pad.win || !winB) throw new Error("窓が 2 枚見つからない");
  check("同じ app（pid）の窓が 2 枚ある", pad.win.pid === winB.pid, `pid ${pad.pid} windows ${pad.win.window_id}/${winB.window_id}`);

  const L = makeLeases(join(D, "home"), { driver: (l) => { const d = cuaDriver(l); return d ? timed(d) : null; }, defaultMode: "allow", resourceMs: 8000 });
  const ga = L.give({ pid: pad.pid, windowId: pad.win.window_id, app: "ScratchPad", title: "W11b-A" }, "s:A"), gb = L.give({ pid: pad.pid, windowId: winB.window_id, app: "ScratchPad", title: "W11b-B" }, "s:B");
  if (!ga.ok || !gb.ok) throw new Error("give");
  const a = tokenOf(ga.lease), b = tokenOf(gb.lease);
  const tokenOfText = async (t: string) => { const r = await L.act(t, "get_window_state", {}); return { r, tok: r.ok ? /^(\S+)\tTextArea/m.exec(r.text)?.[1] : undefined }; };
  const [sa, sb] = [await tokenOfText(a), await tokenOfText(b)];
  check("両方の窓の欄が読める", !!sa.tok && !!sb.tok, `${sa.tok} ${sb.tok}`);

  // UC-b1
  spans.length = 0;
  const [ra, rb] = await Promise.all([L.act(a, "set_value", { element_token: sa.tok, value: "aaa" }), L.act(b, "set_value", { element_token: sb.tok, value: "bbb" })]);
  check("UC-b1: 別々の窓への書き込みは両方成功", ra.ok && rb.ok && !(ra as any).isError && !(rb as any).isError, JSON.stringify([ra.ok, rb.ok]));
  const w = spans.filter((x) => x.id.startsWith("set_value"));
  check("UC-b1: 並行（待ち合わせていない）", w.length === 2 && overlap(w[0]!, w[1]!), JSON.stringify(w.map((x) => [x.s - t0, x.e - t0])));
  const ta = await L.act(a, "get_window_state", {}), tb = await L.act(b, "get_window_state", {});
  check("UC-b1: 読み戻すと各窓に各自の値", ta.ok && tb.ok && /aaa/.test(ta.text) && /bbb/.test(tb.text) && !/bbb/.test(ta.text) && !/aaa/.test(tb.text));

  // UC-b2 / b3: 2 つの会話が同時に同じ資源を取りに行く。門の中の driver 呼び出し（span）が重ならない = 順番
  const race = async (keys: string[]) => {
    spans.length = 0;
    const rs = await Promise.all([L.act(a, "hotkey", { keys }), L.act(b, "hotkey", { keys })]);
    return { rs, hs: spans.filter((x) => x.id.startsWith("hotkey")) };
  };
  const m = await race(["cmd", "k"]);
  check("UC-b2: 同じ app の menu（cmd+k）は両方通る", m.rs.every((r) => r.ok), JSON.stringify(m.rs.map((r) => r.ok ? "ok" : (r as any).why)));
  check("UC-b2: menu は app 単位で順番（driver 呼び出しが重ならない）", m.hs.length === 2 && !overlap(m.hs[0]!, m.hs[1]!), JSON.stringify(m.hs.map((x) => [x.s - t0, x.e - t0])));
  const menuLog = (() => { try { return readFileSync(logFile, "utf8"); } catch { return ""; } })();
  say(`参考: app が受けた menu-start ${(menuLog.match(/menu-start/g) ?? []).length} 回（0 なら cua の背景 key は menu の key equivalent に届かない）`);
  const c = await race(["cmd", "c"]);
  check("UC-b3（W46-A）: clipboard（cmd+c）は両方断られ、driver に届かない", c.rs.every((r) => !r.ok) && c.hs.length === 0, JSON.stringify(c.rs.map((r) => r.ok ? "ok" : (r as any).why)));
  L.closeAll();
} catch (e) { check("例外なく通る", false, String(e)); }
finally { await stop?.(); rmSync(D, { recursive: true, force: true }); }
say(fails.length ? `FAIL ${fails.length}: ${fails.join(" / ")}` : "ALL PASS");
process.exit(fails.length ? 1 : 0);
