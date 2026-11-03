// W112（docs/BRIEF-w112.md）: 会話を DESIGN.md §4・§6 に合わせる（吹き出し・読み幅・入力欄・toast の位置）。本物のブラウザには触れない（css / source の文字列と、panel.js の純関数）。実機（見た目）は未測。
// 読む file: "extension/panel.css" "extension/panel.html" "extension/panel.js"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const css = read("extension/panel.css").replace(/\/\*[\s\S]*?\*\//g, "");
const html = read("extension/panel.html");
const js = read("extension/panel.js");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
const body = (sel: string) => rules.filter((r) => r.sel.split(",").some((s) => s.trim() === sel)).map((r) => r.body).join(";");
const fn = (name: string) => js.slice(js.indexOf(`function ${name}(`), js.indexOf("\n}\n", js.indexOf(`function ${name}(`)) + 3);

test("W112 AC1: 吹き出しは最大幅 min(88%, 640px)・自分は muted・相手は card・本文の枠と影が無い", () => {
  expect(css).toMatch(/--w-bubble:\s*min\(88%, 640px\)/);
  for (const sel of [".chat-row.me", ".chat-row.they"]) expect(body(sel)).toMatch(/max-width:var\(--w-bubble\)/);
  expect(body(".chat-row.me .chat-text")).toMatch(/background:var\(--muted\)/);
  expect(body(".chat-row.they .chat-text")).toMatch(/background:var\(--card\)/);
  for (const sel of [".chat-row.me .chat-text", ".chat-row.they .chat-text", ".chat-row.me", ".chat-row.they"]) expect(body(sel)).not.toMatch(/border:|box-shadow|backdrop/);
  expect(body(".chat-row.they .chat-text")).toMatch(/padding:var\(--bubble-pad-y\) var\(--bubble-pad-x\)/); // 12 / 16
  expect(body(".chat-row.they .chat-text")).toMatch(/border-radius:var\(--r-bubble\) var\(--r-bubble\) var\(--r-bubble\) var\(--r-tail\)/);
  expect(body(".chat-text")).toMatch(/overflow-wrap:anywhere;[^}]*line-break:strict/);
  expect(body("#rows")).toMatch(/padding:var\(--sp-5\) var\(--gutter\)/); // 24 / 16
  expect(body("#rows > .chat-row + .chat-row")).toMatch(/margin-top:var\(--message-gap\)/); // 別話者 24
  expect(body("#rows > .chat-row + .chat-row.same")).toMatch(/margin-top:var\(--same-speaker-gap\)/); // 同じ話者 8
  expect(body(".chat-row > time")).toMatch(/font-size:var\(--fs-time\);[^}]*font-variant-numeric:tabular-nums/);
});

test("W112 AC2: 同じ話し手の連続は先頭の 1 行だけが顔と名前を持つ（renderChat は sameSpeaker で名前の要素を作らない）", () => {
  const { speakerKey, sameSpeaker } = new Function(`
    const relayMark = (t) => /^\\[\\[relay: /.test(t) ? {} : null, spawnedParent = (t) => /^\\[\\[spawned: /.test(t) ? "x" : null;
    const botName = ${js.match(/const botName = (.*);\n/)![1]};
    ${fn("speakerKey")}
    const sameSpeaker = ${js.match(/const sameSpeaker = (.*);\n/)![1]};
    return { speakerKey, sameSpeaker };
  `)() as { speakerKey: (r: any) => string; sameSpeaker: (l: any[], i: number) => boolean };
  const say = (text: string, by?: string) => ({ text, by });
  const names = (list: any[]) => list.filter((r, i) => r.text.startsWith("🤖") && !sameSpeaker(list, i)).length; // 名前の要素を作る行の数
  expect(names([say("🤖 経理: 1 つ目"), say("🤖 経理: 2 つ目")])).toBe(1); // 同じ相手の 2 連続 = 名前は 1 つ
  expect(names([say("🤖 経理: a"), say("🤖 広報: b"), say("🤖 広報: c")])).toBe(2); // 相手が替われば付く
  expect(names([say("🤖 経理: a"), say("頼み"), say("🤖 経理: b")])).toBe(2); // 自分が挟まれば付き直す
  expect(names([say("🤖 経理: a", "経理"), say("🤖 経理: b", "経理")])).toBe(1); // by（W102）があればそれが話し手
  expect(sameSpeaker([say("頼み 1"), say("頼み 2")], 1)).toBe(true); // 自分の連続も間は 8
  expect(sameSpeaker([say("📋 メモ"), say("📋 メモ")], 1)).toBe(false); // memo は連続に数えない
  expect(sameSpeaker([say("[[relay: B | r1]] hi"), say("[[relay: B | r1]] hi")], 1)).toBe(false);
  expect(speakerKey(say("🤖 名前の無い返事"))).toBe("🤖"); // コロンが無ければ本文を名前にしない
  expect(js).toContain("const cont = sameSpeaker(list, i);");
  expect(js).toMatch(/if \(e\.av && !cont\) \{/); // 連続の 2 行目は who-line（顔 + 名前）を els に入れない
  expect(js).toContain('li.classList.toggle("same", cont)');
});

test("W112 AC2b: 時刻は吹き出しの外の <time>。送りかけの行（番兵 createdAt）には出さない", () => {
  const timeLabel = new Function(`${fn("timeLabel")}; return timeLabel;`)() as (at: number) => string;
  expect(timeLabel(Number.MAX_SAFE_INTEGER)).toBe("");
  expect(timeLabel(Date.now())).toMatch(/^\d{2}:\d{2}$/);
  expect(js).toContain('e.time ??= document.createElement("time")');
  expect(js).toContain("els.push(e.time)");
});

test("W112 AC3: 入力欄は下端に固定・端から 16・下 16 + safe area・外枠 card / control-border / 角丸 xl・textarea は 48〜144・toast は欄の上 8・最大 320", () => {
  const form = body("#send-form");
  expect(form).toMatch(/flex:none/); // #chat の一番下（#rows だけが伸びる）
  expect(body("#chat")).toMatch(/display:flex; flex-direction:column/);
  expect(form).toMatch(/margin:0 var\(--gutter\) calc\(var\(--sp-4\) \+ env\(safe-area-inset-bottom\)\)/);
  expect(form).toMatch(/padding:var\(--sp-2\)/);
  expect(form).toMatch(/min-height:var\(--composer-min\)/);
  expect(form).toMatch(/background:var\(--card\)/);
  expect(form).toMatch(/border:var\(--line-w\) solid var\(--control-border\)/);
  expect(form).toMatch(/border-radius:var\(--r-xl\)/);
  expect(html).toMatch(/<textarea id="send-text" rows="1" placeholder="返事を書く"><\/textarea>/);
  const ta = body("#send-text");
  expect(ta).toMatch(/min-height:var\(--textarea-min\)/);
  expect(ta).toMatch(/max-height:var\(--composer-max\)/);
  expect(ta).toMatch(/padding:var\(--sp-3\)/);
  expect(ta).toMatch(/line-height:var\(--lh-body\)/);
  expect(body("#attach")).toMatch(/width:var\(--hit\);\s*height:var\(--hit\)/);
  expect(body("#send-form #send-btn")).toMatch(/width:var\(--send\);\s*height:var\(--send\)/);
  const toast = body("kg-toast");
  expect(toast).toMatch(/bottom:max\([^;]*var\(--composer-top\) \+ var\(--toast-gap\)\)/); // 欄の上 8
  expect(toast).toMatch(/max-width:min\(var\(--toast-max\), calc\(var\(--full\) - 2 \* var\(--gutter\)\)\)/); // 320 と左右 16
  expect(css).toMatch(/--composer-top:\s*0px/); // 欄の無い画面は 0 = 下 --toast-bottom
  expect(js).toContain('document.documentElement.style.setProperty("--composer-top"');
  expect(js).toContain("new ResizeObserver(follow).observe(form)");
});

test("W112 AC3b: Enter で送る・Shift+Enter は改行・変換中は送らない・送った後は高さを戻す", () => {
  const i = js.indexOf('box.addEventListener("keydown"');
  const keydown = js.slice(i, js.indexOf("});", i));
  expect(keydown).toContain('e.key !== "Enter" || e.shiftKey || composing || e.isComposing || e.keyCode === 229');
  expect(keydown).toContain("form.requestSubmit()");
  expect(js).toContain('Object.defineProperty(box, "value"'); // 送った後の空・書きかけの戻しは全部 value の書き込み
  expect(js).toMatch(/set\(v\) \{ desc\.set\.call\(this, v\); fit\(\); \}/);
  expect(js).toContain('if (e.key === "Enter" && (composing || e.isComposing || e.keyCode === 229)) e.preventDefault();'); // 今の止めは残る
});
