// W121（docs/BRIEF-w121.md・DESIGN §6 入力欄と送る / §7 押した直後）: 空は送れない・送った直後は busy・失敗は入力を戻す。
// syncSend は panel.js から切り出して実行する（本物のブラウザには触れない）。実機の見た目は未測（要 operator）。読む file を literal で名指す: "extension/panel.js" "extension/panel.css"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const js = read("extension/panel.js"), css = read("extension/panel.css");
const src = /function syncSend\(\) \{[\s\S]*?\n\}\n/.exec(js)![0];
const rig = () => {
  const btn: any = { dataset: {}, disabled: false, attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
  const inp: any = { value: "" };
  const st = new Function("$", `let sending = false, pendAtts = []; ${src}; return { syncSend, set(s, p) { sending = s; pendAtts = p; } };`)((id: string) => (id === "send-btn" ? btn : inp));
  return { btn, inp, ...st };
};

test("AC1 空（文 0 字・添付 0）は disabled・1 字で押せる・空白だけは空・添付だけでも押せる", () => {
  const r = rig();
  r.syncSend(); expect(r.btn.disabled).toBe(true);
  r.inp.value = "  \n"; r.syncSend(); expect(r.btn.disabled).toBe(true);
  r.inp.value = "あ"; r.syncSend(); expect(r.btn.disabled).toBe(false);
  r.inp.value = ""; r.set(false, [{}]); r.syncSend(); expect(r.btn.disabled).toBe(false);
});
test("AC2 送る直後は disabled＋aria-busy=true・返りで外れる。止める（動いている間）は欄が空なら押せる・文字があれば送信中だけ止める", () => {
  const r = rig();
  r.inp.value = "x"; r.set(true, []); r.syncSend();
  expect(r.btn.disabled).toBe(true); expect(r.btn.attrs["aria-busy"]).toBe("true");
  r.set(false, []); r.syncSend();
  expect(r.btn.disabled).toBe(false); expect(r.btn.attrs["aria-busy"]).toBe("false");
  r.btn.dataset.stop = "7"; r.inp.value = ""; r.syncSend(); expect(r.btn.disabled).toBe(false); // 止める
  r.set(true, []); r.syncSend(); expect(r.btn.disabled).toBe(false); // 送信中でも欄が空なら止められる
  r.inp.value = "y"; r.syncSend(); expect(r.btn.disabled).toBe(true); // 文字を書いた送信中は 2 度送らせない
});
test("AC3 失敗の返りで文を欄へ戻す・toast は showErr・成功でも失敗でも sending は finally で外す（panel.js の形）", () => {
  const sub = /\$\("send-form"\)\.onsubmit = [\s\S]*?\n\};\n/.exec(js)![0];
  expect(sub).toMatch(/typed = i\.value[\s\S]*i\.value = ""/); // 空にする前に控える
  expect(sub).toMatch(/sending = true;[\s\S]*paintChips\(\)/); // 同じイベントの中で busy
  expect(sub).toMatch(/if \(!r\.ok\) \{[\s\S]*i\.value = typed[\s\S]*drafts\.set\(id[\s\S]*showErr\(i, r\.hint\)/);
  expect(sub).toMatch(/finally \{\s*sending = false;\s*syncSend\(\)/);
  expect(js).toMatch(/refreshRuns\(\{ scene: r\.ok \? "send" : "fail", reload: true \}\);\n  return r;/); // sendChat が結果を返す
});
test("syncSend を呼ぶ口: 欄の input・添付の増減・renderField・renderHead。disabled は CSS で disabled 色（.off は無い）", () => {
  expect(js).toContain('$("send-text").addEventListener("input", syncSend)');
  expect((/function paintChips\(\) \{[\s\S]*?\n\}\n/.exec(js)![0])).toContain("syncSend()");
  expect((/function renderField\(\) \{[\s\S]*?\n\}\n/.exec(js)![0])).toContain("syncSend()");
  expect(js).not.toMatch(/classList\.toggle\("off"/);
  expect(css).toMatch(/#send-btn:disabled \{[^}]*var\(--disabled-bg\)[^}]*var\(--disabled-fg\)[^}]*not-allowed/);
  expect(css).not.toContain("#send-btn.off");
  expect(css).toMatch(/#att-chips \{[^}]*flex-wrap:wrap[^}]*gap:var\(--sp-2\)/);
});
test("IME 変換中の Enter は送らない（isComposing / 229）・Shift+Enter は改行（textarea の keydown は本線の W105/W112 の持ち物）", () => {
  const kd = /\$\("send-text"\)\.addEventListener\("keydown"[\s\S]*?\n\}\);\n/.exec(js)![0];
  expect(kd).toContain("composing || e.isComposing || e.keyCode === 229");
  expect(js).toMatch(/e\.key !== "Enter" \|\| e\.shiftKey \|\| composing \|\| e\.isComposing \|\| e\.keyCode === 229[\s\S]*requestSubmit\(\)/);
});
