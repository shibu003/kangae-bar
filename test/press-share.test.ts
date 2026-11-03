import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportPress, importPress, loadKeys, writeReceipt } from "../src/press-share";
import { readPress, savePress } from "../src/press";
import { env, mkPress, tmp } from "./press-fixture";

const send = () => { const a = tmp(); const p: any = mkPress(); p.cookie = "SESSION=SECRET1"; p.fields.title.value = "SECRETVAL"; p.stages[1].way.args.text.value = "SECRETARG"; savePress(a, p); const out = join(tmp(), "予定.kangae-press.json"); return { a, out, r: exportPress(a, p.id, out) }; };
const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);

describe("W63 press-share", () => {
  test("AC1: 値・cookie・runs の数が無い。const と fixed だけ値がある・0600", () => {
    const { out, r } = send();
    expect(r.ok).toBe(true);
    const raw = readFileSync(out, "utf8"), j = JSON.parse(raw);
    for (const s of ["SECRET1", "SECRETVAL", "SECRETARG", "cookie"]) expect(raw).not.toContain(s);
    expect(j.press.runs).toEqual({ total: 0, clean: 0 });
    expect(j.press.stages[0].way.args.url).toEqual({ const: "https://calendar.google.com" });
    expect(j.press.fields.cal).toEqual({ fixed: "仕事" });
    expect(j.press.fields.title).toEqual({ ask: true, label: "予定の名前" });
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });
  test("AC2: 別の home で読み込むと検証が通り保存され、madeBy.fp が送り手の指紋・card が付く", () => {
    const { a, out, r } = send(); const b = tmp();
    const i = importPress(b, out, env());
    expect(i.ok).toBe(true); if (!i.ok || !r.ok) return;
    expect(i.press.madeBy).toEqual({ fp: r.fp });
    expect(r.fp).toBe(loadKeys(a).ok ? (loadKeys(a) as any).fp : "");
    expect(readPress(b, i.press.id)!.madeBy!.fp).toBe(r.fp);
    expect(i.press.runs).toEqual({ total: 0, clean: 0 });
    expect(i.cardOk).toBe(true);
    expect(i.card.steps.some((s) => s.who === "you")).toBe(true);
    expect(i.missing).toBeGreaterThan(0); // login と adb と brew
  });
  test("AC3 armed: 署名 1 byte・press の 1 字・pub の差し替え → 断り・保存されない", () => {
    const { out } = send();
    const j = JSON.parse(readFileSync(out, "utf8"));
    const tries: Record<string, any> = {
      sig: { ...j, sig: flip(j.sig, 10) },
      press: { ...j, press: { ...j.press, name: j.press.name + "!" } },
      const: { ...j, press: { ...j.press, stages: [{ ...j.press.stages[0], way: { ...j.press.stages[0].way, args: { url: { const: "https://evil.example" } } } }, j.press.stages[1]] } },
      pub: { ...j, pub: loadKeys(tmp()).ok ? (loadKeys(tmp()) as any).pub : "" },
      noSig: { press: j.press },
    };
    for (const [k, v] of Object.entries(tries)) {
      const b = tmp(), f = join(tmp(), `${k}.json`); writeFileSync(f, JSON.stringify(v));
      const i = importPress(b, f, env());
      expect(i.ok, k).toBe(false);
      expect(existsSync(join(b, "presses")), k).toBe(false);
    }
    // 対照: 触らなければ通る（上の赤が「壊したから」だと分かる）
    expect(importPress(tmp(), out, env()).ok).toBe(true);
  });
  test("署名が正しくても、形が合わない物・指紋が違う物・同じ id の別人の物は守る", () => {
    const { a, out } = send(); const b = tmp();
    const first = importPress(b, out, env()); expect(first.ok).toBe(true);
    // 同じ送り手の再読み込みは上書き（id 同じ）
    const again = importPress(b, out, env()); expect(again.ok && first.ok && again.press.id === first.press.id).toBe(true);
    // 別人の鍵で同じ id → 別の id で保存・元の物は無傷
    const other = tmp(); savePress(other, mkPress({ name: "別人の物" })); const o = join(tmp(), "o.json"); exportPress(other, "a1b2c3d4", o);
    const i = importPress(b, o, env()); expect(i.ok).toBe(true);
    if (i.ok && first.ok) { expect(i.press.id).not.toBe(first.press.id); expect(readPress(b, first.press.id)!.name).toBe("予定を足す"); }
    // 壊れた file・大きい file
    const junk = join(tmp(), "j.json"); writeFileSync(junk, "{"); expect(importPress(tmp(), junk, env()).ok).toBe(false);
    writeFileSync(junk, "x".repeat(1024 * 1024 + 1)); expect(importPress(tmp(), junk, env()).ok).toBe(false);
    expect(readdirSync(a).includes("press-keys.json")).toBe(true);
  });
  test("鍵: 0600・2 回目は同じ指紋・壊れていたら作り直さず断る", () => {
    const h = tmp(); const k1 = loadKeys(h), k2 = loadKeys(h);
    expect(k1.ok && k2.ok && k1.fp === k2.fp).toBe(true);
    expect(statSync(join(h, "press-keys.json")).mode & 0o777).toBe(0o600);
    writeFileSync(join(h, "press-keys.json"), "{broken");
    const k3 = loadKeys(h); expect(k3.ok).toBe(false);
    expect(readFileSync(join(h, "press-keys.json"), "utf8")).toBe("{broken"); // 触っていない
    savePress(h, mkPress()); expect(exportPress(h, "a1b2c3d4", join(tmp(), "x.json")).ok).toBe(false);
  });
  test("AC7: 受領証に値が無く pressId・runs・from がある", () => {
    const { a } = send(); const out = join(tmp(), "r.receipt.json");
    const r = writeReceipt(a, "a1b2c3d4", out, 123); expect(r.ok).toBe(true);
    const raw = readFileSync(out, "utf8"), j = JSON.parse(raw);
    expect(j).toEqual({ pressId: "a1b2c3d4", from: (loadKeys(a) as any).fp, runs: { total: 7, clean: 5 }, at: 123 });
    for (const s of ["SECRET", "仕事", "calendar"]) expect(raw).not.toContain(s);
    expect(writeReceipt(a, "00000000", out).ok).toBe(false);
  });
});
