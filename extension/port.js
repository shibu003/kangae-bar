// 常駐への繋ぎを 1 枚に。classic script（panel / app / newtab のどれからも読める）。
// kangaeConnect() は { postMessage, onMessage.addListener, onDisconnect.addListener } を返す。
//  - 拡張の中: chrome.runtime.connect()（今まで通り）
//  - chrome が無い所（bar の WebView）: 常駐の /ws?token=…（token は常駐が頁に埋めた <meta>）
(() => {
  if (globalThis.chrome?.runtime?.connect) {
    globalThis.kangaeConnect = () => chrome.runtime.connect();
    return;
  }
  // chrome.tabs / tabGroups / windows が無い所では、タブの束ね・新しいタブは黙って何もしない
  const none = async () => [];
  const ev = { addListener() {} };
  globalThis.chrome ??= {};
  chrome.tabs ??= { query: none, update: async () => undefined, create: async () => ({}), get: async () => undefined, group: async () => undefined, onActivated: ev, onUpdated: ev };
  chrome.tabGroups ??= { query: none, update: async () => undefined };
  chrome.windows ??= { getCurrent: async () => ({}), getLastFocused: async () => ({}) };

  const listeners = () => {
    const fns = [];
    return { addListener: (f) => fns.push(f), fire: (...a) => fns.forEach((f) => f(...a)) };
  };
  globalThis.kangaeConnect = () => {
    const token = document.querySelector('meta[name="kangae-token"]')?.content ?? "";
    const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
    const onMessage = listeners();
    const onDisconnect = listeners();
    const queue = [];
    ws.onopen = () => queue.splice(0).forEach((m) => ws.send(m));
    ws.onmessage = (e) => {
      try { onMessage.fire(JSON.parse(e.data)); } catch {}
    };
    ws.onclose = () => onDisconnect.fire();
    return {
      postMessage: (msg) => {
        const s = JSON.stringify(msg);
        if (ws.readyState === WebSocket.OPEN) ws.send(s);
        else if (ws.readyState === WebSocket.CONNECTING) queue.push(s);
      },
      onMessage,
      onDisconnect,
    };
  };
})();
