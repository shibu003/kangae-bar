// holes-27 の実機試験（画面に窓が 3 秒出る・CEO の実験の間は回さない＝runner に保留）。
// 使い方: bun test/holes27.e2e.ts   — 非 activating の小窓を出す app を起こし、新しい見張りが +win で記録し・旧い見張りは 0 件なのを確かめる。
import { mktmp } from "./tmp.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeWins } from "./front-judge.ts";

const D = mktmp("holes27");
const sh = (c: string[]) => Bun.spawnSync(c, { stderr: "pipe" });
const root = join(import.meta.dir, "..");
writeFileSync(join(D, "win.swift"), `import AppKit
let a = NSApplication.shared; a.setActivationPolicy(.accessory)
let w = NSPanel(contentRect: NSRect(x: 200, y: 200, width: 300, height: 120), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
w.level = .floating; w.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + 3) { exit(0) }
a.run()
`);
const oldSrc = sh(["git", "-C", root, "show", "481f022:tools/front-watch.swift"]).stdout.toString();
writeFileSync(join(D, "old.swift"), oldSrc);
for (const [src, out] of [[join(root, "tools/front-watch.swift"), "new"], [join(D, "old.swift"), "old"], [join(D, "win.swift"), "win"]] as const) {
  const r = sh(["swiftc", "-O", src, "-o", join(D, out)]);
  if (r.exitCode !== 0) { console.log("FAIL swiftc " + out + "\n" + r.stderr); process.exit(1); }
}
const run = async (bin: string) => {
  const w = Bun.spawn([join(D, bin), "6"], { stdout: "pipe" });
  await Bun.sleep(1500);
  Bun.spawn([join(D, "win")]);
  return await new Response(w.stdout).text();
};
const [newOut, oldOut] = [await run("new"), await run("old")];
const nw = judgeWins(newOut), ow = judgeWins(oldOut);
const check = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n} ${d}`); if (!ok) process.exitCode = 1; };
check("新しい見張りは非 activating の窓を +win で記録する", !nw.ok, nw.detail);
check("負の対照: 旧い見張りは同じ窓を 0 件のまま（見逃す）", ow.ok && /前面が変わった回数=0/.test(oldOut), oldOut.trim().split("\n").pop());
// ponytail: Gatekeeper の dialog（印つきの小さな .app）は未測。CEO の画面に dialog が出るので operator の許可を待つ
