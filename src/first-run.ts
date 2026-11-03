// 初めて開いた人に出す「足りない物」の 1 枚（W7a）。何が足りないか（what）と次の一手 1 行（how）。使えない物は勧めない（gemini は個人向けが終了・engine-choice.ts）
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { asideNotices } from "./aside.ts";
import { axReadHelper, axWanted, EXT_STEPS, READER_APP } from "./lease.ts";
import { findClis } from "./llm.ts";
import { spawnSync } from "node:child_process";

export type Refusal = { app: string; why: string }; // 断った webHello: 相手の browser の名前と理由（path・argv は入れない）
export type FirstNeed = { kind: "agent" | "login" | "extension" | "permission" | "update"; what: string; how: string; notice?: true }; // notice = 人が今すぐ何かをする物ではなく知らせ（頭の「あなたの番です」を付けない）
export type FirstInput = {
  clis: readonly string[]; // 入っている AI（claude / codex / gemini）
  claudeLogin: boolean | null; // claude の login（null = 確かめられない）
  extension: "none" | "placed" | "refused" | "connected"; // 拡張: 置いていない / 置いたが Chrome から繋がっていない / 繋がった（webHello した口が居る）
  refused?: Refusal & { at: number }; // extension が refused の時: 最後に断った webHello の理由 1 行と時刻
  ax: boolean | null; // 読み取り .app のアクセシビリティの許可（null = 読み取り .app が無い）
  axWanted?: boolean; // 別の Space の窓を実際に読もうとして、許可が無くて読めなかった（W21: 要らない人・窓を使わない会話に「あなたの番です」を出さない）
};

export function firstRunNeeds(i: FirstInput): FirstNeed[] {
  const out: FirstNeed[] = [];
  const usable = i.clis.filter((c) => c === "claude" || c === "codex"); // gemini だけでは勧めも数えもしない
  if (!usable.length) out.push({ kind: "agent", what: "agent（claude）が入っていません", how: "ターミナルで claude を入れて（https://claude.com/claude-code）、もう一度開いてください" });
  else if (i.clis.includes("claude") && i.claudeLogin === false && !i.clis.includes("codex")) out.push({ kind: "login", what: "claude の login がまだです", how: "ターミナルで claude と打って login してください" });
  if (i.extension === "placed") out.push({ kind: "extension", what: "拡張はまだ Chrome から繋がっていません", how: `${EXT_STEPS}。繋がるとこの案内は消えます。拡張が無くても、この窓だけで話せます` });
  else if (i.extension === "refused") out.push({ kind: "extension", what: `${i.refused!.app} から繋がろうとしましたが、断りました（${i.refused!.why}・${new Date(i.refused!.at).toTimeString().slice(0, 5)}）`, notice: true, how: "いつもの Google Chrome の、いつもの profile で、拡張を読み込み直してください（chrome://extensions の更新ボタン）。繋がるとこの案内は消えます。拡張が無くても、この窓だけで話せます" });
  else if (i.extension === "none") out.push({ kind: "extension", what: "ブラウザの拡張が入っていません", how: `${EXT_STEPS}。拡張が無くても、この窓だけで話せます` });
  if (i.ax === false && i.axWanted) out.push({ kind: "permission", what: `別の Space の窓を読む許可がありません`, how: `システム設定 › プライバシーとセキュリティ › アクセシビリティ で「${READER_APP}」を許可してください（要らない人はそのままで話せます）` });
  return out;
}

// 実際の機械から入力を集める。許可の確認は読み取り .app を前に出さずに 1 回起こす（lease.ts と同じ道・prompt は出さない）
export async function collectFirstRun(home: string, extConnected: boolean, refused: (Refusal & { at: number }) | null = null): Promise<FirstNeed[]> {
  const found = await findClis();
  const clis = found.map((f) => f.cli);
  let claudeLogin: boolean | null = null;
  const c = found.find((f) => f.cli === "claude");
  if (c) {
    const r = spawnSync(c.path, ["auth", "status"], { env: { ...process.env, ...c.env }, timeout: 8000, encoding: "utf8" });
    try { claudeLogin = JSON.parse(r.stdout).loggedIn === true; } catch { claudeLogin = null; }
  }
  const ax = await axReadHelper(1, 0); // pid 1 の窓は無いので、許可があれば found:false・無ければ no-ax-permission
  // 置いた事は入れた事ではない: 繋がった（常駐の webPeers に拡張の口が居る）時だけ消える。専用 Chromium.app は自分で拡張を読ませるので従来どおり数えない
  const extension = extConnected || existsSync(join(home, "Chromium.app")) ? "connected" : existsSync(join(home, "extension")) ? (refused ? "refused" : "placed") : "none";
  return [...asideNotices().map((n): FirstNeed => ({ kind: "update", ...n, notice: true })), ...firstRunNeeds({ clis, claudeLogin, extension, refused: refused ?? undefined, ax: ax ? ax.error !== "no-ax-permission" : null, axWanted: axWanted() })];
}

// 拡張の id は manifest の key（公開鍵）から決まる = 置き場の path が変わっても同じ（Chrome と同じ計算: sha256 の先頭 16 byte を a-p に）
export const extIdOf = (key: string) => [...createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)].map((b) => "abcdefghijklmnop"[b >> 4]! + "abcdefghijklmnop"[b & 15]!).join("");

// host の manifest が指してよい binary は、配る形（.app の中の compiled kangae）だけ。source（bun src/main.ts）や dist の binary を指すと、.app を消した後に Chrome が壊れた path を呼ぶ
export const hostBinaryOf = (execPath: string, compiled: boolean) => (compiled && /\.app\/.+\/kangae$/.test(execPath) ? execPath : null);

// 人が「拡張の置き場を開く」を押した時だけ呼ぶ（W7b）。拡張を home/extension に写し（Chrome の「読み込む」が選ぶ場所・常駐を入れ替えても動かない）、
// 人の Chrome が常駐に繋がるための host の manifest を 1 file だけ書く。Preferences など Chrome の設定 file は書かない。chromeDir は試験で隔離 dir に替える
export function placeExtension(o: { src: string; home: string; chromeDir: string; hostName: string; hostBinary: string; origin: string }) {
  const dest = join(o.home, "extension");
  rmSync(dest, { recursive: true, force: true });
  cpSync(o.src, dest, { recursive: true });
  const host = join(o.chromeDir, "NativeMessagingHosts", `${o.hostName}.json`);
  mkdirSync(dirname(host), { recursive: true });
  writeFileSync(host, JSON.stringify({ name: o.hostName, description: "Kangae", path: o.hostBinary, type: "stdio", allowed_origins: [o.origin] }, null, 2));
  return { dest, host };
}
