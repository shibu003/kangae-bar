// api-anything（goodnight000・pin a5dd5a7・~/.kangae/vendor/PATCHES.md）を kangae の下から使う入口（W35）。
// 覚える（add）・通信を撮る（capture）は、承認 card を通らなければ process を起こさない。call（読むだけ）は card 無し。
// login は無い（W35c）: call は人が開いている tab の中で再生する（cookie は Chrome に残り、この Mac の file に写さない）ので、取り込む物が無い。
import { existsSync } from "node:fs";
import { join } from "node:path";

export const LEARN = new Set(["add", "capture"]);
export const VERBS = new Set(["call", "sites", "ops", "login", ...LEARN]);

// `kangae api list` / `list <site>` / `<site> <op> k=v…` / `add|capture|login …` → api-anything の verb と引数
export const apiVerb = (a: string[]): { verb: string; args: string[] } =>
  a[0] === "list" ? (a[1] ? { verb: "ops", args: [a[1]] } : { verb: "sites", args: [] }) : LEARN.has(a[0] ?? "") || a[0] === "login" ? { verb: a[0]!, args: a.slice(1) } : { verb: "call", args: a };

export const cardOf = (verb: string, target: string) => {
  const t = target.replace(/\s+/g, " ").slice(0, 60);
  if (verb === "capture") return { label: `capture ${t}`, what: `「${t}」の通信を撮ります`, note: "見えない browser でそのサイトを開き、出た通信（ログインの情報を含む）を、あなただけが読める形でこの Mac に保存します。あなたの画面には出しません" };
  return { label: `add ${t}`, what: `「${t}」の操作を覚えます`, note: "見えない browser でそのサイトを開き、2 回の手本から通信の操作を覚えます。覚えた物は、あなただけが読める形でこの Mac に保存されます。あなたの画面には出しません" };
};

export type ApiDeps = {
  vendor: string; // ~/.kangae/vendor/api-anything
  dataHome: string; // ~/.kangae/api-anything（API_ANYTHING_HOME）
  ask: (d: ReturnType<typeof cardOf>) => Promise<{ ok: true } | { ok: false; hint: string }>; // 承認 card（人の答え）
  cdpUrl: () => Promise<string | null>; // 製品の headless Chromium（src/headless.ts）
  run: (cmd: string[], env: Record<string, string>) => Promise<{ code: number; out: string }>;
};

export async function runApi(verb: string, args: string[], d: ApiDeps): Promise<{ ok: true; out: string } | { ok: false; hint: string }> {
  if (!VERBS.has(verb)) return { ok: false, hint: `api は ${[...VERBS].join(" / ")} だけです` };
  if (verb === "login") return { ok: true, out: "login は要りません: Chrome でその site を開いて login しておけば、call はその tab の中で動きます（cookie は Chrome に残り、この Mac には写しません）。tab が無い時は call が「開いてください」と返します" };
  if (LEARN.has(verb)) {
    const a = await d.ask(cardOf(verb, args[0] ?? ""));
    if (!a.ok) return a; // 断る・時間切れ・取り戻し: 何も起こさない
  }
  // 読み（call）は人が開いている tab の中で再生する（W35c・browser は起こさない）: tier 1 だけ・書く操作の旗や上限を agent が緩める旗は渡させない（--json だけ）。browser が要るのは覚える時（LEARN）だけ＝製品の headless へ
  if (verb === "call" && args.some((x) => x.startsWith("--") && x !== "--json")) return { ok: false, hint: "call に渡せる旗は --json だけです（書く操作・段の上限は変えられません）" };
  const cdp = LEARN.has(verb) ? await d.cdpUrl() : null;
  const r = await d.run(["node", join(d.vendor, "dist/cli.js"), verb, ...args, ...(verb === "call" ? ["--max-tier", "1"] : [])], { API_ANYTHING_HOME: d.dataHome, ...(cdp ? { API_ANYTHING_CDP_URL: cdp } : {}), ...(verb === "call" ? { API_ANYTHING_TAB: "1" } : {}) });
  if (r.code === 0) return { ok: true, out: r.out };
  return { ok: false, hint: `${r.out.slice(0, 400)}${verb === "call" ? "\n（その操作が無い、または使えません: 今の tab の道で読んでください）" : ""}` };
}

// 頼みの文脈に足す 1 行（vendor が入っている時だけ・claude の頼み）。操作があれば tab を開かず、無ければ今の tab の道
export const apiHint = (bin: string) => `web を読む時は、まず \`${bin} api list\` で操作があるか見て、あれば \`${bin} api <site> <op> k=v\` を使ってください（tab は開きません・画面を奪いません）。無ければ今の tab の道です。`;
export const apiInstalled = (home: string) => existsSync(join(home, "vendor/api-anything/dist/cli.js"));
