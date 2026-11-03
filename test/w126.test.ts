// W126: 強制終了（SIGKILL）を「安全の確認で止められた」と言わない。印が無く、しばらく動いた後の SIGKILL は「強制終了されました」。
// 実機（SIGKILL を送って文を見る）は未測。読む file を literal で名指す: "bar/main.swift"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

function stopNoteFn(swift: string) {
  const i = swift.indexOf("func stopNote(");
  const j = swift.indexOf("\n}\n", i);
  return swift.slice(i, j);
}

test("W126 AC2: stopNote は ranFor を受け取り、印か（SIGKILL かつ 5 秒未満）だけ今の安全の確認の文", () => {
  const fn = stopNoteFn(code(read("bar/main.swift")));
  expect(fn).toContain("ranFor: TimeInterval");
  expect(fn).toContain("quarantined || (signal == SIGKILL && ranFor < 5)");
  expect(fn).toContain("xattr -dr com.apple.quarantine");
  expect(fn).toContain("macOS の安全の確認で止められたようです");
});

test("W126 AC2: それ以外の SIGKILL は「強制終了されました」で、xattr を勧めない", () => {
  const fn = stopNoteFn(code(read("bar/main.swift")));
  const tail = fn.slice(fn.indexOf("ranFor < 5"));
  const rest = tail.slice(tail.indexOf("\n    }\n") + 1); // 安全の確認の枝を閉じた後
  expect(rest).toContain("強制終了されました");
  expect(rest).toContain("「考」のメニューで「全部終わる」→ 開き直す");
  expect(rest).not.toContain("xattr");
  expect(fn).toContain("/AppTranslocation/"); // 置き場所の文は今のまま
  expect(fn).toContain("Finder で「アプリケーション」フォルダへ移してから");
});

test("W126 AC1: 呼び出しは起こした時刻を持ち、終わった時に差を渡す", () => {
  const swift = code(read("bar/main.swift"));
  const at = swift.indexOf("p.terminationHandler");
  const handler = swift.slice(at, swift.indexOf("try? p.run()", at));
  expect(swift.slice(0, at)).toContain("let started = Date()");
  expect(handler).toContain("ranFor: Date().timeIntervalSince(started)");
});
