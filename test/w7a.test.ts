import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT_ORIGIN } from "../src/main.ts";
import { extIdOf, firstRunNeeds, placeExtension, type FirstInput } from "../src/first-run.ts";

const ok: FirstInput = { clis: ["claude"], claudeLogin: true, extension: "connected", ax: true };
const kinds = (i: Partial<FirstInput>) => firstRunNeeds({ ...ok, ...i }).map((n) => n.kind);

test("揃っていれば 1 枚も出さない", () => expect(firstRunNeeds(ok)).toEqual([]));
test("claude が無い → agent・次の一手は入れる事（gemini は勧めない）", () => {
  const n = firstRunNeeds({ ...ok, clis: [] });
  expect(n.map((x) => x.kind)).toEqual(["agent"]);
  expect(n[0]!.how).toContain("claude");
  expect(JSON.stringify(n)).not.toContain("gemini");
});
test("gemini だけでも「AI が無い」（個人向けは終了）", () => expect(kinds({ clis: ["gemini"] })).toEqual(["agent"]));
test("login していない → login・ターミナルで claude と打つ", () => {
  const n = firstRunNeeds({ ...ok, claudeLogin: false });
  expect(n.map((x) => x.kind)).toEqual(["login"]);
  expect(n[0]!.how).toContain("claude と打って");
});
test("login が確かめられない（null）時は言わない／codex があれば login を言わない", () => {
  expect(kinds({ claudeLogin: null })).toEqual([]);
  expect(kinds({ clis: ["claude", "codex"], claudeLogin: false })).toEqual([]);
});
test("拡張が無い → install.sh の 1 行・拡張が無くても話せる", () => {
  const n = firstRunNeeds({ ...ok, extension: "none" });
  expect(n.map((x) => x.kind)).toEqual(["extension"]);
  expect(n[0]!.how).toContain("拡張の置き場を Finder で開く");
});
test("拡張: 置いたが繋がっていない → 別の文（読み込む手順）・繋がった → 消える", () => {
  const n = firstRunNeeds({ ...ok, extension: "placed" });
  expect(n.map((x) => x.kind)).toEqual(["extension"]);
  expect(n[0]!.what).toContain("繋がっていません");
  expect(n[0]!.how).toContain("パッケージ化されていない拡張機能を読み込む");
  expect(firstRunNeeds({ ...ok, extension: "connected" })).toEqual([]);
});
test("許可が無い → 読み取り .app の名前を出す。読み取り .app が無い(null)時は言わない", () => {
  const n = firstRunNeeds({ ...ok, ax: false, axWanted: true });
  expect(n.map((x) => x.kind)).toEqual(["permission"]);
  expect(n[0]!.how).toContain("Kangae Bar 読み取り");
  expect(kinds({ ax: null })).toEqual([]);
  expect(kinds({ ax: false })).toEqual([]); // W21: 別の Space の窓を読もうとして断られるまで（要らない人・web だけの会話）は言わない
});
test("全部無い → 3 枚（claude が無ければ login は言わない）・どれも what と how が 1 行", () => {
  const n = firstRunNeeds({ clis: [], claudeLogin: null, extension: "none", ax: false, axWanted: true });
  expect(n.map((x) => x.kind)).toEqual(["agent", "extension", "permission"]);
  for (const x of n) { expect(x.what).not.toContain("\n"); expect(x.how).not.toContain("\n"); }
});

test("拡張の id は manifest の key で決まり、host の allowed_origins とずれない（置き場の path に依らない）", () => {
  const key = JSON.parse(readFileSync(join(import.meta.dir, "../extension/manifest.json"), "utf8")).key as string;
  expect(`chrome-extension://${extIdOf(key)}/`).toBe(EXT_ORIGIN);
});
test("拡張を置く: 置き場に写し、隔離した Chrome dir に host の manifest を 1 file だけ書く", () => {
  const d = mktmp("w7a-place");
  const chromeDir = join(d, "Chrome"); mkdirSync(join(chromeDir, "NativeMessagingHosts"), { recursive: true });
  writeFileSync(join(chromeDir, "NativeMessagingHosts", "other.json"), "{}");
  const r = placeExtension({ src: join(import.meta.dir, "../extension"), home: join(d, "home"), chromeDir, hostName: "app.test.host", hostBinary: "/x/kangae", origin: EXT_ORIGIN });
  expect(readdirSync(r.dest)).toContain("manifest.json");
  expect(readdirSync(chromeDir).sort()).toEqual(["NativeMessagingHosts"]); // Preferences など他は書かない
  expect(readdirSync(join(chromeDir, "NativeMessagingHosts")).sort()).toEqual(["app.test.host.json", "other.json"]);
  const j = JSON.parse(readFileSync(r.host, "utf8"));
  expect(j.allowed_origins).toEqual([EXT_ORIGIN]);
  expect(j.path).toBe("/x/kangae");
});

import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
test("w7j: webHello で hasWebPeer が変わり、切れたら戻る（/first の「繋がった」の根拠）", async () => {
  const h = makeHandler(openStore(":memory:"), async () => [], undefined, undefined, { isExtension: () => true });
  const ext = {};
  expect(h.hasWebPeer()).toBe(false);
  await h({ op: "webHello" }, ext);
  expect(h.hasWebPeer()).toBe(true);
  h.dropOwner(ext);
  expect(h.hasWebPeer()).toBe(false);
});

// W8g-5b: 断った webHello の理由 1 つを覚え、最初の画面の 4 つ目の状態にする。本物の口が繋がると消える
test("w8g5b: 断った webHello → lastRefusal・/first の入力 refused の文・繋がると消える", async () => {
  let verdict: boolean | { app: string; why: string } = { app: "Brave Browser", why: "決まった browser ではありません" };
  const h = makeHandler(openStore(":memory:"), async () => [], undefined, undefined, { isExtension: () => verdict });
  const ext = {};
  expect(h.lastRefusal()).toBe(null);
  expect(await h({ op: "webHello" }, ext)).toEqual({ ok: false, hint: "Brave Browser から繋がろうとしましたが、断りました（決まった browser ではありません）" });
  expect(h.hasWebPeer()).toBe(false);
  const r = h.lastRefusal()!;
  expect(r).toMatchObject({ app: "Brave Browser", why: "決まった browser ではありません" });
  const needs = firstRunNeeds({ clis: ["claude"], claudeLogin: true, extension: "refused", refused: { ...r, at: 0 }, ax: true });
  expect(needs).toHaveLength(1);
  expect(needs[0]!.what).toContain("Brave Browser から繋がろうとしましたが、断りました（決まった browser ではありません");
  expect(needs[0]!.what).not.toContain("Chrome から");
  expect(needs[0]!.notice).toBe(true); // 知らせ = 頭に「あなたの番です」を付けない
  expect(needs[0]!.how).toContain("いつもの Google Chrome");
  verdict = true;
  await h({ op: "webHello" }, ext);
  expect(h.lastRefusal()).toBe(null);
  expect(h.hasWebPeer()).toBe(true);
});
