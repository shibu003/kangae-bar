// 拡張の JS を偽の chrome.* の上で試す（Chromium を起こさない）。正本 docs/BRIEF-extunit.md
import { expect, test } from "bun:test";
import { installChrome, load } from "./fake-chrome";

// affected が拡張の変更でこの unit を拾えるよう、読む file を literal で名指す: "extension/web.js" "extension/tabs.js" "extension/sw.js" "extension/gate.js"
const act = { tabId: 1, docId: "d", element_token: "d1" };
const KEY = "kangaeGated";

test("W11c-3 floors: minGen より古い gen の act は executeScript の前に断る・同じか新しい gen は通る", async () => {
  const c = installChrome();
  const { webRun } = await load("web");
  await webRun("gate_off", { tabId: 1, minGen: 5 });
  const before = c.pages();
  const old = await webRun("click", { ...act, gen: 4 });
  expect(old.error).toBe(true);
  expect(old.text).toContain("取り戻されました");
  expect(c.pages()).toBe(before); // 何も送っていない
  expect((await webRun("click", { ...act, gen: 5 })).error).toBe(false);
  expect(c.pages()).toBe(before + 1);
  expect((await webRun("click", { ...act, tabId: 2, gen: 1 })).error).toBe(false); // 他の tab の floor ではない
});

test("W8b-2 見張り: 渡した tab にだけ張る・遷移で張り直す・取り戻しで外す・tab を閉じたら消す", async () => {
  const c = installChrome();
  const { webRun } = await load("web");
  await c.settle();
  await webRun("gate_on", { tabId: 1 });
  expect(c.session[KEY]).toEqual([1]);
  const a1 = c.arms(1);
  await c.webNavCommitted.fire({ tabId: 1, frameId: 0 });
  await c.webNavCommitted.fire({ tabId: 1, frameId: 3 }); // 別 frame では張らない
  await c.webNavCommitted.fire({ tabId: 2, frameId: 0 }); // 渡していない tab には張らない
  await c.settle();
  expect(c.arms(1)).toBe(a1 + 1);
  expect(c.arms(2)).toBe(0);
  await webRun("gate_off", { tabId: 1 });
  expect(c.session[KEY]).toEqual([]);
  await c.webNavCommitted.fire({ tabId: 1, frameId: 0 });
  await c.settle();
  expect(c.arms(1)).toBe(a1 + 1); // 外した後は張り直さない
  await webRun("gate_on", { tabId: 2 });
  await c.tabsRemoved.fire(2);
  expect(c.session[KEY]).toEqual([]);
});

test("w8b2fix2 眠りから戻す: storage.session の一覧へ張り直す・張れない間は書き換えを断り読む操作は通す", async () => {
  const c = installChrome({ session: { [KEY]: [1] } });
  await load("web"); // sw が起きた = module の変数が空
  await c.settle();
  expect(c.arms(1)).toBe(1);
  expect(c.arms(2)).toBe(0);
  const d = installChrome({ session: { [KEY]: [1] }, armThrows: true });
  const { webRun } = await load("web");
  await d.settle();
  const w = await webRun("click", { ...act, gen: 1 });
  expect(w.error).toBe(true);
  expect(w.text).toContain("見張りを張り直せない");
  expect(d.pages()).toBe(0);
  expect((await webRun("tab_state", { tabId: 1 })).data.exists).toBe(true); // 読む操作は通る
});

test("W11e onConnect: 拡張自身の画面だけ受ける・頁の script・別の拡張は切る", async () => {
  const c = installChrome({ id: "extid" });
  await load("sw");
  const port = (sender: any) => ({ sender, dropped: false, disconnect() { this.dropped = true; }, onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {} });
  const self = port({ id: "extid", origin: "chrome-extension://extid" });
  const page = port({ id: "extid", origin: "https://evil.example" }); // content script の sender は頁の origin
  const other = port({ id: "otherext", origin: "chrome-extension://otherext" });
  for (const p of [self, page, other]) await c.onConnect.fire(p);
  expect([self.dropped, page.dropped, other.dropped]).toEqual([false, true, true]);
});

// W8g-5b: 常駐が webHello を断った（ack の ok が偽）なら、拡張の icon に ! と理由 1 行。繋がったら消す
test("W8g-5b sw: webHello の ack が ok:false なら icon に ! と理由を出し、ok なら消す", async () => {
  const c = installChrome({ id: "extid" });
  await load("sw");
  const port = { sender: { id: "extid", origin: "chrome-extension://extid" }, disconnect() {}, onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {} };
  await c.onConnect.fire(port);
  await c.nativeMsg.fire({ id: "w:hello", ok: false, hint: "Brave Browser から繋がろうとしましたが、断りました（決まった browser ではありません）" });
  expect(c.action.badge).toBe("!");
  expect(c.action.title).toContain("Brave Browser から繋がろうとしましたが、断りました");
  await c.nativeMsg.fire({ id: "w:hello", ok: true });
  expect(c.action.badge).toBe("");
});
