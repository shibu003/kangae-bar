// review-press: 押す操作 module（W61〜W64・W67〜W73）を AC の外から破りに行く。各 test の頭に「自分の実装が落ちる点」を書く
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readPress, savePress, validateFields, type Press } from "../src/press";
import { runPress, type PressDeps } from "../src/press-run";
import { canonical, exportPress, importPress } from "../src/press-share";
import { handlePress, makeAims, makePressHub } from "../src/press-cli";
import { env, mkPress, tmp } from "./press-fixture";

const one = (o: Partial<Press> = {}): Press => mkPress({ id: "c0ffee01", fields: {}, limits: {}, runs: { total: 0, clean: 0 }, stages: [{ n: 1, kind: "op", goal: "予定を保存する", post: { kind: "elements", names: ["保存しました"] }, way: { kind: "act", app: "web", tool: "press_button", args: { name: { const: "保存" } } } }], ...o });
const fake = (o: { view?: () => string[]; agent?: () => void } = {}) => {
  const log: string[] = [];
  const g = { ok: true, text: "ok" };
  const d: PressDeps = {
    act: async (_a, tool, args) => { log.push(`act:${tool}:${JSON.stringify(args)}`); return g; },
    op: async () => g, runCmd: async () => g, api: async () => g, openTab: async () => g,
    read: async () => { log.push("read"); return { title: "予定", names: o.view?.() ?? [] }; },
    askAgent: async () => { log.push("askAgent"); o.agent?.(); return g; },
    askHuman: async () => { log.push("askHuman"); return "stop"; },
    now: () => 1,
  };
  return { d, log };
};

describe("二重送信", () => {
  // 落ちる点: 門が ok を返した press_button でも、面の反映が 1 読み分遅いと「済んでいない」と見て同じ門で 2 度押す（予定が 2 件）
  test("press_button が ok・面の反映が遅い → 同じ門で 2 度押さない・探し直しの読みで済む（healed）", async () => {
    const home = tmp(), p = one(); savePress(home, p);
    let reads = 0;
    const f = fake({ view: () => (++reads >= 2 ? ["保存しました"] : []) });
    const r = await runPress(home, p, {}, f.d);
    expect(f.log.filter((x) => x.startsWith("act:press_button")).length).toBe(1);
    expect(r).toMatchObject({ ok: true, stopped: false });
    expect(f.log).toContain("askAgent");
  });
});

describe("幅の外", () => {
  // 落ちる点: 数の幅を Number() で比べると、"1e1"・"0x50"・"+5"・" 5" が別の綴りのまま幅を通り、受ける app は別の数に読む（parseInt("0x50") = 0）
  test("数の幅は 10 進の綴りだけ・文字の幅は今までどおり辞書順", () => {
    const p = one({ fields: { n: { range: ["1", "100"] }, t: { range: ["09:00", "18:00"] } } });
    for (const v of ["1e1", "0x50", "+5", " 5", "5 ", "5.", ".5", "Infinity", "1_0"]) expect(validateFields(p, { n: v, t: "10:00" }).ok).toBe(false);
    for (const v of ["1", "50", "100", "99.5"]) expect(validateFields(p, { n: v, t: "10:00" }).ok).toBe(true);
    for (const v of ["0", "101", "-1", "100.01"]) expect(validateFields(p, { n: v, t: "10:00" }).ok).toBe(false);
    expect(validateFields(p, { n: "5", t: "18:01" }).ok).toBe(false);
    expect(validateFields(p, { n: "5", t: "09:00" }).ok).toBe(true);
  });
});

describe("宣言の無い欄の参照", () => {
  // 落ちる点: way の参照が fields に無い名前（constructor・toString・__proto__ は NAME の regex に合う）を指すと、values の継承した関数が値として門に渡る
  test("署名つきの file から来ても、門に渡るのは空の文字だけ", async () => {
    const a = tmp(), b = tmp();
    savePress(a, one({ stages: [{ n: 1, kind: "op", goal: "書く", post: { kind: "none" }, way: { kind: "act", app: "web", tool: "fill", args: { x: { field: "constructor" }, y: { field: "toString" }, z: { field: "hasOwnProperty" } } } }] }));
    const out = join(tmp(), "x.kangae-press.json");
    expect(exportPress(a, "c0ffee01", out).ok).toBe(true);
    const i = importPress(b, out, env());
    expect(i.ok).toBe(true); if (!i.ok) return;
    const f = fake();
    await runPress(b, readPress(b, i.press.id)!, {}, f.d);
    expect(f.log[0]).toBe(`act:fill:${JSON.stringify({ x: "", y: "", z: "" })}`);
  });
});

describe("署名", () => {
  // 落ちる点: 自分の鍵で署名し直した物に、元の作り手の指紋（madeBy.fp）を書いて「あの人の物」に見せる
  test("別の鍵で署名し直し、madeBy.fp だけ元の作り手にした物は断る・保存しない", () => {
    const a = tmp(), b = tmp(); savePress(a, one());
    const out = join(tmp(), "x.kangae-press.json"); exportPress(a, "c0ffee01", out);
    const j = JSON.parse(readFileSync(out, "utf8"));
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    j.press.stages[0].goal = "全部の予定を消す";
    j.sig = sign(null, Buffer.from(canonical(j.press)), privateKey).toString("base64");
    j.pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const forged = join(tmp(), "f.kangae-press.json"); writeFileSync(forged, JSON.stringify(j));
    const r = importPress(b, forged, env());
    expect(r.ok).toBe(false);
    expect(readdirSync(b).includes("presses") ? readdirSync(join(b, "presses")) : []).toEqual([]);
    // 正の対照: 指紋を自分の鍵の物にすれば通る（＝上は指紋の検査で落ちた）
    j.press.madeBy.fp = createHash("sha256").update(Buffer.from(j.pub, "base64")).digest("hex").slice(0, 16);
    j.sig = sign(null, Buffer.from(canonical(j.press)), privateKey).toString("base64");
    writeFileSync(forged, JSON.stringify(j));
    expect(importPress(b, forged, env()).ok).toBe(true);
  });
  // 落ちる点: 他人の file の id が自分の押す操作の id と同じだと、自分の物（再現率の履歴ごと）を上書きする
  test("他人の file の id が自分の物と同じ → 別の id で保存し、自分の物と再現率は残る", () => {
    const mine = tmp(), them = tmp();
    savePress(mine, one({ name: "自分の", runs: { total: 9, clean: 9 } }));
    savePress(them, one({ name: "他人の" }));
    const out = join(tmp(), "x.kangae-press.json"); exportPress(them, "c0ffee01", out);
    const r = importPress(mine, out, env());
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.press.id).not.toBe("c0ffee01");
    expect(readPress(mine, "c0ffee01")).toMatchObject({ name: "自分の", runs: { total: 9, clean: 9 } });
  });
});

describe("禁止語", () => {
  // 落ちる点: 作り手の goal に全角・零幅・大文字で技術語を隠すと、主画面に出たまま検査を抜ける
  test("全角・零幅・大文字で隠した goal も読み込みの cardOk が false で、語が返る", () => {
    for (const goal of ["ＡＤＢ で繋ぐ", "a​db で繋ぐ", "Wi-Fi の PORT を開く", "ﾋﾞﾙﾄﾞする"]) {
      const a = tmp(), b = tmp(); savePress(a, one({ stages: [{ ...one().stages[0]!, goal }] }));
      const out = join(tmp(), "x.kangae-press.json"); exportPress(a, "c0ffee01", out);
      const r = importPress(b, out, env());
      expect(r.ok).toBe(true); if (!r.ok) continue;
      expect(r.cardOk).toBe(false);
      expect(r.bannedWords.length).toBeGreaterThan(0);
    }
  });
});

describe("並行の runs と agent の口", () => {
  // 落ちる点: 同じ押す操作を 2 回続けて押すと 2 本走り、runs.total が 2 増え・門が 2 度呼ばれる
  test("同じ押す操作の 2 本目は走っている間は断る・total は 1", async () => {
    const home = tmp(); savePress(home, one({ stages: [{ ...one().stages[0]!, post: { kind: "none" } }] }));
    const hub = makePressHub();
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let acts = 0;
    const deps = (): Omit<PressDeps, "askHuman"> => ({ ...fake().d, act: async () => { acts++; await gate; return { ok: true, text: "ok" }; } });
    const h = { home, hub, agent: false, node: 1, busy: () => false, ext: () => false, deps, say: () => {} };
    const first = await handlePress({ action: "run", press: "c0ffee01" }, h);
    const second = await handlePress({ action: "run", press: "c0ffee01" }, h);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false });
    release(); await Bun.sleep(20);
    expect(acts).toBe(1);
    expect(readPress(home, "c0ffee01")!.runs.total).toBe(1);
  });
  // 落ちる点: action の綴りを変える（大文字・空白・未知）と agent の禁止が外れて save / rm / answer が通る
  test("agent は action の綴りを変えても save / rm / answer に届かない", async () => {
    const home = tmp(); savePress(home, one());
    const h = { home, hub: makePressHub(), agent: true, node: 1, busy: () => false, ext: () => false, deps: () => fake().d, say: () => {} };
    for (const action of ["rm", "RM", " rm", "rm ", "save", "answer", "import", "share", ["rm"], { toString: () => "rm" }]) {
      const r = await handlePress({ action, press: "c0ffee01" } as any, h);
      expect(r.ok).toBe(false);
    }
    expect(readPress(home, "c0ffee01")).not.toBeNull();
  });
});

describe("W72 の的", () => {
  const rec = (op: string) => ({ at: 1, face: "tab:9", app: "Chrome", gen: 3, op, value: "{}", result: "ok", owner: "s:1" });
  // 落ちる点: 門が記録の前に throw すると的が残り、aims を通らない次の記録（step の道の leases.act）が古い要素を的にする＝別の要素を押す press になる
  test("記録の来なかった的は残らない（次の同じ面・世代・操作の記録に付かない）", async () => {
    const aims = makeAims(), tok = "tab:9|3|s:1";
    const boom = { act: async () => { throw new Error("driver 切断"); } };
    await aims.act(boom as any, tok, "click", { element_token: "e1" }).catch(() => {});
    await aims.act(boom as any, tok, "fill", { field: "件名", value: "x" }).catch(() => {});
    expect(aims.tag(rec("click") as any)).toEqual(rec("click"));
    expect(aims.tag(rec("fill") as any)).toEqual(rec("fill"));
  });
  // 落ちる点: role の判定が部分一致だと、表の行・本文・欄の名前（＝頁の中身や入れた値）が的になり、goal を通って渡す file に載る
  test("button 類でない要素（行・セル・本文・欄・role の前後に字）は click しても名前を取らない", async () => {
    const aims = makeAims(), tok = "tab:9|3|s:1", got: any[] = [];
    const rows = ["e1\tAXRow\t山田様 請求書 120000", "e2\tcell\t口座 1234567", "e3\tAXStaticText\t本文", "e4\ttextbox\t入れた値", "e5\tbuttonish\t偽", "e6\tAXButton \t空白つき"];
    const gate = { act: async (_t: string, tool: string, args: any) => { got.push(aims.tag(rec(tool) as any)); return tool === "get_window_state" ? { ok: true, isError: false, text: ["snapshot", ...rows].join("\n") } : { ok: true, isError: false, text: "ok" }; } };
    await aims.act(gate, tok, "get_window_state", {});
    for (let i = 1; i <= 6; i++) await aims.act(gate, tok, "click", { element_token: `e${i}` });
    const clicks = got.slice(1);
    expect(clicks.map((r) => r.target)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(clicks.map((r) => r.el)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
  });
});
