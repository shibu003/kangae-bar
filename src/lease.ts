// 束縛表（面 → 持ち主・世代・期限）と操作の門。実験 B（面の識別・世代・期限）と実験 C（unknown は拒否・床が無ければ拒否・世代の正は file）の規則を製品に移した物。
// 面 = app の窓（pid + window_id）か web の tab（tabId + 文書の印 docId）。agent は `kangae act` を通してしか窓に触れず、門が実行の直前に操作権を確かめ、pid・window_id を自分で差し込む。
import { makeAuthCards, type AuthCard, type AuthChoice, type GateKind } from "./authcard.ts";
import { setAside } from "./aside.ts";
import type { DragPost } from "./dragpost.ts";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { shrink } from "./peek.ts";
import { homedir, tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { pollUntil } from "./wait.ts";
import { CLI, argvInside, editorExe, isEditor, loadCmds, outName, overlaps, registerLine, sealOf, startCmd, tailOf } from "./cmds.ts";
import { join } from "node:path";

import { MAX_ITEMS, MAX_PAGES, WEBOP_BUDGET_MS, WEB_OPS, checkParams, nextOf, parseBody, weekOf } from "./webops.ts";
import { APP_OPS, SLOT_MAX, intentGate, scriptGate, shownText, urlGate, type AppOp, type Step } from "./mods.ts";
export type Surface = { pid: number; windowId: number; app: string; title: string } | { tabId: number; docId: string; app: string; title: string; url?: string };
// op = 門が最後に通した「変える操作」の時刻（agent が起こした移動かの判定に使う）。prior = 持ち主を保ったまま上げる前の世代（agent の手元の token はそのまま通る）。note = 次の返事に 1 度だけ添える
// turnAllow = 人が「この頼みの間、この窓に許す」を押した印（図 §35）。その turn が終わる・全停止・取り戻し・世代が変わるのどれかで消える（lease の上にだけ在るので、lease を作り直せば無い）
export type Lease = { surface: Surface; owner: string; gen: number; exp: number; confirmed: boolean; hold?: boolean; waitSince?: number; turnAllow?: boolean; appBatch?: boolean; cap?: "read"; op?: { start: number; end: number | null }; prior?: number[]; note?: string; adopting?: Promise<unknown>; steps?: Step[]; kinds?: Record<string, string>; lastNav?: { type: string; afterEnd: number | null; fromStart: number | null } };
// unknown = 送った後に結果が分からなくなった（時間切れ・driver の切断・読めない error）。実行された可能性がある（W11f / vision §11-F）
// o.ms = この 1 回の呼びの締切（既定 20 秒＝読み取りの呼び）。launch_app のように冷えた app の起動で十数秒〜かかる呼びだけ長くする（W27）。timedOut = 締切で諦めた（driver が理由を返した失敗とは別）
export type Driver = { call(tool: string, args: Record<string, unknown>, o?: { ms?: number }): Promise<{ text: string; isError: boolean; data: any; img?: { data: string; mime: string }; unknown?: boolean; timedOut?: boolean }>; close(): void };
export const APP_LIFE_MS = 30 * 60_000, APP_WAIT_MS = 45_000; // W31a: 起こした GUI の最大寿命・窓が出るまで待つ上限
export { isEditor };
export const LAUNCH_MS = 90_000; // launch_app の締切（8GB の Mac で冷えた Zed の起動は十数秒・混むと 1 分近い）
export type Why = "bad" | "unknown" | "owner" | "gen" | "exp" | "surface" | "tool" | "no-floor" | "busy" | "driver" | "denied" | "timeout" | "off" | "mod" | "result" | "waiting" | "human";
// 承認の表（面の app ごと）。許す = 聞かずに実行 / 先に聞く（既定）= 門が保留して人の答えを待つ / 切る = 読むだけ。読むだけの道具は表に関係なく通る
export type Mode = "allow" | "ask" | "off";
// 別の Space の窓を読むだけの helper（tools/ax-read.swift・普通の AX で読む）。cua-driver は別 Space の窓を自分から拒否する。無ければ null（今までの理由つき拒否になる）
export type AxRead = { found?: boolean; raised?: boolean; error?: string; responsible?: string; app?: string; elements?: { depth: number; role: string; label: string; value: string }[]; truncated?: boolean };
export type AxReader = (pid: number, windowId: number) => Promise<AxRead | null>;
// 許可（アクセシビリティ）を出す相手の名前は 1 つに固定する（bar・Chrome の relay・端末のどれが常駐を起こしても同じ）。LaunchServices 経由で起こす小さな .app（tools/build-reader.sh）に許可が付く
export const READER_APP = "Kangae Bar 読み取り";
let axWantedAt = 0; // 別の Space の窓を読もうとして、アクセシビリティの許可が無くて読めなかった時刻（0 = まだ無い）。最初の画面の「許可」の案内は、これが立った時だけ出す（W21）
export const axWanted = () => axWantedAt > 0;
export const axReadPath = (execPath = process.execPath, env: Record<string, string | undefined> = process.env) => [env.KANGAE_AX_READ, join(dirname(execPath), `${READER_APP}.app`), `${env.HOME}/.kangae/bin/${READER_APP}.app`].find((p) => p && existsSync(p));
const runReader = async (args: string[]): Promise<AxRead | null> => {
  const bin = axReadPath();
  if (!bin) return null;
  const withPath = (r: AxRead): AxRead => ({ ...r, app: bin });
  if (!bin.endsWith(".app")) { // 試験・開発用: 裸の実行 file を直に
    const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "ignore" });
    const t = setTimeout(() => p.kill(), 8000);
    try { return withPath(JSON.parse(await new Response(p.stdout).text())); } catch { return null; } finally { clearTimeout(t); }
  }
  // .app は LaunchServices（open -g = 前に出さない・-n = 毎回新しい process・-W = 終わるまで待つ）で起こす。許可はこの .app に付く。結果は --stdout の file。
  // helper が先に終わると -W が「Unable to block on application」で待たずに戻る事がある（W4h-3 の実測）ので、戻りを当てにせず file に結果が書かれるのを待つ
  const out = join(tmpdir(), `kangae-reader-${process.pid}-${crypto.randomUUID()}.json`);
  const p = Bun.spawn(["open", "-g", "-n", "-W", "--stdout", out, "-a", bin, "--args", ...args], { stdout: "ignore", stderr: "ignore" });
  const t = setTimeout(() => p.kill(), 8000);
  try {
    const got = await pollUntil(() => { try { return JSON.parse(readFileSync(out, "utf8")); } catch { return null; } }, 8000, 50); // 回数でなく 8 秒の締切
    if (got) return withPath(got);
    return { error: "no-reply", app: bin }; // 起こせたが返事の file が読めない（helper が無い事とは別の理由）
  } finally { clearTimeout(t); try { unlinkSync(out); } catch {} }
};
export const axReadHelper: AxReader = (pid, windowId) => runReader([String(pid), String(windowId)]);
// W8e: 人が覗き窓の絵を押した時だけ、その窓を AX で raise して app を前に出す（同じ helper・同じ許可の名前）。{raised:true} か {error}
export const axRaiseHelper: AxReader = (pid, windowId) => runReader([String(pid), String(windowId), "raise"]);
// 窓の絵（window_image）の置き場は会話ごと。agent に渡す Read の許可はこの 1 つだけ（main.ts）＝他の会話の窓の絵は path を知っても Glob / Read できない（review17-2）
export const winDir = (home: string, owner: string) => join(home, "win", owner.replace(/[^A-Za-z0-9_-]/g, "_"));
export const READ_ONLY = ["get_window_state", "scroll", "fetch_url", "render_url", "window_image", "web_op"];
export const APPROVAL_MS = 120_000;
export type Verdict = "yes" | "turn" | "no" | "timeout" | "gone";
// danger = 取り返しがつかないかもしれない操作の card（「この頼みの間」の選択肢を出さない・図 §35）
export type Approval = { id: string; key: string; owner: string; app: string; title: string; tool: string; what: string; at: number; danger?: boolean; unsure?: boolean; note?: string; open?: string }; // open = open_tab の開く先の origin（card の文が別になる）
const DRAG_HINT = "この窓への drag は、macOS では人のポインタを動かさずに送る道がありません（何も送っていません・ポインタを動かす道には落としません）。drag 以外で届けてください: スライダーや数値は set_value、並べ替えは「上へ / 下へ」のボタンかメニュー、範囲の選択はキーボードの shortcut（shift + 矢印）、移動は click の組み合わせ。それでも drag しか道が無い時は、`kangae draft` で人に残して止まってください";
const CROSS_NOTE = "この操作は、今の tab だけでなく同じ site の他の tab や他の端末にも効きます。許してよいか確かめてから押してください";
// 操作の種類（W8a）。read = 読むだけ / write = 書く（承認の表どおり） / destructive = 送信・削除・購入など取り返しがつかないかもしれない・または分からない物（安全側）
// unsure = 押す先が分からない（座標・古い token・名前の無い要素・フォーカス不明の return）。分かっている destructive と同じに（表が「許す」の app でも）聞く。減らすのは agent の文（token で押す）の側
// crossing = 渡した面の外にも効く（ログアウト・アカウント設定・password・連携の解除。vision §11-A）。destructive と同じく毎回 1 回聞く・「この頼みの間」の選択肢は出さない
export type Kind = "read" | "write" | "destructive" | "unsure" | "crossing";
// label は画面の文字で信用できない（F3）ので広めに取る。当たらなくても「押す要素が分からない」は destructive
const DANGER = /送信|削除|購入|投稿|注文|決済|支払|確定|公開|消去|退会|破棄|解約|送る|買う|send|delete|remove|buy|purchase|post|submit|pay|order|publish|confirm|checkout|erase|discard|unsubscribe|cancel subscription/i;
const CROSSING = /ログ ?アウト|サインアウト|ログオフ|アカウント設定|アカウントの設定|アカウント情報|アカウント(を)?(停止|閉鎖|無効)|メールアドレス(の|を)?変更|パスワード(の)?(変更|再設定|リセット)|パスワードを(変更|再設定|リセット)|連携(を)?(解除|削除)|接続(を)?解除|すべての端末|全ての端末|全端末|セキュリティ設定|二段階認証|2 ?段階認証|共有|(?<![a-z])(share|(log|sign)[ _-]?(out|off)|account settings?|manage account|(change|reset|update) (your )?(password|e-?mail)|(deactivate|close) (your |my )?account|disconnect|unlink|revoke|all (devices|sessions)|security settings|two-factor|2fa)(?![a-z])|settings\/(account|security)|account\/(settings|security)/i; // 英語は語境界つき（Dialog outline・Design outline を拾わない）。link の value は URL なので /logout・settings/account も当たる
const CLICKS = ["click", "double_click", "right_click"];
// W78（design-no-cua-cursor.md）: 画素 x,y の click は最後の手段。読んだ木（AX / tab の要素）のどれかがその点を覆っていれば、その要素の element_token（tab なら press_button / fill）で押させる。
// 覆う要素が無い点（canvas・WebGL・AX の無い窓）だけが画素の道に残る（その時も本物のポインタは動かさない・W39）。木を読んでいない時は覆いが分からないので止めない（既存の道）
export const pixelHint = (tool: string, args: Record<string, unknown>, els: Record<string, { role: string; label: string; f?: [number, number, number, number] }> | undefined): string => {
  if (!CLICKS.includes(tool) || args.element_token != null || args.x == null || args.y == null) return "";
  const x = Number(args.x), y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "";
  const hit = Object.entries(els ?? {}).filter(([, e]) => e.f && x >= e.f[0] && x <= e.f[0] + e.f[2] && y >= e.f[1] && y <= e.f[1] + e.f[3]).sort((a, b) => a[1].f![2] * a[1].f![3] - b[1].f![2] * b[1].f![3])[0];
  return hit ? `画素の座標（${Math.round(x)}, ${Math.round(y)}）では押しません。その点には読んだ要素があります: element_token "${hit[0]}"（${hit[1].role.replace("AX", "")}${hit[1].label.trim() ? ` 「${hit[1].label.replace(/\s+/g, " ").slice(0, 30)}」` : ""}）。${tool} は element_token で指してください（web の tab なら名前つき操作 press_button / fill / select_option も）。座標が要るのは、読んだ木に要素が無い所（canvas・描画領域）だけです` : "";
};
// W42c（design-no-fallback.md S5・既定 off の切り替え）: 人が「名前つき操作だけ」にした tab では、名前つき操作（press_button / fill / select_option）で済む相手への生の click / type_text / set_value を断り、その名前つき操作を案内する。
// 名前が 1 つに決まらない・名前の無い要素・他の道具（press_key・hotkey・drag・double / right click）は、名前つき操作で代われないので断らない（行き止まりを作らない）
export const namedHint = (tool: string, args: Record<string, unknown>, el: { role: string; label: string; stale?: boolean; secure?: boolean } | undefined, els: Record<string, { role: string; label: string }> | undefined): string => {
  if (!el || el.stale || el.secure) return ""; // password 欄は fill の対象にしない（review29: 断った先に道が無い）
  const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
  const label = norm(el.label);
  if (!label) return "";
  const same = (role: string) => Object.values(els ?? {}).filter((x) => x.role === role && norm(x.label).toLowerCase() === label.toLowerCase()).length;
  const lead = "この tab は人が「名前つき操作だけ」にしています。生の操作ではなく、見える名前で指す操作を使ってください: ";
  if (tool === "click" && el.role === "button" && same("button") === 1) return `${lead}act press_button ${JSON.stringify(JSON.stringify({ name: label }))}`;
  if ((tool === "type_text" || tool === "set_value") && el.role === "textbox" && same("textbox") === 1) return `${lead}act fill ${JSON.stringify(JSON.stringify({ field: label, value: String(args.text ?? args.value ?? "") }))}（入れる文字は value に）`;
  if (tool === "set_value" && el.role === "select" && same("select") === 1) return `${lead}act select_option ${JSON.stringify(JSON.stringify({ field: label, option: String(args.value ?? "") }))}`;
  return "";
};
export const NAMED = ["fill", "press_button", "select_option"]; // W42b: tab 面の名前つき操作（欄・ボタンを見える名前で指す）
// 拡張を入れる手順 3 つ（最初の画面と、tab を開けなかった agent の頼みで同じ文）
export const EXT_STEPS = "手順: 1. 下の「拡張の置き場を Finder で開く」を押して、extension フォルダを出す 2. Chrome で chrome://extensions を開き、右上の「デベロッパー モード（Developer mode）」をオンにする 3. 「パッケージ化されていない拡張機能を読み込む（Load unpacked）」を押して、1 で開いた extension フォルダを選ぶ。Chrome を開くたびに「デベロッパー モードの拡張機能を無効にしますか」と出ることがありますが、キャンセルで残してください";
export const EXT_HANDOFF = `[[handoff: Chrome に拡張を入れてください（1. Kangae Bar の最初の画面で「拡張の置き場を Finder で開く」を押して extension フォルダを出す 2. Chrome で chrome://extensions を開き、右上の「デベロッパー モード（Developer mode）」をオンにする 3. 「パッケージ化されていない拡張機能を読み込む（Load unpacked）」で、開いた extension フォルダを選ぶ） | chrome://extensions]]`;
// W16b: agent が新しい tab を裏で開く先。読んだ物を載せて外へ出す口にしない（W11e-2）: http(s)・query と # と user:pass 無し・短い。全 URL は承認 card に出す
export const OPEN_MAX = 300;
export const PATH_MAX = 256, SEG_MAX = 64; // W46-C
export const openUrlOf = (raw: unknown): { ok: true; url: URL } | { ok: false; hint: string } => {
  let u: URL;
  try { u = new URL(String(raw ?? "")); } catch { return { ok: false, hint: "open_tab の url は https:// から始まる URL で渡してください。開いていません" }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, hint: "open_tab で開けるのは http(s) の頁だけです。開いていません" };
  if (u.search || u.hash || /[?#]/.test(String(raw)) || u.username || u.password) return { ok: false, hint: "open_tab の url に ?（query）・#・ログイン情報は付けられません（読んだ物を URL に載せて外へ出す道になるため）。path までの URL で開いてください。開いていません" };
  const segs = u.pathname.split("/");
  if (u.pathname.length > PATH_MAX || segs.some((x) => x.length > SEG_MAX)) return { ok: false, hint: `open_tab の path は全体 ${PATH_MAX} 文字・1 区切り ${SEG_MAX} 文字までです（長い path は読んだ物を載せて外へ出す道になるため）。開いていません` };
  if (u.href.length > OPEN_MAX) return { ok: false, hint: `open_tab の url は ${OPEN_MAX} 文字までです。開いていません` };
  return { ok: true, url: u };
};
export const classify = (tool: string, args: Record<string, unknown>, el?: { role: string; label: string; value?: string }): Kind => {
  if (READ_ONLY.includes(tool)) return "read";
  if (CLICKS.includes(tool) || tool === "press_button") {
    if (el && /text(field|area)|textbox|searchfield|combobox/i.test(el.role) && !DANGER.test(el.label) && !CROSSING.test(el.label)) return "write"; // 欄を押して狙うのは名前が無くても無害（押しても何も送らない）
    if (!el || !el.label.trim()) return "unsure";
    if (DANGER.test(el.label) || (/button/i.test(el.role) && DANGER.test(el.value ?? ""))) return "destructive";
    return CROSSING.test(el.label) || (/button|link/i.test(el.role) && CROSSING.test(el.value ?? "")) ? "crossing" : "write";
  }
  // return / 改行は、1 行の欄か button に入れば送信になりうる。複数行の欄（AXTextArea・textarea）の改行は改行でしかない。押す先が分からなければ安全側
  const oneLine = !el || !/textarea/i.test(el.role);
  const enter = (hit: boolean): Kind => (!hit || !oneLine ? "write" : el ? "destructive" : "unsure");
  if (tool === "press_key") return enter(/^(return|enter|kp_enter|numpad_?enter)$/i.test(String(args.key ?? "").trim()));
  if (tool === "hotkey") {
    const k = (Array.isArray(args.keys) ? args.keys : []).map((x) => String(x).toLowerCase());
    return k.some((x) => ["cmd", "command", "ctrl", "control"].includes(x)) && ["return", "enter", "delete", "backspace", "forwarddelete"].includes(k.at(-1) ?? "") ? "destructive" : "write";
  }
  if (tool === "type_text") return enter(/[\r\n]/.test(String(args.text ?? "")));
  return "write";
};
// 資源ごとの排他（W11b / vision §11-B）。agent を丸ごと止めず、競合する操作だけを止める。窓の要素への書き込みは並行（資源なし）・app 共通の menu は app 全体で 1 本・clipboard は機械全体で 1 本。
// 前面入力は門に経路が無い（ALLOWED に無く、delivery_mode は STRIP が捨てる）ので、人と共有する入力経路は今まで通り常に断る
export const RESOURCE_MS = 8000;
const MENU_ROLE = /^(AX)?Menu(Bar)?(Bar)?(Item)?$|^(AX)?MenuBarItem$/;
// 文書の同一（W11b-3）: 別 tab が同じ文書か。origin + path に「id らしき区間（8 字以上で数字を含む）」か id 系の query がある時だけ分かる＝分からない時は undefined（並行のまま・誤って止めない）
export const docKeyOf = (url?: string): string | undefined => {
  let u: URL;
  try { u = new URL(url ?? ""); } catch { return undefined; }
  if (!/^https?:$/.test(u.protocol)) return undefined;
  const seg = u.pathname.split("/").find((x) => /^[A-Za-z0-9_-]{8,}$/.test(x) && /\d/.test(x));
  const q = ["id", "doc", "docid", "document", "file", "fileid", "page", "pageid"].map((n) => [...u.searchParams].find(([k]) => k.toLowerCase() === n)).find((p) => p?.[1]);
  return seg || q ? `doc:${u.origin}${u.pathname}${q ? `?${q[0]}=${q[1]}` : ""}` : undefined;
};
export const resourceOf = (tool: string, args: Record<string, unknown>, s: Surface, el?: { role: string }): string | undefined => {
  if (CLICKS.includes(tool) && "pid" in s && el && MENU_ROLE.test(el.role)) return `menu:${s.pid}`;
  if (tool === "hotkey") {
    const k = (Array.isArray(args.keys) ? args.keys : []).map((x) => String(x).toLowerCase());
    if (!k.some((x) => ["cmd", "command", "ctrl", "control"].includes(x))) return undefined;
    if ("pid" in s) return `menu:${s.pid}`; // cmd+その他は app の menu の key equivalent を押す＝menu と同じ
  }
  if ("tabId" in s && !READ_ONLY.includes(tool)) return docKeyOf(s.url); // 同じ文書の書き換えだけ順番待ち（読むは並行）
  return undefined;
};
// 操作権の 6 欄（W11a / vision §11-A）。人が一望の行を開くと「その面で agent ができる事 / できない事」が読める。判定は門（actNow）が使う定数と関数を読むだけ（新しい規則は足さない）。
// write = 門の表の判定そのもの（試験が実際の act の結果と突き合わせる）。表（Mode）は 面（この窓だけ）> app（人が「この app の全部の窓」と明示）> 既定 の順で効く。どれが効いているかを write の文に出す
export type Rights = { write: "off" | "ask" | "turn" | "allow" | "mod"; rows: [string, string][] };
export type Scope = "surface" | "app" | "default";
export const capOf = (l: Lease, mode: Mode, at: number, scope: Scope = "default"): Rights => {
  const s = l.surface, web = "tabId" in s;
  const write: Rights["write"] = l.cap === "read" ? "mod" : mode === "off" ? "off" : mode === "ask" ? (l.turnAllow ? "turn" : "ask") : "allow";
  const by = { surface: "この窓だけの設定", app: `${s.app} の全部の窓の設定（人が明示）`, default: `既定の設定です（${s.app} の他の窓にも同じ設定が効きます）` }[scope];
  const danger = "送信・削除・購入など取り返しがつかない物と、この tab の外にも効く操作（ログアウト・アカウント設定など）は毎回聞く";
  const w = { mod: "書けない: この mod は「読むだけ」と宣言", off: `書けない: 「${s.app}」は人が「読むだけ」にしている（${by}）`, ask: `書ける: 先に人に聞く（${by}）。${danger}`, turn: `書ける: この頼みの間は聞かずに。${danger}`, allow: `書ける: 聞かずに（${by}）。${danger}` }[write];
  const mins = Math.max(0, Math.ceil((l.exp - at) / 60_000));
  return { write, rows: [
    ["面", web ? `web の tab「${s.title || "無題"}」` : `${s.app} の窓${s.title ? `「${s.title}」` : ""}`],
    ["読める", web ? "この tab の頁と、同じ site の頁だけ（別の site・画面の絵は読みません）" : "この窓の中身だけ（別のデスクトップの窓は読むだけ・他の窓は読みません）"],
    ["書ける", `${w}${l.hold && write !== "off" && write !== "mod" ? "。あなたが離れるまで始めません" : ""}`],
    ["経路", web ? "頁の中身を直接操作します（あなたのマウス・キーボードは使いません）。tab の開閉やアドレスバーは操作できません" : "窓のボタンや欄を直接操作します（あなたのマウス・キーボードは使わず、窓も前に出しません）"],
    ["取り合う物", web ? "この tab と、この文書（別の tab が同じ頁を開いていると分かる時）の書き換え。clipboard はこの Mac に 1 つ（取り合う時だけ順番を待ちます）。文書の同一が分からない時・同じアカウントの別の作業は、見張っていません" : `この窓の中は、他の会話の agent と同時に書けます。${s.app} の menu は app に 1 つ・clipboard はこの Mac に 1 つ（取り合う時だけ順番を待ちます）。${s.app} の他の作業（開いている project など）への影響は見張っていません`],
    ["期限", `この頼みの間（あと ${mins} 分で切れます）・あなたが取り戻すまで。取り戻すか、頁・窓が切り替わると使えなくなります`],
  ] };
};
// element_token → 要素（label を含む）。memory だけ・lease の list / 保存 / 蒸留の steps には出さない
// 戻す記録（W8f）。lease の外の memory だけ・file / list / steps / log に出さない（人の画面の文字を残さない約束 F4 を、戻すまでの短い間だけ緩める）。
// type_text = 何文字・どの要素だけ（文字そのものは持たない）/ set_value = 前の値（直近の snapshot の値・上限 UNDO_VALUE）/ 戻せない物は理由だけ。寿命: turn の終わり・取り戻し・世代が変わる・戻した 1 件ごと
type UndoStep = { tool: string; key?: string; n?: number; before?: string; after?: string; irreversible?: string };
const VIEW_VALUE = 120; // get_window_state が element の値を切る長さ。これに届いた値は切れているので「前の値」には使えない
const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].length; // backspace は 1 文字（絵文字の連なりも 1 つ）ずつ消すので、code point でなく grapheme で数える
export const UNDO_MAX = 20, UNDO_VALUE = 2000;
const undoOf = new WeakMap<Lease, UndoStep[]>();
// 面ごとの順番: act どうしは並んでよい（承認待ちの card が複数在って「この頼みの間」で一緒に通る）が、人の「1 手戻す」は動いている act が全部終わってから 1 本だけ走り、その間に来た act は戻し終わるまで待つ
const undoAt = new WeakMap<Lease, number>(); // 最後に戻す記録を積んだ順（連番。時刻だと同じ ms の 2 面が同点になり、先に作った面が選ばれる）
const sentOf = new WeakMap<Lease, number>(); // 取り戻しの時に driver へ送って返事が来ていない書き換えの数（W11c）
export type Recovery = { key: string; owner: string; app: string; title: string; phase: "stopping" | "reclaimed" | "verifying" | "confirmed" | "unknown"; sent: number; steps: { phase: string; at: number }[] };
// 人にしかできない確認（W8b-2 / 図 §47）: 指紋・passkey・認証コード・CAPTCHA・パスワード欄。見えた面は、人が「続けて」と言うまで書き換えを全部断る（推測で入れない・解かない・回り込まない）。読むだけは通す。理由（種類）だけを持ち、画面の文字は持たない
const humanOf = new WeakMap<Lease, string>();
const GATE_ROLE = /text(field|area)|textbox|searchfield|combobox|button|checkbox|select|link/i;
// 曖昧なら止まる側。web は拡張が gate（otp / captcha / webauthn）を付けて来る。窓は AX の role と label
export const humanGate = (e: { role?: string; label?: string; gate?: string }): string | null => {
  if (e.gate === "otp" || e.gate === "captcha" || e.gate === "webauthn") return ({ otp: "認証コード（SMS や認証アプリの数字）の欄", captcha: "CAPTCHA（人かどうかの確認）", webauthn: "指紋・顔・passkey の確認" } as const)[e.gate];
  const role = String(e.role ?? ""), label = String(e.label ?? "");
  if (/SecureTextField/i.test(role)) return "パスワードの欄";
  if (!GATE_ROLE.test(role)) return null;
  if (/captcha|私はロボットではありません|not a robot|ロボットでは/i.test(label)) return "CAPTCHA（人かどうかの確認）";
  if (/touch ?id|指紋|passkey|パスキー|security key|セキュリティキー|face ?id/i.test(label)) return "指紋・顔・passkey の確認";
  if (/one-?time|認証コード|確認コード|ワンタイム|verification code|security code|2段階認証|二段階認証|SMS コード/i.test(label)) return "認証コード（SMS や認証アプリの数字）の欄";
  return null;
};
const HUMAN_HINT = (why: string) => `止まってください: 画面に人にしかできない確認（${why}）が出ています。入力も押下もしていません。推測で入れる・解く・別の道で回り込むことはしないでください。返事に [[handoff: ${why}を済ませてください | どこで止まったか]] を 1 行書いて止まり、人が「続けて」と言うまで待ってください（続きは画面を読み直してから）`;
const unsureOf = new WeakSet<Lease>(); // 結果不明の後（W11f）: 読む act が 1 回通るまで、その面の書き換えを門が止める
const UNSURE_HINT = "結果不明: 送った後に応答が途切れたので、実行された可能性があります。get_window_state で読み直して確かめてから次を決めてください（同じ操作を繰り返さない・二重になることがあります）";
const focusOf = new WeakMap<object, string>(); // 最後に狙った要素（press_key / type_text は token を取らないので、押す先の推定に使う）
type Sent = { tool: string; token: string; text?: string }; // 送った書き換えの的（W11fix: 照合は的の跡だけを見る）
const inflightOf = new WeakMap<Lease, Sent[]>();
const elementsOf = new WeakMap<object, Record<string, { role: string; label: string; value?: string; stale?: boolean; c?: [number, number]; f?: [number, number, number, number]; secure?: boolean }>>();
// W39: 面ごとの仮想カーソル（座標・押下中のボタン・hover 先）。人の本物のポインタとは無関係＝動かさない。tab は CDP / 拡張、app は pid 宛て。見せる時だけ cua の overlay（window scope のみ）
// W42a S3: 操作の記録（面・世代・操作名・値・結果）。動画も画面写真も証拠にしない。値は 80 字まで・secure な欄への文字は伏せる
export type OpRecord = { at: number; face: string; app: string; gen: number; op: string; value: string; result: string; owner?: string; where?: string }; // owner = 会話（s:N）・where = 面の題（W50: 人の panel が「どの tab / 窓で」を言う）
export type VCursor = { x?: number; y?: number; down?: string; hover?: string };
const cursorOf = new WeakMap<object, VCursor>();
const POINTING = ["click", "double_click", "right_click", "drag", "scroll"];
const frameOf = (e: any): [number, number, number, number] | undefined => { const f = e?.frame ?? e?.bounds; return f && [f.x, f.y, f.width, f.height].every(Number.isFinite) && f.width > 0 && f.height > 0 ? [f.x, f.y, f.width, f.height] : undefined; };
const centerOf = (e: any): [number, number] | undefined => { const f = e?.frame ?? e?.bounds; return f && [f.x, f.y, f.width, f.height].every(Number.isFinite) ? [f.x + f.width / 2, f.y + f.height / 2] : undefined; };
const VERB: Record<string, string> = { click: "押す", double_click: "ダブルクリックする", right_click: "右クリックする", type_text: "文字を入れる", press_key: "キーを押す", hotkey: "ショートカットを押す", set_value: "値を書き換える", drag: "ドラッグする" };
const whatOf = (tool: string, a: Record<string, unknown>) => {
  const v = a.text ?? a.value ?? a.key ?? (Array.isArray(a.keys) ? a.keys.join("+") : undefined);
  const at = v == null && Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y)) && a.x != null && a.y != null ? `（画面の位置 ${Math.round(Number(a.x))}, ${Math.round(Number(a.y))}）` : ""; // 押す先の名前が無い時は、どこを押すかだけでも見せる
  return `${VERB[tool] ?? tool}${v != null ? `「${shownText(v)}」` : at}`;
};

// W60b1: 画面を「ブラウザの窓」として持つ app（cua の窓の面）。tab の面（拡張）と同じ画面になりうる
export const BROWSER_APP = /^(Google Chrome|Chromium|Safari|Arc|Microsoft Edge|Brave Browser|Firefox|Vivaldi|Opera)\b/i;
export const LEASE_MS = 30 * 60_000;
// W11d: 人が見ている面を任された時は、人が離れてから書き換える。待つ間は何も送らず、この時間ごとに「まだ始めていません」を返す（hold は残る＝勝手に始めない）
export const LEAVE_WAIT_MS = 60_000;
// agent 自身の click で起きた移動か（図 §31）。開始が操作の [start, end + NAV_AFTER_MS] に入り、種類が link / form_submit で、
// 修飾（アドレスバー・戻る進む・client redirect）が無い時だけ「agent が起こした」。外れる物・分からない物は全部取り戻す。NAV_AFTER_MS は実測（docs/REPORT-w2f.md）
export const NAV_AFTER_MS = 100;
const AGENT_NAV = ["link", "form_submit"];
// browser 自身の操作（tab の開閉・移動・アドレスバー・終了）は web の面からは送れない。送ると「黙って効かない」になるので門が理由つきで断る
const BROWSER_KEYS = ["t", "w", "n", "l", "q", "r", "d", "h", "m", "j", "y", "tab", "f6", "f5"];
// W46-A: 面と面はクリップボードを使わない（surface.md 境界）。copy / cut / paste の key と menu は、app の面も tab の面も門で断る（代わりは set_value / type_text / fill）
const CLIP_HINT = "クリップボード（コピー・切り取り・貼り付け）は面と面の受け渡しの経路になるので使えません。入れたい文字は type_text / set_value（web の tab は fill）で直接入れてください。何も送っていません";
export const clipKeys = (a: Record<string, unknown>): boolean => {
  const t = new Set<string>();
  for (const k of ["keys", "key", "modifier", "modifiers"]) { const v = a[k]; for (const x of Array.isArray(v) ? v : v == null ? [] : [v]) for (const y of String(x).toLowerCase().split("+")) t.add(y.trim()); }
  const mod = ["cmd", "command", "ctrl", "control", "meta", "super"].some((m) => t.has(m));
  return (mod && ["c", "x", "v"].some((c) => t.has(c))) || (t.has("insert") && (mod || t.has("shift")));
};
export const clipMenu = (role: string, label: string): boolean => MENU_ROLE.test(role) && /^\s*(copy|cut|paste)\b|^\s*(コピー|カット|切り取り|ペースト|貼り付け|貼りつけ)/i.test(label);
export const ALLOWED = ["get_window_state", "click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "set_value", "drag", "fetch_url", "render_url", "open_app", "open_tab", "window_image", "fill", "press_button", "select_option", "web_op"];
// 渡された tab と同じ site の別の頁を、画面に何も増やさずに読む 2 つ（tab も窓も作らない・何も変えない・図 §34）。fetch_url = 人の cookie を乗せて取るだけ / render_url = 見えない面で描いて読む
const READ_URL = ["fetch_url", "render_url"];
// agent が渡しても門が捨てる欄（前面に出す・別の面を狙う・file に書く物）
// 渡す欄は名前で許す物だけ（W11e: 未知の欄・撮影や範囲を変える欄が driver に届かない）。下の STRIP は許す欄の中でも面を指す物を落とす保険
export const PASS = ["element_token", "to_element_token", "text", "value", "key", "keys", "direction", "amount", "by", "x", "y", "from_x", "from_y", "to_x", "to_y", "button", "count", "modifier", "modifiers", "url", "field", "name", "option", "op", "week", "max_elements", "max_depth", "timeout_ms"];
const STRIP = ["tabId", "docId", "pid", "window_id", "session", "target", "scope", "delivery_mode", "debug_image_out", "screenshot_out_file", "capture_id", "from_zoom"];

// tab は tabId だけが鍵（再読み込み・別 site でも tabId は同じ。文書の印 docId は門が毎回見て、変われば世代を上げる）
export const keyOf = (s: Surface) => ("tabId" in s ? `tab:${s.tabId}` : `${s.pid}:${s.windowId}`);
export const tokenOf = (l: Lease) => `${keyOf(l.surface)}|${l.gen}|${l.owner}`;
// 1 つの会話が持てる面の数（W8c）。上げる前に、承認 card の混ざり方と agent の取り違えを測る
export const MAX_FACES = 2;
// agent が面を指す名前（tab / window・同種が複数なら tab2 …）。持っている順
export const faceNames = (ls: Lease[]): Record<string, string> => {
  const n: Record<string, number> = {};
  return Object.fromEntries(ls.map((l) => { const kind = "tabId" in l.surface ? "tab" : "window"; n[kind] = (n[kind] ?? 0) + 1; return [n[kind] === 1 ? kind : `${kind}${n[kind]}`, tokenOf(l)]; }));
};
// `kangae act --on <名前>` の token を env から選ぶ。2 枚持っていて名前が無い・合わない時は実行しない（誤った面に書かない）
export const pickLease = (env: Record<string, string | undefined>, on?: string): { ok: true; token: string } | { ok: false; hint: string } => {
  let faces: Record<string, string> = {};
  try { faces = JSON.parse(env.KANGAE_LEASES ?? "{}"); } catch {}
  const names = Object.keys(faces);
  if (!names.length) return { ok: true, token: env.KANGAE_LEASE ?? "" };
  if (on?.includes("|")) return { ok: true, token: on }; // act open_app で増えた面の token（この turn の env には無い）。門が持ち主・世代を確かめる
  if (on) return Object.hasOwn(faces, on) ? { ok: true, token: faces[on]! } : { ok: false, hint: `「${on}」という面はありません。持っている面: ${names.join(" / ")}` };
  if (names.length === 1) return { ok: true, token: faces[names[0]!]! };
  return { ok: false, hint: `面を 2 枚持っています。どの面かを --on で指してください（${names.map((x) => `--on ${x}`).join(" / ")}）。実行していません` };
};

export const cuaPath = () =>
  process.env.KANGAE_CUA || // 試験用: 本物の driver を包む shim に差し替える（W11f の UC-f1）。無ければ本物
  [`${process.env.HOME}/.local/bin/cua-driver`, "/usr/local/bin/cua-driver", "/opt/homebrew/bin/cua-driver", "/Applications/CuaDriver.app/Contents/MacOS/cua-driver"].find((p) => existsSync(p));

// cua-driver mcp の 1 本の名前付き session（面ごとに 1 本。閉じた label は再利用できない）。call は直列
export function cuaDriver(label: string): Driver | null {
  const bin = cuaPath();
  if (!bin) return null;
  const p = Bun.spawn([bin, "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const waiting = new Map<number, (r: any) => void>();
  let n = 1;
  let buf = "";
  (async () => {
    const dec = new TextDecoder();
    for await (const c of p.stdout) {
      buf += dec.decode(c, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { const j = JSON.parse(l); waiting.get(j.id)?.(j); waiting.delete(j.id); } catch {}
      }
    }
    for (const w of waiting.values()) w({ error: "driver ended" });
    waiting.clear();
  })();
  const send = (o: unknown) => { p.stdin.write(JSON.stringify(o) + "\n"); p.stdin.flush(); };
  const rpc = (method: string, params: unknown, ms = 20_000) =>
    new Promise<any>((resolve) => {
      const id = n++;
      const t = setTimeout(() => { waiting.delete(id); resolve({ error: "timeout" }); }, ms);
      waiting.set(id, (r) => { clearTimeout(t); resolve(r); });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const ready = rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "kangae", version: "1" } }).then(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }));
  let q: Promise<unknown> = ready;
  return {
    call: (tool, args, o) => {
      const run = q.then(async () => {
        const r = await rpc("tools/call", { name: tool, arguments: { ...args, session: label } }, o?.ms);
        const res = r.result;
        if (!res) return { text: r.error === "timeout" ? (tool === "launch_app" ? "app の起動に時間がかかっています（画面の応答が遅い）。開いたか確かめます" : "画面の応答が遅いので諦めました（読むだけの操作なら、もう一度試して構いません）") : String(r.error?.message ?? r.error ?? "driver error"), isError: true, data: null, unknown: !r.error?.message, ...(r.error === "timeout" ? { timedOut: true } : {}) }; // driver が理由つきで断った（error.message 有り）以外は、実行された可能性がある
        const text = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        const im = (res.content ?? []).find((c: any) => c.type === "image"); // W8e: 窓の絵（get_window_state の include_screenshot）。base64 のまま持つ
        return { text, isError: !!res.isError, data: res.structuredContent ?? null, ...(im?.data ? { img: { data: String(im.data), mime: String(im.mimeType ?? "image/png") } } : {}) };
      });
      q = run.catch(() => {});
      return run;
    },
    close: () => { try { send({ jsonrpc: "2.0", id: n++, method: "tools/call", params: { name: "end_session", arguments: { session: label } } }); } catch {} setTimeout(() => p.kill(), 300); },
  };
}

// 前面の app（macOS の lsappinfo front・読むだけ）。起こす前後で比べ、替わったら黙らず知らせる（W31a）。取れなければ null
// W33: `lsappinfo front` は ASN（ASN:0x0-c00c:）しか返さず、`lsappinfo info -only name` はこの機械では何も返さなかった（実測）。`lsappinfo list` の行 `3) "Google Chrome" ASN:0x0-c00c: (in front)` から名前を引く。
// 名前は他人の app が決める文字列＝制御文字を除き 40 字まで（agent への返事・log に出す）。引けなければ ASN のまま（秘密は出ない）
export const appNameIn = (list: string, asn: string): string | null => {
  for (const l of list.split("\n")) { const m = /^\s*\d+\)\s+"([^"]{1,200})"\s+(ASN:\S+)/.exec(l); if (m && m[2] === asn) return m[1]!.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 40) || null; }
  return null;
};
// W60a: 送る直前に人が入っていないかを見る口（窓の面）。前面の app の pid（lsappinfo list の「(in front)」の項の pid）と、人の最後の入力からの秒（ioreg の HIDIdleTime・ns）。取れなければ null＝見えない（送る）
export const frontPidIn = (list: string): number | null => { const m = /\(in front\)[^\n]*\n(?:(?!\n\d+\)).)*?\bpid = (\d+)/s.exec(list); return m ? Number(m[1]) : null; };
export const hidIdleIn = (out: string): number | null => { const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out); return m ? Number(m[1]) / 1e9 : null; };
const run = async (cmd: string[]): Promise<string> => { const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" }); const t = setTimeout(() => p.kill(), 2000); const o = await new Response(p.stdout).text(); clearTimeout(t); return o; };
export const frontPidNow = async (): Promise<number | null> => { try { return frontPidIn(await run(["/usr/bin/lsappinfo", "list"])); } catch { return null; } };
export const hidIdleNow = async (): Promise<number | null> => { try { return hidIdleIn(await run(["/usr/sbin/ioreg", "-c", "IOHIDSystem"])); } catch { return null; } };
export const HUMAN_IDLE_S = 1.5; // 人がこれより最近入力していて、その面が前面なら、送らない（W60a）
const appNameOf = (asn: string): string => { try { const r = Bun.spawnSync(["/usr/bin/lsappinfo", "list"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" }); return (r.exitCode === 0 && appNameIn(r.stdout.toString(), asn)) || asn; } catch { return asn; } };
// 起こす前後の前面を比べた事実の 1 文（W43）。替わった時は注意・同じなら「確かめた」・取れない時は「確かめていない」（測らずに「変えていません」と書かない）
const frontNote = (before: string | null, after: string | null, name: (asn: string) => string) =>
  !before || !after ? "\n前面は確かめられませんでした。人に前面が替わっていないか見てもらってください"
  : before !== after ? `\n注意: 起こした時に前面の app が替わりました（${name(before)} → ${name(after)}）。人に 1 行で伝えてください`
  : "\n前面は起動の直後に確かめて、変わっていません（app が後から自分で前に出ることはあります）";
export function frontApp(): string | null {
  try { const r = Bun.spawnSync(["/usr/bin/lsappinfo", "front"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" }); const t = r.stdout.toString().trim(); return r.exitCode === 0 && t ? t : null; } catch { return null; }
}

type Saved = { floor: Record<string, number>; leases: { surface: Surface; owner: string; exp: number }[]; modes?: Record<string, Mode>; surfaceModes?: Record<string, Mode> };

export function makeLeases(home: string, opts: { driver?: (label: string) => Driver | null; web?: Driver; now?: () => number; onChange?: () => void; onRevoke?: (owner: string) => void | Promise<void>; defaultMode?: Mode; approvalMs?: number; resourceMs?: number; windowMs?: number; appLifeMs?: number; appWaitMs?: number; appStepMs?: number; front?: () => string | null; appName?: (asn: string) => string; launchMs?: number; verifyMs?: number; verifyStepMs?: number; axRead?: AxReader; leaveMs?: number; webReady?: () => boolean; showCursor?: () => boolean; osa?: (script: string) => Promise<{ ok: boolean; text: string }>; ops?: AppOp[]; home?: string; openUrl?: (url: string) => Promise<{ ok: boolean; text: string }>; intent?: (wrapper: string, input: string) => Promise<{ ok: boolean; text: string }>; record?: (e: OpRecord) => void; nameOf?: (owner: string) => string | undefined; frontPid?: () => Promise<number | null>; hidIdle?: () => Promise<number | null>; humanPollMs?: number; scheduled?: (owner: string) => boolean; namedOnly?: () => boolean; openMode?: () => "allow" | "ask"; onOpened?: (o: { owner: string; kind: "tab" | "app"; label: string }) => void; webOpBudgetMs?: number; dragPost?: DragPost; authAuto?: () => boolean; authCanRegister?: () => boolean; authRegistered?: (host: string, kind: GateKind) => boolean; onAuthCard?: (c: AuthCard) => void } = {}) {
  const file = join(home, "leases.json");
  const now = opts.now ?? Date.now;
  const flying = new Map<string, Set<Promise<unknown>>>();
  const undoing = new Map<string, Promise<unknown>>();
  let undoSeq = 0;
  const open = opts.driver ?? cuaDriver;
  // 世代の正は常駐が持つ file の写し（床）。memory の gen は「起動後に確認した」物だけが操作を通す
  let floor: Record<string, number> = {};
  const table = new Map<string, Lease>();
  const drivers = new Map<string, Driver>();
  let seq = 0;
  const modes = new Map<string, Mode>(); // app 単位（人が明示した時だけ・保存済みの物はそのまま効く）
  const surfaceModes = new Map<string, Mode>(); // 面（keyOf）単位。ある窓で「許す」にしても同じ app の別の窓には効かない（W11a-2）
  const modeOf = (s: Surface): [Mode, Scope] => { const k = keyOf(s); return surfaceModes.has(k) ? [surfaceModes.get(k)!, "surface"] : modes.has(s.app) ? [modes.get(s.app)!, "app"] : [modeDefault, "default"]; };
  let modeDefault: Mode = opts.defaultMode ?? "ask";
  const waits = new Map<string, { a: Approval; settle: (v: Verdict) => void }>();
  const auth = makeAuthCards({ now, onChange: opts.onChange, autoReady: opts.authAuto, canRegister: opts.authCanRegister, registered: opts.authRegistered }); // W76a: 認証の card（面ごと 1 枚・種類と host だけ）
  const hostOf = (s: Surface) => { if ("tabId" in s) { try { return s.url ? new URL(s.url).origin : s.app; } catch { return s.app; } } return s.app; }; // 面の題は載せない（頁が決める文字）
  // 頁に残した WebAuthn の印を消して見張りを張り直す（人が済ませた後）
  const rearmGate = (l: Lease) => { if ("tabId" in l.surface) { const tabId = l.surface.tabId; void (async () => { await opts.web?.call("gate_off", { tabId }); await opts.web?.call("gate_on", { tabId }); })().catch(() => {}); } };
  const raiseAuth = (k: string, l: Lease, why: string) => { humanOf.set(l, why); const had = auth.byKey(k); const c = auth.add({ owner: l.owner, key: k, reason: why, host: hostOf(l.surface) }); if (!had) opts.onAuthCard?.(c); }; // 新しく立った時だけ main に知らせる（always allow の自動認証）
  const held = new Map<string, Promise<void>>(); // 資源 → 今使っている操作の終わり
  const gone = new Map<string, Set<() => void>>(); // 面 → 資源の空き待ち（取り戻されたら起こす）
  // 資源を取る。空きを待つ終わり方は askHuman と同じ 3 つ: 空いた / 時間切れ（断る）/ 取り戻された（待ちも消える）
  const hold = async (res: string, k: string, l: Lease): Promise<{ ok: true; release: () => void } | { ok: false; why: Why; hint: string }> => {
    const until = now() + (opts.resourceMs ?? RESOURCE_MS);
    while (held.has(res)) {
      let wake = () => {}, t: ReturnType<typeof setTimeout> | undefined;
      const set = gone.get(k) ?? gone.set(k, new Set()).get(k)!;
      const out = await Promise.race([held.get(res)!.then(() => "free"), new Promise<string>((r) => { wake = () => r("gone"); set.add(wake); }), new Promise<string>((r) => { t = setTimeout(() => r("timeout"), Math.max(0, until - now())); })]);
      clearTimeout(t); set.delete(wake);
      if (out === "gone" || table.get(k) !== l) return { ok: false, why: "gen", hint: "操作権は取り戻されました。止まってください" };
      if (out === "timeout" && held.has(res)) return { ok: false, why: "busy", hint: `${res === "clipboard" ? "clipboard は別の会話が使っています" : res.startsWith("doc:") ? "この文書は別の会話が書いています" : `${l.surface.app} の menu は別の会話が使っています`}（数秒で空きます）。少し待って、もう一度` };
    }
    let release = () => {};
    held.set(res, new Promise<void>((r) => { release = () => { if (held.get(res) === p) held.delete(res); r(); }; }));
    const p = held.get(res)!;
    return { ok: true, release };
  };
  try {
    const s: Saved = JSON.parse(readFileSync(file, "utf8"));
    floor = s.floor ?? {};
    for (const [a, m] of Object.entries(s.modes ?? {})) modes.set(a, m);
    for (const [k, m] of Object.entries(s.surfaceModes ?? {})) if ((s.leases ?? []).some((l) => keyOf(l.surface) === k)) surfaceModes.set(k, m); // 面が無くなった許しは持ち越さない（pid の再利用で別の窓に効かせない）
    for (const l of s.leases ?? []) table.set(keyOf(l.surface), { surface: l.surface, owner: l.owner, gen: floor[keyOf(l.surface)] ?? 0, exp: l.exp, confirmed: false }); // 起こし直した後は分からない
  } catch (e) { if (e instanceof SyntaxError) setAside(file, "窓の操作権の記録"); } // 無い file は新規。JSON でない物は取っておく

  const save = () => {
    const tmp = `${file}.tmp`;
    const s: Saved = { floor, leases: [...table.values()].map((l) => ({ surface: l.surface, owner: l.owner, exp: l.exp })), modes: Object.fromEntries(modes), surfaceModes: Object.fromEntries(surfaceModes) };
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, file);
    opts.onChange?.();
  };
  const drop = (k: string) => { drivers.get(k)?.close(); drivers.delete(k); };
  const driverOf = (l: Lease) => {
    const k = keyOf(l.surface);
    let d = drivers.get(k);
    if (!d) { d = open(`kangae-${process.pid}-${l.gen}-${seq++}`) ?? undefined; if (d) drivers.set(k, d); }
    return d;
  };
  // 人の今（W11d・vision §11-D）。① 前面の app の pid ② 窓が前面にある browser の選択中の tab ③ 最後に入力した面（key だけ・中身は読まない）。seq は「③ が ①② の最後の動きより後か」の順序
  const seen = { front: null as number | null, tab: null as number | null, seq: 0, moved: 0, input: null as { pid?: number; tabId?: number; seq: number } | null };
  const onSurface = (l: Lease) => { const s = l.surface, i = seen.input; return ("tabId" in s ? seen.tab === s.tabId : seen.front === s.pid) || (!!i && i.seq > seen.moved && ("tabId" in s ? i.tabId === s.tabId : i.pid === s.pid)); };
  const overlay = new WeakSet<Lease>();
  const pointTo = (l: Lease, tool: string, a: Record<string, unknown>, el: { label?: string; c?: [number, number] } | undefined, d: Driver): VCursor => {
    const v = cursorOf.get(l) ?? cursorOf.set(l, {}).get(l)!;
    const n = (k: string) => (Number.isFinite(Number(a[k])) && a[k] != null ? Number(a[k]) : undefined);
    const to: [number | undefined, number | undefined] = tool === "drag" ? [n("to_x"), n("to_y")] : el?.c ?? [n("x"), n("y")];
    if (to[0] != null && to[1] != null) { v.x = to[0]; v.y = to[1]; }
    v.hover = el?.label || v.hover;
    if (tool === "drag" || CLICKS.includes(tool)) v.down = tool === "right_click" ? "right" : "left";
    if (opts.showCursor?.() && !("tabId" in l.surface) && onSurface(l) && v.x != null) { // overlay の失敗は操作を止めない
      void (async () => { try { if (!overlay.has(l)) { overlay.add(l); await d.call("set_agent_cursor_enabled", { enabled: true }); } await d.call("move_cursor", { x: v.x, y: v.y, scope: "window" }); } catch {} })();
    }
    return v;
  };
  const stirred = new WeakSet<Lease>(); // hold 中に人が入力した面（W11d の後に古い木で書かせない）
  const leaving = new Map<string, Set<() => void>>();
  const recheck = () => { for (const l of table.values()) if (l.hold && !onSurface(l)) for (const w of [...(leaving.get(keyOf(l.surface)) ?? [])]) w(); };
  // 人が離れる（または時間切れ・取り戻し）まで待つ。true = 離れた
  const waitLeave = (l: Lease, k: string) => new Promise<boolean>((resolve) => {
    const set = leaving.get(k) ?? leaving.set(k, new Set()).get(k)!;
    const done = (v: boolean) => { clearTimeout(t); set.delete(w); if (!set.size) leaving.delete(k); resolve(v); };
    const w = () => done(true);
    const t = setTimeout(() => done(false), opts.leaveMs ?? LEAVE_WAIT_MS);
    set.add(w);
    if (!l.hold || !onSurface(l)) done(true);
  });
  const recov = new Map<string, Recovery>();
  const early = new WeakMap<Recovery, "confirmed" | "unknown">();
  const RECOV_MS = 10 * 60_000;
  const mark = (r: Recovery, phase: Recovery["phase"]) => { r.phase = phase; r.steps.push({ phase, at: now() }); opts.onChange?.(); };
  const facesOf = (owner: string) => [...table.values()].filter((l) => l.owner === owner);
  // W60b1: 面の index（table が 1 面 1 持ち主の正本）。貸す前に空きを見る入口はここ 1 つ。同じ key の持ち主に加えて、同じ画面を別の道で触る重なりも「使っている」と数える:
  // ブラウザの窓（cua・画面の座標）を持つ担当が居る間は、その中の tab（拡張）を別の担当に貸さない・逆も同じ（窓の操作と tab の操作が同じ画面に同時に入る）。返すのは使っている担当（会話）
  const occupant = (surface: Surface, owner: string): string | null => {
    const held = table.get(keyOf(surface));
    if (held && held.owner !== owner) return held.owner;
    const isTab = "tabId" in surface;
    for (const l of table.values()) {
      if (l.owner === owner) continue;
      if (isTab ? !("tabId" in l.surface) && BROWSER_APP.test(l.surface.app) : "tabId" in l.surface && BROWSER_APP.test(surface.app)) return l.owner;
    }
    return null;
  };
  const busyWhy = (o: string) => `その画面は${opts.nameOf?.(o) ? `「${opts.nameOf(o)}」` : "別の担当"}が使っています（同じ画面を 2 つの担当が同時に触らないよう、使い終わるまで貸しません）`;
  // 照合: 取り戻しの後、常駐が driver に get_window_state を 1 回だけ読む（書き換えない）。送っていた操作の的（要素と入れた値）に跡が見える時だけ確認済み（人の操作・前の書き換えで木が変わっても確認済みにしない）。
  // 跡が分からなければ そのまま（返事か切断が来れば 確認済み / 結果不明で終わる）
    // 的の跡: 的の要素が前後の木の両方に見え、type_text は入れた字が増えて入っている・set_value は入れた値になった・他は的の中身が変わった。見つからない・値が読めない・跡が無いなら false（結果不明のまま）
  const traced = (x: Sent, before: Record<string, { role: string; label: string; value?: string }>, els: { element_token?: unknown; role?: unknown; label?: unknown; value?: unknown }[]) => {
    const b = before[x.token];
    if (!b) return false;
    const lab = (e: { label?: unknown }) => String(e.label ?? "").slice(0, 120);
    const a = els.find((e) => String(e.element_token) === x.token && String(e.role) === b.role && lab(e) === b.label) ?? els.find((e) => String(e.role) === b.role && lab(e) === b.label);
    if (!a) return false;
    const av = a.value == null ? undefined : String(a.value).slice(0, 120);
    if (x.tool === "type_text") return av !== undefined && av !== b.value && av.includes(x.text!.slice(-40)) && (av.length > (b.value ?? "").length);
    if (x.tool === "set_value") return av !== undefined && av !== b.value && av === x.text!.slice(0, 120);
    return av !== b.value;
  };
  const verify = async (rec: Recovery, l: Lease, snap: ReturnType<typeof elementsOf.get>, sent: Sent[]) => {
    const cur = l.surface;
    const web = "tabId" in cur;
    const d = web ? opts.web : open(`kangae-verify-${process.pid}-${seq++}`);
    try {
      const r = await d?.call("get_window_state", { include_screenshot: false, max_elements: 300, max_depth: 40, timeout_ms: 4000, ...(web ? { tabId: cur.tabId, docId: cur.docId } : { pid: cur.pid, window_id: cur.windowId }) });
      const els = r?.data?.elements as { element_token?: unknown; role?: unknown; label?: unknown; value?: unknown }[] | undefined;
      if (rec.phase === "verifying" && snap && els?.length && sent.length && sent.every((x) => traced(x, snap, els))) mark(rec, "confirmed");
    } catch { /* 読めなければ跡は分からない */ } finally { if (!web) d?.close(); }
  };
  // 世代を上げて持ち主を外す（古い操作権はもう通らない）。agent も止める
  const revoke = (k: string) => {
    const l = table.get(k);
    if (!l) return null;
    floor[k] = Math.max(floor[k] ?? 0, l.gen) + 1;
    running.get(l.owner)?.(); // 面が取り戻されたら、その持ち主の command も止める（W17a）
    killAppsOf((a) => a.key === k); // その面の app も止める（W31a）
    table.delete(k); // 戻す記録は lease に付いているので、lease と一緒に消える
    auth.dismissKey(k);
    if ("tabId" in l.surface) void Promise.resolve(opts.web?.call("gate_off", { tabId: l.surface.tabId, minGen: floor[k] })).catch(() => {}); // WebAuthn の見張りを元の関数に戻す + 拡張へ下限の世代（W11c-3: 渡った act が実行の直前に断られる）
    for (const w of [...(leaving.get(k) ?? [])]) w(); // 離れるのを待っていた act は起こして「取り戻された」にする
    drop(k);
    for (const w of [...waits.values()]) if (w.a.key === k) w.settle("gone"); // 承認待ちの操作も実行しない
    for (const f of [...(gone.get(k) ?? [])]) f(); // 資源の空き待ちも消える
    save();
    // W11c: 何が起きたかを残す。停止要求中 → 回収済み（承認待ちの続きが走り終えた後）→ 送った物があれば 結果を確認中（図 §54）
    for (const [rk, x] of recov) if (x.steps[0]!.at < now() - RECOV_MS) recov.delete(rk);
    const rec: Recovery = { key: k, owner: l.owner, app: l.surface.app, title: l.surface.title, phase: "stopping", sent: sentOf.get(l) ?? 0, steps: [{ phase: "stopping", at: now() }] };
    recov.set(k, rec);
    // 停止要求中 = agent に止まれと言ってから、止まったと分かるまで（onRevoke が返す Promise・本物の時間）。止まったら 回収済み
    const snap = elementsOf.get(l);
    const stopped = facesOf(l.owner).length ? Promise.resolve() : Promise.resolve(opts.onRevoke?.(l.owner)).catch(() => {}); // もう 1 枚残る間は agent を止めない（取り戻した面の act だけが「取り戻されました」になる）
    void stopped.then(() => { mark(rec, "reclaimed"); if (rec.sent) { mark(rec, "verifying"); const e = early.get(rec); if (e) mark(rec, e); else void verify(rec, l, snap, [...(inflightOf.get(l) ?? [])]); } });
    return l;
  };
  // 承認を人に聞いて、答え（時間切れは断ると同じ）を待つ
  const askHuman = (l: Lease, tool: string, args: Record<string, unknown>, d?: { label: string; unsure: boolean; note?: string; what?: string; open?: string }) =>
    new Promise<Verdict>((resolve) => {
      const id = crypto.randomUUID();
      const settle = (v: Verdict) => { clearTimeout(t); waits.delete(id); opts.onChange?.(); resolve(v); };
      const t = setTimeout(() => settle("timeout"), opts.approvalMs ?? APPROVAL_MS);
      waits.set(id, { a: { id, key: keyOf(l.surface), owner: l.owner, app: l.surface.app, title: l.surface.title, tool, what: d ? (d.what ?? (d.open ? `新しい tab で ${d.open} を開きます` : d.unsure ? whatOf(tool, args) : `「${d.label.replace(/\s+/g, " ").slice(0, 40)}」を${VERB[tool] ?? tool}`)) : whatOf(tool, args), at: now(), ...(d ? { danger: true, ...(d.unsure ? { unsure: true } : {}), ...(d.note ? { note: d.note } : {}), ...(d.open ? { open: d.open } : {}) } : {}) }, settle });
      opts.onChange?.();
    });

  // 人の答えが「実行しない」側か（実行の直前に毎回: 断る・時間切れ・全停止・取り戻し・期限）。null = 続けてよい
  const freeAsk = new WeakSet<Lease>(); // W23: 面をまだ持たない会話が最初に app を開く時の「聞く側」の印（表には入らない仮の lease）。取り戻し・世代の確認は要らない（承認待ちの間に turn が終わる・全停止は waits の "gone" で止まる）
  const refused = (v: Verdict, l: Lease, k: string, gen: number, done = "実行していません"): { ok: false; why: Why; hint: string } | null => {
    if (v === "no") return { ok: false, why: "denied", hint: `人が断りました（${done}）。同じ操作を繰り返さず、何をしたかったかを人に 1 行で伝え、次にどうするか聞いてください` };
    if (v === "timeout") return { ok: false, why: "timeout", hint: `人が時間内に答えなかったので、${done}（断ると同じ）。人に声をかけ、もう一度頼んでよいか聞いてください` };
    if (v === "gone" || (!freeAsk.has(l) && (table.get(k) !== l || (l.gen !== gen && !l.prior?.includes(gen))))) return { ok: false, why: "gen", hint: `人が「全部止める」を押したか、貸した tab / 窓を取り戻しました。止まってください（${done}）` };
    if (l.exp <= now()) return { ok: false, why: "exp", hint: `貸した時間が切れました（${done}）。続けるなら、人にもう一度貸してもらってください` };
    return null;
  };
  // W54b: 貸した窓へ pid 宛ての drag を送る（opts.dragPost）。座標は窓内の点（args）を、list_windows の窓の位置で画面座標にする。窓が画面上に無い・位置が読めない・点が窓の外 = 送らず、cua と同じ拒否の形（background_unavailable）で返す
  const dragViaPost = async (d: Driver, cur: { pid: number; windowId: number }, a: Record<string, unknown>): Promise<Awaited<ReturnType<Driver["call"]>>> => {
    const refuse = (text: string) => ({ text: `${text}（background_unavailable: 何も送っていません）`, isError: true, data: { code: "background_unavailable" } });
    const ws = ((await d.call("list_windows", { pid: cur.pid })).data?.windows as { window_id: number; is_on_screen?: boolean; bounds?: { x: number; y: number; width: number; height: number } }[] | undefined) ?? [];
    const w = ws.find((x) => x.window_id === cur.windowId);
    if (!w?.bounds || w.is_on_screen === false) return refuse("貸した窓が画面上に見つかりません");
    const n = (k: string) => Number(a[k]);
    const pts = [n("from_x"), n("from_y"), n("to_x"), n("to_y")];
    if (pts.some((x) => !Number.isFinite(x)) || pts[0]! < 0 || pts[1]! < 0 || pts[2]! < 0 || pts[3]! < 0 || pts[0]! > w.bounds.width || pts[2]! > w.bounds.width || pts[1]! > w.bounds.height || pts[3]! > w.bounds.height) return refuse("drag の点が窓の外です");
    const r = await opts.dragPost!.send({ pid: cur.pid, windowNumber: cur.windowId, from: [w.bounds.x + pts[0]!, w.bounds.y + pts[1]!], to: [w.bounds.x + pts[2]!, w.bounds.y + pts[3]!], steps: Number(a.steps) || undefined, durationMs: Number(a.duration_ms) || undefined });
    return r.ok ? { text: r.text, isError: false, data: null } : { text: `${r.text}（background_unavailable）`, isError: true, data: { code: "background_unavailable" } };
  };
  // 聞く → 答えの確認を 1 本に（承認の入口はここ 1 か所・open_app も同じ）
  const asked = async (l: Lease, k: string, gen: number, tool: string, args: Record<string, unknown>, d?: Parameters<typeof askHuman>[3], done?: string) => { const v = await askHuman(l, tool, args, d); return { v, no: refused(v, l, k, gen, done) }; };
  // 操作権（token）の検査の本体＝持ち主・確認済み・世代・期限（actNow の最初の 5 つ・AW1: Runtime も同じ検査を通すので 1 か所に寄せた）。token の形は `面|世代|持ち主`
  const check = (token: string): { ok: true; lease: Lease } | { ok: false; why: Why; hint: string } => {
    const [k, g, owner] = String(token ?? "").split("|");
    const gen = Number(g);
    if (!k || !owner || !Number.isInteger(gen)) return { ok: false, why: "bad", hint: "操作権がありません（面を渡された会話の agent だけが動かせます）" };
    const l = table.get(k);
    if (!l) return { ok: false, why: (floor[k] ?? 0) > gen ? "gen" : "unknown", hint: (floor[k] ?? 0) > gen ? "操作権は取り戻されました。止まってください" : "分からない面です" };
    if (!l.confirmed) return { ok: false, why: "unknown", hint: "アプリが再起動しました。あなたが一望の「再確認」を押すまで動けません" };
    if (l.owner !== owner) return { ok: false, why: "owner", hint: "その面の持ち主ではありません" };
    if (l.gen !== gen && !l.prior?.includes(gen)) return { ok: false, why: "gen", hint: "操作権は取り戻されました。止まってください" };
    if (l.exp <= now()) return { ok: false, why: "exp", hint: "操作権の期限が切れました" };
    return { ok: true, lease: l };
  };
  // W78o: 「開くだけ」の既定（openMode）。allow = open_app / open_tab の card を出さず裏で開く（書き込みの Mode =「許す / 先に聞く / 切る」とは別の値・書く操作の card は変わらない）。開いたら onOpened で知らせる（人は toast で気づく）
  const openFree = () => opts.openMode?.() === "allow";
  const askOpen = async (...a: Parameters<typeof asked>) => (openFree() ? { v: "yes" as Verdict, no: null } : asked(...a));
  // W16a: agent が app を裏で開く。聞くのは毎回（表が「許す」でも・人の頼みに app 名があっても省かない）。起こすのは cua の launch_app（background・前面に出さない）。出た窓はその会話の面として渡す
  const imgs = new Map<string, Set<string>>(); // 持ち主 → agent に渡した窓の絵の file（turn の終わりに消す＝session の外に残さない）
  const turnNo = new Map<string, number>(); // endTurn の回数（絵を撮っている間に turn が終わったら、撮れた絵を残さない）
  try { rmSync(join(home, "win"), { recursive: true, force: true }); } catch {} // 前の常駐が落ちて残した窓の絵
  const dropImgs = (owner?: string) => { for (const [o, set] of [...imgs]) if (!owner || o === owner) { for (const f of set) try { unlinkSync(f); } catch {} imgs.delete(o); } };
  const openApp = async (l: Lease, k: string, gen: number, args: Record<string, unknown>, human = false): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; why: Why; hint: string }> => {
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const bundle = str(args.bundle_id, 200), name = str(args.app, 80), path = str(args.path, 500).replace(/^~\//, `${process.env.HOME}/`);
    const bad = (hint: string) => ({ ok: false as const, why: "tool" as Why, hint });
    if (isEditor(name, bundle)) return bad("編集器（Zed・VS Code・Cursor・Xcode・TextEdit など）は開きません（開くと前に出て人の画面を奪います）。file を直接編集して、`kangae run <登録した名前>` で build してください。登録した GUI の app は `kangae launch <名前>` で起こせます。人が見たい時は人が自分で開けます");
    if (!bundle && !name) return bad('open_app には bundle_id か app（app の名前）を渡してください。例: act open_app \'{"app":"Zed","path":"/Users/…/folder"}\'');
    if (bundle && name) return bad("bundle_id と app は片方だけ渡してください（人の承認 card に出す名前と、実際に起こす app をずらさないため。開いていません）");
    if (name && !/^[^/\\:\x00-\x1f]+$/.test(name)) return bad("app は app の名前だけです（path や : は渡せません。file は path 欄で）");
    if (bundle && !/^[A-Za-z0-9][A-Za-z0-9.-]{2,}$/.test(bundle)) return bad("bundle_id の形が違います（例: com.apple.calculator）");
    if (path && (!path.startsWith("/") || !existsSync(path))) return bad("path は在る file か folder の絶対 path だけです（URL は開けません）");
    if (path && (/\.(command|app|tool|workflow|scpt|terminal|action|pkg|dmg)$/i.test(path) || (statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0))) return bad("実行できる file（.command・.app・実行権のある file など）は path に渡せません。開く先は書類か folder だけです（開いていません）");
    if (l.cap === "read") return { ok: false, why: "mod", hint: "この mod は「読むだけ」と宣言しています。app を開くことはできません" };
    if (modeOf(l.surface)[0] === "off") return { ok: false, why: "off", hint: `「${l.surface.app}」は人が「読むだけ」にしています。app を開くことはできません。人に伝えてください` };
    if (facesOf(l.owner).length >= MAX_FACES) return { ok: false, why: "busy", hint: `この会話はもう面を ${MAX_FACES} 枚持っています。人に、どれかを取り戻してもらってください（開いていません）` };
    const label = (name || bundle).replace(/\s+/g, " ");
    const silent = !human && openFree(); const { no } = human ? { no: null } : await askOpen(l, k, gen, "open_app", args, { label, unsure: false, what: `${label} を裏で開きます`, note: "前に出す指示はしません（起動の前後で前面を確かめ、替わったら知らせます）。file・folder は開きません。許すと、agent はこの app の窓を操作できるようになります（その app が既に開いていて他の会話が持っていない窓があれば、その窓が渡ります）。断ると何も開きません\n確かめること: 開く app の名前と、開く file・folder の場所が、頼んだ事に合っているか" });
    if (no) return no;
    const tmp = freeAsk.has(l) || "tabId" in l.surface; // tab の面・面なしは窓の口を持たないので、app を開く cua は別に 1 本
    const c = tmp ? open(`kangae-open-${process.pid}-${seq++}`) : driverOf(l);
    if (!c) return { ok: false, why: "driver", hint: "画面を操作する準備ができていません（cua-driver が見つかりません）" };
    try {
      // W43: path は urls に渡さない（文書を開く Apple Event が app を前に出す: W34 で Zed が 35〜38 秒後に前面）。path は窓を選ぶ目印にだけ使う
      const before = (opts.front ? opts.front() : frontApp());
      let r = await c.call("launch_app", bundle ? { bundle_id: bundle } : { name }, { ms: opts.launchMs ?? LAUNCH_MS });
      let pid = Number((r.data as { pid?: unknown } | null)?.pid);
      if (r.isError || r.unknown) {
        // W27: 締切で諦めた（冷えた app の起動が遅い）だけなら、起きていないとは限らない。起きたか窓の一覧で確かめ、起きていれば面として渡す（遅れて起きた app を二重に開かせない）。書く操作なので「もう一度試して」とは言わない
        if (!r.timedOut) return { ok: false, why: "result", hint: `開けませんでした: ${r.text.slice(0, 200)}` };
        const same = (w: any) => (bundle ? String(w.bundle_id ?? "") === bundle : String(w.app_name ?? "").toLowerCase() === name.toLowerCase()) && !table.has(`${w.pid}:${w.window_id}`);
        const seen = await pollUntil(async () => { const ws = ((await c.call("list_windows", {})).data?.windows as any[] | undefined) ?? []; return ws.find(same); }, opts.verifyMs ?? 45_000, opts.verifyStepMs ?? 1500);
        if (!seen) return { ok: false, why: "result", hint: `${label} の起動に時間がかかっていて、窓がまだ見つかりません（起動の途中かもしれません）。同じ open_app を続けて頼むと二重に開くので繰り返さず、少し待ってから、人に画面を確かめてもらってください` };
        pid = Number(seen.pid);
        r = { text: "", isError: false, data: { pid, windows: [] } };
      }
      if (!Number.isInteger(pid)) return { ok: false, why: "result", hint: "app は起きましたが、窓を特定できませんでした（pid が返りません）。人に伝えてください" };
      // 出た窓: 返事の windows に無ければ（窓がまだ）数秒待って list_windows。他の会話が持つ窓・既に自分が持つ窓は渡さない。path の名前が題に入る窓を優先
      const find = async () => {
        let ws = (r.data as { windows?: any[] } | null)?.windows ?? [];
        if (!ws.some((w) => w.pid === pid)) ws = ((await c.call("list_windows", { pid })).data?.windows as any[] | undefined) ?? [];
        const free = ws.filter((w) => w.pid === pid && !table.has(`${pid}:${w.window_id}`));
        return free.find((w) => path && String(w.title ?? "").includes(basename(path))) ?? free[0];
      };
      const w = await pollUntil(find, opts.windowMs ?? 6000, 300);
      if (!w) return { ok: false, why: "surface", hint: `${label} は起きましたが、渡せる窓が出ませんでした（もう開いている窓は他の会話の物かもしれません）。人に伝えてください` };
      if (!freeAsk.has(l) && table.get(k) !== l) return { ok: false, why: "gen", hint: "操作権は取り戻されました。止まってください" };
      const g = give({ pid, windowId: w.window_id, app: String(w.app_name ?? label).slice(0, 80), title: String(w.title ?? "").slice(0, 120) }, l.owner);
      if (!g.ok) return { ok: false, why: "busy", hint: g.why };
      if (silent) opts.onOpened?.({ owner: l.owner, kind: "app", label });
      return { ok: true, text: `${label} を裏で開き、その窓を面として渡しました（${g.lease.surface.app}${g.lease.surface.title ? ` / ${g.lease.surface.title}` : ""}）。この窓は \`act --on '${tokenOf(g.lease)}' <操作> '<JSON>'\` で操作します（まず get_window_state。この '…' の文字列ごと --on に渡す）。${path ? "path は開いていません（開く file は渡せません）。" : ""}${frontNote(before, (opts.front ? opts.front() : frontApp()), opts.appName ?? appNameOf).trim()}`, isError: false };
    } finally { if (tmp) c.close(); }
  };

  // W23: 面を 1 枚も持たない会話の agent が、最初の app を裏で開く（承認 card は同じ asked・毎回・danger）。開けた窓がその会話の最初の面になる
  const openAppFree = (owner: string, args: Record<string, unknown>) => {
    const l: Lease = { surface: { pid: 0, windowId: 0, app: "", title: "" }, owner, gen: 0, exp: now() + LEASE_MS, confirmed: true };
    freeAsk.add(l);
    return openApp(l, keyOf(l.surface), 0, args);
  };
  // H1: 人が Finder の .app を落とした。人の操作そのものが許しなので card は挟まない（編集器の拒否・面の上限・窓の検査は openApp の同じ道）。agent は呼べない（HUMAN_OPS）
  const openAppHuman = (owner: string, name: string) => {
    const l: Lease = { surface: { pid: 0, windowId: 0, app: "", title: "" }, owner, gen: 0, exp: now() + LEASE_MS, confirmed: true };
    freeAsk.add(l);
    return openApp(l, keyOf(l.surface), 0, { app: name }, true);
  };
  // W40: 面を 1 枚も持たない会話の最初の一手を open_tab にする（openAppFree と同じ型・card は同じ asked・毎回）。near が無いので拡張は今の tab を替えず裏に開く
  const openTabFree = (owner: string, args: Record<string, unknown>) => {
    const l: Lease = { surface: { pid: 0, windowId: 0, app: "", title: "" }, owner, gen: 0, exp: now() + LEASE_MS, confirmed: true };
    freeAsk.add(l);
    return openTab(l, keyOf(l.surface), 0, args);
  };
  // W47: tab の面の「名前つきの読み」（webops.ts の表・GET だけ・貸した tab の origin の固定 path・同 origin の fetch）。agent は op の名前と少数の欄だけ。読むだけなので card は無い（面は人が貸した物）
  const partialOf = new Map<string, string>(); // W47c: 直前の web_op が途中までだった会話（owner → 何の上限か）。Doc に書く文に「一部のみ」が無ければ card で人に知らせる
  // 途中までの Canvas の結果を Doc に書く文に、その旨（「一部のみ」「途中」「打ち切り」）が無い時、card に 1 行足す（止めはしない・人が見て決める）
  const partialWarn = (owner: string, args: Record<string, unknown>): string => {
    const why = partialOf.get(owner);
    return why && !/一部|途中|打ち切/.test(String(args.text ?? args.value ?? "")) ? `\n⚠ 直前の Canvas の読みは途中までです（${why}）。この文には「一部のみ」の語がありません。全部のように見えないか確かめてから許してください` : "";
  };
  const webOp = async (l: Lease, k: string, gen: number, args: Record<string, unknown>): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; why: Why; hint: string }> => {
    const s = l.surface;
    if (!("tabId" in s)) return { ok: false, why: "tool", hint: "web_op は web の tab を渡された時だけ使えます" };
    const op = WEB_OPS.find((o) => o.name === String(args.op ?? ""));
    if (!op) return { ok: false, why: "tool", hint: `op「${String(args.op ?? "").slice(0, 40)}」はありません。あるのは: ${WEB_OPS.map((o) => `${o.name}（${o.what}）`).join(" / ")}` };
    const chk = checkParams(op, args);
    if (!chk.ok) return { ok: false, why: "tool", hint: chk.hint };
    let origin = "";
    try { const u = new URL(String(s.url)); if (u.protocol !== "https:") throw 0; origin = u.origin; } catch { return { ok: false, why: "surface", hint: "この tab の URL が https ではないので読みません" }; }
    if (!opts.web) return { ok: false, why: "driver", hint: "ブラウザの拡張が繋がっていません" };
    const lost = () => !freeAsk.has(l) && (table.get(k) !== l || (l.gen !== gen && !l.prior?.includes(gen)));
    const notCanvas = `この tab（${origin}）は Canvas ではないようです（${op.name} の API が JSON で返りません）。人に「Canvas の tab（学校の Canvas を開いた tab）を渡してください」と伝えてください`;
    const needLogin = `この tab の Canvas に login していません（または権限がありません）。人に「Canvas の tab で login してから、もう一度頼んでください」と伝えてください`;
    let url: string | null = origin + op.build(chk.p, new Date(now()));
    const raw: unknown[] = [];
    let more = "";
    const t0 = Date.now(), budget = opts.webOpBudgetMs ?? WEBOP_BUDGET_MS; // 実時間（now は試験で止まる物）
    for (let page = 0; url; page++) {
      if (page >= MAX_PAGES) { more = `安全の上限（${MAX_PAGES} 頁）`; break; }
      if (page > 0 && Date.now() - t0 >= budget) { more = `時間の上限（${Math.round(budget / 1000)} 秒）`; break; }
      const r = await opts.web.call("api_fetch", { url, method: "GET", headers: { accept: "application/json" }, tabId: s.tabId });
      if (lost()) return { ok: false, why: "gen", hint: "操作権は取り戻されました。止まってください（結果は渡しません）" };
      const d = r.data as { status?: number; url?: string; body?: string; headers?: [string, string][] } | null;
      if (r.isError || !d) return { ok: false, why: "result", hint: /別の site/.test(String(r.text)) ? needLogin : `読めませんでした（${String(r.text).slice(0, 160)}）。人に Canvas の tab が開いたままか確かめてもらってください` };
      let landed = ""; try { landed = new URL(String(d.url)).pathname; } catch {}
      if (d.status === 401 || d.status === 403 || /^\/login(\/|$)/.test(landed)) return { ok: false, why: "result", hint: needLogin };
      if (d.status !== 200) return { ok: false, why: "result", hint: d.status === 404 ? notCanvas : `${op.name} は HTTP ${d.status} でした。少し待って、もう一度試してください（続くなら人に伝えてください）` };
      const json = parseBody(Buffer.from(String(d.body ?? ""), "base64").toString("utf8"));
      if (!Array.isArray(json)) return { ok: false, why: "result", hint: notCanvas }; // HTML・{errors:…}・別の形＝Canvas の planner / todo ではない
      raw.push(...json);
      const link = (d.headers ?? []).find(([h]) => h.toLowerCase() === "link")?.[1];
      url = nextOf(link, origin);
      if (url && raw.length >= MAX_ITEMS) { more = `安全の上限（${MAX_ITEMS} 件）`; break; }
    }
    const items = op.reduce(raw.slice(0, MAX_ITEMS), new Date(now())) as unknown[];
    if (more) partialOf.set(l.owner, more); else partialOf.delete(l.owner);
    const w = op.params.week ? weekOf(new Date(now()), chk.p.week === "this" ? "this" : "next") : null;
    return { ok: true, isError: false, text: JSON.stringify({ op: op.name, ...(w ? { week: chk.p.week, from: w.start, to: w.end } : {}), items, ...(more ? { truncated: true, note: `${more}で、ここまで ${items.length} 件を返します。続きがあります。Doc には「一部のみ」と書いてください` } : {}), ...(items.length === 0 ? { note: `${w ? `${w.start}〜${w.end} に` : "今"}Canvas に載っている課題・予定は 0 件でした。授業が planner に出ていない（Canvas の「予定表」で授業の表示が外れている）だけかもしれません。人に「Canvas の予定表で同じ週を見て、課題が無いか確かめてください」と伝え、推測で課題を足さないでください` } : {}) }) };
  };
  // W46-B: api の call は「その会話に貸した tab」の中だけで再生する。貸していない site の tab を使う時は、その会話で最初の 1 回だけ card で「この tab を貸す」と聞き、許せば面にする（以後 card 無し）
  const apiTab = async (owner: string, origin: string): Promise<{ ok: true; tabId: number } | { ok: false; hint: string }> => {
    const originOf = (u?: string) => { try { return new URL(String(u)).origin; } catch { return ""; } };
    const mine = facesOf(owner).find((x) => x.confirmed && "tabId" in x.surface && originOf(x.surface.url) === origin);
    if (mine) return { ok: true, tabId: (mine.surface as { tabId: number }).tabId };
    if (!opts.web || opts.webReady?.() === false) return { ok: false, hint: `ブラウザの拡張が繋がっていないので、${origin} の tab を借りられません。何も送っていません` };
    if (facesOf(owner).length >= MAX_FACES) return { ok: false, hint: `この会話はもう面を ${MAX_FACES} 枚持っていて、${origin} の tab を借りられません。人に、要らない面を取り戻してもらってください` };
    const f = (await opts.web.call("tab_find", { origin })).data as { tabId?: number; docId?: string; title?: string; url?: string } | null;
    if (!Number.isInteger(f?.tabId) || !f?.docId) return { ok: false, hint: `${origin} を開いている tab がありません。Chrome でその site を開き、login してから、もう一度` };
    const taken = occupant({ tabId: f!.tabId!, docId: f!.docId!, app: "web", title: "", url: "" }, owner);
    if (taken) return { ok: false, hint: `${busyWhy(taken)}。何も借りていません（人に聞く前に断りました）` }; // 貸す前に空きを見る（許された後に断らない）
    let l = facesOf(owner).find((x) => x.confirmed);
    if (!l) { l = { surface: { pid: 0, windowId: 0, app: "", title: "" }, owner, gen: 0, exp: now() + LEASE_MS, confirmed: true }; freeAsk.add(l); }
    const { no } = await asked(l, keyOf(l.surface), l.gen, "api_tab", { origin }, { label: origin, unsure: false, what: `${origin} の tab「${shownText(f!.title ?? "", 60)}」を借ります`, note: `許すと、この会話の agent は、この tab のサイトのデータを、あなたがログインしたままの状態で読めます（読むだけで、書き換えません）。この会話では 2 回目から聞きません。やめたい時は、Bar の「全部止める」を押してください\n確かめること: このサイトのログインの中身を、この agent に読ませてよいか` });
    if (no) return { ok: false, hint: no.hint };
    if (facesOf(owner).length >= MAX_FACES) return { ok: false, hint: `この会話はもう面を ${MAX_FACES} 枚持っています（何も借りていません）` };
    const g = give({ tabId: f!.tabId!, docId: f!.docId!, app: "web", title: String(f!.title || origin).slice(0, 120), url: f!.url ?? origin }, owner, false);
    return g.ok ? { ok: true, tabId: f!.tabId! } : { ok: false, hint: `tab を面にできませんでした（${g.why}）` };
  };
  // W41: desktop の op（段 2・AppleScript）。agent が渡すのは app・op の名前・slot の値だけ。起動済みの app だけ（未起動は Dock に出る）・script に起こす / 前に出す語を書かせない・write は毎回 card・read は card 無し
  const osa = opts.osa ?? (async (script: string) => {
    const p = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const t = setTimeout(() => p.kill(), 15_000);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(t);
    return { ok: code === 0, text: (code === 0 ? out : err).trim() };
  });
  const opRun = async (owner: string, appName: string, opName: string, kv: Record<string, unknown>): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; why: Why; hint: string }> => {
    const bad = (hint: string, why: Why = "tool") => ({ ok: false as const, why, hint });
    const ops = opts.ops ?? APP_OPS;
    const mine = ops.filter((o) => o.app.toLowerCase() === appName.toLowerCase());
    const op = mine.find((o) => o.name === opName);
    if (!op) return bad(mine.length ? `「${appName.slice(0, 40)}」に op「${opName.slice(0, 40)}」はありません。あるのは: ${mine.map((o) => o.name).join(", ")}` : `app「${appName.slice(0, 40)}」の op はまだありません（対応: ${[...new Set(ops.map((o) => o.app))].join(", ")}）`);
    for (const k of Object.keys(kv)) if (!op.slots.includes(k)) return bad(`op「${op.name}」に欄「${k.slice(0, 40)}」はありません。欄: ${op.slots.join(", ") || "（無し）"}`);
    const slots: Record<string, string> = {};
    for (const k of op.slots) {
      const v = kv[k];
      if (typeof v !== "string" || !v) return bad(`op「${op.name}」の欄「${k}」を渡してください（${op.slots.map((x) => `${x}=…`).join(" ")}）`);
      const multi = op.lines?.includes(k);
      if (v.length > (multi ? 4000 : SLOT_MAX) || (multi ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(v)) return bad(multi ? `欄「${k}」は 4000 文字までです（改行・tab 以外の制御文字は渡せません）` : `欄「${k}」は ${SLOT_MAX} 文字までの 1 行です（改行・制御文字は渡せません）`);
      slots[k] = v;
    }
    // W41b: 段ごとの門と実行。osa = script 検査 / scheme = open -g（URL 検査）/ intent = openAppWhenRun:false の action だけ / file = 先に path を確かめる（閉じた app にも届く）
    const via = op.via ?? "osa";
    const home = opts.home ?? homedir();
    let shown = "", exec: () => Promise<{ ok: boolean; text: string }>;
    if (via === "osa") {
      const script = op.build!(slots);
      const g = scriptGate(script);
      if (g) return bad(g);
      shown = `実行する script: ${script}`; exec = () => osa(script);
    } else if (via === "scheme") {
      const url = op.build!(slots);
      const g = urlGate(url, op.scheme ?? "");
      if (g) return bad(g);
      shown = `開く先: ${url}（前に出さずに渡します）`;
      exec = async () => (opts.openUrl ?? (async (u: string) => { const p = Bun.spawn(["open", "-g", u], { stdout: "pipe", stderr: "pipe" }); const [e, c] = [await new Response(p.stderr).text(), await p.exited]; return { ok: c === 0, text: c === 0 ? "渡しました" : e.trim() }; }))(url);
    } else if (via === "intent") {
      const g = intentGate(op.intent!.appPath, op.intent!.action);
      if (g) return bad(g);
      const wrapper = `kangae-${op.intent!.action}`;
      shown = `${op.app} の機能「${op.what}」を、あなたが用意したショートカット「${wrapper}」で行います（渡す内容: ${shownText(JSON.stringify(slots), 300)}）`;
      exec = async () => (opts.intent ?? (async (w: string, input: string) => { const p = Bun.spawn(["shortcuts", "run", w, "--input-path", "-", "--output-path", "-"], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" }); const t = setTimeout(() => p.kill(), 30_000); const [o, e, c] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited]; clearTimeout(t); return { ok: c === 0, text: (c === 0 ? o : e).trim() }; }))(wrapper, JSON.stringify(slots));
    } else {
      const pl = op.plan!(slots, home);
      if (!pl.ok) return bad(pl.hint);
      shown = `実行する事: ${pl.desc}`; exec = async () => { try { return { ok: true, text: pl.exec() }; } catch (e) { return { ok: false, text: (e as Error).message }; } };
    }
    // 起動済みの確認は osa / scheme / intent だけ（file は app が閉じていても届く）。確認は osa の `is running`（起こさない）
    const needRun = via !== "file";
    const running = async () => !needRun || (await osa(`application id "${op.bundle}" is running`)).text === "true";
    const noRun = `${op.app} が起動していません。agent は app を起こしません（Dock に出るため）。人に起動を頼み、起きてからもう一度頼んでください`;
    if (!(await running())) return bad(noRun, "surface");
    let ask = "";
    { // review26: read も毎回 card（前の窓は人が貸した面ではない＝他の会話・ssh・秘密の出力が見えうる。surface.md 境界「読みは貸した面だけ」）
      let l = facesOf(owner).find((x) => x.confirmed);
      if (l) {
        if (op.permission === "write" && l.cap === "read") return { ok: false, why: "mod", hint: "この mod は「読むだけ」と宣言しています。op の write はできません" };
      } else { l = { surface: { pid: 0, windowId: 0, app: "", title: "" }, owner, gen: 0, exp: now() + LEASE_MS, confirmed: true }; freeAsk.add(l); }
      const { no } = await asked(l, keyOf(l.surface), l.gen, op.permission === "write" ? "op_write" : "op_read", { app: op.app, op: op.name }, { label: `${op.app} / ${op.name}`, unsure: false, what: `${op.app} の「${op.what}」を行います`, note: `${shown}\n${op.permission === "read" ? "読むだけですが、人が貸した窓ではありません。中身に秘密が見えていないか確かめてから許してください\n" : ""}この app は前に出ません${via === "osa" ? "。初めての時は macOS の「Kangae が " + op.app + " を制御しようとしています」が前に出ます" : ""}\n確かめること: 実行する内容が頼んだ事に合っているか` });
      if (no) return no;
      if (!(await running())) return bad(noRun, "surface"); // 待つ間に app が終わった
      ask = op.permission;
    }
    const r = await exec();
    if (!r.ok) return { ok: false, why: "result", hint: `${op.app} の ${op.name} は失敗しました（${r.text.slice(0, 200)}）${via === "osa" ? "。窓が開いていない可能性があります" : via === "intent" ? "。署名した shortcut が無いか、macOS の許可の問いが出ていない可能性があります（人が一度入れる）" : ""}` };
    return { ok: true, isError: false, text: JSON.stringify({ app: op.app, op: op.name, via, ...(ask ? { permission: ask } : {}), result: r.text.slice(0, 8000) }) };
  };
  // W17a: 人が登録した command を名前で走らせる（docs/BRIEF-w17.md）。agent が決められるのは名前だけ。承認は asked 1 か所（毎回・danger）。面が取り戻された・turn が終わったら process group ごと止める
  const running = new Map<string, () => void>(); // 持ち主 → 走っている command を止める関数
  const touched = new Map<string, string[]>(); // W38: 持ち主 → run で承認された登録の cwd（最後に触った物が先・8 件まで・会話が消えるまで残す）。人が Bar の「見る」で開く folder
  const runCmd = async (owner: string, name: string, ctx: { uiHome: string; workDir: string; sock?: string }): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; why: Why; hint: string }> => {
    const bad = (hint: string, why: Why = "tool") => ({ ok: false as const, why, hint });
    const all = loadCmds(ctx.uiHome), names = all.map((c) => c.name).join(", ") || "（まだありません）";
    const c = all.find((x) => x.name === name);
    if (!c) return bad(`command「${name.slice(0, 40)}」は登録されていません。登録済み: ${names}。人が登録する行: ${registerLine(/^[a-z0-9][a-z0-9-]{0,31}$/.test(name) ? name : "build")}。人に 1 行で伝えてください（あなたは登録できません）`);
    if (c.seal !== sealOf(c)) return bad(`command「${name}」の登録が書き換えられています。動かしません。人に伝え、登録し直してもらってください（${CLI} cmd-rm ${name} → cmd-add）`);
    if (c.app) return bad(`「${name}」は app（GUI）の登録です。待たずに起こすのは \`kangae launch ${name}\` です（run は終わりを待つ command 用）`);
    const l = facesOf(owner).find((x) => x.confirmed);
    if (!l) return bad("command を走らせられるのは、操作権（面）を持つ turn だけです。人に面を渡してもらうか、登録した app を `kangae launch <名前>` で起こしてください（編集器は開けません。file は直接編集します）");
    if (l.cap === "read") return { ok: false, why: "mod", hint: "この mod は「読むだけ」と宣言しています。command は走らせられません" };
    if (modeOf(l.surface)[0] === "off") return { ok: false, why: "off", hint: `「${l.surface.app}」は人が「読むだけ」にしています。command は走らせられません。人に伝えてください` };
    if (!existsSync(c.cwd)) return bad(`command「${name}」の場所（${c.cwd}）が無くなっています。人に伝えてください`);
    // Kangae の置き場（uiHome）の中、またはそれを中に含む場所では走らせない（登録・承認・鍵の file を agent が書き換えられる道）。承認の後にもう一度見る。
    // W37（user 承認済み）: 登録した場所の中は agent が直接編集してよい（main.ts の Edit / Write）ので、作業場所との重なりはもう断らない。書き換えた file を走らせる被害は seatbelt（書けるのは場所と tmp だけ・通信なし）で包む
    const unsafe = (x: typeof c) => overlaps(x.cwd, ctx.uiHome) || argvInside(x.argv, ctx.uiHome);
    if (unsafe(c)) return bad(`command「${name}」の場所か実行する行が、Kangae の置き場の中（またはそれを含む場所）にあります（登録や鍵の file を書き換えられる道になるため動かしません）。人に、Kangae の置き場と重ならない folder・command で登録し直してもらってください`);
    if (running.has(owner) || running.size >= 2) return { ok: false, why: "busy", hint: "別の command が走っています（終わるのを待って、もう一度）" };
    const k = keyOf(l.surface), gen = l.gen;
    const { no } = await asked(l, k, gen, "run_cmd", { name }, { label: name, unsure: false, what: `登録した「${name}」を実行します`, note: `場所: ${c.cwd}\n実行する行: ${c.argv.join(" ")}\nagent は「場所」の中の file を書き換えてから build します（あなたの folder の中身が変わります）\n書けるのは「場所」の中だけ・ネットワーク: ${c.network ? "あり（登録で許した物）" : "なし"}・${c.reads?.length ? `読めるのは「場所」と ${c.reads.join(" / ")} だけ` : "あなたのフォルダ（場所の外）は読めません"}\nこの行は あなたが ${new Date(c.at).toISOString().slice(0, 10)} に登録した物です。画面は変わりません。出力は agent だけが読みます\n確かめること: 実行する行が、あなたが登録した物のままか（場所・行・ネットワークの有無）` }, "登録した物は走っていません");
    if (no) return no;
    const now2 = loadCmds(ctx.uiHome).find((x) => x.name === name); // 承認を待つ間に登録が替わっていたら、人が見た行と違う物は走らせない
    if (!now2 || now2.seal !== c.seal || sealOf(now2) !== c.seal) return bad(`command「${name}」の登録が、承認を待つ間に替わりました。走らせていません。人に伝え、もう一度頼んでください`);
    if (unsafe(now2) || !existsSync(now2.cwd)) return bad(`command「${name}」の場所が、承認を待つ間に変わりました。走らせていません。人に伝え、もう一度頼んでください`);
    if (running.has(owner) || running.size >= 2) return { ok: false, why: "busy", hint: "別の command が走っています（終わるのを待って、もう一度）" }; // 待つ間に同じ持ち主 / 他の持ち主が走らせた
    touched.set(owner, [now2.cwd, ...(touched.get(owner) ?? []).filter((d) => d !== now2.cwd)].slice(0, 8)); // W38: 人が許した登録の cwd だけが「触った folder」
    const wd = winDir(ctx.uiHome, owner); // 出力は会話ごとの置き場（shots は全会話が Read できる・review17-2）
    mkdirSync(wd, { recursive: true, mode: 0o700 });
    const out = join(realpathSync(wd), outName());
    (imgs.get(owner) ?? imgs.set(owner, new Set()).get(owner)!).add(out); // turn の終わりに消す（window_image の絵と同じ集合）
    let r: ReturnType<typeof startCmd>;
    try { r = startCmd(c, out, { sock: ctx.sock }); } catch (e) { return { ok: false, why: "result", hint: `走らせられませんでした（${(e as Error).message.slice(0, 120)}）。人に伝えてください` }; }
    running.set(owner, r.kill);
    const ran = await r.done.finally(() => running.delete(owner));
    const tail = tailOf(out), secs = Math.round(ran.ms / 100) / 10;
    if (ran.why === "killed") return { ok: false, why: "gen", hint: `操作権が取り戻された（または turn が終わった）ので command「${name}」を止めました。止まってください。出力の途中: ${out}` };
    const head = ran.why === "timeout" ? `時間切れ（${c.timeoutSec} 秒）で止めました` : ran.why === "big" ? "出力が大きすぎて止めました（2MB）" : `exit ${ran.code}（${secs} 秒）`;
    return { ok: true, isError: ran.why !== "exit" || ran.code !== 0, text: `command「${name}」: ${head}\n--- 出力の末尾 ---\n${tail}\n--- 全文（Read で読めます）: ${out}` };
  };

  // W31a: 人が `cmd-add --app` で登録した GUI を、名前だけで待たずに起こす（kangae launch・docs/BRIEF-w31.md）。毎回 card・sandbox の下・窓が出れば面（その turn の間は click / type_text をまとめて許す・W32）・
  // turn の終わり / 取り戻し / 全停止 / 常駐の終了 / 最大寿命で process group ごと止める。同じ持ち主の同じ名前は二重に起こさない
  type AppRun = { owner: string; name: string; pid: number; key: string; kill: () => void };
  const apps = new Map<string, AppRun>();
  const appId = (owner: string, name: string) => `${owner}\0${name}`;
  const dropApp = (a: AppRun) => { if (apps.get(appId(a.owner, a.name)) === a) apps.delete(appId(a.owner, a.name)); try { a.kill(); } catch {} };
  const killAppsOf = (pred: (a: AppRun) => boolean) => { for (const a of [...apps.values()]) if (pred(a)) dropApp(a); };
  // W35: api-anything の add / capture / login の承認 card（人が「いいよ」と言うまで何も起こさない）。null = 許された
  const confirmApi = async (owner: string, d: { label: string; what: string; note: string }): Promise<{ ok: false; hint: string } | null> => {
    let l = facesOf(owner).find((x) => x.confirmed);
    if (!l) { l = { surface: { pid: 0, windowId: 0, app: "", title: "" }, owner, gen: 0, exp: now() + LEASE_MS, confirmed: true }; freeAsk.add(l); }
    const { no } = await asked(l, keyOf(l.surface), l.gen, "api_anything", { label: d.label }, { label: d.label, unsure: false, what: d.what, note: d.note }, "実行していません");
    return no ? { ok: false, hint: no.hint } : null;
  };
  const launchApp = async (owner: string, name: string, ctx: { uiHome: string; workDir: string; sock?: string }): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; why: Why; hint: string }> => {
    const bad = (hint: string, why: Why = "tool") => ({ ok: false as const, why, hint });
    const all = loadCmds(ctx.uiHome), names = all.filter((x) => x.app).map((x) => x.name).join(", ") || "（まだありません）";
    const c = all.find((x) => x.name === name);
    if (!c) return bad(`app「${name.slice(0, 40)}」は登録されていません。登録済みの app: ${names}。人が登録する行: ${CLI} cmd-add <名前> --app --cwd <フォルダ> -- <実行 file>。人に 1 行で伝えてください（あなたは登録できません）`);
    if (c.seal !== sealOf(c)) return bad(`app「${name}」の登録が書き換えられています。起こしません。人に伝え、登録し直してもらってください（${CLI} cmd-rm ${name} → cmd-add）`);
    if (editorExe(c.argv[0] ?? "")) return bad(`「${name}」は編集器の登録なので起こしません（起こすと前に出て人の画面を奪います）。file は直接編集して、build は \`kangae run\` で行ってください`);
    if (!c.app) return bad(`「${name}」は command の登録です。走らせるなら \`kangae run ${name}\` です（launch は app（GUI）を待たずに起こす物）`);
    const have = apps.get(appId(owner, name));
    if (have) { const fl = table.get(have.key); if (fl && fl.owner === owner) return { ok: true, isError: false, text: `app「${name}」は既に起きています（二重には起こしません）。この窓は \`act --on '${tokenOf(fl)}' <操作> '<JSON>'\` で操作します` }; dropApp(have); }
    let l = facesOf(owner).find((x) => x.confirmed);
    if (l) {
      if (l.cap === "read") return { ok: false, why: "mod", hint: "この mod は「読むだけ」と宣言しています。app は起こせません" };
      if (modeOf(l.surface)[0] === "off") return { ok: false, why: "off", hint: `「${l.surface.app}」は人が「読むだけ」にしています。app は起こせません。人に伝えてください` };
    } else { l = { surface: { pid: 0, windowId: 0, app: "", title: "" }, owner, gen: 0, exp: now() + LEASE_MS, confirmed: true }; freeAsk.add(l); }
    if (facesOf(owner).length >= MAX_FACES) return { ok: false, why: "busy", hint: `この会話はもう面を ${MAX_FACES} 枚持っています。人に、どれかを取り戻してもらってください（起こしていません）` };
    if (!existsSync(c.cwd)) return bad(`app「${name}」の場所（${c.cwd}）が無くなっています。人に伝えてください`);
    const unsafe = (x: typeof c) => overlaps(x.cwd, ctx.uiHome) || argvInside(x.argv, ctx.uiHome); // W37: 作業場所との重なりは断らない（登録した場所は agent が直接編集してよい）
    if (unsafe(c)) return bad(`app「${name}」の場所か実行する行が、Kangae の置き場の中（またはそれを含む場所）にあります（登録や鍵の file を書き換えられる道になるため起こしません）。人に、Kangae の置き場と重ならない folder・実行 file で登録し直してもらってください`);
    const k = keyOf(l.surface), gen = l.gen;
    const { no } = await asked(l, k, gen, "launch_app", { name }, { label: name, unsure: false, what: `app「${name}」を起動します`, note: `場所: ${c.cwd}\n実行する行: ${c.argv.join(" ")}\n前に出す指示はしません（app が自分で前に出たら知らせます）。書けるのは「場所」の中だけ・ネットワーク: ${c.network ? "あり（登録で許した物）" : "なし"}\nこの app の窓が出たら、この頼みの間、窓の中で押す・文字を入れる操作は、まとめて 1 回の承認になります（「削除」「送信」などの語や Enter は今までどおり毎回聞きます）\nこの行は あなたが ${new Date(c.at).toISOString().slice(0, 10)} に登録した物です。出力は agent だけが読みます\n確かめること: 起こす行が、あなたが登録した物のままか（場所・行・ネットワークの有無）` }, "app は起こしていません");
    if (no) return no;
    const now2 = loadCmds(ctx.uiHome).find((x) => x.name === name); // 承認を待つ間に登録が替わっていたら起こさない
    if (!now2 || now2.seal !== c.seal || sealOf(now2) !== c.seal || !now2.app) return bad(`app「${name}」の登録が、承認を待つ間に替わりました。起こしていません。人に伝え、もう一度頼んでください`);
    if (unsafe(now2) || !existsSync(now2.cwd)) return bad(`app「${name}」の場所が、承認を待つ間に変わりました。起こしていません。人に伝え、もう一度頼んでください`);
    if (apps.has(appId(owner, name))) return bad(`app「${name}」は、承認を待つ間に別の頼みで起きました。起こしていません（二重には起こしません）`);
    if (facesOf(owner).length >= MAX_FACES) return { ok: false, why: "busy", hint: `この会話はもう面を ${MAX_FACES} 枚持っています。起こしていません` };
    const wd = winDir(ctx.uiHome, owner);
    mkdirSync(wd, { recursive: true, mode: 0o700 });
    const out = join(realpathSync(wd), outName());
    (imgs.get(owner) ?? imgs.set(owner, new Set()).get(owner)!).add(out);
    const before = (opts.front ? opts.front() : frontApp());
    let r: ReturnType<typeof startCmd>;
    try { r = startCmd(c, out, { sock: ctx.sock, timeoutMs: opts.appLifeMs ?? APP_LIFE_MS }); } catch (e) { return { ok: false, why: "result", hint: `起こせませんでした（${(e as Error).message.slice(0, 120)}）。人に伝えてください` }; }
    const run: AppRun = { owner, name, pid: r.pid, key: "", kill: r.kill };
    apps.set(appId(owner, name), run);
    void r.done.then(() => { // 自分で終わった・最大寿命・kill: 登録を外し、面が残っていれば取り戻す
      if (apps.get(appId(owner, name)) === run) apps.delete(appId(owner, name));
      if (run.key && table.get(run.key)?.owner === owner) revoke(run.key);
    });
    const tmp = freeAsk.has(l) || "tabId" in l.surface;
    const cua = tmp ? open(`kangae-app-${process.pid}-${seq++}`) : driverOf(l);
    if (!cua) { dropApp(run); return { ok: false, why: "driver", hint: "画面を操作する準備ができていません（cua-driver が見つかりません）。起こしたものは止めました" }; }
    try {
      const w = await pollUntil(async () => { const ws = ((await cua.call("list_windows", { pid: r.pid })).data?.windows as any[] | undefined) ?? []; return ws.find((x) => x.pid === r.pid && !table.has(`${r.pid}:${x.window_id}`)); }, opts.appWaitMs ?? APP_WAIT_MS, opts.appStepMs ?? 1000);
      if (!w) { dropApp(run); return { ok: false, why: "result", hint: `app「${name}」の窓が出ませんでした（${Math.round((opts.appWaitMs ?? APP_WAIT_MS) / 1000)} 秒待って、起こしたものは止めました）。人に伝えてください` }; }
      if (!freeAsk.has(l) && table.get(k) !== l) { dropApp(run); return { ok: false, why: "gen", hint: "操作権は取り戻されました。起こしたものは止めました。止まってください" }; }
      const g = give({ pid: r.pid, windowId: w.window_id, app: String(w.app_name ?? name).slice(0, 80), title: String(w.title ?? "").slice(0, 120) }, owner);
      if (!g.ok) { dropApp(run); return { ok: false, why: "busy", hint: g.why }; }
      run.key = keyOf(g.lease.surface);
      g.lease.turnAllow = true; // W32: 人が起動を許した turn の間、この窓の click / type_text をまとめて許す（endTurn・取り戻しで消える）
      g.lease.appBatch = true;
      opts.onChange?.();
      const after = (opts.front ? opts.front() : frontApp());
      const moved = before && after && before !== after ? frontNote(before, after, opts.appName ?? appNameOf) : "";
      if (moved) console.error(`app「${name}」を起こして前面が替わった: ${before} → ${after}`); // log は ASN のまま（名前は他人の app の文字列）
      const nm = Object.entries(faceNames(facesOf(owner).filter((x) => x.confirmed))).find(([, t]) => t === tokenOf(g.lease))?.[0] ?? "window";
      return { ok: true, isError: false, text: `app「${name}」を起こし、その窓を面として渡しました（${g.lease.surface.app}${g.lease.surface.title ? ` / ${g.lease.surface.title}` : ""}）。この窓は \`act --on ${nm} <操作> '<JSON>'\` で操作します（まず window_image で絵を読む）。この頼みの間、窓の中の click / type_text はまとめて許されています${moved}` };
    } finally { if (tmp) cua.close(); }
  };
  // 別の Space の窓を、普通の AX の helper で読む。理由を混ぜない: helper が無い / 許可が無い（誰に出すか）/ AX がその窓を持っていない（一度も画面に出ていない）
  const offSpaceRead = async (pid: number, windowId: number): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; why: Why; hint: string }> => {
    const r = await (opts.axRead ?? axReadHelper)(pid, windowId);
    if (!r) return { ok: false, why: "surface", hint: "その窓は別の Space にあり、読む helper（Kangae Bar 読み取り）が見つかりません。入れ直すと読めます。人に伝えてください" };
    if (r.error === "no-ax-permission") { axWantedAt = Date.now(); /* W21: 本当に要った時だけ、最初の画面が許可を勧める */ return { ok: false, why: "surface", hint: `その窓は別の Space にあり、読むにはアクセシビリティの許可が要ります。システム設定 › プライバシーとセキュリティ › アクセシビリティ で「${READER_APP}」${r.app ? `（${r.app}）` : ""}を許可してください（一覧に無ければ + で足します）。人に伝えてください` }; }
    if (r.found && r.elements) return { ok: true, text: [`（別の Space の窓を読むだけの道で読みました。押す・書くはできません） 要素 ${r.elements.length}${r.truncated ? "（途中まで）" : ""}`, ...r.elements.map((e) => `${"  ".repeat(Math.min(e.depth, 6))}${e.role}\t${[e.label, e.value].filter((x) => x).join(" = ")}`)].join("\n").slice(0, 20_000), isError: false };
    if (r.error === "no-reply") return { ok: false, why: "surface", hint: "その窓は別の Space にあります。読む helper の返事を受け取れませんでした。もう一度試してください" };
    if (r.found === false) return { ok: false, why: "surface", hint: "その窓は別の Space にあり、一度も画面に出ていないので読めません。人にその窓のある Space へ移って窓を見せてもらってください（見えた後なら、人が別の Space に居ても読めます）" };
    return { ok: false, why: "surface", hint: `その窓は別の Space にあり、読めませんでした（${r.error ?? "helper の返事が読めません"}）。人に伝えてください` };
  };

  // 面を渡す。1 つの面に持ち主は 1 人・1 人の持ち主は MAX_FACES 枚まで
  // here = 渡した時に人がその面を見ているか（web は拡張が教える。省くと人の今の記録から判定）
  const give = (surface: Surface, owner: string, here?: boolean): { ok: true; lease: Lease } | { ok: false; why: string } => {
    const k = keyOf(surface);
    const held = table.get(k);
    const who = occupant(surface, owner);
    if (who) return { ok: false, why: busyWhy(who) };
    if (!held && facesOf(owner).length >= MAX_FACES) return { ok: false, why: `この会話はもう面を ${MAX_FACES} 枚持っています。先にどれかを取り戻してください` };
    recov.delete(k);
    const lease: Lease = { surface, owner, gen: Math.max(floor[k] ?? 0, held?.gen ?? 0) + 1, exp: now() + LEASE_MS, confirmed: true };
    floor[k] = lease.gen;
    table.set(k, lease);
    if (here && "tabId" in surface) seen.tab = surface.tabId;
    if ("tabId" in surface) void Promise.resolve(opts.web?.call("gate_on", { tabId: surface.tabId })).catch(() => {}); // 渡した tab だけ・持っている間だけ（revoke で戻す）
    lease.hold = here ?? onSurface(lease); // 人が見ている面を任された＝離れてから書き換える
    save();
    return { ok: true, lease };
  };
  // W16b: 新しい tab を裏で開き（拡張の chrome.tabs.create active:false＝前面も今の tab も替えない）、その会話の次の面にする。毎回 1 回聞く（danger の card・「この頼みの間」も表の「許す」も効かない）。
  // 待つ（承認）前に断れる物は全部先に断る: url・読むだけの宣言・人の確認・面の数・拡張が無い。tab を作るのは人が許した後だけ
  const openTab = async (l: Lease, k: string, gen: number, args: Record<string, unknown>): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; why: Why; hint: string }> => {
    const u = openUrlOf(args.url);
    if (!u.ok) return { ok: false, why: "tool", hint: u.hint };
    if (l.cap === "read") return { ok: false, why: "mod", hint: "この mod は「読むだけ」と宣言しています。新しい tab は開けません。読んで分かった事を人に伝えてください" };
    if (modeOf(l.surface)[0] === "off") return { ok: false, why: "off", hint: `「${l.surface.app}」は人が「読むだけ」にしています。新しい tab は開けません。人に伝え、どうするか聞いてください` };
    if (humanOf.has(l)) return { ok: false, why: "human", hint: HUMAN_HINT(humanOf.get(l)!) };
    const full = () => facesOf(l.owner).length >= MAX_FACES;
    const fullHint = `この会話はもう面を ${MAX_FACES} 枚持っています。新しい tab は開けません（何も開いていません）。要らない面を人に取り戻してもらってから`;
    if (full()) return { ok: false, why: "tool", hint: fullHint };
    const noExt = `ブラウザの拡張が Chrome に入っていない（常駐に繋がっていない）ので、tab を開けません。何も開いていません。返事に ${EXT_HANDOFF} を 1 行書いて止まってください`;
    if (!opts.web || opts.webReady?.() === false) return { ok: false, why: "driver", hint: noExt };
    // path だけの URL でも GET で効く物がある（ログアウト・設定・共有）。この PC / 社内の宛先（localhost・IP 直指定）も人の browser から叩かせる口になる。card で人に見せる
    const host = u.url.hostname;
    const warn = (CROSSING.test(decodeURIComponent(u.url.pathname)) ? "。この URL はログアウト・設定変更・共有など、開くだけで取り返しのつかない副作用がある頁かもしれません" : "") + (/^(localhost|[\d.]+|\[.*\])$|\.(local|localhost|internal|lan|home\.arpa)$/i.test(host) ? "。この PC か社内の宛先（IP 直指定・localhost など）です" : "");
    const silent = openFree(); const { no } = await askOpen(l, k, gen, "open_tab", args, { label: "", unsure: false, open: u.url.origin, note: `開く URL: ${u.url.origin}【頁: ${u.url.pathname}】。URL に、読んだ頁の中身（名前・番号・文）が入っていないか見てから許してください。tab は裏で開くので、今の画面は変わりません。断ると何も開きません\n確かめること: 開く先の URL が頼んだ事に合っているか・読んだ中身が URL に入っていないか${warn}` }, "tab は開いていません");
    if (no) return no;
    if (full()) return { ok: false, why: "tool", hint: fullHint }; // 待つ間に人が別の面を渡した
    const r = await opts.web.call("open_tab", { url: u.url.href, ...("tabId" in l.surface ? { near: l.surface.tabId } : {}) });
    const info = r.data as { tabId?: number; docId?: string; title?: string; url?: string } | null;
    if (r.unknown || r.text === "ブラウザが応答しません") return { ok: false, why: "driver", hint: opts.webReady?.() === false ? noExt : "ブラウザの返事がありません。tab が開いたかどうか分かりません。同じ操作を繰り返さず、人に「新しい tab が開いたか」を確かめてもらってください" };
    if (!Number.isInteger(info?.tabId)) return { ok: false, why: "driver", hint: `tab を開けませんでした（${r.text.slice(0, 200)}）` };
    if (!info!.docId) return { ok: false, why: "surface", hint: `tab は裏で開きましたが、読み込みが終わらず面にできませんでした（${r.text.slice(0, 120) || "頁が重いか、拡張が触れない頁"}）。人にその tab を渡してもらってください` };
    if (!freeAsk.has(l) && table.get(k) !== l) return { ok: false, why: "gen", hint: "tab は裏で開きましたが、その間に操作権を取り戻されたので面にしていません。止まってください" };
    const g = give({ tabId: info!.tabId!, docId: info!.docId, app: "web", title: (info!.title || info!.url || u.url.href).slice(0, 120), url: info!.url ?? u.url.href }, l.owner, false);
    if (!g.ok) return { ok: false, why: "tool", hint: `tab は裏で開きましたが、面にできませんでした（${g.why}）` };
    if (!freeAsk.has(l)) { // 面なしの仮 lease には戻す手の帳は無い
    const st = undoOf.get(l) ?? [];
    st.push({ tool: "open_tab", irreversible: "開いた tab は閉じません（要らなければ人が閉じてください）" });
    if (st.length > UNDO_MAX) st.shift();
    undoOf.set(l, st);
    undoAt.set(l, ++undoSeq);
    }
    const name = Object.entries(faceNames(facesOf(l.owner))).find(([, t]) => t === tokenOf(g.lease))?.[0] ?? "tab2";
    if (silent) opts.onOpened?.({ owner: l.owner, kind: "tab", label: u.url.origin });
    return { ok: true, isError: false, text: `新しい tab を裏で開き、面「${name}」として渡されました（${g.lease.surface.title}）。この面は \`act --on ${name} <操作>\` で操作できます（まず get_window_state）。元の面は --on で元の名前を指してください` };
  };
  const api = {
    list: () => [...table.values()].map((l) => ({ key: keyOf(l.surface), ...l, token: tokenOf(l), undo: undoOf.get(l)?.length ?? 0, rights: capOf(l, modeOf(l.surface)[0], now(), modeOf(l.surface)[1]) })), // undo = 戻せる手の数だけ（値は出さない）
    facesOf,
    runCmd,
    launchApp,
    confirmApi,
    openAppFree,
    openAppHuman,
    opRun,
    check,
    // AW1: Runtime（src/anywindow.ts）の承認。名前つき操作 1 件を card にして人に聞く＝askHuman と同じ card・答え口 answer・時間切れ・答えた後の世代の確認。ok:true = 人が許した
    async askOp(token: string, tool: string, what: string): Promise<{ ok: true } | { ok: false; why: Why; hint: string }> {
      const c = check(token);
      if (!c.ok) return c;
      const { no } = await asked(c.lease, token.split("|")[0]!, Number(token.split("|")[1]), tool, {}, { label: tool, unsure: false, what });
      return no ?? { ok: true };
    },
    apiTab,
    openTabFree,
    touchedOf: (owner: string): string[] => touched.get(owner) ?? [], // W38
    touchedDrop: (owner: string) => { touched.delete(owner); }, // W38: 会話が消えた時に忘れる（main.ts の remove）
    give,
    // mod の走りの間だけ、その持ち主の面に宣言の強さの上限を付ける（turn が終わると外れる）
    setCap: (owner: string, cap: "read" | undefined) => { for (const l of table.values()) if (l.owner === owner) l.cap = cap; },
    takeback: (k: string) => revoke(k) !== null,
    // 全停止: 渡してある全部の面の操作権を取り戻す（承認待ちも実行しない・世代が上がるので以後の操作は 拒否(gen)）
    stopAll: () => [...table.keys()].map(revoke).filter(Boolean).length,
    approvals: () => [...waits.values()].map((w) => w.a),
    recoveries: (): Recovery[] => [...recov.values()].filter((x) => x.steps[0]!.at >= now() - RECOV_MS),
    // yes=その 1 件だけ許す / turn=この頼みの間この窓に許す（同じ窓で待っている他の card も許される） / 断る
    // 人が「続けて」「やりました」と言った（図 §47）: 旗を落とす。読み直すまで書けない（まだ出ていれば読んだ時にまた立つ）
    authCards: () => auth.list(),
    // W76a: 認証 card の返事。done = 人が済ませた（旗を落とす）・deny = やめる（旗は残す＝agent は書けないまま）。allow / always / register は W76c / d
    authTake: (id: string, choice: unknown) => auth.take(id, choice),
    authDismiss: (owner: string) => auth.dismissOwner(owner),
    authFronted: (key: string) => auth.markFronted(key), // W76b: 人が絵を押して面を前に出した（peekFront が成功した時だけ）
    authOpen: (key: string) => !!auth.byKey(key)?.fronted, // W76b: 人がその面で認証している間（人の入力・認証後の移動で面を取り戻さない）
    humanDone: (owner: string) => facesOf(owner).filter((l) => humanOf.delete(l)).map((l) => {
      auth.dismissOwner(owner);
      unsureOf.add(l);
      rearmGate(l); // 頁に残した WebAuthn の印を消して見張りを張り直す
    }).length,
    humanAsked: (owner: string) => facesOf(owner).map((l) => humanOf.get(l)).find((x) => x),
    answer: (id: string, yes: boolean, turn = false) => {
      const w = waits.get(id);
      if (!w) return false;
      if (w.a.danger) turn = false; // 取り返しがつかない物に「この頼みの間」は無い。他の card も巻き込まない
      if (yes && turn) for (const o of [...waits.values()]) if (o !== w && o.a.key === w.a.key && !o.a.danger) o.settle("turn");
      w.settle(yes ? (turn ? "turn" : "yes") : "no");
      return true;
    },
    // その会話の turn が終わった（agent の process が終わった）。この頼みの間の許しを消し、待っている card も実行しない
    endTurn: (owner: string) => {
      let n = 0;
      running.get(owner)?.(); // turn が終わったら走っている command も止める
      partialOf.delete(owner); // 途中までの読みの印は turn の物
      for (const a of [...apps.values()].filter((x) => x.owner === owner)) { const key = a.key; dropApp(a); if (key && table.has(key)) revoke(key); } // 起こした app と、その面も（W31a）
      dropImgs(owner);
      for (const l of table.values()) if (l.owner === owner) { cursorOf.delete(l); if (overlay.delete(l)) void driverOf(l)?.call("set_agent_cursor_enabled", { enabled: false }).catch(() => {}); } // turn が終わったら仮想カーソルも overlay も消す
      turnNo.set(owner, (turnNo.get(owner) ?? 0) + 1);
      for (const l of table.values()) if (l.owner === owner) { undoOf.delete(l); if (l.turnAllow || l.cap || l.appBatch) { l.turnAllow = undefined; l.appBatch = undefined; l.cap = undefined; n++; } }
      for (const w of [...waits.values()]) if (w.a.owner === owner) w.settle("gone");
      for (const l of table.values()) if (l.owner === owner) for (const f of [...(gone.get(keyOf(l.surface)) ?? [])]) f(); // 資源の空き待ちも実行しない
      if (n) opts.onChange?.();
      return n;
    },
    // この会話の操作の列を取り出して捨てる（turn の終わり）。蒸留に使う
    takeSteps: (owner: string) => { // ponytail: 2 枚の時は steps の多い面 1 枚だけを蒸留に出す（面をまたぐ手順は未対応）
      const ls = facesOf(owner), l = ls.reduce<Lease | undefined>((a, x) => ((x.steps?.length ?? 0) > (a?.steps?.length ?? 0) ? x : a), undefined);
      const out = l?.steps?.length ? { app: l.surface.app, steps: l.steps } : null;
      for (const x of ls) x.steps = undefined;
      return out;
    },
    setMode: (app: string, m: Mode, surfaceKey?: string) => { if (surfaceKey) surfaceModes.set(surfaceKey, m); else if (app === "*") modeDefault = m; else modes.set(app, m); save(); }, // surfaceKey = その面だけ。無い時は人が明示した app 単位（"*" = 既定）
    modes: () => ({ default: modeDefault, ...Object.fromEntries(modes) }),
    // 人がその app に触った（前面にした）。持ち主の居る面なら取り戻す
    // 人の今を知らせる（W11d）。front = 前面の app の pid / tab = 窓が前面の browser で選択中の tab（browser が前面でなければ null）/ input = 入力した面（pid か tabId だけ）
    seeFront: (pid: number) => { seen.front = pid; seen.moved = ++seen.seq; recheck(); },
    seeTab: (tabId: number | null) => { seen.tab = tabId; seen.moved = ++seen.seq; recheck(); },
    seeInput: (on: { pid: number } | { tabId: number }) => { seen.input = { ...on, seq: ++seen.seq }; for (const l of table.values()) if (l.hold && ("tabId" in on ? "tabId" in l.surface && l.surface.tabId === on.tabId : "pid" in l.surface && l.surface.pid === on.pid)) stirred.add(l); recheck(); },
    touch: (pid: number, except?: (key: string) => boolean) => [...table.values()].filter((l) => !l.hold && "pid" in l.surface && l.surface.pid === pid && !except?.(keyOf(l.surface))).map((l) => revoke(keyOf(l.surface))).length,
    // 人がその tab を前面にした・窓を移した・入力した。持ち主の居る tab なら取り戻す
    touchTab: (tabId: number) => (table.get(`tab:${tabId}`)?.hold ? 0 : revoke(`tab:${tabId}`) ? 1 : 0), // hold 中（まだ何も書いていない）は取り戻すものが無い
    // tab が移動した。agent 自身の操作の直後の link 移動なら、持ち主を保ったまま世代を上げて操作権を返す。人が起こした・分からない移動は取り戻す（安全側）
    async navigated(tabId: number, nav: { startedAt: number; type: string; quals: string[] }): Promise<number> {
      const k = `tab:${tabId}`;
      const l = table.get(k);
      if (!l || !("tabId" in l.surface)) return 0;
      const op = l.op;
      l.op = undefined; // 1 つの操作で説明できる移動は 1 回だけ
      const authNav = !!auth.byKey(k)?.fronted; // W76b: 人が認証している面の移動（login 後の遷移）は人の操作として許す。面は保ち、世代と頁の印だけ更新する（gate の旗は読み直しで落ちる）
      const agent = authNav || !!op && nav.startedAt >= op.start && nav.startedAt <= (op.end ?? Infinity) + NAV_AFTER_MS && AGENT_NAV.includes(nav.type) && nav.quals.every((q) => q === "server_redirect");
      l.lastNav = { type: nav.type, afterEnd: op?.end != null ? nav.startedAt - op.end : null, fromStart: op ? nav.startedAt - op.start : null }; // 観測用（NAV_AFTER_MS を実測で決めた根拠。leaseList に出る）
      if (!agent) return revoke(k) ? 1 : 0;
      const job = (async () => {
        // 新しい文書の見張り（人の入力）もここで入る。回数でなく 1.5 秒の締切（遅い機械は 1 回の往復が長く、3 回では先に尽きた）
        let info = null as { docId?: string; title?: string; url?: string } | null;
        await pollUntil(async () => { info = (await opts.web?.call("tab_info", { tabId }))?.data ?? null; return info?.docId; }, 1500, 150);
        if (table.get(k) !== l) return 0; // 待つ間に人が触って取り戻された
        if (!info?.docId) return revoke(k) ? 1 : 0; // 新しい文書を読めない＝分からない
        l.prior = [...(l.prior ?? []), l.gen];
        l.turnAllow = undefined; // 世代が変わる＝頁が移った。許しは前の頁の物
        undoOf.delete(l);
        l.gen = Math.max(floor[k] ?? 0, l.gen) + 1;
        floor[k] = l.gen;
        l.surface = { ...l.surface, docId: info.docId, title: (info.title || info.url || l.surface.title).slice(0, 120), url: info.url };
        l.note = `（ページが移動しました: ${l.surface.title}。get_window_state を読み直してください）`;
        save();
        return 0;
      })();
      l.adopting = job;
      return job as Promise<number>;
    },
    // 落ちた後の復帰: file の床 +1 で世代を上げて「分かった」にする。床が無ければ黙って 0 から始めない
    reconfirm(k: string): { ok: true; lease: Lease } | { ok: false; why: Why } {
      const l = table.get(k);
      if (!l) return { ok: false, why: "unknown" };
      if (floor[k] === undefined) return { ok: false, why: "no-floor" };
      l.gen = floor[k]! + 1;
      l.turnAllow = undefined; // 世代が変わる
      undoOf.delete(l);
      floor[k] = l.gen;
      l.exp = now() + LEASE_MS;
      l.confirmed = true;
      save();
      return { ok: true, lease: l };
    },
    // 門。実行の直前に毎回、上から順に確かめる（図 §29）
    // 仮想カーソル: 押す・引く・回す直前にその点へ動かす（本物のポインタには触れない）。on の時だけ、窓が人に見えていれば cua の overlay も（scope=window・desktop は使わない）
    cursor: (token: string): VCursor | undefined => { const l = table.get(String(token ?? "").split("|")[0]!); return l && cursorOf.get(l); },
    async act(token: string, tool: string, args: Record<string, unknown>, human = false) {
      const k = String(token ?? "").split("|")[0]!;
      while (!human && undoing.has(k)) await undoing.get(k)!.catch(() => {});
      const p = this.actNow(token, tool, args, human);
      if (opts.record) void p.then((r) => { // 記録の失敗は操作に響かせない
        try {
          const l = table.get(k), e0 = elementsOf.get(l ?? {})?.[String(args.element_token ?? "")], role = String(e0?.role ?? "");
          const nameSecret = /pass|secret|otp|one.?time|\bpin\b|cvv|cvc|security.?code|暗証|パスワード|認証コード|ワンタイム/i.test(String(args.field ?? ""));
          const secret = ((/secure|password/i.test(role) || e0?.secure === true) && ["type_text", "set_value"].includes(tool)) || (["fill", "select_option"].includes(tool) && (nameSecret || !r.ok)); // review26: web の password 欄は role が textbox なので secure の印も見る。review-press ③: fill/select_option は element_token が無く e0 で role を見られないので、欄名が秘密っぽい時・断られた時は値を伏せる
          const raw = tool === "type_text" || tool === "set_value" || tool === "fill" || tool === "select_option" ? String(args.text ?? args.value ?? args.option ?? "") : JSON.stringify(Object.fromEntries(Object.entries(args).filter(([a]) => PASS.includes(a) && a !== "element_token" && a !== "text" && a !== "value" && a !== "option")));
          opts.record!({ at: now(), face: k, app: l?.surface.app ?? "", owner: l?.owner ?? "", where: String(l?.surface.title ?? "").replace(/\s+/g, " ").slice(0, 40), gen: Number(String(token ?? "").split("|")[1]), op: String(tool).slice(0, 40), value: secret ? "〈伏せ〉" : raw.slice(0, 80), result: r.ok ? (r.isError ? "error" : "ok") : `refused:${r.why}` });
        } catch {}
      });
      const set = flying.get(k) ?? flying.set(k, new Set()).get(k)!;
      set.add(p);
      void p.then(() => {}, () => {}).then(() => { set.delete(p); if (!set.size && flying.get(k) === set) flying.delete(k); });
      return p;
    },
    async actNow(token: string, tool: string, args: Record<string, unknown>, human = false): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; why: Why; hint: string }> {
      const c = check(token);
      if (!c.ok) return c;
      const l = c.lease, k = String(token).split("|")[0]!, gen = Number(String(token).split("|")[1]);
      if (!ALLOWED.includes(tool)) return { ok: false, why: "tool", hint: `使える操作: ${ALLOWED.join(", ")}` };
      if (tool === "open_tab") return openTab(l, k, gen, args);
      const s = l.surface;
      let waited = false; // 門の確認から送るまでに待ちが挟まったか（承認・人が離れるのを待つ・資源の順番待ち）
      if (tool === "hotkey" && clipKeys(args)) return { ok: false, why: "tool", hint: CLIP_HINT };
      if ("tabId" in s && tool === "hotkey") {
        const keys = (Array.isArray(args.keys) ? args.keys : []).map((x) => String(x).toLowerCase());
        if (keys.some((x) => x === "cmd" || x === "command" || x === "ctrl" || x === "control") && BROWSER_KEYS.includes(keys.at(-1) ?? "")) return { ok: false, why: "tool", hint: `${keys.join("+")} は browser 自身の操作（tab の開閉・移動・アドレスバーなど）で、web の面からは送れません。ページの中の操作は click / type_text で` };
      }
      // 記号・文字は press_key だと黙って別の結果になる（+ = が入らず 7 8 だけ入る）。type_text に寄せる
      if (tool === "press_key" && [...String(args.key ?? "")].length === 1) return { ok: false, why: "tool", hint: "文字・記号は press_key ではなく type_text で入れてください（press_key は return / tab / escape / 矢印などの名前の key だけ）" };
      if (tool === "web_op" && !("tabId" in s)) return { ok: false, why: "tool", hint: "web_op は web の tab を渡された時だけ使えます（app の窓は element_token で）" };
      if (NAMED.includes(tool) && !("tabId" in s)) return { ok: false, why: "tool", hint: `${tool} は web の tab を渡された時だけ使えます（app の窓は element_token で）` };
      if (READ_URL.includes(tool) && !("tabId" in s)) return { ok: false, why: "tool", hint: `${tool} は web の tab を渡された時だけ使えます` };
      let offSpace = false;
      const d = "tabId" in s ? opts.web : driverOf(l);
      if (!d) return { ok: false, why: "driver", hint: "画面を操作する準備ができていません" };
      // 読む先は、渡された tab の今の site（origin）だけ。人の cookie が乗るので、別の site には使わせない。url を省くと tab の今の頁
      let readUrl: string | undefined;
      if (READ_URL.includes(tool) && "tabId" in s) {
        const info = (await d.call("tab_info", { tabId: s.tabId })).data as { url?: string } | null;
        if (!info?.url) return { ok: false, why: "driver", hint: "ブラウザが応答しません。もう一度" };
        try {
          const u = new URL(String(args.url ?? info.url), info.url);
          if (!/^https?:$/.test(u.protocol) || u.origin !== new URL(info.url).origin) throw 0;
          readUrl = u.href;
        } catch { return { ok: false, why: "tool", hint: `${tool} で読めるのは、渡された tab と同じ site（${(() => { try { return new URL(info.url!).origin; } catch { return "?"; } })()}）の URL だけです` }; }
      }
      if ("tabId" in s) {
        const st = (await d.call("tab_state", { tabId: s.tabId })).data as { exists: boolean; docId?: string } | null;
        if (!st) return { ok: false, why: "driver", hint: "ブラウザが応答しません。もう一度" };
        if (!st.exists) return { ok: false, why: "surface", hint: "その tab はもうありません" };
        // 再読み込み・別 site への移動で文書が変わった: 古い操作権を新しい文書に効かせない（世代を上げて止める）
        if (st.docId !== s.docId && l.adopting) await l.adopting; // 移動の判定が終わるのを待つ（agent が起こした移動なら docId が追い付く）
        if (table.get(k) !== l) return { ok: false, why: "gen", hint: "操作権は取り戻されました。止まってください" };
        if (st.docId !== (l.surface as Extract<Surface, { tabId: number }>).docId) { revoke(k); return { ok: false, why: "gen", hint: "tab の文書が変わったので操作権は取り戻されました。止まってください" }; }
      } else {
        const wins = (await d.call("list_windows", {})).data?.windows as { pid: number; window_id: number; on_current_space?: boolean }[] | undefined;
        if (!wins) return { ok: false, why: "driver", hint: "画面を読めませんでした（機械が混んでいます）。もう一度" }; // 読めない事と窓が無い事を混ぜない
        const w = wins.find((x) => x.pid === s.pid && x.window_id === s.windowId);
        if (!w) return { ok: false, why: "surface", hint: "その窓はもうありません" };
        // 別の Space（デスクトップ・全画面の Space）の窓。押す・書くは測れるまで理由つき拒否のまま。読むだけは、まず driver（cua は窓が AXWindows に在れば別 Space でも読める作り・
        // 上流 background_input.rs:226 / macos-background-input-v1-plan.md §7・実窓は未測）に任せ、要素 0 件の時だけ普通の AX の helper で読む（下の offSpaceRead）
        if (w.on_current_space === false) {
          if (tool !== "get_window_state") return { ok: false, why: "surface", hint: "その窓は、人がいま見ている画面（Space）とは別の Space にあります。読むだけなら get_window_state で読めます。押す・書くは、人がその窓のある Space に移ってからです。人に伝えてください" };
          offSpace = true;
        }
      }
      // await の間に取り戻されていたら、実行しない
      if (table.get(k) !== l) return { ok: false, why: "gen", hint: "操作権は取り戻されました。止まってください" };
      // 人にしかできない確認が出ている面（図 §47）: 読む以外は門が断る。agent の返事ではなく門が止める
      if (!READ_ONLY.includes(tool) && !human && humanOf.has(l)) return { ok: false, why: "human", hint: HUMAN_HINT(humanOf.get(l)!) };
      if (tool === "open_app") return openApp(l, k, gen, args);
      if (tool === "web_op") return webOp(l, k, gen, args);
      if (tool === "window_image" && "tabId" in s) return { ok: false, why: "tool", hint: "window_image は app の窓の面だけです（web の tab の絵は読みません。頁の中身は get_window_state / fetch_url で）" };
      // 人が見ている面を任された（図 §55）: 書き換えは人が離れるまで送らない。読むだけは待たせない
      // W49: 定時（routine）で起きた会話は、面を任された時に人が居なくても、書く時に人がその面を見ていれば離れるまで待つ（hold と同じ判定・面に触らない仕事は何も待たない）
      const forced = !READ_ONLY.includes(tool) && !human && !l.hold && !!opts.scheduled?.(l.owner) && onSurface(l); // この待ちは定時だから足した hold（待ちを諦める時は戻す＝次の人の turn に残さない・review27）
      if (forced) l.hold = true;
      if (!READ_ONLY.includes(tool) && !human && l.hold) {
        waited = true;
        l.waitSince ??= now();
        opts.onChange?.();
        const left = await waitLeave(l, k);
        if (table.get(k) !== l) return { ok: false, why: "gen", hint: "操作権は取り戻されました。止まってください" };
        if (!left) { if (forced) { l.hold = false; l.waitSince = undefined; opts.onChange?.(); } return { ok: false, why: "waiting", hint: "まだ始めていません: 人がこの面を見ているので、離れるまで書き換えを送っていません（何も変えていません）。get_window_state で読むのはいつでもできます。書き換えは同じ操作をもう一度送ると、人が離れた時に始まります" }; }
        l.hold = false;
        l.waitSince = undefined;
        opts.onChange?.();
        // hold 中は人が触っても取り戻さない（まだ何も書いていない）ので、agent の読んだ木は古いかもしれない。最初の書き換えは送らず、読み直させる
        if (stirred.delete(l)) { unsureOf.add(l); return { ok: false, why: "result", hint: "まだ何も変えていません: 待っている間に人がこの面を操作したので、読んだ内容が古いかもしれません。get_window_state で読み直してから書き換えてください" }; }
      }
      // 承認（図 §35）: 壊しうる操作は、面の表が「許す」でなければ実行しない。agent の返事ではなく門がここで止める
      const els0 = elementsOf.get(l);
      // W60d: press_button は押す前に、そのボタンの名前を全部（見える文字・aria-label・title）受け取って危険語を見る（agent が渡した名前だけ見ると、aria-label の「次へ」で見える文字「削除」のボタンを押させられる）。見つからない・決まらないは card の前に返す
      let btnNames: string[] | undefined;
      if (tool === "press_button" && "tabId" in s && !human) {
        let pr: Awaited<ReturnType<Driver["call"]>>;
        try { pr = await d.call("button_names", { name: String(args.name ?? ""), tabId: s.tabId, docId: s.docId, gen: l.gen }); } catch (e: any) { return { ok: false, why: "driver", hint: `ブラウザが答えませんでした（${String(e?.message ?? e).slice(0, 80)}）` }; }
        if (pr.isError) return { ok: false, why: "tool", hint: String(pr.text || "そのボタンは見つかりません").slice(0, 400) };
        if (Array.isArray(pr.data?.names)) btnNames = (pr.data.names as unknown[]).map((x) => String(x).slice(0, 120)); // 古い拡張は button_names を知らず何も返さない: 名前だけで見る今までの道（押さないので安全）
      }
      const el = tool === "press_button" ? { role: "button", label: btnNames ? btnNames.join(" / ") : String(args.name ?? "") } : els0?.[String(args.element_token ?? (CLICKS.includes(tool) ? "" : focusOf.get(l) ?? ""))]; // 名前つきのボタンは、名前そのものを危険語の判定に使う
      if (CLICKS.includes(tool) && el && clipMenu(el.role, el.label)) return { ok: false, why: "tool", hint: CLIP_HINT };
      if (!human) { const h = pixelHint(tool, args, els0); if (h) return { ok: false, why: "tool", hint: h }; }
      if (!human && "tabId" in s && ["click", "type_text", "set_value"].includes(tool) && opts.namedOnly?.()) { const h = namedHint(tool, args, el, els0); if (h) return { ok: false, why: "tool", hint: h }; }
      const kind = classify(tool, args, el);
      if (!READ_ONLY.includes(tool) && unsureOf.has(l)) return { ok: false, why: "result", hint: "直前の操作は結果不明のままです。先に get_window_state で読み直して、実行されたかを確かめてください（確かめるまで書き換えは送れません）" };
      if (!READ_ONLY.includes(tool) && !human) { // human = 人が押した「1 手戻す」（承認は挟まない）
        // mod の宣言が「読むだけ」の走り（W6a）。宣言より強い操作は、表が「許す」でも門が断る
        if (l.cap === "read") return { ok: false, why: "mod", hint: "この mod は「読むだけ」と宣言しています。書き換えはできません。読んで分かった事を人に伝えてください" };
        const m = modeOf(s)[0];
        if (m === "off") return { ok: false, why: "off", hint: `「${s.app}」は人が「読むだけ」にしています。書き換えはできません。読んで分かった事を人に伝え、どうするか聞いてください` };
        const docsWrite = "tabId" in s && /^https:\/\/docs\.google\.com\//.test(String(s.url ?? "")) && ["type_text", "set_value", "press_key", "hotkey", "fill", "select_option", "press_button"].includes(tool); // W47: Google Docs の編集面への書き込みは、面の表が「許す」でも「この頼みの間」でも毎回聞く
        const danger = docsWrite || (kind !== "write" && kind !== "read" && !(l.appBatch && kind === "unsure" && CLICKS.includes(tool))); // W32: 登録 app の面は、人が起動を許した turn の間、押す先が分からない click をまとめて許す（DANGER 語・送信・Enter は従来どおり毎回）
        // 取り返しがつかない物は「この頼みの間」の許しがあっても 1 件ずつ聞く
        if ((m === "ask" && (!l.turnAllow || danger)) || (m === "allow" && danger)) {
          waited = true;
          const { v, no } = await asked(l, k, gen, tool, args, danger ? { label: el?.label ?? "", unsure: kind === "unsure", ...(docsWrite ? { what: tool === "type_text" || tool === "set_value" ? `Google Docs の本文に「${shownText(args.text ?? args.value ?? "", 200)}」を入れる` : `Google Docs の本文で ${whatOf(tool, args)}` } : {}), note: docsWrite ? `Google Docs の本文に書き込みます。書く内容を上で確かめてから許してください（1 回ごとに聞きます）${partialWarn(l.owner, args)}` : kind === "crossing" ? CROSS_NOTE : m === "allow" ? (kind === "unsure" ? "この app は「許す」ですが、押す先が分からないので聞きます" : "この app は「許す」ですが、取り返しがつかない操作なので聞きます") : undefined } : undefined);
          if (no) return no;
          if (v === "turn") l.turnAllow = true; // danger の答えは answer() が turn を落とす
        }
      }
      const clean = Object.fromEntries(Object.entries(args).filter(([a]) => PASS.includes(a) && !STRIP.includes(a)));
      // 窓の木は既定で絞る（既定のままだと大きい木で driver が 20 秒を超える・画像も返らなくてよい）
      const dflt = tool === "window_image" ? { include_screenshot: true, max_elements: 1, max_depth: 1, timeout_ms: 8000 } : tool === "get_window_state" ? { include_screenshot: false, max_elements: 300, max_depth: 40, timeout_ms: 4000 } : {};
      const cur = l.surface; // 移動を 1 度経ていれば docId は新しい
      const op: Lease["op"] = "tabId" in cur && tool !== "get_window_state" && !READ_URL.includes(tool) ? (l.op = { start: now(), end: null }) : undefined;
      if (args.element_token != null && !READ_ONLY.includes(tool)) focusOf.set(l, String(args.element_token));
      const res = resourceOf(tool, args, cur, el);
      let release = () => {};
      if (res) { waited = true; // 承認の後・送る直前に取る（人の答えを待つ間は握らない）
        const g = await hold(res, k, l);
        if (!g.ok) return g;
        release = g.release;
      }
      const wr = !READ_ONLY.includes(tool);
      // W11c-3（図 §54）: 順番待ちの間に取り戻されていたら、送らない。cua の書き込みは窓が同じかも直前に確かめる（拡張には gen を渡し、拡張が実行の直前に比べる）
      const prevented = (hint: string) => { release(); const rec = recov.get(k); if (rec && rec.owner === l.owner) { rec.steps.push({ phase: "prevented", at: now() }); opts.onChange?.(); } return { ok: false as const, why: "gen" as Why, hint }; };
      const lost = () => table.get(k) !== l || (l.gen !== gen && !l.prior?.includes(gen));
      const sleep = (ms: number) => new Promise((x) => setTimeout(x, ms));
      // W60a: 窓への書き込みは、送る直前（最後の 1 手）に、その窓の app が前面で人が今入力していないかを見る。入っていたら送らず、少し待つ（4 回見ても入っていたら止める）
      const winWrite = wr && !human && !("tabId" in cur) && !!opts.frontPid && !!opts.hidIdle; // 常駐（main.ts）が本物の読みを渡す。渡さない所（試験の多く）は見ない
      const humanIn = async (): Promise<boolean> => { if ((await opts.frontPid!()) !== (cur as { pid: number }).pid) return false; const idle = await opts.hidIdle!(); return idle != null && idle < HUMAN_IDLE_S; };
      if (winWrite) for (let n = 0; await humanIn(); n++) {
        if (n >= 3) { release(); return { ok: false, why: "waiting", hint: "まだ送っていません: 人が今この窓に入力しています（何も変えていません）。少し待って get_window_state で読み直してから、もう一度送ってください" }; }
        await sleep(opts.humanPollMs ?? 500);
      }
      if (lost()) return prevented("操作権は取り戻されました。止まってください（何も送っていません）");
      if (wr && waited && !("tabId" in cur)) {
        let wins: { pid: number; window_id: number }[] | undefined;
        try { wins = (await d.call("list_windows", {})).data?.windows; } catch { release(); return { ok: false, why: "driver", hint: "画面を読めませんでした。何も送っていません。もう一度" }; } // 落ちても握った資源を残さない
        if (lost()) return prevented("操作権は取り戻されました。止まってください（何も送っていません）");
        if (wins && !wins.some((x) => x.pid === cur.pid && x.window_id === cur.windowId)) { release(); return { ok: false, why: "surface", hint: "その窓はもうありません（何も送っていません）" }; }
      }
      const turn0 = turnNo.get(l.owner) ?? 0;
      const sent: Sent = { tool, token: String(args.element_token ?? focusOf.get(l) ?? ""), text: String(args.text ?? args.value ?? "") };
      if (wr) { sentOf.set(l, (sentOf.get(l) ?? 0) + 1); inflightOf.set(l, [...(inflightOf.get(l) ?? []), sent]); }
      const vc = POINTING.includes(tool) ? pointTo(l, tool, args, el, d) : undefined;
      let r: Awaited<ReturnType<Driver["call"]>>;
      // W54b: 裏の窓への drag は、cua が拒否する（上流 drag.rs:233）。自己確認が通った自前の注入器（tools/drag-post.swift）がある時だけ、**貸した窓**（pid・窓番号は面から取る・agent の引数は見ない）へ pid 宛ての列を送る。無い・自己確認が落ちた・点が窓の外なら cua の拒否のまま（DRAG_HINT で止まる＝本物のポインタの道には落ちない）
      const viaPost = tool === "drag" && !("tabId" in cur) && opts.dragPost?.ready() === true;
      const callIt = () => viaPost ? dragViaPost(d, cur as { pid: number; windowId: number }, clean) : d.call(tool === "window_image" ? "get_window_state" : tool, { ...dflt, ...clean, ...(readUrl ? { url: readUrl } : {}), ...(wr && !human && "tabId" in cur ? { guard: true } : {}), ...(btnNames ? { expect: btnNames } : {}), ...("tabId" in cur ? { tabId: cur.tabId, docId: cur.docId, gen: l.gen } : { pid: cur.pid, window_id: cur.windowId }) });
      const t0 = Date.now();
      try {
        r = await callIt();
        // W60a: 拡張が書く瞬間に「人がこの tab を今操作している」と返したら（頁の中で hasFocus と人の最後の入力時刻を見る）、送っていない。少し待って送り直す（人は待たされない）
        for (let n = 0; n < 3 && r.data?.human === true; n++) { await sleep(opts.humanPollMs ?? 500); r = await callIt(); }
      }
      catch (e: any) { r = { text: `driver が落ちました: ${String(e?.message ?? e).slice(0, 120)}`, isError: true, data: null, unknown: true }; } // 送った後に throw したら結果不明（sentOf を残さない・W11f と同じ止め方）
      finally { release(); if (vc && vc.down) vc.down = undefined; }
      // W60a: 送っている間に人が入力した（前面がこの窓の app で、人の最後の入力が送り始めより後）なら、どちらの入力が効いたか分からない＝結果不明にして読み直させる
      if (winWrite && !r.isError && !r.unknown && (await opts.frontPid!()) === (cur as { pid: number }).pid) { const idle = await opts.hidIdle!(); if (idle != null && idle * 1000 <= Date.now() - t0) r = { ...r, unknown: true }; }
      if (typeof r.data?.gate === "string" && !human) raiseAuth(k, l, humanGate({ gate: r.data.gate }) ?? "人にしかできない確認"); // 頁が呼んだ WebAuthn など、読む前に起きた物
      if (op) op.end = now();
      if (tool === "window_image") { // W16a: AX が少ない app（Zed）の中身は絵で読む。file に置いて agent が Read する（shots は Read の許可内）。持ち主の turn が終わると消す
        if (r.isError || r.unknown || !r.img) return { ok: false, why: "result", hint: r.isError ? `絵を撮れませんでした: ${r.text.slice(0, 120)}` : "絵が返りませんでした（システム設定の「画面収録」の許可が cua-driver に無いかもしれません）。人に伝えてください" };
        const j = shrink(r.img.data, 1400);
        if (!j) return { ok: false, why: "result", hint: "絵を縮められませんでした" };
        const dir = winDir(home, l.owner);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const f = join(dir, `win-${crypto.randomUUID()}.jpg`);
        if ((turnNo.get(l.owner) ?? 0) !== turn0) return { ok: false, why: "gen", hint: "この頼みは終わりました（絵は残していません）" };
        writeFileSync(f, Buffer.from(j, "base64"), { mode: 0o600 });
        (imgs.get(l.owner) ?? imgs.set(l.owner, new Set()).get(l.owner)!).add(f);
        return { ok: true, text: `${l.surface.app} の窓の絵: ${f}（Read で開いて見る。この頼みが終わると消えます）`, isError: false };
      }
      if (wr) { // 返事が来た。取り戻しの後なら、送った物の結末を履歴に残す（W11c）
        const left = (sentOf.get(l) ?? 1) - 1;
        sentOf.set(l, left);
        if (r.unknown !== true) inflightOf.set(l, (inflightOf.get(l) ?? []).filter((x) => x !== sent)); // 返事が来た物は的から外す（結果不明は残す）
        const rec = recov.get(k);
        if (rec && table.get(k) !== l && left === 0 && rec.owner === l.owner) { const res = r.unknown ? "unknown" : "confirmed"; if (rec.phase === "verifying") mark(rec, res); else if (rec.phase !== "confirmed" && rec.phase !== "unknown") early.set(rec, res); } // 止まったと分かる前に返事が来た: 結果を確認中に入った時に反映（順番を崩さない）
      }
      // W54: 裏の窓への drag は、macOS に人のポインタを使わずに送る道が無く cua が拒否する（上流 drag.rs:233-234・原文は docs/verify/w54/SOURCES.md）。delivery_mode は STRIP が落とすので、前面に出して本物のポインタを動かす道（foreground）には落ちない。代わりの道を言って止まる
      if (tool === "drag" && !("tabId" in cur) && (r.data?.code === "background_unavailable" || /background_unavailable/.test(r.text))) return { ok: false, why: "tool", hint: DRAG_HINT };
      if (r.data?.human === true && !READ_ONLY.includes(tool)) return { ok: false, why: "waiting", hint: "まだ送っていません: 人が今この tab を操作しています（何も変えていません）。少し待って get_window_state で読み直してから、もう一度送ってください" }; // W60a: 4 回送り直しても人が居た
      if (r.unknown && !READ_ONLY.includes(tool)) { // 結果不明: 「やり直す」と言わない。戻す記録にも「戻せません」で積む
        unsureOf.add(l);
        if (!human) { const st = undoOf.get(l) ?? []; st.push({ tool, irreversible: "結果不明" }); if (st.length > UNDO_MAX) st.shift(); undoOf.set(l, st); undoAt.set(l, ++undoSeq); }
        return { ok: false, why: "result", hint: UNSURE_HINT };
      }
      if (tool !== "scroll" && READ_ONLY.includes(tool) && !r.isError && !r.unknown && (tool !== "get_window_state" || r.data?.elements?.length)) unsureOf.delete(l); // 読めた＝読み直した
      if (!human && !READ_ONLY.includes(tool) && !r.isError) {
        const st = undoOf.get(l) ?? [];
        const lbl = el?.label ? `「${el.label.replace(/\s+/g, " ").slice(0, 30)}」` : "この操作";
        const key = args.element_token != null ? String(args.element_token) : undefined;
        st.push(kind === "crossing" ? { tool, irreversible: `${lbl}（この tab の外にも効く操作）は取り消せません` }
          : kind === "destructive" ? { tool, irreversible: `${lbl}（送信・削除・購入など）は取り消せません` }
          : tool === "type_text" ? { tool, key, n: graphemes(String(args.text ?? "")) }
          : tool === "set_value" && el && !el.stale && (el.value ?? "").length < VIEW_VALUE ? { tool, key, before: (el.value ?? "").slice(0, UNDO_VALUE), after: String(args.value ?? "").slice(0, VIEW_VALUE) }
          : { tool, irreversible: tool === "set_value" ? "前の値が分かりません（読んだ後に変わったか、長くて切れています）" : "何を戻せばよいか分かりません" });
        for (const k of [key, focusOf.get(l)]) if (k && els0?.[k]) els0[k]!.stale = true; // 書いた要素の「読んだ時の値」はもう古い
        if (st.length > UNDO_MAX) st.shift();
        undoOf.set(l, st);
        undoAt.set(l, ++undoSeq);
      }
      const note = l.note ? `${l.note}\n` : "";
      l.note = undefined;
      // 窓の木は element_token つきの 1 行 1 要素で返す（click などはこの token で押す）
      const els = tool === "get_window_state" ? (r.data?.elements as any[] | undefined) : undefined;
      // 混んでいて読めなかった時、driver は要素 0 件を「成功」で返す。agent はそれを「権限が無い」と読んで人に頼んでしまう（UC3 実測）。読めなかった事を言う
      if (tool === "get_window_state" && !els?.length && offSpace && !("tabId" in cur)) return offSpaceRead(cur.pid, cur.windowId);
      if (tool === "get_window_state" && !els?.length) return { ok: true, text: note + "窓の中身を読めませんでした（機械が混んでいて応答が遅いようです。権限の問題ではありません）。少し待って、もう一度 get_window_state を呼んでください", isError: true };
      const gated = els?.map((e) => humanGate(e)).find((x) => x);
      if (gated && !human) raiseAuth(k, l, gated);
      // W76b: 人が面を前に出して認証した後、読み直した画面から入力欄（password・認証コード）が消えていたら、人が済ませたとみなして旗を落とす（「戻す」の押し忘れで agent を待たせ続けない）。
      // 人が絵を押した card（fronted）だけ・入力欄で見つけた種類（password・認証コード）だけ。passkey・CAPTCHA は画面に欄が無いので人の「戻す」だけ。読んだ直後なので「読み直せ」の印は付けない
      if (els && !gated && humanOf.has(l)) { const c = auth.byKey(k); if (c?.fronted && (c.kind === "password" || c.kind === "otp")) { humanOf.delete(l); auth.dismissKey(k); rearmGate(l); } }
      if (els) elementsOf.set(l, Object.fromEntries(els.map((e) => [String(e.element_token), { role: String(e.role), label: String(e.label ?? "").slice(0, 120), value: e.value == null ? undefined : String(e.value).slice(0, 120), c: centerOf(e), f: frameOf(e), secure: e.secure === true }])));
      if (els) l.kinds = Object.fromEntries(els.map((e) => [String(e.element_token), String(e.role).replace("AX", "")])); // 要素の種類（role）だけ。label・value は持たない
      else if (!r.isError && !READ_ONLY.includes(tool)) { // 蒸留の元（W6b）: 道具名・要素の種類・key の名前だけ。args の値・画面の文字は積まない
        const keys = tool === "press_key" ? String(args.key ?? "") : tool === "hotkey" && Array.isArray(args.keys) ? args.keys.join("+") : "";
        (l.steps ??= []).push({ tool, kind: ((k) => (/^[A-Za-z]{1,30}$/.test(k) ? k : ""))(l.kinds?.[String(args.element_token ?? "")] ?? ""), ...(/^[A-Za-z0-9+_ -]{1,30}$/.test(keys) ? { keys } : {}) });
        if (l.steps.length > 100) l.steps.shift();
      }
      const text = els
        ? [`snapshot ${r.data.snapshot_id} / 要素 ${els.length}${r.data.truncated ? "（途中まで）" : ""}`, ...els.map((e) => `${e.element_token}\t${String(e.role).replace("AX", "")}\t${[e.label, e.value].filter((x) => x).map((x) => String(x).slice(0, 80)).join(" = ")}`)].join("\n")
        : r.text;
      const stop = humanOf.get(l) && !human ? `\n【${HUMAN_HINT(humanOf.get(l)!)}】` : "";
      return { ok: true, text: (note + text).slice(0, 20_000 - stop.length) + stop, isError: r.isError };
    },
    // 人が押した「1 手戻す」。最後の 1 手だけ。戻せる物 = type_text（書いた分の backspace）と set_value（前の値）。戻せない物は理由 1 行で何もしない・順序を飛び越えない
    async undo(owner: string): Promise<{ ok: true; text: string } | { ok: false; hint: string }> {
      const l = facesOf(owner).filter((x) => undoOf.get(x)?.length).sort((a, b) => (undoAt.get(b) ?? 0) - (undoAt.get(a) ?? 0))[0] ?? facesOf(owner)[0]; // 最後に操作した面から
      if (!l) return { ok: false, hint: "戻す物がありません" };
      const k = keyOf(l.surface); // 戻す 1 本ずつ・動いている act（承認待ち含む）が終わってから
      const prev = undoing.get(k);
      const p = (async () => {
        await prev?.catch(() => {});
        while (flying.get(k)?.size) await Promise.allSettled([...flying.get(k)!]);
        return this.undoNow(l);
      })();
      const tail = p.then(() => {}, () => {});
      undoing.set(k, tail);
      void tail.then(() => { if (undoing.get(k) === tail) undoing.delete(k); });
      return p;
    },
    async undoNow(l: Lease): Promise<{ ok: true; text: string } | { ok: false; hint: string }> {
      const st = table.get(keyOf(l.surface)) === l ? undoOf.get(l) : undefined; // 待っている間に取り戻されていたら何もしない
      const top = st?.at(-1);
      if (!st || !top) return { ok: false, hint: "戻す物がありません" };
      if (top.irreversible) return { ok: false, hint: `戻せません: ${top.irreversible}` };
      const tk = tokenOf(l);
      const run = async (tool: string, a: Record<string, unknown>) => {
        let r = await this.actNow(tk, tool, a, true);
        if (r.ok && r.isError && a.element_token) r = await this.actNow(tk, tool, { ...a, element_token: undefined }, true); // 古い token は外して今の focus に
        return r;
      };
      const fail = (r: { ok: boolean; hint?: string; text?: string }) => ({ ok: false as const, hint: `戻せませんでした: ${(r as any).hint ?? (r as any).text ?? ""}`.slice(0, 200) });
      if (top.tool === "type_text") {
        for (let i = 0; i < Math.min(top.n ?? 0, 500); i++) { const r = await run("press_key", { key: "delete", ...(top.key && i === 0 ? { element_token: top.key } : {}) }); if (!r.ok || r.isError) { top.n = (top.n ?? 0) - i; return fail(r); } } // 消せた分は引く（もう一度押しても書いてない所を消さない）
        st.pop();
        return { ok: true, text: `戻しました: 書いた ${top.n} 文字を消しました` };
      }
      // 戻す前に面を読み直す: 書いた値のまま残っている時だけ前の値へ戻す（その間に人や別の操作が変えたら上書きしない）
      const seen = await run("get_window_state", {});
      const now0 = seen.ok && !seen.isError ? elementsOf.get(l) : undefined;
      const cur = now0?.[top.key ?? ""] ?? Object.values(now0 ?? {}).find((e) => (e.value ?? "").slice(0, VIEW_VALUE) === top.after);
      if (!cur || (cur.value ?? "").slice(0, VIEW_VALUE) !== (top.after ?? "")) return { ok: false, hint: "戻せません: 面が変わった" };
      const r = await run("set_value", { element_token: top.key, value: top.before ?? "" });
      if (!r.ok || r.isError) return fail(r);
      st.pop();
      return { ok: true, text: "戻しました: 値を前に戻しました" };
    },
    closeAll: () => { for (const f of [...running.values()]) f(); for (const a of [...apps.values()]) dropApp(a); for (const k of [...drivers.keys()]) drop(k); dropImgs(); },
  };
  return api;
}
