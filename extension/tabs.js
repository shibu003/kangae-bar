// 生きている tab が cap を超えたら、古い順に discard する対象の id を返す（DOM も chrome.* も持たない純関数）
// keep = 捨てない tab の id（agent の面・agent が開いた tab）
export function pickDiscard(tabs, cap, keep = new Set()) {
  const live = tabs.filter((t) => !t.discarded);
  const old = live
    .filter((t) => !t.active && !t.pinned && !t.audible && !keep.has(t.id))
    .sort((a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0));
  return old.slice(0, Math.max(0, live.length - cap)).map((t) => t.id);
}

// 拡張の口の送信元（chrome.* を持たない純関数＝試験できる）。sender は chrome の MessageSender
// 常駐へ繋げるのは拡張自身の画面（panel / newtab / offscreen）だけ。頁に差し込んだ script（content script）の sender.origin は頁の origin になる
export const fromExtensionPage = (sender, id) => !!id && sender?.id === id && sender.origin === `chrome-extension://${id}`;
// 「人が触った」は、渡された tab の最上位 frame に差し込んだ script からだけ（別 frame の script が他人の操作権を取り戻させない）
export const humanTouch = (sender) => !!sender?.tab && sender.frameId === 0;
// render の返事は、描いている枠（tab を持たない）から、頼んだ origin の頁として来た時だけ
export const renderFrom = (sender, origin) => !sender?.tab && sender?.origin === origin;
