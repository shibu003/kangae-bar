// 全 suite の門: bun test の出力に「N pass」「N fail」の行が無ければ exit 0 でも赤（偽の緑を通さない・holes-21）
// 使い方: bun tools/suite.ts [bun test の引数…]
import { testTimeoutMs } from "./test-timeout.ts";
const p = Bun.spawn(["bun", "test", "--timeout", String(testTimeoutMs()), ...process.argv.slice(2)], { stdout: "pipe", stderr: "pipe" });
let out = "";
const pump = async (s: ReadableStream<Uint8Array>, w: (b: Uint8Array) => unknown) => {
  const d = new TextDecoder();
  for await (const c of s) { out += d.decode(c, { stream: true }); w(c); }
};
await Promise.all([pump(p.stdout, (b) => process.stdout.write(b)), pump(p.stderr, (b) => process.stderr.write(b))]);
const rc = await p.exited;
// bun の最後の 3 行（N pass / N fail / Ran N tests across…）が出力の末尾に揃っている時だけ数える。色（FORCE_COLOR）は剥がす・途中の試験が印字した「3 pass」では通らない
export const counted = (t: string) => /^\s*\d+ pass\s*\n(?:[^\n]*\n)*?\s*\d+ fail\s*\n(?:\s*\d+ (?:expect\(\) calls|errors?)\s*\n)*Ran \d+ tests? across \d+ files?\.[^\n]*\s*$/m.test(t.replace(/\x1b\[[0-9;]*m/g, "").slice(-400));
if (rc === 0 && !counted(out)) {
  console.error("suite: exit 0 だが「N pass / N fail」の行が無い＝途中で黙って終わった。赤として扱う");
  process.exit(1);
}
process.exit(rc);
