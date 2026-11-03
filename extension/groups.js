// tab group の判断。DOM も chrome.* も持たない。B は結果を chrome.* に渡すだけ。

export function groupTitle(root) {
  return `${root.text.slice(0, 12)} ·#${root.id}`;
}

export function findGroup(groups, rootId) {
  const suffix = `·#${rootId}`;
  return groups.find((g) => (g.title || "").endsWith(suffix)) ?? null;
}

function urlOf(tab) {
  return tab.url || tab.pendingUrl || "";
}

export function isWeb(tab) {
  return /^https?:/.test(urlOf(tab));
}

function webTabsInGroup(rootId, windowTabs, groups) {
  const target = findGroup(groups, rootId);
  if (!target) return [];
  return windowTabs.filter((t) => t.groupId === target.id && isWeb(t));
}

export function planAdd({ rootId, rootText, tab, groups }) {
  const g = findGroup(groups, rootId);
  return {
    tabId: tab.id,
    groupId: g ? g.id : null,
    newTitle: g ? null : groupTitle({ id: rootId, text: rootText }),
  };
}

// 進んだ頁 = この根の group の http(s) の tab のうち、付いた全ての保存 url のどれとも完全一致しない物。
// exclude は自分で開いた tab の id（題名行の数えだけが渡す。pill は渡さない）。
/** @param {{rootId:number,savedUrls:string[],windowTabs:any[],groups:any[],exclude?:number[]}} a */
export function advancedPages({ rootId, savedUrls, windowTabs, groups, exclude = [] }) {
  return webTabsInGroup(rootId, windowTabs, groups).filter(
    (t) => !savedUrls.includes(urlOf(t)) && !exclude.includes(t.id),
  );
}

function newestAccessed(tabs) {
  let best = tabs[0];
  let bestAt = best.lastAccessed ?? 0;
  for (let i = 1; i < tabs.length; i++) {
    const at = tabs[i].lastAccessed ?? 0;
    if (at > bestAt) {
      best = tabs[i];
      bestAt = at;
    }
  }
  return best;
}

// 見ていない根の切替（pill）。保存 url が空なら何もしない（他 group も畳まない）。
// 前面: 窓の保存 url の最初。無ければ進んだ頁の lastAccessed 最大（0 は後ろ・同値は配列の最初）。
// 進んだ頁も無ければ、付いた順の 1 行目の保存 url だけを開く（窓に http(s) があれば裏、無ければ表）。
// collapse は対象以外で title が ·#<数> で終わる物だけ。対象 group は expand（無ければ null）。
export function planSwitch({ rootId, savedUrls, windowTabs, groups }) {
  const empty = { activate: null, group: [], open: [], collapse: [], expand: null };
  if (savedUrls.length === 0) return empty;

  const matching = windowTabs.filter((t) => savedUrls.includes(urlOf(t)));
  const target = findGroup(groups, rootId);
  const advanced = advancedPages({ rootId, savedUrls, windowTabs, groups });

  let activate = null;
  let open = [];
  if (matching.length > 0) activate = matching[0].id;
  else if (advanced.length > 0) activate = newestAccessed(advanced).id;
  else open = [{ url: savedUrls[0], active: !windowTabs.some(isWeb) }];

  return {
    activate,
    group: matching.map((t) => t.id),
    open,
    collapse: groups.filter((g) => (!target || g.id !== target.id) && /·#\d+$/.test(g.title || "")).map((g) => g.id),
    expand: target ? target.id : null,
  };
}

// 題名の行（上から最初に当たる 1 つ。lastAccessed は使わない）。
// (a) 窓にその url の tab → その最初。
// (b) mapTab = 自分で開いた tab で今もこの窓に居る物の id（呼ぶ側が tabs.get で確かめて渡す）→ その tab。
// (c) 進んだ頁（mapValues の tab を除く）がちょうど 1 枚 → 開かずその 1 枚。
// (d) 2 枚以上 → disabled。
// (e) 0 枚 → 開く。窓に http(s) があれば裏、無ければ表。
/** @param {{rootId:number,url:string,savedUrls?:string[],windowTabs:any[],groups:any[],mapTab?:number|null,mapValues?:number[]}} a */
export function planTitle({ rootId, url, savedUrls = [url], windowTabs, groups, mapTab = null, mapValues = [] }) {
  const hit = windowTabs.find((t) => urlOf(t) === url);
  if (hit) return { activate: hit.id, open: null, disabled: false };
  if (mapTab != null) return { activate: mapTab, open: null, disabled: false };
  const advanced = advancedPages({ rootId, savedUrls, windowTabs, groups, exclude: mapValues });
  if (advanced.length === 1) return { activate: advanced[0].id, open: null, disabled: false };
  if (advanced.length >= 2) return { activate: null, open: null, disabled: true };
  return { activate: null, open: { url, active: !windowTabs.some(isWeb) }, disabled: false };
}

// 仕事の run が生きている = running か開始待ち（queue>0）。終了 = view に居て、どちらでもない。
/** @param {{status:string,queue?:number}} run */
export function isLive(run) {
  return run.status === "running" || (typeof run.queue === "number" && run.queue > 0);
}

// 印と止めるを付ける run。sent は送った直後に覚えた {runId, nodeId, rowId}。
// view に居ない間は終了にしない。view に居て終了と返った run は含めない。
/** @param {any[]} runs @param {{runId:string,nodeId:number,rowId:number|null}[]} sent */
export function liveRuns(runs, sent) {
  const out = runs.filter(isLive).map((r) => ({ id: r.id, nodeId: r.nodeId, rowId: r.rowId, log: r.log ?? [] })); // log = 進み具合の card と上の 1 行が読む
  for (const s of sent) {
    if (!runs.some((r) => r.id === s.runId)) out.push({ id: s.runId, nodeId: s.nodeId, rowId: s.rowId, log: [] });
  }
  return out;
}

// op:runs の失敗の行。その根の最新の run が failed のときだけ、その run の行 id。stopped には出さない。
/** @param {any[]} runs @param {number} nodeId */
export function failedRowId(runs, nodeId) {
  let latest = null;
  for (const r of runs) {
    if (r.nodeId !== nodeId) continue;
    if (!latest || (r.startedAt ?? 0) >= (latest.startedAt ?? 0)) latest = r;
  }
  return latest && latest.status === "failed" && latest.rowId != null ? latest.rowId : null;
}

// 描き直しの末尾の扱い。scene: open | send | fail | reply | toggle | keep。
// near = 直前の位置が #rows の下端から 1 行分（34px）以内。
// 返事の頭を読ませる（last-top）のは open と reply だけで、末尾が 🤖 で #rows より高いとき。
export const NEAR_BOTTOM = 34;
export function scrollPlan({ scene, near, lastIsBot, lastHeight, viewHeight }) {
  const top = lastIsBot && lastHeight > viewHeight ? "last-top" : "end";
  switch (scene) {
    case "open":
      return top;
    case "reply":
      return near ? top : "keep";
    case "send":
    case "fail":
      return "end";
    case "toggle":
      return near ? "end" : "keep";
    default:
      return "keep";
  }
}

// agent の色の番号（0..AGENT_COLORS-1）。nodeId を色の数で割った余りを第一候補にし、すでに別の agent が使っていたら次の空きへ。
// 小さい id から順に決めるので同じ並びなら同じ色になり、並んだ agent が同じ色にならない（色の数まで）。
export const AGENT_COLORS = 6;
/** @param {number[]} ids @returns {Map<number, number>} */
export function agentColors(ids) {
  const out = new Map();
  const used = new Set();
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    let c = id % AGENT_COLORS;
    for (let i = 0; i < AGENT_COLORS && used.has(c); i++) c = (c + 1) % AGENT_COLORS;
    if (used.size < AGENT_COLORS) used.add(c);
    out.set(id, c);
  }
  return out;
}

// 常駐からの読み込み（/first・面の一覧・画面の道具・mod）を締切の中で間を空けて読み直す（0.5 → 1 → 2 → 4 秒…・合計 60 秒）。
// attempt() は {ok:true,…} か {ok:false, reason, final?}（final = 読み直しても無駄）を返す。1 回落ちても黙らず、越えたら理由 1 行を返す。sleep は test が差し替える
export const FIRST_DELAYS = [500, 1000, 2000, 4000];
export const FIRST_DEADLINE = 60000;
export async function readRetry(attempt, { sleep, onWait = undefined }) {
  let spent = 0;
  for (let i = 0; ; i++) {
    const r = await attempt();
    if (r.ok || r.final) return r;
    const d = FIRST_DELAYS[Math.min(i, FIRST_DELAYS.length - 1)];
    if (spent + d > FIRST_DEADLINE) return r;
    onWait?.();
    await sleep(d);
    spent += d;
  }
}

// 最初の画面の card（/first の足りない物 → 題・次の一手 1 行・button）。人が今する物には「あなたの番です」を付け、知らせ（notice）には付けない。
// button は拡張の案内にだけ（「拡張の置き場を Finder で開く」）。描くのは panel.js
export function firstCards(needs) {
  return needs.map((n) => ({ title: n.notice ? n.what : `あなたの番です — ${n.what}`, how: n.how, button: n.kind === "extension" ? "拡張の置き場を Finder で開く" : null }));
}
// session が無い画面の一言目から付ける session の名前（頭の 30 字・名前は先に聞かない）
export const firstName = (text) => [...text.trim()].slice(0, 30).join("");

// 画面に出す agent 名・会話の見出し（review19）。制御文字・書式文字（RTL 上書き・ゼロ幅・改行）を落とし、空白を畳み、長さを切り、双方向の隔離（FSI…PDI）で包む＝周りの文の並びを入れ替えられない。HTML としては描かない（textContent に渡す）
export const plain = (s, n = 30) => {
  const t = Array.from(String(s ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim());
  return `\u2068${t.slice(0, n).join("")}${t.length > n ? "…" : ""}\u2069`;
};

// W79: 縮小絵を撮りに行く面。人が押した面（一覧の行の icon・「拡げる」）と、認証 card が出ている面だけ。誰も押していなければ空＝撮影 0（要件 37「常時 screencast しない」）
export const peekKeys = (leases, { rows, open, auth }) => leases.map((l) => l.key).filter((k) => rows.has(k) || open.has(k) || auth.includes(k));
