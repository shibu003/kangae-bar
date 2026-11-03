// W75c（CEO 10-14「agentもscreenshotやfile, 画像、linkなどをchatに送れるように」）: kangae send。card なし。送れるのは自分の作業場所の file・先に撮った窓の絵・http(s) の URL だけ（人の home の file は送れない）
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attDir, makeAttach } from "../src/attach.ts";
import { winDir } from "../src/lease.ts";
import { defaultWorkspace, makeHandler } from "../src/main.ts";
import { openStore } from "../src/store.ts";
import { mktmp } from "./tmp.ts";
setDefaultTimeout(120_000);

let top: string, ui: string;
beforeEach(() => { top = realpathSync(mktmp("w75c")); ui = join(top, "ui"); mkdirSync(ui); });
afterEach(() => rmSync(top, { recursive: true, force: true }));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const cli = { write() {} }; // unix socket（agent の CLI）から来た印

async function boot() {
  const spawn = () => { let done!: (c: number) => void; return { stdout: new ReadableStream<Uint8Array>({ start: () => {} }), exited: new Promise<number>((r) => (done = r)), kill: () => done(143) }; };
  const store = openStore(":memory:");
  const H: any = makeHandler(store, async () => [], undefined, { dir: join(top, "ws"), bin: "/x/kangae", open: async () => true, clis: async () => [{ cli: "claude", path: "/bin/claude", env: {} }], spawn, browserUrl: async () => "http://127.0.0.1:9" } as any, { uiHome: ui, leaseDriver: () => null });
  const root = store.add(null, "user", "調べる", true);
  const r0: any = await H({ op: "workspace", nodeId: root.id, agent: true, text: "go" });
  return { store, H, root, dir: realpathSync(r0.run.dir), owner: `s:${root.id}` };
}
const send = (H: any, owner: string, m: Record<string, unknown>) => H({ op: "sendOut", owner, ...m }, cli);

test("W75c file / image: 作業場所の中の file は att にコピーされ、🤖 の行に [[att:]] が付いて chat の atts になる・card は出ない", async () => {
  const { store, H, root, dir, owner } = await boot();
  writeFileSync(join(dir, "report.md"), "# 週報\n本文");
  writeFileSync(join(dir, "chart.png"), PNG);
  expect(await send(H, owner, { kind: "file", arg: join(dir, "report.md"), text: "週報です" })).toMatchObject({ ok: true });
  expect(await send(H, owner, { kind: "image", arg: join(dir, "chart.png") })).toMatchObject({ ok: true });
  const rows = (await H({ op: "chat", rootId: root.id })).rows.filter((r: any) => r.atts);
  expect(rows.map((r: any) => r.atts[0])).toMatchObject([{ kind: "file", name: "report" }, { kind: "image", name: "chart" }]);
  expect(rows[0].text).toContain("週報です");
  expect(rows[0].text).not.toContain("[[att:");
  expect(store.tree(root.id).some((n) => n.text.startsWith("🤖 claude: 週報です"))).toBe(true);
  expect(H.approvals?.() ?? []).toEqual([]); // 承認待ちは増えない
  // コピーなので、送った後に元を書き換えても人が見た物は変わらない
  const sent = readdirSync(attDir(ui, owner)).filter((f) => !f.startsWith(".") && f.endsWith(".txt"))[0]!;
  writeFileSync(join(dir, "report.md"), "差し替え");
  expect(readFileSync(join(attDir(ui, owner), sent), "utf8")).toContain("本文");
});

test("W75c 根の外は送れない: 人の home の file・../・symlink で外へ出る物・別の会話の att・「.」始まり・folder・空・8MB 超・画像でない image", async () => {
  const { H, dir, owner } = await boot();
  const outside = join(top, "secret.txt"); writeFileSync(outside, "TOP SECRET");
  writeFileSync(join(dir, ".env"), "KEY=1"); writeFileSync(join(dir, "empty.txt"), ""); writeFileSync(join(dir, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 1)); writeFileSync(join(dir, "n.txt"), "text");
  symlinkSync(outside, join(dir, "link.txt")); symlinkSync(top, join(dir, "updir")); mkdirSync(join(dir, "sub"));
  const A = makeAttach(ui); const other = (A.chunk("s:999", { upId: "up-other001", seq: 0, last: true, name: "o", b64: PNG.toString("base64") }) as any).att;
  for (const [arg, why] of [[outside, "外"], [join(dir, "..", "secret.txt"), "../"], [join(dir, "link.txt"), "symlink"], [join(dir, "updir", "secret.txt"), "symlink dir"], [other.path, "別の会話の att"], [join(dir, ".env"), "dot"], [join(dir, "sub"), "folder"], [join(dir, "empty.txt"), "空"], [join(dir, "big.bin"), "8MB 超"], ["/etc/hosts", "etc"], [join(process.env.HOME ?? "/", ".ssh", "id_ed25519"), "ssh"], ["", "空文字"]] as const) {
    const r = await send(H, owner, { kind: "file", arg });
    expect(r.ok, why).toBe(false);
  }
  expect((await send(H, owner, { kind: "image", arg: join(dir, "n.txt") })).ok).toBe(false); // 画像でない
  expect(readdirSync(attDir(ui, owner)).filter((f) => !f.startsWith("."))).toEqual([]); // 何もコピーされていない
});

test("W75c screenshot: 先に撮った窓の絵（自分の win/）だけを送る・無ければ新しく撮らず理由を言う・別の会話の絵は送れない", async () => {
  const { H, owner } = await boot();
  expect(await send(H, owner, { kind: "screenshot" })).toMatchObject({ ok: false, hint: expect.stringContaining("window_image") });
  const wd = winDir(ui, owner); mkdirSync(wd, { recursive: true }); writeFileSync(join(wd, "shot-1.png"), PNG);
  mkdirSync(winDir(ui, "s:999"), { recursive: true }); writeFileSync(join(winDir(ui, "s:999"), "shot-9.png"), Buffer.concat([PNG, Buffer.from("x")]));
  const r = await send(H, owner, { kind: "screenshot", text: "今の画面" });
  expect(r.ok).toBe(true);
  const sent = readdirSync(attDir(ui, owner)).filter((f) => f.endsWith(".png"));
  expect(sent.length).toBe(1);
  expect(readFileSync(join(attDir(ui, owner), sent[0]!)).equals(PNG)).toBe(true); // 別の会話の絵ではない
});

test("W75c link: http(s) だけ・javascript: / file: / data: / 認証情報つき / 長すぎる / 読めない は断る・題は整える・origin は URL から", async () => {
  const { H, root, owner } = await boot();
  expect(await send(H, owner, { kind: "link", arg: "https://docs.example.com/a?b=1|2#c", title: "週報‮" })).toMatchObject({ ok: true });
  const row = (await H({ op: "chat", rootId: root.id })).rows.find((r: any) => r.atts?.[0]?.kind === "link");
  expect(row.atts[0].origin).toBe("https://docs.example.com");
  expect(row.atts[0].url).toContain("https://docs.example.com/a?b=1");
  expect(row.atts[0].title).not.toMatch(/‮/);
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "https://u:p@evil.example/", "notaurl", "", `https://a.example/${"x".repeat(2100)}`]) expect((await send(H, owner, { kind: "link", arg: bad })).ok, bad.slice(0, 30)).toBe(false);
});

test("W75c 口の約束: CLI（unix socket）の agent だけ・動いている自分の会話だけ・種類は 4 つ・1 分に 10 件まで・案内と Bash の許可に send がある", async () => {
  const { H, owner, dir } = await boot();
  writeFileSync(join(dir, "a.txt"), "a");
  expect((await H({ op: "sendOut", owner, kind: "file", arg: join(dir, "a.txt") }, {})).ok).toBe(false); // panel / 拡張からは使えない
  expect((await send(H, "s:999", { kind: "file", arg: join(dir, "a.txt") })).ok).toBe(false); // 動いていない会話
  expect((await send(H, "oops", { kind: "file", arg: join(dir, "a.txt") })).ok).toBe(false);
  expect((await send(H, owner, { kind: "video", arg: join(dir, "a.txt") })).ok).toBe(false);
  for (let i = 0; i < 10; i++) expect((await send(H, owner, { kind: "file", arg: join(dir, "a.txt") })).ok).toBe(true);
  expect(await send(H, owner, { kind: "file", arg: join(dir, "a.txt") })).toMatchObject({ ok: false, hint: expect.stringContaining("送りすぎ") });
  const src = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  expect(src).toContain("Bash(${ws.bin} send:*)");
  expect(src).toContain("Bash(${ws.bin} role:*)"); // role が許可に無く、agent が打つと止まっていた
  expect(src).toContain("${bin} send screenshot");
  expect(existsSync(attDir(ui, owner))).toBe(true);
});
