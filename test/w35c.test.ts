// W35c: api-anything の login を「cookie をタブの外へ写す」から「開いている tab の中で再生する」に替えた。cookie は Chrome に残り、この Mac の file にも常駐にも来ない
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { runApi, type ApiDeps } from "../src/apianything.ts";
import { installChrome, load } from "./fake-chrome";

const src = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");
const mk = () => {
  const seen = { asked: 0, ran: [] as string[][], env: [] as Record<string, string>[] };
  const d: ApiDeps = { vendor: "/v", dataHome: "/h", ask: async () => (seen.asked++, { ok: true }), cdpUrl: async () => null, run: async (cmd, env) => (seen.ran.push(cmd), seen.env.push(env), { code: 0, out: "{}" }) };
  return { d, seen };
};

test("W35c login は card も process も無い: cookie を取り込まず、tab で動くと案内するだけ", async () => {
  const { d, seen } = mk();
  const r = await runApi("login", ["canvas.example.edu"], d);
  expect(r).toMatchObject({ ok: true });
  expect((r as { out: string }).out).toContain("tab");
  expect(seen.asked + seen.ran.length).toBe(0);
});

test("W35c call は tier 1 だけ・tab で再生する印を env に付ける（add / capture には付けない）", async () => {
  const { d, seen } = mk();
  await runApi("call", ["hn", "search", "q=x"], d);
  expect(seen.ran[0]!.slice(-2)).toEqual(["--max-tier", "1"]);
  expect(seen.env[0]!.API_ANYTHING_TAB).toBe("1");
  await runApi("add", ["hn"], d);
  expect(seen.env[1]!.API_ANYTHING_TAB).toBeUndefined();
});

test("W35c / W46-B 拡張 api_fetch: 常駐が渡した tab（tabId）の中で fetch する・その tab が別 site なら動かない・自分で他の tab を探さない・別 site へ移されたら返さない・cookie は運ばない・GET / HEAD だけ", async () => {
  const c = installChrome();
  const g = globalThis as any;
  const { webRun } = await load("web");
  let queried = 0, ran: any[] = [];
  const q0 = g.chrome.tabs.query, x0 = g.chrome.scripting.executeScript, t0 = g.chrome.tabs.get;
  g.chrome.tabs.query = async () => (queried++, []);
  g.chrome.tabs.get = async (id: number) => (id === 7 ? { id: 7, url: "https://site.example/home", active: true, windowId: 1 } : id === 8 ? { id: 8, url: "https://other.example/", windowId: 1 } : Promise.reject(new Error("no tab")));
  g.chrome.scripting.executeScript = async ({ target, func, args }: any) => (ran.push({ tabId: target.tabId, args }), [{ result: await func(...args) }]);
  const realFetch = g.fetch;
  const hits: any[] = [];
  g.fetch = async (url: string, init: any) => (hits.push({ url, init }), url.includes("moved") ? { url: "https://evil.example/", status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) } : { url, status: 200, headers: new Headers(), arrayBuffer: async () => new TextEncoder().encode('{"a":1}').buffer });
  try {
    const ok = await webRun("api_fetch", { url: "https://site.example/api/x", method: "GET", headers: { accept: "application/json" }, tabId: 7 });
    expect(ran[0].tabId).toBe(7);
    expect(hits[0].init.credentials).toBe("include"); // Chrome が cookie（HttpOnly も）を付ける
    expect(JSON.stringify(hits[0].init.headers ?? {}).toLowerCase()).not.toContain("cookie");
    expect(Buffer.from(ok.data.body, "base64").toString()).toBe('{"a":1}');
    expect((await webRun("api_fetch", { url: "https://site.example/x" })).error).toBe(true); // tab を渡されていない: 探しに行かない
    expect((await webRun("api_fetch", { url: "https://site.example/x", tabId: 8 })).error).toBe(true); // 渡された tab が別 site
    expect((await webRun("api_fetch", { url: "https://site.example/x", tabId: 7, method: "POST" })).error).toBe(true); // 書く method は通さない
    expect(queried).toBe(0);
    expect(hits).toHaveLength(1);
    const moved = await webRun("api_fetch", { url: "https://site.example/moved", tabId: 7 });
    expect(moved.error).toBe(true);
    expect(moved.text).toContain("別の site");
    expect((await webRun("api_fetch", { url: "file:///etc/passwd", tabId: 7 })).error).toBe(true);
  } finally { g.fetch = realFetch; g.chrome.tabs.query = q0; g.chrome.scripting.executeScript = x0; g.chrome.tabs.get = t0; }
  void c;
});

test("W35c 上流の tabFetch: unix socket の apiFetch へ渡し、cookie 行を落とし、返事を Response にする（vendor を実際に読み込む）", async () => {
  const dir = mktmp("w35c"), sock = join(dir, "s");
  let got: any;
  const srv = createServer((s) => s.on("data", (d) => { got = JSON.parse(String(d)); s.write(JSON.stringify({ ok: true, res: { status: 200, url: got.url, headers: [["content-type", "application/json"], ["content-encoding", "gzip"]], body: Buffer.from('{"ok":1}').toString("base64") } }) + "\n"); }));
  await new Promise<void>((r) => srv.listen(sock, r));
  const p = Bun.spawn(["node", "--input-type=module", "-e", `const { tabFetch } = await import(process.env.HOME + "/.kangae/vendor/api-anything/dist/tab-fetch.js"); const r = await tabFetch("https://s.example/a", { method: "POST", headers: { cookie: "sid=SECRET", accept: "x" }, body: "b=1" }); console.log(JSON.stringify({ status: r.status, body: await r.text(), enc: r.headers.get("content-encoding") }))`], { env: { ...process.env, API_ANYTHING_TAB_SOCK: sock, API_ANYTHING_TAB_TOKEN: "tok" }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  srv.close();
  expect(got).toMatchObject({ op: "apiFetch", token: "tok", url: "https://s.example/a", method: "POST", body: "b=1" });
  expect(JSON.stringify(got.headers)).not.toContain("SECRET");
  expect(JSON.parse(out)).toEqual({ status: 200, body: '{"ok":1}', enc: null });
}, 60_000); // 混んだ機械で node の起動が 5 秒を超える

test("W35c 常駐: apiFetch は走っている api の印が無ければ拒み・cookie 行を落とし・api_fetch を拡張の口 1 つへ unicast で運ぶ・call の process ごとに印を作って終わったら消す", () => {
  const m = src("src/main.ts");
  const at = m.indexOf('case "apiFetch"');
  const body = m.slice(at, at + 1300);
  expect(body).toContain("apiTokens.get(m.token)");
  expect(body).toContain("leases.apiTab(owner, origin)"); // W46-B: 貸した tab の中だけ
  expect(body).toContain('["GET", "HEAD"].includes(method)'); // 書く method は通さない
  expect(body).toContain('"cookie"');
  expect(body).toContain('web.call("api_fetch"');
  expect(m).toContain('tool === "api_fetch" ||'); // unicast（agent の CLI も peer なので broadcast に載せない）
  expect(m).toContain("apiTokens.set(token, owner)");
  expect(m).toContain("apiTokens.delete(token)");
});
