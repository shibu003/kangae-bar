// 拡張の JS を Chromium 無しで試す偽の chrome.*（extension/ が使っている API だけ）。正本 docs/BRIEF-extunit.md
// 使い方: const c = installChrome(); const { webRun } = await load("web"); … 呼び出しは c.calls に残る
const EXT = "../extension"; // affected が test → extension/*.js の読みを辿れるよう、path は literal で書く（"../extension/web.js" "../extension/sw.js"）
let n = 0;
// ?n で別の instance にする＝sw が眠って memory が空になった後と同じ（module の変数が新しくなる）
export const load = (name: "web" | "sw") => import(name === "web" ? `../extension/web.js?${++n}` : `../extension/sw.js?${++n}`);

const ev = () => {
  const fns: Function[] = [];
  return { fns, addListener: (f: Function) => fns.push(f), fire: (...a: any[]) => Promise.all(fns.map((f) => f(...a))) };
};

export function installChrome(o: { id?: string; session?: Record<string, any>; tabs?: number[]; armResult?: string; armThrows?: boolean } = {}) {
  const session: Record<string, any> = { ...(o.session ?? {}) };
  const tabs = new Set(o.tabs ?? [1, 2]);
  const calls: { tabId: number; fn: string; args: any[] }[] = [];
  const e = { webNavCommitted: ev(), webNavBefore: ev(), tabsRemoved: ev(), onConnect: ev(), runtimeMsg: ev(), nativeMsg: ev() };
  const action: { badge: string; title: string } = { badge: "", title: "" };
  const c: any = {
    runtime: {
      id: o.id ?? "extid",
      onMessage: e.runtimeMsg, onConnect: e.onConnect, onStartup: ev(),
      sendMessage: async () => {},
      connectNative: () => ({ postMessage() {}, onMessage: e.nativeMsg, onDisconnect: ev() }),
    },
    storage: { session: { get: async (k: string) => ({ [k]: session[k] }), set: async (v: any) => void Object.assign(session, v) } },
    tabs: {
      get: async (id: number) => (tabs.has(id) ? { id, active: true, windowId: 1 } : Promise.reject(new Error("no tab"))),
      query: async () => [], update: async () => ({}),
      onRemoved: e.tabsRemoved, onActivated: ev(), onCreated: ev(), onUpdated: ev(), onAttached: ev(), onDetached: ev(),
    },
    windows: { onFocusChanged: ev(), get: async () => ({ focused: true }), getLastFocused: async () => ({ focused: false }) },
    webNavigation: { onCommitted: e.webNavCommitted, onBeforeNavigate: e.webNavBefore },
    scripting: {
      executeScript: async ({ target, func, args }: any) => {
        const fn = func.name || "(anon)";
        calls.push({ tabId: target.tabId, fn, args: args ?? [] });
        if (fn === "gateHook") { if (o.armThrows) throw new Error("cannot access"); return [{ result: o.armResult ?? (args[0] ? "on" : "off") }]; }
        if (fn === "namedOp") return [{ result: { text: "ok" } }];
        if (fn === "page") return [{ result: { text: "ok", docId: "d" } }];
        return [{ result: "" }];
      },
    },
    alarms: { get: async () => ({}), create() {}, onAlarm: ev() },
    sidePanel: { setPanelBehavior() {} },
    action: { setBadgeText: ({ text }: any) => void (action.badge = text), setTitle: ({ title }: any) => void (action.title = title) },
  };
  (globalThis as any).chrome = c;
  return {
    session, calls, ...e, tabs, action,
    arms: (tabId: number) => calls.filter((x) => x.fn === "gateHook" && x.args[0] === true && x.tabId === tabId).length,
    pages: () => calls.filter((x) => x.fn === "page").length,
    settle: () => new Promise((r) => setTimeout(r, 20)), // import 時の restore（非同期）が済むのを待つ
  };
}
