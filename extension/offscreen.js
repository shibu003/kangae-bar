// 画面に出ない面（offscreen 文書）。agent が頼んだ頁を iframe で描く。窓も tab も作らない（図 §34）
chrome.runtime.onMessage.addListener((m) => {
  if (m?.op === "renderLoad") { const f = document.createElement("iframe"); f.name = m.id; f.src = m.url; document.body.append(f); }
  if (m?.op === "renderDrop") document.querySelector(`iframe[name="${m.id}"]`)?.remove();
});
