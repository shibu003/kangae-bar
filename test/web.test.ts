// W1a: 常駐の WebSocket の口。実物の daemon を起こし、token つきで /panel と /ws が応え、無しだと断る
import { mktmp } from "./tmp.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDaemon, waitDaemon } from "./spawn-daemon";

const dir = mktmp("kangae-web");
const barFile = join(dir, "bar.json");
const proc = spawnDaemon([process.execPath, join(import.meta.dir, "../src/main.ts"), "--daemon"], {
  env: { ...process.env, KANGAE_HOME: dir, KANGAE_SOCK: join(dir, "s.sock"), KANGAE_BAR: barFile },
  stdout: "ignore", stderr: "ignore",
});
await waitDaemon(proc, { bar: barFile });
const { port, token } = JSON.parse(readFileSync(barFile, "utf8"));
const base = `http://127.0.0.1:${port}`;
const wsOpen = (q: string) => new Promise<WebSocket | null>((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${q}`);
  ws.onopen = () => res(ws);
  ws.onerror = () => res(null);
  ws.onclose = () => res(null);
});

test("bar.json は 0600 で token は 64 hex", () => {
  expect((Bun.file(barFile) as any).size).toBeGreaterThan(0);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(require("node:fs").statSync(barFile).mode & 0o777).toBe(0o600);
});

test("/panel: token 無し・違いは 403、正しければ頁と assets が出る", async () => {
  expect((await fetch(`${base}/panel`)).status).toBe(403);
  expect((await fetch(`${base}/panel?token=${"0".repeat(64)}`)).status).toBe(403);
  expect((await fetch(`${base}/panel?token=${token.slice(0, 10)}`)).status).toBe(403);
  const html = await (await fetch(`${base}/panel?token=${token}`)).text();
  expect(html).toContain(`name="kangae-token" content="${token}"`);
  expect(html).toContain(`<base href="/x/${token}/">`);
  for (const f of ["panel.js", "panel.css", "port.js", "groups.js"]) expect((await fetch(`${base}/x/${token}/${f}`)).status).toBe(200);
  expect((await fetch(`${base}/x/${"0".repeat(64)}/panel.js`)).status).toBe(403);
  expect((await fetch(`${base}/x/${token}/..%2Fsrc%2Fmain.ts`)).status).not.toBe(200);
  expect((await fetch(`${base}/x/${token}/nope.js`)).status).toBe(404);
  const root = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
  expect(root.headers.get("location")).toContain(`/panel?token=${token}`);
});

test("/ws: token 無し・違いは繋がらず、正しければ {id, op} に答える", async () => {
  expect(await wsOpen("")).toBeNull();
  expect(await wsOpen(`?token=${"0".repeat(64)}`)).toBeNull();
  const ws = (await wsOpen(`?token=${token}`))!;
  expect(ws).not.toBeNull();
  const res: any = await new Promise((r) => { ws.onmessage = (e) => r(JSON.parse(String(e.data))); ws.send(JSON.stringify({ id: "a1", op: "status" })); });
  expect(res.id).toBe("a1");
  expect(res.ok).toBe(true);
  ws.close();
});

test("止めると bar.json が消える", async () => {
  proc.kill("SIGTERM");
  await proc.exited;
  expect(existsSync(barFile)).toBe(false);
});
