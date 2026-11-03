// W3a の通し（手で回す: bun test/dm.e2e.ts [--real] [--front-watch /path/to/front-watch] [--shots dir]）。
// 隔離した home・socket・bar.json で常駐を起こし、headless の Chrome（窓も前面も出ない）で /panel を開いて、
// 一言 → 返事 → 次の一手 3 つ → 1 つ押す → 深掘り → 開き直しても残る、を通す。owner の bar・常駐・DB には触らない（DB は写しを使う）。
// --real: 偽の claude でなく、この Mac の本物の claude を 1〜2 回呼ぶ。
import { mktmp } from "./tmp.ts";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cdpOpen as cdpOpenAt, sockCall } from "./cdp-sw.ts";
import { judgeFront, rememberOurs } from "./front-judge.ts";
import { humanAsk } from "./human-ask.ts";
import { spawnDaemon, waitDaemon } from "./spawn-daemon";
import { armExe } from "./exe";

const real = process.argv.includes("--real");
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const shots = arg("--shots");
if (shots) mkdirSync(shots, { recursive: true });
const D = mktmp("kangae-dm");
const repo = join(import.meta.dir, "..");
const t0 = Date.now();
const fails: string[] = [];
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const check = (name: string, ok: boolean, detail = "") => { say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) fails.push(name); };

// ---- front-watch: 何かを起こす前から後始末の後まで 1 本 ----
const fwBin = arg("--front-watch");
const fwSec = Number(arg("--fw-sec") ?? (real ? 420 : 200));
const fw = fwBin ? Bun.spawn([fwBin, String(fwSec)], { stdout: "pipe" }) : null;

// ---- 偽の claude（--real でない時）----
const fakebin = join(D, "bin");
mkdirSync(fakebin);
writeFileSync(join(fakebin, "claude"), `#!/bin/sh
case "$1" in auth) exit 0;; esac
prompt="$2"
case "$prompt" in
  *ゼロ*) printf '%s\\n' '{"type":"result","result":"次の一手を付けない返事です。"}' ;;
  *空*) exit 0 ;;
  *TESTASK*) printf '%s\\n' '{"type":"result","result":"どちらにしますか。\\n[[ask: 表の形はどちらにしますか？ | 材料と手順を 1 枚に | 別の表に]]\\n\\n次の一手:\\n1. 任せる\\n2. 待つ\\n3. 変える"}' ;;
  *TESTHAND*) printf '%s\\n' '{"type":"result","result":"人の操作が要ります。[[handoff: 変更を外に送る | git push origin main]]"}' ;;
  *TESTDONE*) printf '%s\\n' '{"type":"result","result":"できました。[[done: できました | 売上.csv]]\\n\\n次の一手:\\n1. 週ごとに足す\\n2. 開く\\n3. 消す"}' ;;
  *TESTSLOW*) printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"資料を読んでいます"}]}}'; sleep 6; printf '%s\\n' '{"type":"result","result":"遅い返事です。\\n\\n次の一手:\\n1. A\\n2. B\\n3. C"}' ;;
  *深掘り*|*調べる*) printf '%s\\n' '{"type":"result","result":"深掘りした返事です。\\n\\n次の一手:\\n1. 深掘り A\\n2. 深掘り B\\n3. 深掘り C"}' ;;
  *) printf '%s\\n' '{"type":"result","result":"まず小さく試す。\\n\\n次の一手:\\n1. 時間を測る\\n2. 案を 3 つ書く\\n3. 一人に話す（深掘り）"}' ;;
esac
`);
armExe(join(fakebin, "claude"));
const shell = join(D, "shell.sh");
writeFileSync(shell, `#!/bin/sh\nprintf '%s' "${fakebin}:/usr/bin:/bin"\n`);
armExe(shell);

// ---- 前の会話（試験の中で作った、keyword の木を持つ古い形の DB）。owner の DB は読まない・会話の中身を log に書かない ----
const home = join(D, "home");
mkdirSync(home);
const oldDb = new Database(join(home, "kangae.db"));
oldDb.run(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES nodes(id), kind TEXT NOT NULL, text TEXT NOT NULL, chosen INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, from_id INTEGER REFERENCES nodes(id), deleted_at INTEGER, url TEXT, data TEXT)`);
const ins = (id: number, parent: number | null, kind: string, text: string) => oldDb.run("INSERT INTO nodes (id, parent_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)", [id, parent, kind, text, 1_700_000_000_000 + id]);
ins(1, null, "user", "試験用の会話");
ins(2, 1, "user", "試験の一言 A");
ins(3, 2, "keyword", "枝 1"); ins(4, 2, "keyword", "枝 2");
ins(5, 3, "user", "試験の一言 B");
ins(6, 5, "keyword", "枝 3");
oldDb.run("PRAGMA user_version = 5"); // keyword の木をやめる前（W3a の移行の前）の形
oldDb.close();
const before: { root: number; text: string; users: string[] } = { root: 1, text: "試験用の会話", users: ["試験の一言 A", "試験の一言 B"] };
say(`移行前（試験で作った古い形の DB）: 根 #${before.root}・一言 ${before.users.length} 件`);

// ---- 常駐 ----
async function startDaemon(tag: string, extra: Record<string, string> = {}) {
  const sock = join(D, `${tag}.sock`);
  const bar = join(D, `${tag}-bar.json`);
  const env = { ...(process.env as Record<string, string>), KANGAE_HOME: tag === "main" ? home : join(D, `home-${tag}`), KANGAE_SOCK: sock, KANGAE_BAR: bar, KANGAE_NODES_DIR: join(D, `nodes-${tag}`), KANGAE_TEST_TRUST_EXT: "1" /* 偽の拡張の webHello（W8g-5） */, ...(real ? {} : { SHELL: shell }), ...extra };
  mkdirSync(env.KANGAE_HOME, { recursive: true });
  const proc = spawnDaemon(["bun", join(repo, "src/main.ts"), "--daemon"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  await waitDaemon(proc, { bar, sock });
  const j = JSON.parse(readFileSync(bar, "utf8")) as { port: number; token: string };
  return { proc, sock, ...j };
}
const daemons: { proc: { kill: () => void } }[] = [];
// ---- headless Chrome（窓を出さない）+ CDP ----
const cdpPort = 9600 + Math.floor(Math.random() * 300);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(D, "profile")}`, "--window-size=480,820", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdout: "ignore", stderr: "ignore" });
const cdpOpen = (url: string) => cdpOpenAt(cdpPort, url, { shots });
const until = async (f: () => Promise<boolean>, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await Bun.sleep(250); } return false; };

const cleanup = async () => {
  rememberOurs(D);
  try { chrome.kill(); } catch {}
  for (const d of daemons) try { d.proc.kill(); } catch {}
  await Bun.sleep(500);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const left = [["Chrome", chrome.pid], ...daemons.map((d: any) => ["常駐", d.proc.pid])].filter(([, pid]) => pid && alive(pid as number));
  say(`残っている物: ${left.length ? left.map(([n, p]) => `${n} pid ${p}`).join(", ") : "なし"}`);
  for (const [, pid] of left) try { process.kill(pid as number, "SIGKILL"); } catch {}
  rmSync(D, { recursive: true, force: true });
};

async function main() {
  const main = await startDaemon("main");
  daemons.push(main);
  const url = `http://127.0.0.1:${main.port}/panel?token=${main.token}`;
  const roots = (await sockCall(main.sock, { op: "roots" })).roots as any[];
  say(`常駐 pid ${main.proc.pid} port ${main.port}・根 ${roots.length} 本（写しの DB が user_version 移行済み）`);

  // 1. 移行（AC-3）: 前の会話が同じ中身で読める
  {
    const chat = await sockCall(main.sock, { op: "chat", rootId: before.root });
    const after = chat.rows.map((r: any) => r.text);
    check("AC-3 前の会話が同じ中身で読める", JSON.stringify(after) === JSON.stringify(before.users), `根 #${before.root}「${before.text}」 前 ${before.users.length} 件 → 後 ${after.length} 件・先頭 ${JSON.stringify(after.slice(0, 2))}`);
    const left = new Database(join(home, "kangae.db")).query("SELECT COUNT(*) AS n FROM nodes WHERE kind='keyword'").get() as { n: number };
    check("keyword の行が保存に残っていない", left.n === 0, `n=${left.n}`);
  }

  // 2. 新しい会話の通し
  const made = await sockCall(main.sock, { op: "add", text: "副業" });
  const rid = made.node.id as number;
  const page = await cdpOpen(url);
  await page.ev(`localStorage.setItem('panel-root', '${rid}')`);
  await page.send("Page.navigate", { url });
  check("画面が開いた（DM の枠）", await until(async () => (await page.ev(`!!document.getElementById('hd') && !document.getElementById('app').hidden`)) === true, 15000));
  // 会話が 2 つ以上あると、まず一覧が出る（W3b）。行を押して会話に入る
  const enter = async (pg: typeof page, id: number) => pg.ev(`(async () => { for (let i = 0; i < 80; i++) { const b = document.querySelector('#roots .root[data-id="${id}"]'); if (b) { if (document.getElementById('app').classList.contains('list-open')) b.click(); for (let j = 0; j < 80 && document.documentElement.dataset.busy; j++) await new Promise((r) => setTimeout(r, 100)); return 1; } await new Promise((r) => setTimeout(r, 100)); } return 0; })()`);
  await enter(page, rid);
  await page.shot("01-empty");
  const type = async (text: string) => page.ev(`(() => { const i = document.getElementById('send-text'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); document.getElementById('send-form').requestSubmit(); return 1; })()`);
  const nexts = async () => (await page.ev(`[...document.querySelectorAll('#next .next-btn')].map((b) => b.textContent)`)) as string[];
  const rowsText = async () => (await page.ev(`[...document.querySelectorAll('#rows .chat-row')].map((li) => li.className + '|' + (li.querySelector('.chat-text')?.textContent ?? li.textContent))`)) as string[];
  const wait3 = async (n: number) => until(async () => (await nexts()).length === n, real ? 180_000 : 30_000);

  const q1 = real ? "副業を始めたい。何から手を付ければいい？" : "副業を始めたい";
  await type(q1);
  check("進み具合の card と「進んでいます」が出る", await until(async () => (await page.ev(`!document.getElementById('progress').hidden && document.getElementById('hd-st').textContent.includes('進んでいます')`)) === true, 15000));
  await page.shot("02-working");
  check("返事の下に次の一手が 3 つ出る", await wait3(3), JSON.stringify(await nexts()));
  const n1 = await nexts();
  const rows1 = await rowsText();
  console.log("--- 返事 1 の原文 ---\n" + rows1.join("\n") + "\n次の一手: " + JSON.stringify(n1));
  check("自分は右の吹き出し・相手は地の文", rows1[0]!.startsWith("chat-row me|") && rows1[1]!.startsWith("chat-row they|"), rows1.map((r) => r.split("|")[0]).join(","));
  check("上の 1 行が「終わりました」", ((await page.ev(`document.getElementById('hd-st').textContent`)) as string).includes("終わりました"));
  await page.shot("03-next3");

  // 3. 開き直しても残る（AC-1 の 6）
  await page.send("Page.navigate", { url });
  await enter(page, rid);
  check("開き直しても同じ会話と最後の 3 つが残っている", await until(async () => (await nexts()).length === 3 && (await rowsText()).length === rows1.length, 15000), JSON.stringify(await nexts()));
  check("開き直しの次の一手が同じ文", JSON.stringify(await nexts()) === JSON.stringify(n1));

  // 4. 1 つ押す → 深掘り → また 3 つ
  const pick = n1[real ? 0 : 2]!;
  const left = await page.ev(`(() => { [...document.querySelectorAll('#next .next-btn')].find((b) => b.textContent === ${JSON.stringify(pick)}).click(); return document.querySelectorAll('#next .next-btn').length; })()`);
  check("押した直後、その回の 3 つは消える（出し直さない）", left === 0, `押した直後の数 n=${left}`);
  check("押した文がそのまま次の一言として会話に残る", await until(async () => (await rowsText()).some((r) => r.startsWith("chat-row me|") && r.endsWith(`|${pick}`)), 10000), pick);
  // 本物の claude は、人に聞かないと進められない返事では次の一手の代わりに ask の card を返す事がある（それも次にする事が 1 つ出ている）
  check(real ? "深掘りの返事が返り、また 3 つ出る（または、答えを聞く card が出る）" : "深掘りの返事が返り、また 3 つ出る", real ? await until(async () => (await nexts()).length === 3 || ((await page.ev(`document.querySelectorAll('#rows .card .btn').length`)) as number) >= 2, 300_000) : await wait3(3), JSON.stringify({ nexts: await nexts(), cardButtons: await page.ev(`[...document.querySelectorAll('#rows .card .btn')].map((b) => b.textContent)`) }));
  const n2 = await nexts();
  console.log("--- 深掘りの返事の原文 ---\n" + (await rowsText()).slice(-2).join("\n") + "\n次の一手: " + JSON.stringify(n2));
  check("前の 3 つと違う文", JSON.stringify(n2) !== JSON.stringify(n1));
  await page.shot("04-deeper");

  // 5. IME: 変換確定の Enter は送らない
  const prevented = await page.ev(`(() => { const e = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true }); document.getElementById('send-text').dispatchEvent(e); return e.defaultPrevented; })()`);
  check("IME 中の Enter は送らない", prevented === true);

  // 6. keyword の木が画面のどこにも出ていない
  const treeish = await page.ev(`document.body.innerText.includes('キーワード') || !!document.getElementById('map') || !!document.getElementById('sky')`);
  check("keyword の木は画面のどこにも出ていない", treeish === false);
  const ph = await page.ev(`document.getElementById('send-text').placeholder`);
  check("欄の案内は dm-ui と同じ「返事を書く」", ph === "返事を書く", ph);

  if (!real) {
    // 7. AC-4: 3 つ出ない / 返事が空
    await type("ゼロ個の返事をください");
    check("AC-4 次の一手が 0 個でも壊れず、次にする事が 1 行出る", await until(async () => ((await page.ev(`document.querySelector('#next .next-hint')?.textContent || ''`)) as string).includes("続きを下の欄に書いて"), 30_000), JSON.stringify(await rowsText()) + " / " + ((await page.ev(`document.getElementById('hd-st').textContent + '|' + document.getElementById('next').outerHTML`)) as string));
    await page.shot("05-zero");
    await type("空の返事をください");
    check("AC-4 返事が空でも壊れず、失敗と次にする事が出る", await until(async () => ((await page.ev(`document.querySelector('.fail-line')?.textContent || ''`)) as string).includes("もう一度送る"), 30_000), (await page.ev(`document.querySelector('.fail-line')?.textContent`)) as string);
    await page.shot("06-empty");
    // 鍵・agent が無い: HOME を空にして claude を探せない常駐
    const none = await startDaemon("none", { KANGAE_CLIS: "none" });
    daemons.push(none);
    const r0 = await sockCall(none.sock, { op: "add", text: "agent の居ない会話" });
    const url2 = `http://127.0.0.1:${none.port}/panel?token=${none.token}`;
    const p2 = await cdpOpen(url2);
    await p2.ev(`localStorage.setItem('panel-root', '${r0.node.id}')`);
    await p2.send("Page.navigate", { url: url2 });
    await until(async () => (await p2.ev(`!document.getElementById('app').hidden`)) === true, 15000);
    await p2.ev(`(() => { const i = document.getElementById('send-text'); i.value = 'こんにちは'; document.getElementById('send-form').requestSubmit(); return 1; })()`);
    check("AC-4 / D7 agent が無い時も壊れず、足りない物の 1 枚（何が・次の一手・もう一度送る）が出る", await until(async () => ((await p2.ev(`document.querySelector('#need')?.textContent || ''`)) as string).includes("claude か codex を入れてください"), 30_000), (await p2.ev(`document.querySelector('#need')?.textContent`)) as string);
    check("D7 足りない物は 1 枚だけ（失敗の行と二重に出ない）", (await p2.ev(`document.querySelectorAll('#need .card').length + '/' + document.querySelectorAll('.fail-line').length`)) === "1/0" && ((await p2.ev(`document.querySelector('#need .btn')?.textContent`)) as string) === "もう一度送る");
    await p2.shot("07-none");
    p2.close();
  }

  if (!real) {
    // ---- W3b: 会話の中の card（D3 承認・引き取り・結果 / D4 進み / D7 足りない物）と、一覧（D6）----
    const cardsOf = async () => (await page.ev(`[...document.querySelectorAll('#rows .card')].map((c) => c.innerText.replace(/\\s+/g, ' ').trim())`)) as string[];
    const btnsOf = async () => (await page.ev(`[...document.querySelectorAll('#rows .card .btn')].map((b) => b.textContent)`)) as string[];
    const bodyAll = async () => ((await page.ev(`document.getElementById('rows').innerText`)) as string);
    // D3 承認（問い）: 印が本文に出ない・card に変わる・1 押しで答えられる・receipt が残る
    await type("TESTASK 表の形を決めたい");
    check("D3 承認の card が会話の中に出る（ボタン 2 つ）", await until(async () => (await btnsOf()).length === 2, 30_000), JSON.stringify(await btnsOf()));
    check("AC-3 印（[[ask）が本文に生で出ていない", !(await bodyAll()).includes("[[") && !(await bodyAll()).includes("ask:"), JSON.stringify((await bodyAll()).slice(-120)));
    check("上の 1 行が「あなたの番です」・次の一手は card と二重に出ない", ((await page.ev(`document.getElementById('hd-st').textContent`)) as string).includes("あなたの番です") && (await page.ev(`document.getElementById('next').hidden`)) === true);
    console.log("--- 承認 card の原文 ---\n" + JSON.stringify(await cardsOf()));
    await page.shot("10-ask");
    await page.ev(`document.querySelector('#rows .card .btn').click()`);
    check("1 押しで答えられ、card は 1 行の receipt に替わる", await until(async () => ((await page.ev(`[...document.querySelectorAll('#rows .receipt')].map((r) => r.textContent).join('|')`)) as string).includes("「材料と手順を 1 枚に」と答えました"), 30_000), (await page.ev(`[...document.querySelectorAll('#rows .receipt')].map((r) => r.textContent).join('|')`)) as string);
    // 人の行の本文は .chat-text（li.textContent は agent が走っている間「動いている止める」が末尾に付く）
    const mineTexts = async () => (await page.ev(`[...document.querySelectorAll('#rows .chat-row.me .chat-text')].map((p) => p.textContent)`)) as string[];
    check("押した文が次の一言として会話に残り、card は消えている", (await btnsOf()).length === 0 && (await mineTexts()).includes("材料と手順を 1 枚に"), JSON.stringify({ btns: await btnsOf(), mine: await mineTexts() }));
    await wait3(3);
    // D3 引き取り + AC-4: 押さずに次の一言を打っても会話が壊れない
    await type("TESTHAND 外に送る話");
    check("D3 引き取りの card（やりました / やめる・人だけがする操作）", await until(async () => (await btnsOf()).join(",") === "やりました,やめる", 30_000), JSON.stringify(await btnsOf()));
    check("引き取りの card に補足と「人だけがする操作」が出る", (await cardsOf()).some((c) => c.includes("変更を外に送る") && c.includes("git push origin main") && c.includes("人だけがする操作")));
    await page.shot("10-handoff");
    await type("先に別の話をします");
    check("AC-4 押さずに次を打っても壊れず、receipt が「答えずに次へ進みました」になる", await until(async () => ((await page.ev(`[...document.querySelectorAll('#rows .receipt')].map((r) => r.textContent).join('|')`)) as string).includes("答えずに次へ進みました"), 30_000) && (await page.ev(`!!document.querySelector('#app') && !document.querySelector('.fail-line')`)) === true);
    await wait3(3);
    // D3 結果
    await type("TESTDONE 売上の表");
    check("D3 結果の card（終わりました — できました・物の名前）", await until(async () => (await cardsOf()).some((c) => c.includes("終わりました — できました") && c.includes("売上.csv")), 30_000), JSON.stringify(await cardsOf()));
    check("結果の card は押すものが無い・次の一手は出る", (await btnsOf()).length === 0 && (await wait3(3)));
    await page.shot("10-done");
    // D4 進み具合: 1 枚・畳める
    await type("TESTSLOW 長い仕事");
    check("D4 進み具合の card が 1 枚出る（進んでいます・いまの 1 行）", await until(async () => ((await page.ev(`document.querySelector('#progress .card')?.innerText || ''`)) as string).includes("進んでいます") && ((await page.ev(`document.querySelector('#progress .card')?.innerText || ''`)) as string).includes("資料を読んでいます"), 15_000), (await page.ev(`document.querySelector('#progress')?.innerText`)) as string);
    check("進み具合は 1 枚だけ", (await page.ev(`document.querySelectorAll('#progress .card').length`)) === 1);
    await page.shot("11-progress");
    await page.ev(`document.querySelector('#progress .t .r').click()`);
    check("畳める（steps が消えて「ひらく」になる）", (await page.ev(`!document.querySelector('#progress .steps') && document.querySelector('#progress .t .r').textContent`)) === "ひらく");
    await page.ev(`document.querySelector('#progress .t .r').click()`);
    check("ひらくと steps が戻る", (await page.ev(`!!document.querySelector('#progress .steps')`)) === true);
    check("終わると進み具合の card は消え、返事が出る", await until(async () => (await page.ev(`document.getElementById('progress').hidden`)) === true && (await nexts()).length === 3, 30_000), JSON.stringify({ hidden: await page.ev(`document.getElementById('progress').hidden`), nexts: await nexts(), st: await page.ev(`document.getElementById('hd-st').textContent`) }));

    // D6 一覧: 会話が 3 つ・面を持っている会話・あなたの番の会話
    const sock2 = (m: Record<string, unknown>) => sockCall(main.sock, m);
    const kaikei = (await sock2({ op: "add", text: "家計" })).node.id as number;
    const wait = (await sock2({ op: "add", text: "承認待ち" })).node.id as number;
    await sock2({ op: "send", rootId: kaikei, text: "家計簿を始める" });
    await sock2({ op: "send", rootId: wait, text: "TESTASK 承認待ちの話" });
    for (let i = 0; i < 120; i++) {
      const rs = (await sock2({ op: "roots" })).roots as any[];
      if (rs.find((r) => r.id === kaikei)?.last?.mine === false && rs.find((r) => r.id === wait)?.last?.turn) break;
      await Bun.sleep(250);
    }
    // いちばん古い会話（副業）に最後に一言送る: 並びが「作った順」ではなく「最後に動いた順」であることを測る
    await sock2({ op: "send", rootId: rid, text: "もう一言" });
    for (let i = 0; i < 120; i++) {
      if (((await sock2({ op: "roots" })).roots as any[]).find((r) => r.id === rid)?.last?.text === "まず小さく試す。") break;
      await Bun.sleep(250);
    }
    // 偽の拡張（常駐の /ws に繋いで tab_info にだけ答える）で、rid の会話に面を渡す
    const fakeExt = new WebSocket(`ws://127.0.0.1:${main.port}/ws?token=${encodeURIComponent(main.token)}`);
    await new Promise((r) => (fakeExt.onopen = r));
    fakeExt.send(JSON.stringify({ id: "w:hello", op: "webHello" })); // 拡張の代役も、本物と同じに「受けられる」と知らせる
    fakeExt.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === "web") fakeExt.send(JSON.stringify({ id: crypto.randomUUID(), op: "webResult", callId: m.id, text: "", data: { docId: "d1", title: "買い物の頁", url: "https://example.com/" } })); };
    const given = await humanAsk(join(D, "main-bar.json"))({ op: "leaseGive", rootId: rid, tabId: 77, title: "買い物の頁" });
    check("面を渡せた（偽の拡張が tab_info に答える）", given.ok === true, JSON.stringify(given).slice(0, 160));
    await page.ev(`localStorage.removeItem('panel-seen')`);
    await page.send("Page.navigate", { url });
    const rowsInfo = async () => (await page.ev(`JSON.stringify([...document.querySelectorAll('#roots button.root')].map((b) => ({ id: b.dataset.id, title: b.querySelector('.root-text')?.textContent, last: b.querySelector('.pv-last')?.textContent, mark: b.querySelector('.mark')?.hidden === false ? b.querySelector('.mark').textContent : '', icon: !!b.querySelector('.mark svg'), lastShown: b.querySelector('.pv-last')?.hidden === false, lease: b.querySelector('.lease')?.hidden === false ? b.querySelector('.lease').textContent : '', dot: b.querySelector('.badge')?.hidden === false, time: b.querySelector('.time')?.textContent, bold: b.classList.contains('you') })))`)) as string;
    check("会話が 2 つ以上だと、まず一覧が出る（会話ではなく）", await until(async () => (await page.ev(`document.getElementById('app').classList.contains('list-open') && document.querySelectorAll('#roots .root').length >= 3`)) === true, 15_000));
    await Bun.sleep(800);
    const ri = JSON.parse(await rowsInfo()) as any[];
    console.log("--- 一覧の行の原文 ---\n" + ri.map((r) => JSON.stringify(r)).join("\n"));
    const idx = (id: number) => ri.findIndex((r) => r.id === String(id));
    check("D6 新しい順（作った順ではなく、最後に動いた会話が上）", idx(rid) < idx(wait) && idx(wait) < idx(kaikei), `副業=${idx(rid)}（いちばん古いが最後に動いた） 承認待ち=${idx(wait)} 家計=${idx(kaikei)}`);
    check("D6 あなたの番の会話に印と ●（承認待ち）", ri[idx(wait)]?.mark === "あなたの番です" && ri[idx(wait)]?.dot === true && ri[idx(wait)]?.bold === true);
    check("W3b-2 一覧の 2 行目は状態の icon + 状態語（動いています / あなたの番です / 終わりました）。状態の行は最後の文を出さない", ri.every((r) => (r.mark ? ["動いています", "あなたの番です", "終わりました", "失敗"].includes(r.mark) && r.lastShown === false : r.lastShown === true)) && ri.some((r) => r.mark === "終わりました") && ri.every((r) => !r.mark || r.icon), JSON.stringify(ri.map((r) => [r.mark, r.lastShown, r.icon])));
    check("W3b-2 一覧に前の画面の操作（付いた tab・履歴・名前を変える・タブで開く・デスクトップに置く）が無い。「＋」は 1 つ", await page.ev(`document.querySelectorAll('#sessions #rename, #sessions #open-tab, #sessions #to-desktop, #sessions #term-to-desktop, #sessions #tab-to-desktop, #sessions #add-tab, #sessions .attached, #sessions .history').length === 0 && document.querySelectorAll('#sessions > #session-tools button').length === 1 && document.getElementById('plus').closest('#sessions') != null`) === true);
    check("D6 未読の会話に ●（家計: 返事が来ていて、まだ開いていない）", ri[idx(kaikei)]?.dot === true && ri[idx(kaikei)]?.last?.length > 0);
    check("D6 最後の 1 行と時刻が出る", ri.every((r) => r.last && /^(\d\d:\d\d|昨日|\d+\/\d+)$/.test(r.time)), JSON.stringify(ri.map((r) => [r.last?.slice(0, 12), r.time])));
    check("通し 3: 面を持っている会話の行に「誰が何の面を持っているか」が出る", ri[idx(rid)]?.lease === "🔒 agent が 買い物の頁 を持っています" && ri.filter((r) => r.lease).length === 1, ri[idx(rid)]?.lease);
    await page.shot("12-list-narrow");
    // 通し 2: 押すと DM、☰ で一覧を開く
    await page.ev(`document.querySelector('#roots .root[data-id="${kaikei}"]').click()`);
    check("通し 2: 一覧の行を押すと DM の画面に入る", await until(async () => (await page.ev(`!document.getElementById('app').classList.contains('list-open') && document.getElementById('hd-name').textContent`)) !== false && ((await page.ev(`[...document.querySelectorAll('#rows .chat-row')].map((l) => l.textContent).join('|')`)) as string).includes("家計簿を始める"), 10_000));
    await page.ev(`document.getElementById('hd-more').click()`);
    check("W3b-2 DM の上の「…」を押すと、名前を変える・タブで開く・デスクトップに置く・付いた tab・履歴が出る（消していない）", await page.ev(`(() => { const m = document.getElementById('more'); return !m.hidden && ['rename', 'open-tab', 'to-desktop', 'add-tab', 'attached', 'history'].every((id) => m.querySelector('#' + id)) && m.getClientRects().length > 0; })()`) === true);
    await page.ev(`document.getElementById('hd-more').click()`);
    check("入った会話の未読の印は消える（もう一度一覧を見ると ● が無い）", await (async () => { await page.ev(`document.getElementById('hd-list').click()`); await Bun.sleep(600); return JSON.parse(await rowsInfo()).find((r: any) => r.id === String(kaikei))?.dot === false; })());
    check("☰ で一覧を開く", (await page.ev(`document.getElementById('app').classList.contains('list-open') && document.querySelector('#chat').offsetParent === null`)) === true);
    // 広い窓でも一覧と会話は並ばない。☰ は残る
    await page.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
    await Bun.sleep(400);
    await page.ev(`document.querySelector('#roots .root').click()`);
    await Bun.sleep(300);
    check("広い窓でも ☰ が出て、一覧と会話は並ばない", (await page.ev(`document.getElementById('hd-list').offsetParent !== null && document.querySelector('#chat').offsetParent !== null && document.querySelector('#sessions').offsetParent === null`)) === true);
    await page.shot("13-list-wide");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 460, height: 780, deviceScaleFactor: 2, mobile: false });
    fakeExt.close();
  }

  if (real) {
    // ---- W3b（本物の claude）: 印が本物の返事で card になるか・一覧の行き来・面を持つ印 ----
    const k2 = (await sockCall(main.sock, { op: "add", text: "家計" })).node.id as number; // 返事は頼まない会話（先に作る: 一覧の先頭は「最後に動いた会話」になる）
    await type("表を 1 つ作りたい。形（1 枚にまとめる / 材料と手順を別の表に分ける）を私に選ばせたいので、返事の本文に [[ask: 表の形はどちらにしますか？ | 1 枚にまとめる | 別の表に分ける]] の印を 1 つだけ書いて、まだ作らないで。");
    const gotCard = await until(async () => ((await page.ev(`document.querySelectorAll('#rows .card .btn').length`)) as number) >= 2, 240_000);
    const rawReply = ((await page.ev(`[...document.querySelectorAll('#rows .chat-row.they .chat-text')].map((p) => p.textContent).join('\\n')`)) as string); // 相手の本文だけ（人の行には試験が書いた印の文が入る）
    check("D3（本物）agent が返事に埋めた印が、会話の中の card（ボタン）に変わる", gotCard, JSON.stringify({ buttons: await page.ev(`[...document.querySelectorAll('#rows .card .btn')].map((b) => b.textContent)`), tail: rawReply }));
    check("AC-3（本物）印が本文に生で出ていない", !rawReply.includes("[[") && !rawReply.includes("ask:"));
    await page.shot("10-ask-real");
    if (gotCard) {
      await page.ev(`document.querySelector('#rows .card .btn').click()`);
      check("D3（本物）1 押しで答えられ、receipt が残る", await until(async () => ((await page.ev(`[...document.querySelectorAll('#rows .receipt')].map((r) => r.textContent).join('|')`)) as string).includes("と答えました"), 20_000));
      check("D4（本物）答えた後の返事の間、進み具合の card が 1 枚出る", await until(async () => (await page.ev(`!document.getElementById('progress').hidden && document.querySelectorAll('#progress .card').length`)) === 1, 60_000));
      await page.shot("11-progress-real");
      check("答えた後の返事が返り、進み具合の card が消える", await until(async () => (await page.ev(`document.getElementById('progress').hidden`)) === true, 300_000));
    }
    // 一覧: 会話を 2 つ足し（返事は頼まない）、面を渡して、行き来
    const fakeExt = new WebSocket(`ws://127.0.0.1:${main.port}/ws?token=${encodeURIComponent(main.token)}`);
    await new Promise((r) => (fakeExt.onopen = r));
    fakeExt.send(JSON.stringify({ id: "w:hello", op: "webHello" })); // 拡張の代役も、本物と同じに「受けられる」と知らせる
    fakeExt.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === "web") fakeExt.send(JSON.stringify({ id: crypto.randomUUID(), op: "webResult", callId: m.id, text: "", data: { docId: "d1", title: "買い物の頁", url: "https://example.com/" } })); };
    const given = await humanAsk(join(D, "main-bar.json"))({ op: "leaseGive", rootId: rid, tabId: 77, title: "買い物の頁" });
    check("面を渡せた（偽の拡張が tab_info にだけ答える）", given.ok === true);
    await page.send("Page.navigate", { url });
    check("会話が 2 つ以上だと、まず一覧が出る", await until(async () => (await page.ev(`document.getElementById('app').classList.contains('list-open') && document.querySelectorAll('#roots .root').length >= 3`)) === true, 15_000));
    await Bun.sleep(800);
    const info = JSON.parse((await page.ev(`JSON.stringify([...document.querySelectorAll('#roots button.root')].map((b) => ({ id: b.dataset.id, title: b.querySelector('.root-text')?.textContent, last: b.querySelector('.pv-last')?.textContent, lease: b.querySelector('.lease')?.hidden === false ? b.querySelector('.lease').textContent : '', time: b.querySelector('.time')?.textContent })))`)) as string) as any[];
    console.log("--- 一覧の行の原文（本物の会話）---\n" + info.slice(0, 5).map((r) => JSON.stringify(r)).join("\n"));
    check("D6（本物）いちばん最近動いた会話（副業）が一覧の先頭・面を持つ印が出る", info[0]?.id === String(rid) && info[0]?.lease === "🔒 agent が 買い物の頁 を持っています", JSON.stringify(info[0]));
    await page.shot("12-list-narrow");
    await page.ev(`document.querySelector('#roots .root[data-id="${k2}"]').click()`);
    check("通し 2（本物）行を押すと DM に入り、☰ で一覧を開く", await until(async () => (await page.ev(`!document.getElementById('app').classList.contains('list-open')`)) === true, 10_000) && ((await page.ev(`document.getElementById('hd-list').click(); document.getElementById('app').classList.contains('list-open')`)) === true));
    fakeExt.close();
  }

  // 8. 移行した前の会話を画面で開く
  {
    await page.ev(`localStorage.setItem('panel-root', '${before.root}')`);
    await page.send("Page.navigate", { url });
    await enter(page, before.root);
    await until(async () => (await rowsText()).length > 0, 15000);
    const t = await rowsText();
    check("AC-3 画面でも前の会話が読める", t.length === before.users.length && t[0]!.endsWith(`|${before.users[0]}`), `画面の行 ${t.length} 件・先頭「${before.users[0]}」`);
    await page.shot("08-old-conversation");
  }

  // 9. 絵（dm-ui.html）と並べる: 会話・一覧・card（左 = 絵、右 = 今の画面）
  const wire = join(homedir(), "shibubu-manager/projects/openroly/openroly-desktop/backlog/design/dm-ui.html");
  if (shots && existsSync(wire)) {
    const wp = await cdpOpen(`file://${wire}`);
    await Bun.sleep(1500);
    await wp.ev(`document.querySelector('.toolbar').style.display = 'none'`); // 貼り付いた上の帯を撮らない
    const sbs = async (selector: string, mine: string, out: string, wireName: string, width = 460) => {
      const box = (await wp.ev(`(() => { const a = document.querySelector(${JSON.stringify(selector)}); a.scrollIntoView({ block: 'start' }); const r = a.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`)) as any;
      const a = await wp.shot(wireName, box);
      if (!existsSync(join(shots, `${mine}.png`))) return; // その写真を撮らない走り（本物の claude の走り）では並べない
      const b = readFileSync(join(shots, `${mine}.png`)).toString("base64");
      const both = await cdpOpen("about:blank");
      await both.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false });
      await both.ev(`document.body.style.cssText = 'margin:0;display:flex;gap:24px;align-items:flex-start;padding:16px;background:#888;font:14px sans-serif'; document.body.innerHTML = '<div><div>dm-ui.html の絵</div><img src="data:image/png;base64,${a}" style="width:${width}px"></div><div><div>今の画面（bar の /panel・幅 460）</div><img src="data:image/png;base64,${b}" style="width:${width}px"></div>'`);
      await Bun.sleep(500);
      await both.shot(out, { x: 0, y: 0, width: 1100, height: 1000 });
      both.close();
    };
    await sbs("#a .app", "03-next3", "side-by-side", "wire-dm-ui");
    await sbs(".app.listonly", "12-list-narrow", "side-by-side-list", "wire-list", 390);
    await sbs("#b .kinds .kind:nth-child(4)", "10-ask", "side-by-side-ask", "wire-ask", 400);
    await sbs("#b .kinds .kind:nth-child(3)", "11-progress", "side-by-side-progress", "wire-progress", 400);
    wp.close();
  }
  // 本物の claude を使った走りは、答えた model を claude の session 記録（jsonl の "model"）で数える
  if (real) {
    const proj = join(homedir(), ".claude/projects");
    const mine = existsSync(proj) ? (await import("node:fs")).readdirSync(proj).filter((n) => n.includes(D.split("/").pop()!)) : [];
    const models = new Map<string, number>();
    for (const d of mine) for (const f of (await import("node:fs")).readdirSync(join(proj, d)).filter((x) => x.endsWith(".jsonl"))) for (const m of readFileSync(join(proj, d, f), "utf8").matchAll(/"model":"([^"]+)"/g)) models.set(m[1]!, (models.get(m[1]!) ?? 0) + 1);
    say(`答えた model（claude の session 記録 ${mine.length} 件の jsonl・env ANTHROPIC_MODEL=${process.env.ANTHROPIC_MODEL ?? "(無し)"}）: ${JSON.stringify([...models])}`);
    check("答えた model が claude-sonnet-5-5 だけ", models.size > 0 && [...models.keys()].every((k) => k === "claude-sonnet-5-5"), JSON.stringify([...models]));
  }
  page.close();
}

try {
  await main();
} catch (e) {
  fails.push(`例外: ${String((e as Error)?.stack ?? e)}`);
  console.log(String((e as Error)?.stack ?? e));
}
await cleanup();
if (fw) {
  const out = await new Response(fw.stdout).text(); // 時間が来て自分で終わるまで待つ（区間を切らない）
  console.log("--- front-watch 全文（何かを起こす前〜後始末の後まで・切っていない）---\n" + out.trim());
  const j = judgeFront(out, { paths: [D] });
  console.log(`前面: ${j.detail}`);
  if (!j.ok) fails.push("我々の前面が出た");
}
console.log(fails.length ? `\nFAIL ${fails.length}: ${fails.join(" / ")}` : `\n全部 PASS（${real ? "本物の claude" : "偽の claude"}）`);
process.exit(fails.length ? 1 : 0);
