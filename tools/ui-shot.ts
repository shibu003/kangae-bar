// uishot: Bar の panel（本物の Bar の既定の大きさ 460×640）の「全ての状態」を明・暗で撮る。見た目は直さない。
// 使い方: bun tools/ui-shot.ts [outDir] [sceneFilter]    outDir 既定 docs/verify/uishot
// 土台は tools/bar-shot.ts（試験の常駐・temp の home・headless Chromium）。panel の WebSocket だけ fixture に差し替える
// （roots / runs / chat / leaseList など。それ以外の op は本物の常駐が答える）。owner の窓・home・Chrome・Kangae Bar.app には触らない。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capOf } from "../src/lease.ts";
import { spawnDaemon } from "../test/spawn-daemon";
import { pollUntil } from "../src/wait.ts";

const repo = join(import.meta.dir, "..");
const SRC = process.env.UISHOT_SRC ?? repo; // 消えた画面を撮る時だけ、昔の commit を git archive で展開した所を指す（UISHOT_OLD=A|B と一緒に）
const OUT = process.argv[2] ?? join(repo, "docs/verify/uishot");
const ONLY = process.argv[3] ?? "";
mkdirSync(OUT, { recursive: true });
const D = mkdtempSync(join(tmpdir(), "kangae-uishot-"));
const say = (s: string) => console.log(s);
const BACK = { light: "f3f3f6", dark: "232326" };
const W = 460, H = 640; // bar/main.swift の contentRect 既定

// ---- fixture（偽の data。名前も内容も作り物） ----
const now = Date.now();
const min = 60_000;
const mkLease = (surface: any, o: any = {}) => { const l: any = { surface, owner: "s:1", gen: 1, exp: now + 20 * min, confirmed: true, ...o }; return { key: o.key, ...l, token: "t", undo: o.undo ?? 0, rights: capOf(l, o.mode ?? "ask", now, "default") }; };
const bot = (id: number, text: string, at: number) => ({ id, text: `🤖 ${text}`, cards: [] as any[], createdAt: at });
const me = (id: number, text: string, at: number) => ({ id, text, cards: [] as any[], createdAt: at });
const root = (id: number, name: string | null, text: string, last: any, agent: any = {}) => ({
  id, parentId: null, kind: "user", text, createdAt: now - (9 - id) * 30 * min, deletedAt: null, role: null,
  agent: name ? { name, unread: false, answer: null, answeredAt: null, routines: [], ...agent } : undefined,
  last: last && { id: 900 + id, mine: false, turn: false, at: now - id * 7 * min, ...last },
});
const roots7 = [
  root(1, "メール係", "今日のメールを整理して", { text: "未読 12 件を、返事が要る 3 件と読むだけの 9 件に分けています" }),
  root(2, "経費まとめ", "9 月の経費をまとめて", { text: "領収書 4 枚の金額が読めません。どうしますか", turn: true }),
  root(3, "調べ物係", "来週の出張の宿を探して", { text: "駅から 5 分以内で 3 件に絞りました" }, { answer: "駅から 5 分以内で 3 件に絞りました", unread: true }),
  root(4, "予約係", "金曜の夜の店を予約して", { text: "予約の画面で「送信」を押してよいか待っています" }),
  root(5, "請求書係", "請求書を PDF にして送って", { text: "止めました" }),
  root(6, "旅行係", "京都の2泊3日を組んで", { text: "✗ 宿の画面にログインできませんでした" }, { answer: "✗ 宿の画面にログインできませんでした" }),
  root(7, null, "メモ: 来月の引っ越しの段取り", { text: "段取りを 5 つに分けて", mine: true }),
];
const run = (id: number, nodeId: number, o: any = {}) => ({ id, nodeId, role: null, cli: "claude", status: "idle", log: [], queue: 0, rowId: 900 + nodeId, switched: null, screen: null, stop: null, startedAt: now - 5 * min, updatedAt: now - 1 * min, dir: null, need: null, ...o });
const runs7 = [
  run(11, 1, { status: "running", dir: "/Users/you/work/mail", log: ["受信箱を読んでいます"], screen: { engine: "cua", steps: 6, ms: 14000 } }),
  run(14, 4, { status: "running" }),
  run(15, 5, { status: "stopped" }),
  run(16, 6, { status: "idle", switched: { line: "料金の上限に近いので、無料の枠に替えました", limits: "この Mac の中だけで動きます" } }),
];
const leases = [
  mkLease({ app: "メモ", title: "買い物", pid: 11, windowId: 1 }, { key: "win:11:1", owner: "s:1", hold: true, waitSince: now, undo: 2 }),
  mkLease({ app: "web", title: "Example Domain", tabId: 5, url: "https://example.com/" }, { key: "tab:5", owner: "s:4", mode: "allow" }),
];
const approvals = [
  { id: "a1", owner: "s:4", key: "tab:5", app: "Google Chrome", title: "Example Domain", what: "「送信」を押す", danger: true },
];
const leaseList = { ok: true, leases, approvals: [], recoveries: [], carries: [], routineCards: [], modes: [], auth: [] };
const noLease = { ok: true, leases: [], approvals: [], recoveries: [], carries: [], routineCards: [], modes: [], auth: [] };
const longChat = (() => {
  const t = now - 90 * min, rows: any[] = [];
  const pairs: [string, string][] = [
    ["今日のメールを整理して", "受信箱を読みます。未読は 12 件です。"],
    ["返事が要るものだけ先に見せて", "返事が要るのは 3 件です。取引先の見積もり、総務の備品、友人の日程です。"],
    ["見積もりの返事の下書きを書いて", "下書きを書きました。金額は先方の数字のままにしています。"],
    ["金額を 10% 下げた案も欲しい", "10% 下げた案も並べました。どちらで送りますか。"],
    ["下げた案で。件名も短く", "件名を「お見積もりのご返信」にしました。"],
    ["総務の備品は何を頼まれてる？", "モニター台 2 つとケーブル 5 本の発注です。"],
    ["それは来週でいいと返して", "来週に回す旨の返事を書きました。"],
    ["友人の日程は金曜の夜で", "金曜の夜で空けておく返事にしました。"],
    ["全部送って", "3 件とも送りました。読むだけの 9 件は「あとで読む」に入れています。"],
    ["ありがとう。今日はこれで終わり", "お疲れさまでした。残りの返事はありません。"],
  ];
  pairs.forEach(([q, a], i) => { rows.push(me(100 + i * 2, q, t + i * 4 * min)); rows.push(bot(101 + i * 2, a, t + i * 4 * min + 30_000)); });
  return rows;
})();
const withCard = (rows: any[], card: any, text: string) => [...rows, { ...bot(990, text, now - 2 * min), cards: [card] }];
const askCard = { kind: "ask", title: "領収書 4 枚の金額が読めません。手で入れますか", options: ["手で入れる", "読み直す", "飛ばす"], detail: "" };
const handoffCard = { kind: "handoff", title: "宿の画面で login してください", options: ["やりました", "やめる"], detail: "https://example.com/login" };
const doneCard = { kind: "done", title: "9 月の経費表ができました", options: [], detail: "経費-2026-09.xlsx" };
const nexts = [{ id: 7001, text: "続きをお願い" }, { id: 7002, text: "もう少し短く" }, { id: 7003, text: "送って" }];

type Scene = {
  id: string; // 例 "01-list"
  note: string;
  fx?: Record<string, any>; // op → 応答（__by:"rootId" なら rootId ごと）
  open?: number; // 開いておく会話（localStorage panel-root）
  steps?: [string, number?][]; // 読み込み後に評価する式と待ち ms
  noRoots?: boolean;
};
const baseFx = { roots: { ok: true, roots: roots7 }, runs: { ok: true, runs: runs7 }, leaseList: noLease, providers: { ok: true, providers: [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }] }, chat: { __by: "rootId", "*": { ok: true, rows: longChat, next: nexts } } };
const leaseFx = { ...baseFx, leaseList };
const click = (sel: string) => [`document.querySelector(${JSON.stringify(sel)})?.click();'ok'`, 500] as [string, number];
const toList = click("#hd-list");
const openGear = click("#user-btn");
const openSec = (n: number) => [`(()=>{const d=document.querySelectorAll('#user-pop > details')[${n}];d.open=true;d.scrollIntoView();return 'ok'})()`, 600] as [string, number];
const dropEvt = (sel: string, type: string, data: string) => [`(()=>{const dt=new DataTransfer();${data};const e=new DragEvent('${type}',{dataTransfer:dt,bubbles:true,cancelable:true});document.querySelector(${JSON.stringify(sel)}).dispatchEvent(e);return 'ok'})()`, 500] as [string, number];

const scenes: Scene[] = [
  { id: "01a-list7", note: "一覧（担当 7 件・状態がまちまち・窓は渡していない）", fx: baseFx, open: 1, steps: [toList] },
  { id: "01b-list7-leases", note: "一覧（担当 7 件・窓を 2 つ渡している＝帯が出る）", fx: leaseFx, open: 1, steps: [toList] },
  { id: "01c-list7-leases-scrolled", note: "一覧（同上・下へ送った所）", fx: leaseFx, open: 1, steps: [toList, [`(()=>{const s=document.getElementById('sessions');s.scrollTop=s.scrollHeight;document.querySelectorAll('*').forEach(e=>{if(e.scrollHeight>e.clientHeight+20&&getComputedStyle(e).overflowY!=='visible')e.scrollTop=e.scrollHeight});return 'ok'})()`, 500]] },
  { id: "02-list-empty", note: "一覧が空（初めて・最初の案内が出そろうまで 7 秒待った後）", noRoots: true, steps: [[`document.getElementById('first').textContent.slice(0,60)`, 7000]] },
  { id: "03-chat-long", note: "会話（10 往復）", fx: baseFx, open: 1 },
  { id: "04-chat-approve", note: "会話に承認 card（lease の承認）", fx: { ...baseFx, leaseList: { ...leaseList, approvals }, chat: { __by: "rootId", "*": { ok: true, rows: withCard(longChat.slice(-6), askCard, "領収書 4 枚の金額が読めません。"), next: [] } } }, open: 4 },
  { id: "05-chat-cards-toast", note: "会話に複数の card と toast", fx: { ...baseFx, leaseList: { ...leaseList, approvals, carries: [{ id: "v1", owner: "s:2", host: "example.com", at: now, vault: true }] }, chat: { __by: "rootId", "*": { ok: true, rows: [...withCard(longChat.slice(-4), handoffCard, "宿の画面に login が要ります。"), { ...bot(991, "表もできました。", now - min), cards: [doneCard] }], next: nexts } } }, open: 2, steps: [[`__push({type:'opened',who:'メール係',kind:'tab',label:'Gmail'});'ok'`, 700]] },
  { id: "06-input-long", note: "入力欄に長い文", fx: baseFx, open: 1, steps: [[`(()=>{const t=document.getElementById('send-text');t.value='来週の月曜から金曜まで、朝 9 時に今週の予定と未読のメールの要点を 3 行にまとめて、返事が要るものには下書きを付けて、午前 10 時までに私に見せてください。祝日の週は飛ばしてください。取引先からのメールだけは必ず先頭に並べて、金額が書いてあるものには印を付けてください。';t.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`, 700]] },
  { id: "07a-menu-list-more", note: "menu: 一覧の「…」", fx: baseFx, open: 1, steps: [toList, click("#list-more")] },
  { id: "07b-menu-avatar", note: "menu: 行の avatar（その担当の設定）", fx: baseFx, open: 1, steps: [toList, click("#roots li:nth-child(1) .av-btn")] },
  { id: "07c-menu-plus", note: "menu: 一覧の「＋」", fx: baseFx, open: 1, steps: [toList, click("#plus")] },
  { id: "07d-menu-surf-icon", note: "menu: 行の面 icon（縮小絵）", fx: leaseFx, open: 1, steps: [toList, click("#roots kg-row .surfs span[data-key]")] },
  { id: "07e-menu-gear", note: "menu: 歯車（設定）", fx: baseFx, open: 1, steps: [toList, openGear] },
  { id: "07f-menu-attach", note: "menu: 会話の clip（file 選び＝OS の窓で WebView では撮れない・押した直後の画面）", fx: baseFx, open: 1, steps: [click("#attach")] },
  { id: "08-chat-more", note: "会話の「…」の menu", fx: baseFx, open: 1, steps: [click("#hd-more")] },
  { id: "09a-settings-top", note: "歯車: 設定（節は全部閉じ）", fx: baseFx, open: 1, steps: [toList, openGear] },
  { id: "09b-settings-chat", note: "歯車: 会話", fx: baseFx, open: 1, steps: [toList, openGear, openSec(0)] },
  { id: "09c-settings-screen", note: "歯車: 画面の操作", fx: baseFx, open: 1, steps: [toList, openGear, openSec(1)] },
  { id: "09d-settings-remembered", note: "歯車: 覚えた許し（3 件）", fx: { ...baseFx, remembered: { ok: true, items: [{ id: "r1", label: "example.com の login を運ぶ" }, { id: "r2", label: "メモ への書き込み" }, { id: "r3", label: "Google Chrome を聞かずに開く" }] } }, open: 1, steps: [toList, openGear, openSec(2)] },
  { id: "09e-settings-learned", note: "歯車: 覚えた物（登録した物・覚えた手順・下書き）", fx: { ...baseFx,
      cmdList: { ok: true, items: [{ name: "daily-report", cwd: "/Users/you/work", line: "bun run report.ts", at: now - 86_400_000, app: false, network: false, reads: ["/Users/you/work"], ok: true }] },
      mods: { ok: true, offer: null, mods: [{ ok: true, key: "m1", app: "メモ", name: "add-shopping", label: "買い物を足す", permission: "write", on: true, runs: "メモの入力欄に書く", origin: "distill", seen: 3, front: false }, { ok: true, key: "m2", app: "Numbers", name: "sum-column", label: "列を合計する", permission: "read", on: false, runs: "Numbers の表を読む", origin: "ai", seen: 1, front: false }] },
      draftList: { ok: true, drafts: [{ id: "d1", op: "Numbers: 列を合計", why: "同じ手順を 3 回しました", suggestion: { what: "列の合計を読む", permission: "read" } }] } }, open: 1, steps: [toList, openGear, openSec(3), [`document.querySelectorAll('#user-pop details details').forEach(d=>d.open=false);'ok'`, 300]] },
  { id: "09f-settings-learned-empty", note: "歯車: 覚えた物（何も無い時）", fx: baseFx, open: 1, steps: [toList, openGear, openSec(3)] },
  { id: "09g-settings-remote", note: "歯車の外: スマホで操作", fx: baseFx, open: 1, steps: [toList, click("#list-more"), click("#open-remote")] },
  { id: "12a-drop-row", note: "drop の帯: 一覧の行の上に落とす時", fx: baseFx, open: 1, steps: [toList, dropEvt("#roots li:nth-child(2)", "dragover", "dt.setData('text/uri-list','https://example.com/\\n')")] },
  { id: "12b-drop-chat", note: "drop の帯: 会話に落とす時（file）", fx: baseFx, open: 1, steps: [dropEvt("#chat", "dragover", "dt.items.add(new File(['x'],'見積もり.pdf',{type:'application/pdf'}))")] },
  { id: "13-press", note: "押す操作の画面", fx: baseFx, open: 1, steps: [click("#hd-more"), [`[...document.querySelectorAll('#add-line button')].find(b=>b.textContent.includes('押す操作'))?.click();'ok'`, 800]] },
  { id: "14-thread", note: "thread（agent どうしの chat）", fx: { ...baseFx,
      roomLog: { ok: true, room: { members: [{ name: "メール係", role: "受信箱" }, { name: "経費まとめ", role: "領収書" }] }, rows: [{ from: "メール係", to: "経費まとめ", text: "領収書の PDF が 4 枚届いています。読めますか", at: now - 9 * min }, { from: "経費まとめ", to: "メール係", text: "2 枚は読めました。残りは画像が荒いです", at: now - 7 * min }, { from: "メール係", to: "経費まとめ", text: "元のメールに高い解像度のものがあります。送り直します", at: now - 5 * min }] },
      chat: { __by: "rootId", "*": { ok: true, rows: [me(100, "[[relay: メール係 | room-1]] 領収書の PDF が 4 枚届いています", now - 9 * min), bot(101, "読んでみます。", now - 8 * min)], next: [] } } }, open: 2, steps: [[`document.querySelector('kg-notice, #rows kg-notice')?.click();'ok'`, 800]] },
  { id: "15a-down", note: "つながらない時（本体に繋がらない）", fx: { status: { ok: false } }, noRoots: false },
  { id: "15b-send-fail", note: "エラーの時: 送れなかった（agent がいない）", fx: { ...baseFx, send: { ok: false, hint: "agent がいません", need: { kind: "agent", what: "agent がいません", how: "claude か codex を入れてください。gemini は有料の API key がある時だけ使えます。入れたら、もう一度送ります" }, row: { id: 8000 } } }, open: 3, steps: [[`(()=>{const t=document.getElementById('send-text');t.value='続きをお願い';t.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('send-form').requestSubmit();return 'ok'})()`, 1500]] },
  { id: "15c-lease-read-fail", note: "エラーの時: 渡している窓の一覧が読めない", fx: { ...baseFx, leaseList: { ok: false, hint: "本体が答えません" } }, open: 1 },
  { id: "15d-login-lost", note: "エラーの時: agent の login が切れている（一覧の行）", fx: { ...baseFx, runs: { ok: true, runs: [run(11, 1, { status: "idle", need: { kind: "login", what: "agent の login が切れています", how: "ターミナルで claude と打って login してから、もう一度送ってください" } }), ...runs7.slice(1)] } }, open: 1, steps: [toList] },
  { id: "16-run-stop-switched", note: "一覧の行の下の 1 行（代わる・続けて・替わった）", fx: baseFx, open: 3, steps: [toList, [`document.getElementById('roots').scrollTop=0;'ok'`, 200]] },
];

// 消えた画面（昔の commit の panel）。A = W103 の 1 つ前（一覧の頭の「やること」＝ Jira / Linear を追加）、B = W77c の 1 つ前（歯車の GitHub / Google・plugin / MCP / skill・スマホ）
const oldScenes: Record<string, Scene[]> = {
  A: [
    { id: "10a-old-todo-jira-linear", note: "【消えた】一覧の「やること」を開いた所（Jira / Linear を追加）", fx: baseFx, open: 1, steps: [toList, click("#todo")] },
    { id: "10b-old-jira-pressed", note: "【消えた】「Jira を追加」を押した所（接続はまだ）", fx: baseFx, open: 1, steps: [toList, click("#todo"), click("#task-jira")] },
  ],
  B: [
    { id: "11a-old-gear-popover", note: "【消えた】歯車の中（GitHub / Google・plugin / MCP / skill・スマホの入口）", fx: baseFx, open: 1, steps: [toList, openGear] },
    { id: "11b-old-plugins-page", note: "【消えた】plugin / MCP / skill の頁", fx: baseFx, open: 1, steps: [toList, openGear, click("[data-pane=plugins]")] },
    { id: "11c-old-accounts-page", note: "【消えた】GitHub / Google の頁", fx: baseFx, open: 1, steps: [toList, openGear, click("[data-pane=accounts]")] },
    { id: "11d-old-phone-page", note: "【消えた】connect with your phone の頁", fx: baseFx, open: 1, steps: [toList, openGear, click("[data-pane=phone]")] },
  ],
};
if (process.env.UISHOT_OLD) { scenes.length = 0; scenes.push(...oldScenes[process.env.UISHOT_OLD]!); }

// ---- 起動 ----
const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd); if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`); return r.stdout.toString(); };
void sh;
const preload = `(()=>{const R=WebSocket;globalThis.WebSocket=class extends R{constructor(...a){super(...a);globalThis.__wsi=this}send(s){try{const m=JSON.parse(s);const fx=globalThis.__FX||{};let h=fx[m.op];if(h&&h.__by){h=h[m[h.__by]]??h["*"]}if(h!==undefined){setTimeout(()=>this.onmessage&&this.onmessage({data:JSON.stringify({id:m.id,...h})}),0);return}}catch{}super.send(s)}};globalThis.__push=(o)=>globalThis.__wsi.onmessage({data:JSON.stringify(o)});})()`;
const home = join(D, "home"), sock = join(D, "main.sock"), barJson = join(D, "main-bar.json");
mkdirSync(home, { recursive: true });
const daemon = spawnDaemon(["bun", join(SRC, "src/main.ts"), "--daemon"], { env: { ...(process.env as Record<string, string>), KANGAE_HOME: home, KANGAE_SOCK: sock, KANGAE_BAR: barJson, KANGAE_NODES_DIR: join(D, "nodes") }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
let chrome: ReturnType<typeof Bun.spawn> | undefined;
const made: { id: string; note: string; file: string; ok: boolean; got?: string }[] = [];
try {
  await pollUntil(() => existsSync(barJson) && existsSync(sock), 60_000, 100);
  const j = JSON.parse(readFileSync(barJson, "utf8")) as { port: number; token: string };
  const url = `http://127.0.0.1:${j.port}/panel?token=${j.token}`;
  say(`常駐 port ${j.port}`);
  const port = 9900 + Math.floor(Math.random() * 90);
  chrome = Bun.spawn(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(D, "profile")}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  await pollUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, 30_000, 200);
  const tgt = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as any;
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r as any));
  let id = 0; const wait = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); wait.get(m.id)?.(m); };
  const send = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "document.documentElement.style.setProperty('--bar-inset-left','78px')" });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: preload });
  let prev: string | undefined;
  for (const sc of scenes) {
    if (ONLY && !sc.id.includes(ONLY)) continue;
    for (const dark of [false, true]) {
      const name = `${sc.id}-${dark ? "dark" : "light"}`;
      const c = BACK[dark ? "dark" : "light"];
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
      await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
      await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16), a: 1 } });
      if (prev) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: prev });
      const fx = sc.noRoots ? {} : sc.fx ?? baseFx;
      const src = `try{localStorage.clear();${sc.open != null ? `localStorage.setItem('panel-root','${sc.open}');` : ""}}catch{};globalThis.__FX=${JSON.stringify(fx)};`;
      prev = (await send("Page.addScriptToEvaluateOnNewDocument", { source: src })).result.identifier;
      await send("Page.navigate", { url });
      await pollUntil(async () => (await ev("document.readyState==='complete'&&(!document.getElementById('app').hidden||!document.getElementById('empty-text').disabled||!document.getElementById('down').hidden)")) === true, 15_000, 200).catch(() => {});
      await Bun.sleep(900);
      let got = "";
      for (const [expr, ms] of sc.steps ?? []) { got = String((await ev(expr)) ?? ""); await Bun.sleep(ms ?? 400); }
      await Bun.sleep(500);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const file = `${name}.png`;
      writeFileSync(join(OUT, file), Buffer.from(shot.result.data, "base64"));
      made.push({ id: sc.id, note: sc.note, file, ok: true, got });
      say(`${file}${got && got !== "ok" ? `  → ${got}` : ""}`);
    }
  }
  ws.close();
} finally {
  try { chrome?.kill(); } catch {}
  try { daemon.kill(); } catch {}
  await Bun.sleep(500);
  const prevMade = existsSync(join(OUT, "made.json")) ? (JSON.parse(readFileSync(join(OUT, "made.json"), "utf8")) as typeof made) : [];
  const ids = new Set(made.map((m) => m.id));
  writeFileSync(join(OUT, "made.json"), JSON.stringify([...prevMade.filter((m) => !ids.has(m.id)), ...made], null, 1)); // 部分撮りで台帳を消さない
  rmSync(D, { recursive: true, force: true });
  process.exit(0);
}
