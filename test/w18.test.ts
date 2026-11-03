// W18（CEO「Agent ごとにチャットを分けてね」「そこで agent と会話できるように」）: agent = 会話（root）1 つ。A のチャットで送った文は A の turn にだけ渡り、B の画面（chat）に出ない・A の返事は A のチャットに載る
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";

test("W18 A に送った文は A の turn にだけ渡り B のチャットに出ない・返事は A のチャットに載る", async () => {
  const s = openStore(":memory:");
  const a = s.add(null, "user", "A の頼み", true), b = s.add(null, "user", "B の頼み", true);
  const calls: { cmd: string[]; reply: (t: string) => void }[] = [];
  const spawn = (cmd: string[]) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>; let done!: (c: number) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
    const exited = new Promise<number>((r) => (done = r));
    calls.push({ cmd, reply: (t) => { ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ type: "result", result: t }) + "\n")); try { ctrl.close(); } catch {} done(0); } });
    return { stdout, exited, kill: () => { try { ctrl.close(); } catch {} done(143); } };
  };
  const h = makeHandler(s, async () => [], undefined, { dir: mktmp("ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => null });
  const text = (id: number) => s.tree(id).map((n) => n.text).join("\n");
  await h({ op: "workspace", nodeId: a.id, agent: true, text: "A の頼み" }); calls[0]!.reply("A 完了"); await Bun.sleep(60);
  await h({ op: "workspace", nodeId: b.id, agent: true, text: "B の頼み" }); calls[1]!.reply("B 完了"); await Bun.sleep(60);
  const r: any = await h({ op: "send", rootId: a.id, text: "Aにだけ話す合言葉" });
  expect(r.ok).toBe(true);
  expect(calls.length).toBe(3);
  expect(calls[2]!.cmd.join(" ")).toContain("Aにだけ話す合言葉");
  expect(calls.slice(0, 2).some((c) => c.cmd.join(" ").includes("Aにだけ話す合言葉"))).toBe(false);
  calls[2]!.reply("Aの返事です"); await Bun.sleep(60);
  expect(text(a.id)).toContain("Aにだけ話す合言葉");
  expect(text(a.id)).toContain("Aの返事です");
  expect(text(b.id)).not.toContain("Aにだけ話す合言葉");
  expect(text(b.id)).not.toContain("Aの返事です");
  expect(text(b.id)).toContain("B 完了");
  const chatB: any = await h({ op: "chat", rootId: b.id });
  expect(JSON.stringify(chatB)).not.toContain("Aにだけ話す合言葉");
});

test("W18 承認 card に、どの agent の頼みか（会話が 2 つ以上の時）が出る", () => {
  const js = require("node:fs").readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(js).toContain("roots.length >= 2 ? roots.find((x) => `s:${x.id}` === a.owner) : null");
  expect(js).toContain("」の agent の頼みです");
});

test("W18 会話の見出しの丸は一覧の丸と同じ字（avatarGlyph 1 本・W21 で agent A / B が別の字になる形に）", () => {
  const js = require("node:fs").readFileSync(join(import.meta.dir, "../extension/panel.js"), "utf8");
  expect(js).toContain('set($("hd-av"), "textContent", cur ? avatarGlyph(cur) : name.charAt(0))');
  expect(js).toContain("glyph: avatarGlyph(r)"); // W77c: 行の丸は kg-row に glyph で渡す
});
