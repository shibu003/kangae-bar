// 【この Mac では回さない（W3b-3・2026-10-06）】人の画面に Chromium の窓を実際に出す検査（窓の出来る順 = 最初の窓が拡張より先にできて標準の新しいタブにならないか）。
// headless では「最初の窓」が出来ず tabs が空のまま（fresh を headless で回して 86 秒 `[]`・docs/verify/w3b3/cold-fresh-run1.log）、headed は I-5（owner の画面の前に窓を出さない）に反する。
// 回すなら、画面を譲れる機械で `KANGAE_ALLOW_WINDOW=1 bun test/cold.e2e.ts [fresh|normal|crashed]`。normal / crashed は `--profile <試験用に作った profile の dir>` を渡す（owner の profile は読まない）。
if (!process.env.KANGAE_ALLOW_WINDOW) {
  console.log("SKIP(回さない): 人の画面に窓を出す検査。KANGAE_ALLOW_WINDOW=1 で回す");
  process.exit(3);
}
// 起動直後の最初の窓が「Kangae」になっているか（bun test/cold.e2e.ts [fresh|normal|crashed]）。normal / crashed は --profile で渡された profile を写して試す
import { mktmp } from "./tmp.ts";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_APP, openKangae } from "../src/launch.ts";
const mode = process.argv[2] ?? "fresh";
const given = process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : undefined;
if (mode !== "fresh" && !given) {
  console.log("SKIP(回さない): normal / crashed は --profile <試験用に作った profile の dir> が要る（owner の profile は読まない）");
  process.exit(3);
}
const dir = mktmp("kangae-cold");
const prof = join(dir, "profile");
if (mode !== "fresh") {
  cpSync(given!, prof, { recursive: true });
  for (const f of readdirSync(prof)) if (f.startsWith("Singleton")) unlinkSync(join(prof, f));
  const pf = join(prof, "Default/Preferences");
  const p = JSON.parse(readFileSync(pf, "utf8"));
  p.profile.exit_type = mode === "crashed" ? "Crashed" : "Normal";
  writeFileSync(pf, JSON.stringify(p));
}
const port = 9300 + Math.floor(Math.random() * 500);
const proc = await openKangae({ app: CHROMIUM_APP, profile: prof, hostBinary: join(import.meta.dir, "../dist/kangae"), extensionDir: join(import.meta.dir, "../extension"), mockKeychain: true, extraArgs: [`--remote-debugging-port=${port}`], env: { KANGAE_HOME: join(dir, "home"), KANGAE_SOCK: join(dir, "s.sock") } });
const t0 = Date.now();
let pages: any[] = [];
for (let i = 0; i < 40; i++) { await Bun.sleep(1000); try { pages = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[]).filter((t) => t.type === "page"); if (pages.length) break; } catch {} }
// 見るのは tab だけ（CDP の page には裏で先読みされた新しいタブも混ざる）。負荷が高いと差し替えに数十秒かかるので最大 45 秒
let tabs: string[] = [];
let ask: ((e: string) => Promise<any>) | null = null;
for (let i = 0; i < 45; i++) {
  if (!ask) {
    const sw = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[]).find((t) => t.type === "service_worker" && t.url.endsWith("/sw.js"));
    if (sw) {
      const ws = new WebSocket(sw.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      let n = 0;
      const wait = new Map<number, (v: any) => void>();
      ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); wait.get(m.id)?.(m); };
      ask = (expression) => new Promise((r) => { const id = ++n; wait.set(id, r); ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); });
    }
  }
  if (ask) tabs = JSON.parse((await ask("chrome.tabs.query({}).then(t=>JSON.stringify(t.map(x=>(x.title||'')+' '+(x.url||''))))")).result?.result?.value ?? "[]");
  if (tabs.length && tabs.every((x) => x.includes("/newtab.html"))) break;
  await Bun.sleep(1000);
}
console.log(mode, `${Date.now() - t0}ms`, tabs);
process.exitCode = tabs.length > 0 && tabs.every((x) => x.includes("/newtab.html")) ? 0 : 1;
proc.kill();
// 最後に開いた page が起こした中継役は、Chromium が死んだ後も数秒で常駐を起こしうる。待ってから止める
await Bun.sleep(7000);
for (const p of Bun.spawnSync(["lsof", "-t", join(dir, "s.sock")]).stdout.toString().split("\n").filter(Boolean)) try { process.kill(Number(p)); } catch {}
await Bun.sleep(1500); rmSync(dir, { recursive: true, force: true }); process.exit(process.exitCode ?? 1);
