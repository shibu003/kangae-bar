// v1 の通し（bun test/v1.e2e.ts）。panel.html を普通の tab で開いて操る。
// W3b-3: 今の画面（DM の一覧・「…」の中の付いた tab・上の 1 行 #hd-st・欄の右の止める丸）の selector に直し、headless で回す。行ごとの「動いている」「止める」は無くなったので、どの行の仕事かは常駐の run.rowId で見る。
// 本物の Chromium・remote debugging・偽の claude と偽の login shell。KANGAE_OPEN_CMD は /usr/bin/true。
// SPEC §5 の 3 本と §6 の受け入れ。A〜D が揃ってから回す。この file だけでは回さない。
// 仕事の claude は、プロンプトを 1 行追記してから go-<n> ができるまで待つ。止めるとプロセスは死に、列は届かない。
import { mktmp } from "./tmp.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pollUntil } from "../src/wait.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_APP, launch } from "../src/launch.ts";

import { UI_HINT as HINT } from "../src/ui.ts";
import { armExe } from "./exe";
const ADD_HINT = "前面が http か https のタブのとき付けられる";
const EMPTY_MSG = "何をしてほしいかを書いて Enter";
const EMPTY_HINT = "例: 今日のメールを整理して";
const root = join(import.meta.dir, "..");
const dir = mktmp("kangae-v1e");
const home = join(dir, "home");
const holdDir = join(dir, "hold");
const promptLog = join(dir, "prompts.log");
const port = 10000 + Math.floor(Math.random() * 500);
mkdirSync(home, { recursive: true });
mkdirSync(holdDir, { recursive: true });
writeFileSync(promptLog, "");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const name = new URL(req.url).searchParams.get("t") ?? "";
    const safe = name.replace(/[<>&"]/g, "");
    return new Response(`<!doctype html><meta charset="utf-8"><title>${safe}</title><p>${safe}</p>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
const page = (name: string) => `http://127.0.0.1:${server.port}/?t=${encodeURIComponent(name)}`;

const fakebin = join(dir, "bin");
mkdirSync(fakebin);
writeFileSync(
  join(fakebin, "claude"),
  `#!/bin/sh
case "$1" in auth) exit 0;; esac
case "$*" in
  *stream-json*)
    # 渡される文は「一言 + 返事の形の約束（複数行）」。数えるのは 1 回 1 行なので、一言の行だけを記録する
    printf '%s\\n' "$2" | head -1 >> ${promptLog}
    case "$2" in *壊れる*) while [ ! -f ${holdDir}/fail ]; do sleep 0.1; done; exit 3;; esac
    printf '%s\\n' '{"type":"system","subtype":"init","session_id":"S1"}'
    printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"進めています"}]}}'
    n=$(wc -l < ${promptLog} | tr -d ' ')
    while [ ! -f ${holdDir}/go-$n ]; do sleep 0.1; done
    printf '%s\\n' '{"type":"result","result":"短い返事","session_id":"S1"}'
    exit 0 ;;
esac
`,
);
writeFileSync(join(dir, "shell.sh"), `#!/bin/sh\nprintf '%s' "${fakebin}:/usr/bin:/bin"\n`);
for (const f of [join(fakebin, "claude"), join(dir, "shell.sh")]) armExe(f);

const proc = launch({
  app: CHROMIUM_APP,
  profile: join(dir, "profile"),
  hostBinary: join(root, "dist/kangae"),
  extensionDir: join(root, "extension"),
  mockKeychain: true,
  extraArgs: ["--headless=new", `--remote-debugging-port=${port}`, "about:blank"],
  env: {
    KANGAE_HOME: home,
    KANGAE_PROFILE: join(dir, "profile"),
    KANGAE_SOCK: join(dir, "s.sock"),
    SHELL: join(dir, "shell.sh"),
    KANGAE_NODES_DIR: join(dir, "nodes"),
    KANGAE_OPEN_CMD: "/usr/bin/true",
    KANGAE_PROMPT_LOG: promptLog,
    KANGAE_HOLD_DIR: holdDir,
  },
});
const killHost = () => {
  for (const p of Bun.spawnSync(["lsof", "-t", join(dir, "s.sock")]).stdout.toString().split("\n").filter(Boolean)) {
    try { process.kill(Number(p)); } catch { /* 既にいない */ }
  }
};
const kill = () => {
  proc.kill();
  killHost();
  Bun.spawnSync(["pkill", "-f", dir]);
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
};
const timer = setTimeout(() => { console.log("TIMEOUT"); kill(); process.exit(2); }, 2_400_000);

type Target = { id?: string; type?: string; url?: string; webSocketDebuggerUrl?: string };
type Send = (method: string, params?: object) => Promise<any>;
type TabInfo = { id: number; url: string; title: string; active: boolean; index: number; groupId: number; lastAccessed: number };
type GroupInfo = { id: number; title: string; collapsed: boolean };
type TitleInfo = { text: string; disabled: boolean; label?: string };
type RowInfo = { dbg?: unknown; id: string; body: string; stop: boolean; running: boolean; fail: boolean; hint: boolean };
type RootInfo = { text: string; on: boolean; id: string; inner: string; outsideRunning: boolean };
type H1Info = { text: string; style: string; computed: string; open: string; buttons: string[] };

const q = (s: string) => JSON.stringify(s);
const flat = (s: string) => s.replace(/\s/g, "").toLowerCase();
const isNamed = (style: string, computed: string, name: "blue" | "pink") => {
  const rgb = name === "blue" ? "rgb(0,0,255)" : "rgb(255,192,203)";
  const aliases = name === "blue" ? ["blue", "#0000ff", "#00f", "rgb(0,0,255)"] : ["pink", "#ffc0cb", "rgb(255,192,203)"];
  return aliases.includes(flat(style)) && flat(computed) === rgb;
};
const prompts = () => {
  try { return readFileSync(promptLog, "utf8").split("\n").filter((l) => l.length > 0); } catch { return []; }
};
const releasePrompt = (text: string) => {
  const i = prompts().lastIndexOf(text);
  if (i < 0) return false;
  writeFileSync(join(holdDir, `go-${i + 1}`), "1");
  return true;
};
const overrideRaw = () => {
  const p = join(home, "ui", "override.css");
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
};
const oneLine = (raw: string | null) => (raw == null ? null : raw.replace(/\n$/, ""));

const bad: string[] = [];
const t0 = Date.now();
const sec = () => `${Math.round((Date.now() - t0) / 1000)}s`;
function expect(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log("OK", name, sec());
  else {
    bad.push(name);
    console.log("NG", name, sec(), detail === undefined ? "" : JSON.stringify(detail));
  }
}

function cdp(u: string): Promise<Send> {
  const s = new WebSocket(u);
  return new Promise((resolve) => {
    s.onopen = () => {
      let id = 0;
      const wait = new Map<number, (v: unknown) => void>();
      s.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { id: number };
        wait.get(m.id)?.(m);
      };
      resolve((method, params = {}) => new Promise((res) => {
        const i = ++id;
        wait.set(i, res as (v: unknown) => void);
        s.send(JSON.stringify({ id: i, method, params }));
      }));
    };
  });
}

async function targets(): Promise<Target[]> {
  try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[]; } catch { return []; }
}

try {
  let sw: Target | undefined;
  for (let i = 0; i < 60 && !sw?.webSocketDebuggerUrl; i++) {
    sw = (await targets()).find((t) => t.type === "service_worker" && (t.url ?? "").endsWith("/sw.js"));
    if (!sw?.webSocketDebuggerUrl) await Bun.sleep(1000);
  }
  if (!sw?.webSocketDebuggerUrl || !sw.url) throw new Error("service worker が無い");
  const ver = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const browser = await cdp(ver.webSocketDebuggerUrl);
  const extId = new URL(sw.url).host;
  const madeTarget = await browser("Target.createTarget", { url: `chrome-extension://${extId}/panel.html` });
  if (madeTarget.error) console.log("createTarget", JSON.stringify(madeTarget.error));

  const shot = async (send: Send, n: string) => {
    if (!process.env.SHOT_DIR) return;
    await send("Page.enable");
    const data = (await send("Page.captureScreenshot")).result?.data;
    if (typeof data === "string") writeFileSync(join(process.env.SHOT_DIR, n), Buffer.from(data, "base64"));
  };

  async function attachPanel(): Promise<{ send: Send; id: string }> {
    let panel: Target | undefined;
    for (let i = 0; i < 120 && !panel?.webSocketDebuggerUrl; i++) {
      panel = (await targets()).find((t) => t.type === "page" && (t.url ?? "").endsWith("/panel.html") && t.webSocketDebuggerUrl);
      if (!panel?.webSocketDebuggerUrl) await Bun.sleep(500);
    }
    if (!panel?.webSocketDebuggerUrl || !panel.id) throw new Error("panel.html の tab が無い");
    const send = await cdp(panel.webSocketDebuggerUrl);
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
    return { send, id: panel.id };
  }

  let panelId = "";
  let send: Send = await (async () => {
    const a = await attachPanel();
    panelId = a.id;
    return a.send;
  })();

  const ev = async (e: string): Promise<unknown> => {
    const t = Date.now();
    const m = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
    if (Date.now() - t > 3000) console.log("SLOW", sec(), `${Date.now() - t}ms`, e.replace(/\s+/g, " ").slice(0, 90));
    if (m.result?.exceptionDetails) console.log("eval", m.result.exceptionDetails.text ?? m.result.exceptionDetails.exception?.description ?? "");
    return m.result?.result?.value;
  };
  const json = async (e: string): Promise<unknown> => {
    const v = await ev(e);
    if (typeof v !== "string" || !v) return null;
    try { return JSON.parse(v) as unknown; } catch { return null; }
  };
  const waitFor = async (pred: () => Promise<unknown>, tries = 40, ms = 250) => {
    const t = Date.now();
    if (await pollUntil(async () => !!(await pred()), tries * ms, ms)) return true;
    console.log("WAITFAIL", sec(), `${Date.now() - t}ms`, pred.toString().replace(/\s+/g, " ").slice(0, 90));
    return false;
  };
  // once() は busy の間の click / submit を捨てる。.on は applySwitch より先に付くので、名前だけでは待ったことにならない。
  const idle = async () => (await ev(`document.documentElement.dataset.busy !== "1"`)) === true;
  const settle = () => waitFor(idle, 120, 250);
  const act = async (expression: string) => {
    await settle();
    const v = await ev(expression);
    await settle();
    return v;
  };
  const asTabs = (v: unknown): TabInfo[] => Array.isArray(v) ? v as TabInfo[] : [];
  const asGroups = (v: unknown): GroupInfo[] => Array.isArray(v) ? v as GroupInfo[] : [];

  const tabs = async () => asTabs(await json(`chrome.tabs.query({ currentWindow: true }).then((ts) => JSON.stringify(ts.map((t) => ({ id: t.id, url: t.url || t.pendingUrl || '', title: t.title || '', active: !!t.active, index: t.index, groupId: t.groupId, lastAccessed: t.lastAccessed || 0 }))))`));
  const groups = async () => asGroups(await json(`chrome.tabGroups.query({}).then((gs) => JSON.stringify(gs.map((g) => ({ id: g.id, title: g.title || '', collapsed: !!g.collapsed }))))`));
  const activeTab = async () => (await tabs()).find((t) => t.active) ?? null;
  const groupFor = async (id: string) => (await groups()).find((g) => g.title.endsWith(`\u00b7#${id}`)) ?? null;
  const titles = async () => {
    const v = await json(`(() => {
      // 付いた tab は、選んだ会話の「…」の中（#attached）。一覧には出ない
      const box = document.getElementById('attached');
      if (!box || !document.querySelector('#roots .root.on')) return JSON.stringify({ titles: [], empty: false });
      const titles = [...box.querySelectorAll('.tab-title')].map((el) => ({ text: (el.textContent || '').trim(), disabled: el.disabled === true, label: el.getAttribute('title') || '' })).filter((t) => t.text);
      const empty = [...box.querySelectorAll('.attached-empty')].some((el) => (el.textContent || '').trim() === '付いた tab は無い');
      return JSON.stringify({ titles, empty });
    })()`) as { titles?: TitleInfo[]; empty?: boolean } | null;
    return { titles: v?.titles ?? [], empty: v?.empty === true };
  };
  const roots = async () => (await json(`JSON.stringify([...document.querySelectorAll('#roots button.root')].map((b) => {
    const li = b.closest('li');
    const outside = li ? [...li.querySelectorAll('span')].filter((s) => !b.contains(s)).map((s) => s.textContent || '') : [];
    return { text: b.querySelector('.root-text')?.textContent || '', on: b.classList.contains('on'), id: b.dataset.id || '', inner: (() => { const c = b.cloneNode(true); c.querySelectorAll('[hidden]').forEach((x) => x.remove()); return c.textContent || ''; })(), // hidden の印は文字だけ残るので、見えている物だけ数える
     outsideRunning: outside.some((s) => s.includes('動いています')) };
  }))`)) as RootInfo[] | null ?? [];
  // 行の「動いている・止める」は、今の画面では行でなく上の 1 行（#hd-st の「進んでいます」）と欄の右の丸（#send-btn の止める）に出る。
  // 「どの行の仕事か」は常駐の run.rowId で見る（2 本目は 1 本目が終わるまで rowId が移らない）
  const rowOf = async (text: string): Promise<RowInfo | null> => {
    const v = await json(`(() => {
      const want = ${q(text)};
      const lis = [...document.querySelectorAll('#rows li')].filter((n) => [...n.querySelectorAll('.chat-text')].some((p) => p.textContent === want));
      const li = lis[lis.length - 1];
      if (!li) return 'null';
      const spans = [...li.querySelectorAll('span')].map((s) => s.textContent || '');
      const blob = li.innerText || '';
      return JSON.stringify({ id: li.dataset.id || '', body: li.querySelector('.chat-text')?.textContent || '', fail: spans.some((s) => s.includes('失敗')), hint: blob.includes(${q(HINT)}), root: document.querySelector('#roots .root.on')?.dataset.id || '', working: (document.getElementById('hd-st')?.textContent || '').includes('進んでいます'), stopBtn: document.getElementById('send-btn').getAttribute('aria-label') === '止める' });
    })()`) as { id: string; body: string; fail: boolean; hint: boolean; root: string; working: boolean; stopBtn: boolean } | null;
    if (!v || typeof v !== "object") return null;
    const mine = v.root ? (await runs([Number(v.root)]))?.runs ?? [] : [];
    const live = mine.some((r) => r.status === "running" && r.rowId === Number(v.id));
    const running = live && v.working;
    return { id: v.id, body: v.body, stop: running && v.stopBtn, running, fail: v.fail, hint: v.hint, dbg: { live, working: v.working, stopBtn: v.stopBtn, runs: mine.map((r) => [r.status, r.rowId, r.queue]) } };
  };
  const runs = async (nodeIds: number[]) => {
    const mid = `v1-runs-${Math.random().toString(16).slice(2)}`;
    return await json(`new Promise((r) => {
      const p = chrome.runtime.connect();
      const mid = ${q(mid)};
      const t = setTimeout(() => r(''), 8000);
      p.onMessage.addListener((m) => { if (m.id === mid) { clearTimeout(t); r(JSON.stringify(m)); } });
      p.postMessage({ id: mid, op: 'runs', nodeIds: ${JSON.stringify(nodeIds)} });
    })`) as { ok?: boolean; runs?: { id?: string; nodeId?: number; status?: string; queue?: number; rowId?: number | null }[] } | null;
  };
  const treeTabs = async (id: string) => {
    const mid = `v1-tree-${Math.random().toString(16).slice(2)}`;
    const v = await json(`new Promise((r) => {
      const p = chrome.runtime.connect();
      const mid = ${q(mid)};
      const t = setTimeout(() => r(''), 8000);
      p.onMessage.addListener((m) => { if (m.id === mid) { clearTimeout(t); r(JSON.stringify(m)); } });
      p.postMessage({ id: mid, op: 'tree', rootId: ${Number(id) || 0} });
    })`) as { nodes?: { kind?: string; parentId?: number; url?: string; text?: string }[] } | null;
    return (v?.nodes ?? []).filter((n) => n.kind === "tab" && n.parentId === Number(id));
  };
  const onName = async () => String(await ev(`document.querySelector('#roots .root.on .root-text')?.textContent || ''`) ?? "");
  const submit = async (text: string) => {
    await act(`(() => { const f = document.getElementById('send-form'); const i = f.querySelector('input'); i.value = ${q(text)}; f.requestSubmit(); return 1; })()`);
  };
  // 狭い窓は 一覧 ⇄ 会話 の 2 画面。名前が合っていても一覧が開いたままなら、行を押して会話へ入る
  const chatOpen = async () => (await ev(`!document.getElementById('app').classList.contains('list-open')`)) === true;
  const selectName = async (name: string) => waitFor(async () => {
    if (await onName() === name && await chatOpen()) return await idle();
    await settle();
    if (await onName() === name && await chatOpen()) return await idle();
    await ev(`(() => { const b = [...document.querySelectorAll('#roots button.root')].find((n) => n.querySelector('.root-text')?.textContent === ${q(name)}); if (!b) return 0; b.click(); return 1; })()`);
    await settle();
    return (await onName()) === name && await chatOpen() && await idle();
  }, 80, 100);
  const clickTitle = async (text: string) => {
    await settle();
    const ok = (await ev(`(() => {
      const nodes = [...document.querySelectorAll('#attached button')];
      const el = nodes.find((n) => (n.textContent || '').trim() === ${q(text)});
      if (!el) return 0;
      el.click();
      return 1;
    })()`)) === 1;
    if (ok) await settle();
    return ok;
  };
  const clickOn = async () => {
    await settle();
    const v = await ev(`(() => { const b = document.querySelector('#roots .root.on'); if (!b) return 0; b.click(); return 1; })()`);
    await settle();
    return v;
  };
  const refreshTitles = async () => { await clickOn(); };
  // 止める = 欄の右の丸（#send-btn・data-stop に run id）。行ごとの「止める」は無い
  const stopCount = async () => (await json(`JSON.stringify({ n: document.getElementById('send-btn').getAttribute('aria-label') === '止める' ? 1 : 0, outside: 0 })`)) as { n: number; outside: number } | null;
  const createHttp = async (name: string, active: boolean): Promise<TabInfo | null> => {
    const url = page(name);
    const before = new Set((await tabs()).map((t) => t.id));
    await ev(`chrome.tabs.create({ url: ${q(url)}, active: ${active} }).then(() => 1)`);
    for (let i = 0; i < 40; i++) {
      const made = (await tabs()).find((t) => !before.has(t.id) && t.url.includes(`t=${encodeURIComponent(name)}`));
      if (made && made.title === name) return made;
      await Bun.sleep(250);
    }
    return null;
  };
  const waitActive = async (id: number) => waitFor(async () => (await activeTab())?.id === id);
  const httpTabs = (list: TabInfo[]) => list.filter((t) => /^https?:/.test(t.url));

  // —— ① 空の画面、課題、付いた題名 ——
  type PanelReady = { disabled?: boolean; placeholder?: string; plus?: string; field?: string; msg?: string; create?: boolean; failSpan?: boolean };
  let ready: PanelReady | null = null;
  for (let i = 0; i < 45; i++) {
    ready = await json(`JSON.stringify({ disabled: document.getElementById('empty-text').disabled, placeholder: document.getElementById('empty-text').placeholder, plus: document.getElementById('plus').getAttribute('aria-label'), field: document.getElementById('send-text').placeholder, msg: (document.getElementById('empty-msg').textContent || '').trim(), create: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '作る'), failSpan: [...document.querySelectorAll('#empty span')].some((s) => (s.textContent || '').includes('失敗')) })`) as PanelReady | null;
    if (ready?.placeholder === "失敗") break;
    if (ready && ready.disabled === false && ready.placeholder === EMPTY_HINT) break;
    await Bun.sleep(1000);
  }
  console.log("panel:", JSON.stringify(ready));
  expect("emptyMsg", ready?.msg === EMPTY_MSG, ready);
  expect("emptyPlaceholder", ready?.placeholder === EMPTY_HINT && ready?.disabled === false, ready);
  expect("plusLabel", ready?.plus === "新しい会話", ready);
  expect("noCreateButton", ready?.create === false, ready);
  expect("noFailSpan", ready?.failSpan === false, ready);
  const beforeEmpty = await json(`JSON.stringify({ msg: (document.getElementById('empty-msg').textContent || '').trim(), roots: document.querySelectorAll('#roots .root').length, hidden: document.getElementById('empty').hidden === true })`);
  await act(`(() => { const i = document.getElementById('empty-text'); i.value = '   '; document.getElementById('empty-form').requestSubmit(); return 1; })()`);
  await Bun.sleep(400);
  const afterEmpty = await json(`JSON.stringify({ msg: (document.getElementById('empty-msg').textContent || '').trim(), roots: document.querySelectorAll('#roots .root').length, hidden: document.getElementById('empty').hidden === true })`);
  expect("emptyEnter", JSON.stringify(beforeEmpty) === JSON.stringify(afterEmpty), { beforeEmpty, afterEmpty });

  await act(`(() => { const i = document.getElementById('empty-text'); i.value = ${q("課題")}; document.getElementById('empty-form').requestSubmit(); return 1; })()`);
  const made = await waitFor(async () => (await ev(`document.querySelector('#roots .root.on .root-text')?.textContent || ''`)) === "課題");
  const kadai = (await roots()).find((r) => r.text === "課題");
  expect("madeKadai", made && !!kadai?.id, kadai);
  if (!kadai?.id) throw new Error("課題ができない");
  const kadaiId = kadai.id;
  await shot(send, "v1-1.png");

  const blank = await activeTab();
  const addLine = async () => await json(`(() => {
    const btn = document.getElementById('add-tab');
    const tools = document.getElementById('session-tools');
    const phrase = ${q(ADD_HINT)};
    // 「＋今のタブ」と付けられない理由は、会話の「…」の中（開いてあるか確かめてから見る）
    if (document.getElementById('more').hidden) document.getElementById('hd-more').click();
    const note = document.querySelector('#attached .attached-note');
    return JSON.stringify({ disabled: !!btn.disabled, visible: btn.getClientRects().length > 0, hint: !!note && (note.textContent || '').includes(phrase), same: !!note && !!note.closest('.attached'), hintFrame: !!document.getElementById('hint') });
  })()`) as { disabled: boolean; visible: boolean; hint: boolean; same: boolean; hintFrame: boolean } | null;
  let blankAdd = await addLine();
  if (blank && !/^https?:/.test(blank.url)) {
    const seen = await waitFor(async () => {
      blankAdd = await addLine();
      return !!blankAdd && blankAdd.visible && blankAdd.disabled && blankAdd.hint && blankAdd.same;
    });
    expect("addDisabledOnBlank", seen, blankAdd);
    expect("addHintSameLine", !!blankAdd?.same && blankAdd?.hintFrame === false, blankAdd);
  } else {
    expect("addDisabledOnBlank", false, blank);
  }

  const lms1 = await createHttp("LMS-1", true);
  const lms1Enabled = await waitFor(async () => (await ev(`document.getElementById('add-tab').disabled === false`)) === true);
  await act(`document.getElementById('add-tab').click(); 1`);
  const lms1Titled = await waitFor(async () => (await titles()).titles.some((t) => t.text === "LMS-1"));
  expect("titleAttr", (await titles()).titles.every((t) => t.label === t.text), await titles());
  const lms1Nodes = await treeTabs(kadaiId);
  const lms1Group = await groupFor(kadaiId);
  const lms1Grouped = !!lms1 && !!lms1Group && (await tabs()).some((t) => t.id === lms1.id && t.groupId === lms1Group.id);
  expect("attachedLms", lms1Enabled && lms1Titled && lms1Nodes.some((n) => (n.url ?? "").includes("t=LMS-1")), { lms1Enabled, lms1Titled, lms1Nodes });
  expect("groupedLms", lms1Grouped, { lms1Group, lms1 });
  const other = await createHttp("OTHER", true);
  const clickedLms = await clickTitle("LMS-1");
  const lmsFront = !!lms1 && await waitActive(lms1.id);
  expect("titleClickFront", clickedLms && lmsFront, { clickedLms, active: await activeTab() });
  expect("titleNotLastAccessed", !!other && !!lms1 && (await activeTab())?.id === lms1.id && other.id !== lms1.id, await activeTab());
  const frontBeforePill = (await activeTab())?.id;
  await clickOn();
  await Bun.sleep(800);
  const onRoot = (await roots()).find((r) => r.on);
  expect("selectedRootNoSwitch", (await activeTab())?.id === frontBeforePill && !!onRoot && !onRoot.inner.includes("止める") && !onRoot.inner.includes("失敗"), { frontBeforePill, now: (await activeTab())?.id, onRoot });

  const lms2 = await createHttp("LMS-2", true);
  await waitFor(async () => (await ev(`document.getElementById('add-tab').disabled === false`)) === true);
  await act(`document.getElementById('add-tab').click(); 1`);
  await waitFor(async () => (await titles()).titles.some((t) => t.text === "LMS-2"));
  if (lms2) await ev(`chrome.tabs.remove(${lms2.id}).then(() => 1)`);
  await waitFor(async () => !(await tabs()).some((t) => t.url.includes("t=LMS-2")));
  await refreshTitles();
  // v28 (e): 進んだ頁が 0 枚なら、閉じた頁は押せて、窓に別の http があれば裏で開き group に入る（disabled は (d) の 2 枚以上だけ）
  const closedRow = (await titles()).titles.find((t) => t.text === "LMS-2");
  const activeBeforeClosed = (await activeTab())?.id;
  const urlsBeforeClosed = new Set((await tabs()).map((t) => t.url));
  await clickTitle("LMS-2");
  let reopened2: TabInfo | null = null;
  for (let i = 0; i < 40 && !reopened2; i++) {
    reopened2 = (await tabs()).find((t) => !urlsBeforeClosed.has(t.url) && t.url.includes("t=LMS-2")) ?? null;
    if (!reopened2) await Bun.sleep(250);
  }
  const gClosed = await groupFor(kadaiId);
  for (let i = 0; i < 40 && reopened2 && gClosed && reopened2.groupId !== gClosed.id; i++) {
    await Bun.sleep(250);
    reopened2 = (await tabs()).find((t) => t.id === reopened2!.id) ?? reopened2;
  }
  expect("closedTitleEnabled", closedRow?.disabled === false, await titles());
  expect("closedTitleOpensBack", !!reopened2 && reopened2.active === false && (await activeTab())?.id === activeBeforeClosed && !!gClosed && reopened2.groupId === gClosed.id, { reopened2, activeBeforeClosed, active: await activeTab() });
  // 後の通しの前提（LMS-2 の tab が窓に無い）へ戻す
  if (reopened2) await ev(`chrome.tabs.remove(${reopened2.id}).then(() => 1)`);
  await waitFor(async () => !(await tabs()).some((t) => t.url.includes("t=LMS-2")));

  const lms2b = await createHttp("LMS-2", true);
  await act(`(() => { document.getElementById('plus').click(); const i = document.getElementById('send-text'); i.value = '  '; document.getElementById('send-form').requestSubmit(); return 1; })()`);
  await Bun.sleep(400);
  expect("emptyPlus", (await roots()).length === 1, await roots());
  const kadaiGroupBefore = await groupFor(kadaiId);
  const collapsedBefore = kadaiGroupBefore?.collapsed ?? null;
  await act(`(() => { document.getElementById('plus').click(); const i = document.getElementById('send-text'); i.value = ${q("研究")}; document.getElementById('send-form').requestSubmit(); return 1; })()`);
  expect("madeKenkyu", await waitFor(async () => (await ev(`document.querySelector('#roots .root.on .root-text')?.textContent || ''`)) === "研究"));
  const kenkyuView = await titles();
  await Bun.sleep(500);
  const kadaiGroupAfter = await groupFor(kadaiId);
  expect("researchNoMix", !kenkyuView.titles.some((t) => t.text.startsWith("LMS-")), kenkyuView);
  expect("researchEmptyTabs", kenkyuView.empty === true, kenkyuView);
  expect("researchNoCollapse", !!kadaiGroupBefore && kadaiGroupAfter?.collapsed === collapsedBefore, { collapsedBefore, after: kadaiGroupAfter });

  if (lms1 && lms2b) await ev(`chrome.tabs.move(${lms2b.id}, { index: 0 }).then(() => 1)`);
  await Bun.sleep(300);
  const order = (await tabs()).filter((t) => t.url.includes("t=LMS-"));
  const firstMatching = order[0];
  await selectName("課題");
  await selectName("研究");
  await selectName("課題");
  const matched = !!firstMatching && await waitActive(firstMatching.id);
  const oldest = order.find((t) => t.url.includes("t=LMS-1"));
  expect("matching0", matched && !!oldest && firstMatching?.url.includes("t=LMS-2") && (await activeTab())?.id !== oldest.id, { firstMatching, active: await activeTab(), order });

  for (const name of ["LMS-3", "LMS-4"]) {
    const tab = await createHttp(name, true);
    await waitFor(async () => (await ev(`document.getElementById('add-tab').disabled === false`)) === true);
    await act(`document.getElementById('add-tab').click(); 1`);
    if (name === "LMS-3") await waitFor(async () => (await titles()).titles.some((t) => t.text === name));
    else await Bun.sleep(500);
    if (name === "LMS-4" && tab) {
      await waitActive(tab.id);
      await waitFor(async () => (await treeTabs(kadaiId)).some((n) => (n.text ?? "") === "LMS-4"));
    }
  }
  await selectName("研究");
  await selectName("課題");
  const shown = await titles();
  const saved = await treeTabs(kadaiId);
  const savedTexts = saved.map((n) => n.text ?? "");
  expect("threeTitles", shown.titles.length === 3 && shown.titles.map((t) => t.text).join("|") === savedTexts.slice(0, 3).join("|"), { shown, savedTexts });
  expect("fourthHidden", !shown.titles.some((t) => t.text === "LMS-4") && savedTexts.includes("LMS-4"), { shown, savedTexts });
  expect("fourthInTree", saved.length >= 4, savedTexts);
  expect("thirdNotSwapped", shown.titles[2]?.text === savedTexts[2] && shown.titles[2]?.text !== "LMS-4", shown);

  await act(`(() => { document.getElementById('plus').click(); const i = document.getElementById('send-text'); i.value = ${q("メモ")}; document.getElementById('send-form').requestSubmit(); return 1; })()`);
  expect("madeMemo", await selectName("メモ"));
  const memo = (await roots()).find((r) => r.text === "メモ");
  const memoMid = `v1-add-${Math.random().toString(16).slice(2)}`;
  await json(`new Promise((r) => {
    const p = chrome.runtime.connect();
    const mid = ${q(memoMid)};
    const t = setTimeout(() => r(''), 8000);
    p.onMessage.addListener((m) => { if (m.id === mid) { clearTimeout(t); r(JSON.stringify(m)); } });
    p.postMessage({ id: mid, op: 'addTabs', nodeId: ${Number(memo?.id) || 0}, tabs: [{ title: '', url: ${q(page("empty-title"))} }] });
  })`);
  await selectName("課題");
  await selectName("メモ");
  const hostView = await titles();
  const hostText = `127.0.0.1:${server.port}`;
  expect("hostTitle", hostView.titles.some((t) => t.text === hostText) && !hostView.titles.some((t) => t.text.startsWith("LMS-")), hostView);

  // 保存 url を窓から外す。group に残った http のうち、lastAccessed が新しい（窓の先頭ではない）方を前にする
  await selectName("課題");
  const savedUrls = (await treeTabs(kadaiId)).map((n) => n.url ?? "").filter((u) => u.length > 0);
  const holders = (await tabs()).filter((t) => savedUrls.includes(t.url));
  for (let i = 0; i < holders.length; i++) {
    const holder = holders[i];
    if (!holder) continue;
    await ev(`chrome.tabs.update(${holder.id}, { url: ${q(page(`NOW-${i}`))} }).then(() => 1)`);
  }
  await waitFor(async () => !(await tabs()).some((t) => savedUrls.includes(t.url)));
  const kadaiGroup = await groupFor(kadaiId);
  const inGroup = (await tabs()).filter((t) => kadaiGroup && t.groupId === kadaiGroup.id && /^https?:/.test(t.url)).sort((a, b) => a.index - b.index);
  const older = inGroup[0];
  const newer = inGroup[inGroup.length - 1];
  if (older && newer && older.id !== newer.id) {
    await ev(`chrome.tabs.update(${older.id}, { active: true }).then(() => 1)`);
    await Bun.sleep(250);
    await ev(`chrome.tabs.update(${newer.id}, { active: true }).then(() => 1)`);
    await waitActive(newer.id);
    await selectName("研究");
    await selectName("課題");
    const came = await waitActive(newer.id);
    const openedSaved = (await tabs()).some((t) => savedUrls.includes(t.url));
    expect("lastAccessed", came && (await activeTab())?.id === newer.id && (await activeTab())?.id !== older.id, { newer, older, active: await activeTab() });
    expect("savedNotOpened", openedSaved === false, { savedUrls, tabs: (await tabs()).map((t) => t.url) });
  } else {
    expect("lastAccessed", false, inGroup);
    expect("savedNotOpened", false, inGroup);
  }

  const dropHttp = async () => {
    const ids = httpTabs(await tabs()).map((t) => t.id);
    if (ids.length) await ev(`chrome.tabs.remove(${JSON.stringify(ids)}).then(() => 1)`);
    await waitFor(async () => httpTabs(await tabs()).length === 0);
  };

  // group に http が無い・窓には別の http がある。題名行は裏で開き、group に入る
  await dropHttp();
  await selectName("課題");
  const outside = await createHttp("OUTSIDE", true);
  // 根の押下は、group が窓に 1 枚も無いと 1 行目を開く（v28 2-2）。ここでは押さず、前面の購読の描き直しを待つ
  await waitFor(async () => (await titles()).titles.some((t) => t.text === "LMS-1" && !t.disabled));
  const lmsRow = (await titles()).titles.find((t) => t.text === "LMS-1");
  const urlsBeforeOpen = new Set((await tabs()).map((t) => t.url));
  await clickTitle("LMS-1");
  let openedBack: TabInfo | null = null;
  for (let i = 0; i < 40 && !openedBack; i++) {
    openedBack = (await tabs()).find((t) => !urlsBeforeOpen.has(t.url) && t.url.includes("t=LMS-1")) ?? null;
    if (!openedBack) await Bun.sleep(250);
  }
  const backOk = !!openedBack;
  // group へ入れるのは開いた後なので、groupId が付くまで待つ（付かなければ赤のまま）
  const gBack = await groupFor(kadaiId);
  for (let i = 0; i < 40 && openedBack && gBack && openedBack.groupId !== gBack.id; i++) {
    await Bun.sleep(250);
    openedBack = (await tabs()).find((t) => t.id === openedBack!.id) ?? openedBack;
  }
  expect("titleEnabledWithoutGroupHttp", lmsRow?.disabled === false, await titles());
  expect("openBackground", backOk && !!openedBack && openedBack.active === false && (await activeTab())?.id === outside?.id, { openedBack, active: await activeTab() });
  expect("openInGroup", !!openedBack && !!gBack && openedBack.groupId === gBack.id, { openedBack, gBack });

  // 窓に http が無いとき、pill は付いた順の 1 行目だけを前面で開く（v28 2-3）。2 枚目以降は題名行を押すと裏で group に入る
  await dropHttp();
  await selectName("研究");
  const savedOrder = (await treeTabs(kadaiId)).map((n) => n.url ?? "").filter((u) => u.length > 0);
  await selectName("課題");
  const openedFirst = await waitFor(async () => (await tabs()).some((t) => t.url === savedOrder[0]));
  await Bun.sleep(600);
  const afterPill = await tabs();
  const firstTab = afterPill.find((t) => t.url === savedOrder[0]) ?? null;
  const gAll = await groupFor(kadaiId);
  expect("openFrontWhenNoHttp", openedFirst && !!firstTab && firstTab.active === true, { savedOrder, active: await activeTab() });
  expect("pillOpensOnlyFirst", savedOrder.slice(1).every((u) => !afterPill.some((t) => t.url === u)), afterPill.map((t) => t.url));
  expect("firstEnterGroup", !!gAll && !!firstTab && firstTab.groupId === gAll.id, { gAll, firstTab });
  const rowsToOpen = [(await titles()).titles[1]?.text, (await titles()).titles[2]?.text].filter((x): x is string => !!x);
  const openedByRow: (TabInfo | null)[] = [];
  for (const text of rowsToOpen) {
    const seen = new Set((await tabs()).map((t) => t.id));
    await clickTitle(text);
    let made: TabInfo | null = null;
    for (let i = 0; i < 40 && !made; i++) {
      made = (await tabs()).find((t) => !seen.has(t.id) && t.url.includes(`t=${text}`)) ?? null;
      if (!made) await Bun.sleep(250);
    }
    for (let i = 0; i < 40 && made && gAll && made.groupId !== gAll.id; i++) {
      await Bun.sleep(250);
      made = (await tabs()).find((t) => t.id === made!.id) ?? made;
    }
    openedByRow.push(made);
  }
  expect("secondOpenBackground", rowsToOpen.length === 2 && openedByRow.every((t) => !!t && t.active === false) && (await activeTab())?.id === firstTab?.id, openedByRow);
  expect("openedEnterGroup", !!gAll && openedByRow.every((t) => !!t && t.groupId === gAll.id), { gAll, openedByRow });
  await shot(send, "v1-2.png");

  // —— ② 設問の印、研究へ行って戻る、止める前の見ている位置 ——
  await selectName("課題");
  await submit("設問3を解いて");
  const question = await waitFor(async () => {
    const row = await rowOf("設問3を解いて");
    return !!row && row.running && row.stop && row.body === "設問3を解いて";
  }, 60);
  const onWhileOpen = (await roots()).find((r) => r.text === "課題");
  expect("questionMark", question, await rowOf("設問3を解いて"));
  expect("openRootNoMark", !!onWhileOpen?.on && !onWhileOpen.inner.includes("動いています"), onWhileOpen);
  expect("oneStop", (await stopCount())?.outside === 0 && (await stopCount())?.n === 1, await stopCount());
  await selectName("研究");
  const whileResearch = await roots();
  const kadaiBtn = whileResearch.find((r) => r.text === "課題");
  const kenkyuBtn = whileResearch.find((r) => r.text === "研究");
  expect("unwatchedHasMark", !!kadaiBtn && !kadaiBtn.on && kadaiBtn.inner.includes("動いています") && kadaiBtn.outsideRunning === false, whileResearch);
  expect("researchButtonNoMark", !!kenkyuBtn?.on && !kenkyuBtn.inner.includes("動いています"), kenkyuBtn);
  expect("rootNoStopWords", whileResearch.every((r) => !r.inner.includes("止める") && !r.inner.includes("止まった") && !r.inner.includes("失敗")), whileResearch);
  const researchTitles = await titles();
  expect("researchStillEmpty", researchTitles.empty === true && researchTitles.titles.length === 0, researchTitles);

  await selectName("課題");
  const filler = `新しいタブの見出しを${"あ".repeat(2500)}にして`;
  await submit(filler);
  await waitFor(async () => (await rowOf(filler)) != null, 60);
  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 480, deviceScaleFactor: 1, mobile: false });
  await selectName("研究");
  await selectName("課題");
  const scrollOf = async () => await json(`(() => {
    const box = document.getElementById('rows');
    const stop = [...box.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '止める');
    const last = box.querySelector('li:last-child');
    const br = box.getBoundingClientRect();
    const sr = stop ? stop.getBoundingClientRect() : null;
    const head = stop ? stop.closest('li').getBoundingClientRect() : null;
    const lr = last ? last.getBoundingClientRect() : null;
    return JSON.stringify({ stopBottom: sr && sr.bottom, rowsTop: br.top, rowsBottom: br.bottom, headTop: head && head.top, lastBottom: lr && lr.bottom, scrollTop: box.scrollTop, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight });
  })()`) as { stopBottom: number | null; rowsTop: number; rowsBottom: number; headTop: number | null; lastBottom: number | null; scrollTop: number; scrollHeight: number; clientHeight: number } | null;
  let scroll = await scrollOf();
  const scrollSeen = await waitFor(async () => {
    scroll = await scrollOf();
    return !!scroll && scroll.scrollHeight > scroll.clientHeight + 40 && Math.abs(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) < 2;
  });
  // v28 2-2 (i): chat を開いた直後は末尾（見た目の失敗の行は返事ではないので頭へは寄せない）。「止める」が遠くても行までスクロールして押す
  expect("scrollOpenToEnd", scrollSeen, scroll);
  await ev(`document.getElementById('rows').scrollTop = 30; 1`);
  await Bun.sleep(2600);
  const kept = Number(await ev(`document.getElementById('rows').scrollTop`));
  expect("scrollKeep", Math.abs(kept - 30) < 2, { kept });
  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });

  await submit("続きを書いて");
  const secondQueued = await waitFor(async () => {
    const first = await rowOf("設問3を解いて");
    const second = await rowOf("続きを書いて");
    return !!first?.running && !!first.stop && !!second && second.body === "続きを書いて" && !second.running && !second.stop;
  }, 60);
  await Bun.sleep(500);
  const secondStill = await rowOf("続きを書いて");
  const firstStill = await rowOf("設問3を解いて");
  expect("secondNoMark", secondQueued && !!secondStill && !secondStill.running && !!firstStill?.running, { firstStill, secondStill });

  const rowBeforeClose = await rowOf("設問3を解いて");
  const runBeforeClose = (await runs([Number(kadaiId)]))?.runs?.find((r) => r.status === "running" && r.nodeId === Number(kadaiId));
  expect("rowId", !!rowBeforeClose && runBeforeClose?.rowId === Number(rowBeforeClose.id) && runBeforeClose?.queue != null, { rowBeforeClose, runBeforeClose });
  await browser("Target.closeTarget", { targetId: panelId });
  await waitFor(async () => !(await targets()).some((t) => (t.url ?? "").endsWith("/panel.html")));
  // 閉じた panel を開き直す（attachPanel は探すだけなので、先に開く）
  await browser("Target.createTarget", { url: `chrome-extension://${extId}/panel.html` });
  const again = await attachPanel();
  panelId = again.id;
  send = again.send;
  const reopened = await waitFor(async () => {
    const row = await rowOf("設問3を解いて");
    return !!row && row.running && row.stop && row.id === rowBeforeClose?.id;
  }, 60);
  const frontAfterOpen = await activeTab();
  expect("reopenMark", reopened, await rowOf("設問3を解いて"));
  expect("reopenRowId", (await rowOf("設問3を解いて"))?.id === String(runBeforeClose?.rowId ?? ""), await rowOf("設問3を解いて"));
  expect("reopenFrontIsPanel", (frontAfterOpen?.url ?? "").includes("panel.html"), frontAfterOpen);
  await shot(send, "v1-3.png");

  // —— ③ 見た目。走っている印は残し、戻してから仕事に戻る ——
  const ntpSockets = new Map<string, Send>();
  const readH1 = async (pageSend: Send): Promise<H1Info | null> => {
    const m = await pageSend("Runtime.evaluate", {
      expression: `(() => { const h = document.querySelector('h1'); const b = document.getElementById('open'); if (!h || !b) return ''; return JSON.stringify({ text: h.textContent || '', style: h.style.color || '', computed: getComputedStyle(h).color || '', open: (b.textContent || '').trim(), buttons: [...document.querySelectorAll('button')].map((x) => (x.textContent || '').trim()) }); })()`,
      returnByValue: true,
    });
    const v = m.result?.result?.value;
    if (typeof v !== "string" || !v) return null;
    try { return JSON.parse(v) as H1Info; } catch { return null; }
  };
  const findNtp = async (want: (info: H1Info) => boolean) => {
    const list = (await targets()).filter((t) => t.type === "page" && t.id && t.webSocketDebuggerUrl && !(t.url ?? "").includes("panel.html"));
    for (const t of list) {
      const id = t.id;
      const url = t.webSocketDebuggerUrl;
      if (!id || !url) continue;
      const pageSend = ntpSockets.get(id) ?? await cdp(url);
      ntpSockets.set(id, pageSend);
      const info = await readH1(pageSend);
      if (info?.open === "会話を開く" && want(info)) return { send: pageSend, info, id };
    }
    return null;
  };
  const openNtp = async (active: boolean) => {
    const before = new Set((await targets()).map((t) => t.id));
    await ev(`chrome.tabs.create({ url: 'chrome://newtab/', active: ${active} }).then(() => 1)`);
    for (let i = 0; i < 40; i++) {
      const list = (await targets()).filter((t) => t.id && !before.has(t.id) && t.webSocketDebuggerUrl && t.type === "page");
      for (const t of list) {
        const id = t.id;
        const url = t.webSocketDebuggerUrl;
        if (!id || !url) continue;
        const pageSend = ntpSockets.get(id) ?? await cdp(url);
        ntpSockets.set(id, pageSend);
        // 新しいタブは、裏から今の見た目を受け取ってから塗る（それまでは同梱の見た目）
        const painted = (await pageSend("Runtime.evaluate", { expression: "document.body.dataset.painted || ''", returnByValue: true })).result?.result?.value === "1";
        const info = await readH1(pageSend);
        if (painted && info?.open === "会話を開く") return { send: pageSend, info, id };
      }
      await Bun.sleep(250);
    }
    return null;
  };

  const activeBeforeColor = (await activeTab())?.id;
  await submit("新しいタブの見出しを青くして");
  const blueRow = await waitFor(async () => {
    const row = await rowOf("新しいタブの見出しを青くして");
    const qrow = await rowOf("設問3を解いて");
    return !!row && row.body === "新しいタブの見出しを青くして" && !row.running && !row.stop && !!qrow?.running;
  }, 60);
  const blueFile = oneLine(overrideRaw());
  expect("colorBlueNoMark", blueRow, await rowOf("新しいタブの見出しを青くして"));
  expect("colorFileBlueOnly", blueFile === "h1 { color: blue; }", blueFile);
  expect("colorNoFront", (await activeTab())?.id === activeBeforeColor, { activeBeforeColor, now: (await activeTab())?.id });
  const ntp = await openNtp(false);
  let ntpSend = ntp?.send ?? null;
  const ntpBlue = await waitFor(async () => {
    if (!ntpSend) return false;
    const info = await readH1(ntpSend);
    return !!info && info.text === "Kangae" && isNamed(info.style, info.computed, "blue");
  }, 40);
  const ntpInfo = ntpSend ? await readH1(ntpSend) : null;
  expect("ntpBlue", ntpBlue && ntpInfo?.text === "Kangae", ntpInfo);
  expect("ntpNoRestore", !!ntpInfo && ntpInfo.buttons.length === 1 && ntpInfo.buttons[0] === "会話を開く", ntpInfo);
  expect("textStaysDefault", ntpInfo?.text === "Kangae", ntpInfo);
  await selectName("課題"); // 狭い窓は一覧が開いたままだと会話が隠れる
  const clearPos = await json(`(() => {
    const c = document.getElementById('clear-ui');
    const f = document.getElementById('send-form');
    if (!c || c.hidden || !f) return JSON.stringify({ shown: false });
    const cr = c.getBoundingClientRect();
    const fr = f.getBoundingClientRect();
    return JSON.stringify({ shown: true, above: cr.bottom <= fr.top + 2 && cr.top < fr.top, cr: [cr.top, cr.bottom], fr: [fr.top, fr.bottom], listOpen: document.getElementById('app').classList.contains('list-open') });
  })()`) as { shown?: boolean; above?: boolean; cr?: number[]; fr?: number[]; listOpen?: boolean } | null;
  expect("clearAboveSend", clearPos?.shown === true && clearPos.above === true, clearPos);

  const moreBlue = ["新しいタブの見出しを青くしてください", "新しいタブの見出しを青にして", "新しいタブの見出しを青くして。", "新しいタブを青くして"];
  for (const text of moreBlue) {
    await submit(text);
    const ok = await waitFor(async () => {
      const row = await rowOf(text);
      return !!row && !row.running && !row.stop && !row.fail;
    }, 40);
    const info = ntpSend ? await readH1(ntpSend) : null;
    expect(`blue:${text}`, ok && !!info && info.text === "Kangae" && isNamed(info.style, info.computed, "blue"), { row: await rowOf(text), info });
  }
  await submit("新しいタブをピンクにして");
  const pinkOk = await waitFor(async () => {
    const info = ntpSend ? await readH1(ntpSend) : null;
    const row = await rowOf("新しいタブをピンクにして");
    return !!row && !row.running && !!info && info.text === "Kangae" && isNamed(info.style, info.computed, "pink");
  }, 40);
  expect("pink", pinkOk, { row: await rowOf("新しいタブをピンクにして"), info: ntpSend ? await readH1(ntpSend) : null });
  await submit("新しいタブの見出しを青くして");
  expect("backToBlue", await waitFor(async () => {
    const info = ntpSend ? await readH1(ntpSend) : null;
    return !!info && info.text === "Kangae" && isNamed(info.style, info.computed, "blue");
  }, 40), ntpSend ? await readH1(ntpSend) : null);

  const failures = ["新しいタブの見出しを大きくして", "新しいタブの見出しを青春にして", "新しいタブの見出しを白紙にして", "新しいタブの見出しをにして", "新しいタブの見出しを{青}にして", "新しいタブの見出しを青く『今週の募集』にして"];
  for (const text of failures) {
    await submit(text);
    const ok = await waitFor(async () => {
      const row = await rowOf(text);
      return !!row && row.body === text && row.fail && row.hint && !row.running && !row.stop;
    }, 40);
    const info = ntpSend ? await readH1(ntpSend) : null;
    const clearShown = (await ev(`document.getElementById('clear-ui').hidden === false`)) === true;
    expect(`fail:${text}`, ok && !!info && info.text === "Kangae" && isNamed(info.style, info.computed, "blue") && clearShown, { row: await rowOf(text), info, clearShown });
  }
  expect("markSurvivedFail", (await rowOf("設問3を解いて"))?.running === true, await rowOf("設問3を解いて"));

  await submit("新しいタブの見出しを『青』にして");
  const ao = await waitFor(async () => {
    const info = ntpSend ? await readH1(ntpSend) : null;
    const row = await rowOf("新しいタブの見出しを『青』にして");
    return !!row && !row.running && !row.fail && !!info && info.text === "青" && isNamed(info.style, info.computed, "blue");
  }, 40);
  expect("quoteAoNotColor", ao && oneLine(overrideRaw()) === "h1 { color: blue; } 青", { file: overrideRaw(), info: ntpSend ? await readH1(ntpSend) : null });

  await submit("新しいタブの見出しを『今週の募集』にして");
  const recruit = await waitFor(async () => {
    const info = ntpSend ? await readH1(ntpSend) : null;
    return !!info && info.text === "今週の募集" && isNamed(info.style, info.computed, "blue");
  }, 40);
  const recruitFile = overrideRaw();
  expect("recruitText", recruit, ntpSend ? await readH1(ntpSend) : null);
  expect("recruitFile", recruitFile === "h1 { color: blue; } 今週の募集\n", recruitFile);
  const nextWhileBlue = await openNtp(false);
  expect("recruitNewTab", !!nextWhileBlue && nextWhileBlue.info.text === "今週の募集" && isNamed(nextWhileBlue.info.style, nextWhileBlue.info.computed, "blue") && nextWhileBlue.info.buttons.join(",") === "会話を開く", nextWhileBlue?.info);
  expect("markSurvivedPaint", (await rowOf("設問3を解いて"))?.running === true && (await rowOf("設問3を解いて"))?.stop === true, await rowOf("設問3を解いて"));

  if (ntpSend) await shot(ntpSend, "v1-4.png");
  const promptsBeforeStop = prompts();
  await act(`(() => { const b = document.getElementById('send-btn'); if (b.getAttribute('aria-label') !== '止める') return 0; b.click(); return 1; })()`);
  const stopped = await waitFor(async () => {
    const row = await rowOf("設問3を解いて");
    return !!row && !row.running && !row.stop;
  }, 60);
  const runAfter = (await runs([Number(kadaiId)]))?.runs?.find((r) => r.nodeId === Number(kadaiId));
  const chatBlob = String(await ev(`document.getElementById('rows').innerText || ''`));
  expect("stopClearsMark", stopped, await rowOf("設問3を解いて"));
  expect("stopQueueEmpty", runAfter?.status === "stopped" && runAfter.queue === 0, runAfter);
  expect("stopNo480", !chatBlob.includes("短い返事") && !chatBlob.includes("🤖"), chatBlob.slice(0, 200));
  expect("stopDropsSecond", !prompts().includes("続きを書いて") && promptsBeforeStop.includes("設問3を解いて"), prompts());
  expect("noStoppedWord", !chatBlob.includes("止めた"), chatBlob.includes("続きを書いて"));
  expect("bodiesRemain", (await rowOf("設問3を解いて"))?.body === "設問3を解いて" && (await rowOf("続きを書いて"))?.body === "続きを書いて", { a: await rowOf("設問3を解いて"), b: await rowOf("続きを書いて") });

  await act(`document.getElementById('clear-ui').click(); 1`);
  const restored = await waitFor(async () => {
    const hidden = (await ev(`document.getElementById('clear-ui').hidden === true`)) === true;
    const info = ntpSend ? await readH1(ntpSend) : null;
    return hidden && !!info && info.text === "Kangae" && info.style === "" && !isNamed(info.style, info.computed, "blue");
  }, 40);
  const restoredInfo = ntpSend ? await readH1(ntpSend) : null;
  expect("restoredH1", restored && restoredInfo?.text === "Kangae" && restoredInfo.style === "", restoredInfo);
  expect("restoredButtonGone", (await ev(`document.getElementById('clear-ui').hidden === true`)) === true);
  expect("restoredFileGone", overrideRaw() == null, overrideRaw());

  await submit("新しいタブの見出しを『今週の募集』にして");
  const textOnly = await waitFor(async () => {
    const info = ntpSend ? await readH1(ntpSend) : null;
    const shown = (await ev(`document.getElementById('clear-ui').hidden === false`)) === true;
    return !!info && info.text === "今週の募集" && info.style === "" && !isNamed(info.style, info.computed, "blue") && shown;
  }, 40);
  const textFile = overrideRaw();
  expect("textOnlyFile", textFile === "h1 { } 今週の募集\n", textFile);
  expect("textOnlyNotBlue", textOnly, ntpSend ? await readH1(ntpSend) : null);
  expect("textOnlyNotEmpty", (ntpSend ? await readH1(ntpSend) : null)?.text === "今週の募集");
  const nextPlain = await openNtp(false);
  expect("textOnlyNewTab", !!nextPlain && nextPlain.info.text === "今週の募集" && nextPlain.info.style === "" && !isNamed(nextPlain.info.style, nextPlain.info.computed, "blue"), nextPlain?.info);
  expect("textOnlyButtonStays", (await ev(`document.getElementById('clear-ui').hidden === false`)) === true);

  const h1BeforeJobs = ntpSend ? await readH1(ntpSend) : null;
  const jobs = [
    "新しいタブで LMS を開いて",
    "設問3を青で書いて",
    "黒い服の投稿を3本",
    "青春向けの文案",
    "答えは『光合成』だ",
    "白紙に戻して設問3を解いて",
    "投稿の見出しを3案出して",
    "新しいタブを大きくして",
    "新しいタブを投稿の下書きを3本出して",
    "新しいタブの見出しを青くして。続きがある",
  ];
  for (const text of jobs) {
    const activeBefore = (await activeTab())?.id;
    await submit(text);
    const running = await waitFor(async () => {
      const row = await rowOf(text);
      return !!row && row.body === text && row.running && row.stop && !row.hint && !row.fail;
    }, 60);
    const info = ntpSend ? await readH1(ntpSend) : null;
    const stable = !!info && !!h1BeforeJobs && info.text === h1BeforeJobs.text && flat(info.computed) === flat(h1BeforeJobs.computed);
    expect(`job:${text}`, running && stable && (await activeTab())?.id === activeBefore, { row: await rowOf(text), info, activeBefore, now: (await activeTab())?.id });
    expect(`release:${text}`, releasePrompt(text));
    await waitFor(async () => (await rowOf(text))?.running === false, 60);
  }

  // 2 本目は、1 本目が終わるまで印が残り、始まったら移る。本文は届く
  await submit("一段目");
  await waitFor(async () => (await rowOf("一段目"))?.running === true, 60);
  await submit("二段目");
  const held = await waitFor(async () => {
    const a = await rowOf("一段目");
    const b = await rowOf("二段目");
    return !!a?.running && !!b && !b.running;
  }, 40);
  expect("markStaysOnFirst", held, { a: await rowOf("一段目"), b: await rowOf("二段目") });
  expect("releaseFirst", releasePrompt("一段目"));
  const moved = await waitFor(async () => {
    const a = await rowOf("一段目");
    const b = await rowOf("二段目");
    return !!a && !a.running && !!b?.running && !!b.stop && prompts().includes("二段目");
  }, 60);
  expect("markMoves", moved, { a: await rowOf("一段目"), b: await rowOf("二段目"), prompts: prompts() });
  expect("releaseSecond", releasePrompt("二段目"));
  await waitFor(async () => (await rowOf("二段目"))?.running === false, 60);

  // 止めたあとに残した 2 本目は届かない（上の「続きを書いて」）。ここは印が移ったあとの確認だけ
  const tall = `縦${"あ".repeat(2000)}`;
  await submit(tall);
  await waitFor(async () => (await rowOf(tall))?.stop === true, 60);
  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 420, deviceScaleFactor: 1, mobile: false });
  await selectName("研究");
  await selectName("課題");
  // 止めるは欄の右の丸（行の中ではない）。縦に長い行があっても、窓の中に見えている
  const tallStop = await waitFor(async () => (await ev(`(() => { const r = document.getElementById('send-btn').getBoundingClientRect(); return document.getElementById('send-btn').getAttribute('aria-label') === '止める' && r.top >= 0 && r.bottom <= innerHeight; })()`)) === true, 40);
  expect("tallStopVisible", !!tallStop);
  expect("releaseTall", releasePrompt(tall));
  await waitFor(async () => (await rowOf(tall))?.running === false, 60);
  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });

  // v2: 改名（tab group の題も追随）・見ていない根の失敗の印
  await selectName("課題");
  const gBefore = await groupFor(kadaiId);
  await act(`(() => { document.getElementById('rename').click(); return 1; })()`);
  const renameField = await json(`JSON.stringify({ ph: document.getElementById('send-text').placeholder, v: document.getElementById('send-text').value })`) as { ph?: string; v?: string } | null;
  expect("renameField", renameField?.ph === "新しい名前" && renameField?.v === "課題", renameField);
  await act(`(() => { document.getElementById('send-text').value = ${q("課題改")}; document.getElementById('send-form').requestSubmit(); return 1; })()`);
  const renamedOk = await waitFor(async () => (await onName()) === "課題改", 40);
  await waitFor(async () => (await groups()).some((g) => g.title === `課題改 \u00b7#${kadaiId}`), 40);
  const gAfter = (await groups()).find((g) => g.title === `課題改 \u00b7#${kadaiId}`) ?? null;
  expect("renameGroupTitle", renamedOk && !!gBefore && !!gAfter && gAfter.id === gBefore.id, { renamedOk, gBefore, gAfter });
  await act(`(() => { document.getElementById('rename').click(); document.getElementById('send-text').value = ${q("課題")}; document.getElementById('send-form').requestSubmit(); return 1; })()`);
  expect("renameBack", await waitFor(async () => (await onName()) === "課題", 40));

  await act(`(() => { document.getElementById('plus').click(); const i = document.getElementById('send-text'); i.value = ${q("壊す先")}; document.getElementById('send-form').requestSubmit(); return 1; })()`);
  await waitFor(async () => (await onName()) === "壊す先", 40);
  await submit("壊れる指示");
  const failedRow = await waitFor(async () => !!(await rowOf("壊れる指示")), 60);
  await selectName("研究");
  // 一覧の「失敗」の印が見えているか（hidden の span に文字は残るので、innerText でなく computed の display で見る）
  const failShown = async () => (await json(`(() => { const b = [...document.querySelectorAll('#roots button.root')].find((n) => n.querySelector('.root-text')?.textContent === '壊す先'); const m = b && b.querySelector('.mark'); return JSON.stringify({ shown: !!m && getComputedStyle(m).display !== 'none', hiddenAttr: !!m && m.hidden, text: m ? m.textContent : null }); })()`)) as { shown: boolean; hiddenAttr: boolean; text: string | null } | null;
  writeFileSync(join(holdDir, "fail"), "");
  const failBtn = await waitFor(async () => { const f = await failShown(); return f && f.shown && f.text?.includes("失敗") ? f : null; }, 40);
  expect("unseenRootFail", failedRow && failBtn, { failedRow, roots: await roots() });
  await selectName("壊す先");
  await selectName("研究");
  const seenBtn = await waitFor(async () => { const f = await failShown(); return f && !f.shown ? f : null; }, 40);
  expect("seenRootNoFail", !!seenBtn, await failShown());
  await selectName("課題");

  // 同時 2 本までの検査は core.test.ts（画面なしの agent）に任せる。偽の claude が 3 秒で終わるので、ここでは 2 本を走らせ続けられない
  await selectName("課題");
  await act(`(() => { const b = [...document.querySelectorAll('#rows button')].find((n) => (n.textContent || '').trim() === '止める'); if (b) b.click(); return 1; })()`);
  await selectName("研究");
  await act(`(() => { const b = [...document.querySelectorAll('#rows button')].find((n) => (n.textContent || '').trim() === '止める'); if (b) b.click(); return 1; })()`);

  const manifest = await json(`JSON.stringify((chrome.runtime.getManifest().chrome_url_overrides) || {})`) as { newtab?: string } | null;
  const extras = await json(`JSON.stringify({ map: !!document.getElementById('map'), sky: !!document.getElementById('sky'), branch: [...document.querySelectorAll('button')].some((b) => /枝|結論|キーワード/.test(b.textContent || '')) })`) as { map: boolean; sky: boolean; branch: boolean } | null;
  const ntpFinal = ntpSend ? await readH1(ntpSend) : null;
  expect("noMap", extras?.map === false && extras?.sky === false && extras?.branch === false, extras);
  expect("manifestNewtab", manifest?.newtab === "newtab.html", manifest);
  expect("ntpOnlyOpen", !!ntpFinal && ntpFinal.buttons.join(",") === "会話を開く" && ntpFinal.open === "会話を開く", ntpFinal);
  expect("noSecondStop", (await stopCount())?.outside === 0, await stopCount());

  // つながらないときは placeholder「失敗」のまま。常駐を止めても中継役が起こし直すので、host の登録ごと外して繋がらなくする
  rmSync(join(dir, "profile", "NativeMessagingHosts"), { recursive: true, force: true });
  killHost();
  await browser("Target.closeTarget", { targetId: panelId });
  await waitFor(async () => !(await targets()).some((t) => (t.url ?? "").endsWith("/panel.html")));
  await browser("Target.createTarget", { url: `chrome-extension://${extId}/panel.html` });
  const deadPanel = await attachPanel();
  panelId = deadPanel.id;
  send = deadPanel.send;
  type DeadPlace = { placeholder?: string; plus?: string };
  let dead: DeadPlace | null = null;
  for (let i = 0; i < 90; i++) {
    dead = await json(`JSON.stringify({ placeholder: document.getElementById('empty-text').placeholder, plus: document.getElementById('send-text').placeholder })`) as DeadPlace | null;
    if (dead && dead.placeholder === "失敗") break;
    await Bun.sleep(500);
  }
  expect("deadPlaceholder", dead?.placeholder === "失敗", dead);
  const downView = await json(`JSON.stringify({ shown: !document.getElementById('down').hidden, how: document.getElementById('down-how').textContent, retry: document.getElementById('retry').textContent })`) as { shown?: boolean; how?: string; retry?: string } | null;
  expect("downHowToRestart", downView?.shown === true && (downView.how ?? "").includes("開き直") && downView.retry === "もう一度つなぐ", downView);
  
  await shot(send, "v1-5.png");
  console.log("v1", JSON.stringify({ ok: bad.length === 0, ng: bad }));
  process.exitCode = bad.length === 0 ? 0 : 1;
} catch (e) {
  console.log("ERR", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  kill();
  process.exit(process.exitCode ?? 1);
}
