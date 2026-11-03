// AW3: AnyWindow Runtime の片 3（src/anywindow.ts の remindersAdapter・docs/BRIEF-aw3.md・図 docs/diagrams.md §AW1）。
// 通し: Runtime の入口に reminders.add {title, notes?, list?} → 本物の Adapter が（画面を使わず）Reminders に 1 件足す → 返った id で読み直して結果と受領証を返す。
// 試験は偽の osa（osascript を呼ばない差し替え）で回す。本物の Reminders に書く test は KANGAE_AW3_REAL=1 の時だけ（専用リスト「Kangae 試験」に 1 件足して消す）。
// 負の対照（各 test の末尾コメントに「何を戻すと赤くなるか」）
import { expect, test } from "bun:test";
import { asLit, CATALOG, makeRuntime, parseOsaList, remindersAdapter, runOsa, type Osa } from "../src/anywindow.ts";
import { scriptGate } from "../src/mods.ts";

type Step = (script: string, source: boolean) => { ok: boolean; text: string; killed?: boolean } | Promise<{ ok: boolean; text: string; killed?: boolean }>;
// 台本つきの偽 osa。送られた script を全部記録し、規則に合う最初の返事を返す
function scripted(rules: [RegExp, { ok?: boolean; text: string; killed?: boolean } | Step][]) {
  const sent: string[] = [];
  const osa: Osa = async (script, o) => {
    sent.push(script);
    for (const [re, r] of rules) if (re.test(script)) return typeof r === "function" ? r(script, !!o?.source) : { ok: true, ...r };
    return { ok: false, text: `台本に無い script: ${script}` };
  };
  return { osa, sent, made: () => sent.filter((s) => /make new reminder/.test(s)).length };
}
const UP = [/is running$/, { text: "true" }] as [RegExp, { text: string }];
const DEFAULT_LIST = [/name of default list/, { text: "リマインダー" }] as [RegExp, { text: string }];
const ID = "x-apple-reminder://6F1A-22";
const MAKE_OK = [/make new reminder/, { text: ID }] as [RegExp, { text: string }];

const face = { key: "10:1", owner: "s:1", gen: 1, app: "Reminders", pid: 10, windowId: 1, write: "allow" as const };
const mkRt = (osa: Osa, timeoutMs?: number) => makeRuntime({ check: () => ({ ok: true, face }), ask: async () => ({ ok: true }), adapters: { native: remindersAdapter(osa) }, draft: () => ({ ok: false, hint: "x" }), humanOps: {}, timeoutMs });
let n = 0;
const add = (input: Record<string, unknown>) => ({ op: "reminders.add", target: "10:1|1|s:1", input, request_id: `a${++n}` });

test("通し: reminders.add が起動確認 → 読み → 書き 1 回 → id で読み直しを通り、結果と受領証が返る（script は全部 scriptGate を通る）", async () => {
  const s = scripted([UP, DEFAULT_LIST, MAKE_OK, [/get name of reminder id/, { text: "牛乳" }]]);
  const out = await mkRt(s.osa)(add({ title: "牛乳" }));
  expect(out).toMatchObject({ ok: true, op: "reminders.add", result: { id: ID, title: "牛乳", list: "リマインダー" }, receipt: { op: "reminders.add", app: "com.apple.reminders", fields: ["title"], verified: `id ${ID} で読み直し、title が一致` } });
  expect(s.made()).toBe(1);
  expect(s.sent[0]).toBe('application id "com.apple.reminders" is running'); // 最初の手は起動の確認（起こさない）
  expect(s.sent.at(-1)).toBe(`tell application id "com.apple.reminders" to get name of reminder id "${ID}"`);
  for (const x of s.sent) expect(scriptGate(x), x).toBeNull(); // 前に出す・起こす・閉じる語が 1 つも無い
  expect(s.sent.some((x) => /activate|launch|System Events|do shell script/i.test(x))).toBe(false);
  // 負の対照（実測）: asLit の "\n" の escape を外す → 次の test が赤／起動確認の分岐を外す → 「未起動」test が赤。scriptGate の通過はこの test 側の assert が守る（Adapter 内の gate は二重の備え）
});

test("list と notes: 指定のリストの末尾に body つきで足し、title と notes の両方を読み直して照合する", async () => {
  const s = scripted([UP, [/count of \(lists whose name is "Kangae 試験"\)/, { text: "1" }], MAKE_OK, [/get name of reminder id/, { text: "牛乳" }], [/get body of reminder id/, { text: "2 本\n低脂肪" }]]);
  const out = await mkRt(s.osa)(add({ title: "牛乳", notes: "2 本\n低脂肪", list: "Kangae 試験" }));
  expect(out).toMatchObject({ ok: true, result: { id: ID, notes: "2 本\n低脂肪", list: "Kangae 試験" }, receipt: { fields: ["title", "notes", "list"], verified: `id ${ID} で読み直し、title と notes が一致` } });
  expect(s.sent.find((x) => /make new reminder/.test(x))).toBe(`tell application id "com.apple.reminders" to get id of (make new reminder at end of reminders of list "Kangae 試験" with properties {name:"牛乳", body:"2 本\\n低脂肪"})`);
  expect(s.sent.every((x) => !/[\n\r]/.test(x))).toBe(true); // notes に改行が有っても script は 1 行
  // 負の対照: asLit から "\n" の escape を外す → script に生の改行が入り scriptGate が断って failed（この test が赤）
});

test("未起動: 何も送らない（make 0 回・起こさない）。許可が無い -1743 は人の言葉で次の一手を返す", async () => {
  const s = scripted([[/is running$/, { text: "false" }], MAKE_OK]);
  expect(await mkRt(s.osa)(add({ title: "a" }))).toMatchObject({ ok: false, code: "failed", hint: expect.stringContaining("起動していません") });
  expect(s.sent).toEqual(['application id "com.apple.reminders" is running']); // 起動の確認 1 手だけ。tell application は 1 本も送っていない
  const t = scripted([UP, [/name of default list/, { ok: false, text: "execution error: Not authorized to send Apple events to Reminders. (-1743)" }], MAKE_OK]);
  expect(await mkRt(t.osa)(add({ title: "a" }))).toMatchObject({ ok: false, code: "failed", hint: expect.stringContaining("オートメーション") });
  expect(t.made()).toBe(0); // 許可の dialog は読みで出る＝書きの最中に止まらない
  // 負の対照: 起動確認の分岐を外す → 未起動でも読みへ進み sent が 1 手で済まなくなる（赤）
});

test("リスト: 無い / 同名が複数 → 作らず断る（make 0 回）", async () => {
  const none = scripted([UP, [/count of/, { text: "0" }], MAKE_OK]);
  expect(await mkRt(none.osa)(add({ title: "a", list: "無い" }))).toMatchObject({ ok: false, code: "failed", hint: expect.stringContaining("リストは作りません") });
  const dup = scripted([UP, [/count of/, { text: "2" }], MAKE_OK]);
  expect(await mkRt(dup.osa)(add({ title: "a", list: "同名" }))).toMatchObject({ ok: false, code: "failed", hint: expect.stringContaining("2 個") });
  expect(none.made() + dup.made()).toBe(0);
});

test("欄の値: 引用符・backslash は literal の中に収まり、注入しても script の骨組みは同じ・改行 / 制御文字の title は何も送らない", async () => {
  const run = async (title: string) => { const s = scripted([UP, DEFAULT_LIST, [/make new reminder/, { ok: false, text: "止める" }]]); await mkRt(s.osa)(add({ title })); return s.sent.find((x) => /make new reminder/.test(x))!; };
  const strip = (x: string) => x.replace(/"(?:[^"\\]|\\.)*"/g, '""'); // scriptGate と同じ「literal を除いた所」
  const evil = await run('x" & (do shell script "id") & "');
  expect(strip(evil)).toBe(strip(await run("x"))); // 注入しても literal の外は 1 文字も変わらない
  expect(evil).toContain('name:"x\\" & (do shell script \\"id\\") & \\""');
  expect(await run('a"b\\c')).toContain('name:"a\\"b\\\\c"');
  for (const title of ["a\nb", "a\u0000b", "a\tb"]) {
    const s = scripted([UP, DEFAULT_LIST, MAKE_OK]);
    expect(await mkRt(s.osa)(add({ title })), JSON.stringify(title)).toMatchObject({ ok: false, code: "failed" });
    expect(s.sent).toEqual([]); // 値の検査は送る前
  }
  // 負の対照: asLit の '"' の escape を外す → evil の骨組みが変わり do shell script が literal の外に出て赤（scriptGate も断る）
});

test("書きの結果: 非 0 = failed（控えに残さず出し直せる）・途切れ / 締切 = unknown・id が読み直せない = unknown（再送しても実行しない）", async () => {
  const fail = scripted([UP, DEFAULT_LIST, [/make new reminder/, { ok: false, text: "execution error: Can't make class reminder. (-2710)" }]]);
  expect(await mkRt(fail.osa)(add({ title: "a" }))).toMatchObject({ ok: false, code: "failed" });
  const cut = scripted([UP, DEFAULT_LIST, [/make new reminder/, { ok: false, text: "", killed: true }]]);
  expect(await mkRt(cut.osa)(add({ title: "a" }))).toMatchObject({ ok: false, code: "unknown" });
  const evt = scripted([UP, DEFAULT_LIST, [/make new reminder/, { ok: false, text: "execution error: AppleEvent timed out. (-1712)" }]]);
  expect(await mkRt(evt.osa)(add({ title: "a" }))).toMatchObject({ ok: false, code: "unknown" });

  for (const readback of [{ ok: false, text: "execution error: Can't get reminder id. (-1728)" }, { text: "別の title" }, { text: "" }]) {
    const s = scripted([UP, DEFAULT_LIST, MAKE_OK, [/get name of reminder id/, readback]]);
    const rt = mkRt(s.osa), req = add({ title: "牛乳" });
    expect(await rt(req), JSON.stringify(readback)).toMatchObject({ ok: false, code: "unknown", hint: expect.stringContaining("reminders.list") });
    const sentBefore = s.sent.length;
    expect(await rt(req)).toMatchObject({ ok: false, code: "unknown" }); // 同じ request_id の再送: 前の結果を返すだけ
    expect(s.sent.length).toBe(sentBefore);
    expect(s.made()).toBe(1);
  }
  const noid = scripted([UP, DEFAULT_LIST, [/make new reminder/, { text: "" }]]);
  expect(await mkRt(noid.osa)(add({ title: "a" }))).toMatchObject({ ok: false, code: "unknown" });
  // 負の対照: 読み直しの比較 same() を常に true にする → 「別の title」が成功になり赤／unknown を failed にする → 控えが残らず再送で 2 度書く
});

test("締切: Runtime が timeout で unknown を返した後、Adapter は次の手（書き）に進まない（鍵を返した後に書きが走らない）", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const s = scripted([[/is running$/, async () => { await held; return { ok: true, text: "true" }; }], DEFAULT_LIST, MAKE_OK]);
  const out = await mkRt(s.osa, 20)(add({ title: "a" }));
  expect(out).toMatchObject({ ok: false, code: "unknown" }); // 20ms で締切 → signal が落ちる
  release(); // 起動確認がやっと返る（偽の osa は signal を無視して返す＝最悪の場合）
  await new Promise((r) => setTimeout(r, 30));
  expect(s.made()).toBe(0);
  // 負の対照: Adapter の `if (stop()) return stop()!` と Runtime の ac.abort() のどちらかを外す → 書きが走って made() が 1 になり赤
});

test("reminders.list: 読むだけ（make 0 回）。{{id…},{title…}} を読み、件数と返した件数を照合し、50 件で切る・読めない返事は failed", async () => {
  const s = scripted([UP, DEFAULT_LIST, [/get \{id, name\} of \(reminders whose completed is false\)$/, (_x, source) => ({ ok: true, text: source ? '{{"id1", "id2"}, {"a, b", "日本語 \\"q\\""}}' : "NOT SOURCE" })]]);
  expect(await mkRt(s.osa)({ op: "reminders.list", target: "10:1|1|s:1", input: {}, request_id: "l1" })).toMatchObject({ ok: true, result: { list: "リマインダー", count: 2, items: [{ id: "id1", title: "a, b" }, { id: "id2", title: '日本語 "q"' }] }, receipt: { verified: "2 件を読み、2 件を返した（上限 50）" } });
  expect(s.made()).toBe(0);
  const many = `{{${Array.from({ length: 60 }, (_, i) => `"i${i}"`).join(", ")}}, {${Array.from({ length: 60 }, (_, i) => `"t${i}"`).join(", ")}}}`;
  const big = scripted([UP, [/count of/, { text: "1" }], [/reminders of list "L" whose/, { text: many }]]);
  const out = await mkRt(big.osa)({ op: "reminders.list", target: "10:1|1|s:1", input: { list: "L" }, request_id: "l2" });
  expect(out).toMatchObject({ ok: true, result: { count: 60, truncated: true } });
  expect((out as any).result.items).toHaveLength(50);
  const empty = scripted([UP, DEFAULT_LIST, [/whose completed/, { text: "{{}, {}}" }]]);
  expect(await mkRt(empty.osa)({ op: "reminders.list", target: "10:1|1|s:1", input: {}, request_id: "l3" })).toMatchObject({ ok: true, result: { count: 0, items: [] } });
  const bad = scripted([UP, DEFAULT_LIST, [/whose completed/, { text: '{{"a"}, {"b", "c"}}' }]]);
  expect(await mkRt(bad.osa)({ op: "reminders.list", target: "10:1|1|s:1", input: {}, request_id: "l4" })).toMatchObject({ ok: false, code: "failed" });
  // 負の対照: source フラグを渡さない → 偽の返事が "NOT SOURCE" になり赤／LIST_MAX を外す → 60 件が返り赤
});

test("承認 card: 欄の値は向きを変える・見えない文字を [U+…] で見せ、40 字で切った時は全文字数を言う（人が見る順と入れる順を食い違わせない）", async () => {
  const asked: string[] = [];
  const s = scripted([UP, DEFAULT_LIST, MAKE_OK, [/get name of reminder id/, { text: "x" }]]);
  const rt = makeRuntime({ check: () => ({ ok: true, face: { ...face, write: "ask" } }), ask: async (_t, _o, what) => { asked.push(what); return { ok: true }; }, adapters: { native: remindersAdapter(s.osa) }, draft: () => ({ ok: false, hint: "x" }), humanOps: {} });
  await rt(add({ title: "a\u202Eb", notes: "n".repeat(100) }));
  expect(asked[0]).toBe(`Reminders に「リマインダーを足す」: title=a[U+202E]b / notes=${"n".repeat(40)}…（全 100 文字）`);
  // 負の対照: anywindow.ts の what を元の String(v).replace(/\s+/g, " ").slice(0, 40) に戻す → [U+202E] が生のまま・全文字数も出ず赤
});

test("カタログ: reminders.add の list 欄は string だけ（型違い・長すぎは Runtime の入口で bad）", async () => {
  expect(Object.keys(CATALOG.find((d) => d.name === "reminders.add")!.input)).toEqual(["title", "notes", "list"]);
  const s = scripted([UP, DEFAULT_LIST, MAKE_OK]);
  expect(await mkRt(s.osa)(add({ title: "a", list: 5 }))).toMatchObject({ ok: false, code: "bad" });
  expect(await mkRt(s.osa)(add({ title: "a", list: "x".repeat(201) }))).toMatchObject({ ok: false, code: "bad" });
  expect(s.sent).toEqual([]);
});

test("parseOsaList: 引用符・backslash・改行入りの文字列と入れ子 / 空 / 裸の語を読む。閉じていない物は投げる", () => {
  expect(parseOsaList('{{"a, b", "c\\"d", "e\\\\f", "g\nh"}, {}}')).toEqual([["a, b", 'c"d', "e\\f", "g\nh"], []]);
  expect(parseOsaList("{missing value, \"x\"}")).toEqual(["missing value", "x"]);
  for (const bad of ['{"a', "{{", '{"a"} x']) expect(() => parseOsaList(bad), bad).toThrow();
});

// asLit が本物の AppleScript で元の文字列に戻る事（osascript に literal を return させるだけ＝どの app にも触れない）
test.skipIf(process.platform !== "darwin")("asLit: 本物の osascript に返させると、引用符・backslash・改行・tab・日本語が元のまま戻る（app には触れない）", async () => {
  for (const v of ['a"b', "a\\b", "l1\nl2", "t\tt", "日本語 \"q\" \\ x", 'x" & (do shell script "id") & "', "\\n"]) {
    const r = await runOsa(`return ${asLit(v)}`, { source: true });
    expect(r.ok, `${r.text}`).toBe(true);
    expect(parseOsaList(r.text), v).toBe(v);
  }
});

// ---- 本物の Reminders（既定では skip）。KANGAE_AW3_REAL=1 の時だけ: 起動済みの Reminders に専用リスト「Kangae 試験」を作り、1 件足し、読み直し、消す ----
// 前提: Reminders が起動済み（Kangae は起こさない）・初回は osascript → Reminders の Automation 許可 dialog を人が許す
test.skipIf(!process.env.KANGAE_AW3_REAL)("実機: 専用リスト「Kangae 試験」に 1 件足して読み直し、リストごと消す", async () => {
  const L = "Kangae 試験", tell = (b: string) => `tell application id "com.apple.reminders" to ${b}`;
  if ((await runOsa('application id "com.apple.reminders" is running')).text !== "true") throw new Error("Reminders を先に起動してください（Kangae は起こしません）");
  expect((await runOsa(tell(`count of (lists whose name is ${asLit(L)})`))).text, "同名のリストが既に在る＝人の物かもしれないので触らない").toBe("0");
  const rt = makeRuntime({ check: () => ({ ok: true, face }), ask: async () => ({ ok: true }), adapters: { native: remindersAdapter() }, draft: () => ({ ok: false, hint: "x" }), humanOps: {}, timeoutMs: 60_000 });
  try {
    expect((await runOsa(tell(`make new list with properties {name:${asLit(L)}}`))).ok).toBe(true);
    const title = `Kangae AW3 試験 ${Date.now()}`;
    const out = await rt(add({ title, notes: "1 行目\n2 行目", list: L }));
    expect(out).toMatchObject({ ok: true, result: { title, list: L } });
    const id = (out as any).result.id as string;
    const listed = await rt({ op: "reminders.list", target: "10:1|1|s:1", input: { list: L }, request_id: "real-list" });
    expect(listed).toMatchObject({ ok: true, result: { count: 1, items: [{ id, title }] } });
  } finally {
    await runOsa(tell(`delete (every reminder of list ${asLit(L)})`));
    await runOsa(tell(`delete list ${asLit(L)}`));
  }
}, 120_000);
