// offscreen 文書の iframe の中でだけ動く（sw が頼む間だけ、その site に登録する）。頁の JS が描き終わるのを待って、見える文字を sw へ返す。
// 人が普通に開いた tab・iframe では何もしない（親が自分の offscreen 文書で、窓の名前が render の印の時だけ）
(() => {
  if (window === top || location.ancestorOrigins?.[0] !== new URL(chrome.runtime.getURL("/")).origin || !window.name.startsWith("kangae-render:")) return;
  const id = window.name, t0 = Date.now();
  let last = "", same = 0;
  const tick = () => {
    const text = (document.body?.innerText ?? "").slice(0, 20_000);
    same = text === last ? same + 1 : 0;
    last = text;
    if ((same >= 2 && Date.now() - t0 >= 1200) || Date.now() - t0 >= 5000) chrome.runtime.sendMessage({ op: "rendered", id, url: location.href, title: document.title, text }).catch(() => {});
    else setTimeout(tick, 400);
  };
  setTimeout(tick, 400);
})();
