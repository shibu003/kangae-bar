import { afterAll, setDefaultTimeout } from "bun:test";
// bun test の preload: 試験は owner の置き場（home・nodes・mods・Chrome・bar）を使わない。無い・owner を指す値を temp に置き換える
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { reapTestChromes } from "../src/headless.ts";
import { scrubOwnerEnv } from "../src/paths.ts";
import { testTimeoutMs } from "../tools/test-timeout.ts";
// tmpleak-1: 試験の temp は全部この 1 本の folder（名前は短く: unix socket の path は 104 字までで、深くすると socket を張る試験が壊れる＝実測 w8g5）の下に作り、process が終わる時に丸ごと消す（個々の test の mkdtemp に消し忘れがあっても $TMPDIR に積もらない・suite 1 回で 36,000 件 / 600MB 残った）。
// os.tmpdir() は env TMPDIR を毎回読む＝以降の mkdtemp(tmpdir()) と、子 process（TMPDIR を継ぐ）の temp も入る。SIGKILL・時間切れで afterAll が走らなかった分は tools/clean-tmp.ts（prefix kt + 6 字）
{
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(parent, "kt")));
  process.env.TMPDIR = root;
  // preload の afterAll は run 全体の終わりに 1 回だけ走る（実測: 3 file で beforeAll / afterAll 各 1 回）。process.on("exit") は bun test では走らない（実測）
  afterAll(() => { if (/^kt[A-Za-z0-9]{6}$/.test(basename(root)) && dirname(root) === parent) rmSync(root, { recursive: true, force: true }); });
}
scrubOwnerEnv();
reapTestChromes(); // leak1: 前の試験が SIGKILL・timeout で残した headless Chrome（親が launchd・印は一時 home）をこの run の頭で刈る
// 1 本あたりの締切。bunfig.toml の [test] timeout は bun 1.3.14 では読まれず（実測: 30000 と書いても 5 秒で落ちた）、preload の setDefaultTimeout は最初の 1 file にだけ効く（review14 実測: bare の `bun test a b` で b は 5 秒で落ち、単独の `bun test b` は通る）。まとめて回すのは suite.ts / affected.ts の --timeout 30000。
// 子 process を起こす試験が混雑（load 400）で 5 秒を越えて偽の赤になる。速さを測る試験は中で自分の締切を持つ
setDefaultTimeout(testTimeoutMs()); // 30 秒 × load の倍率（tools/test-timeout.ts）
