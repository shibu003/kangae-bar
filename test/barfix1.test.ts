// barfix-1: EXP-1 再走で bar が起動 24 秒後に落ちた（NSWindow を URLSession の背景 thread で触った・Badge.set ← LeaseLink.listen）。swift は回さず、source の形で守る（実機の再起動は computer use）
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const swift = (f: string) => readFileSync(join(import.meta.dir, "../bar", f), "utf8");

test("LeaseLink.listen: receive の callback の中身は全部 main に戻す（窓・pids に背景 thread で触らない）", () => {
  const s = swift("Lease.swift");
  const body = s.slice(s.indexOf("t.receive { [weak self] r in"), s.indexOf("// 人の今（W11d）"));
  expect(body).toMatch(/t\.receive \{ \[weak self\] r in\s+DispatchQueue\.main\.async \{/);
  for (const touch of ["self.app.badge?.set(", "self.pids =", "self.retry()", "self.list()", "self.unread()"]) {
    expect(body.indexOf(touch), touch).toBeGreaterThan(body.indexOf("DispatchQueue.main.async {")); // main.async の中にだけある
  }
});

test("Badge.set は main でなければ main に戻して呼び直す（呼ぶ側が背景でも落ちない）", () => {
  const s = swift("Badge.swift");
  expect(s).toMatch(/func set\(_ n: Int, _ ids: \[Int\]\) \{\s+guard Thread\.isMainThread else \{ return DispatchQueue\.main\.async \{ self\.set\(n, ids\) \} \}/);
});

test("assertMain は DEBUG の build だけで効く（本番では何もしない）・窓に触る入口（Badge.set / show / say / tell）に在る", () => {
  const b = swift("Badge.swift");
  expect(b).toMatch(/func assertMain\(\) \{\s+#if DEBUG\s+dispatchPrecondition\(condition: \.onQueue\(\.main\)\)\s+#endif\s+\}/);
  for (const [f, sig] of [["Badge.swift", "func set(_ n: Int, _ ids: [Int]) {"], ["main.swift", "func show() {"], ["main.swift", "func say(_ s: String) {"], ["Region.swift", "func tell(_ s: String) {"]] as const) {
    const s = swift(f), i = s.indexOf(sig);
    expect(i, `${f}: ${sig}`).toBeGreaterThan(-1);
    expect(s.slice(i, i + 300), `${f}: ${sig}`).toContain("assertMain()");
  }
  expect(readFileSync(join(import.meta.dir, "../bar/build.sh"), "utf8")).not.toContain("DEBUG"); // 配る build に DEBUG を入れない
});

test("背景 thread で動く callback（URLSession / Process / DispatchQueue.global）が窓・view に触る所は main.async の中だけ（全 bar/*.swift）", () => {
  // 既知の背景 callback の入口が、窓に触る前に main へ戻している事を file:行の代わりに形で見る
  const m = swift("main.swift");
  expect(m).toMatch(/URLSession\.shared\.dataTask\(with: req\) \{ _, r, _ in\s+DispatchQueue\.main\.async \{/);
  expect(m).toMatch(/DispatchQueue\.main\.async \{ self\.daemonStop = s; self\.say\(s\) \}/); // terminationHandler
  const r = swift("Region.swift");
  expect(r).toContain("DispatchQueue.main.async { self.tell(m) }");
  expect(r).toContain("DispatchQueue.main.async { self.tell(\"会話に貼れませんでした\") }");
  const l = swift("Lease.swift");
  expect(l).toContain("DispatchQueue.main.async { done(nil) }");
  expect(l).toContain("DispatchQueue.main.async { done(j) }");
});

// barfix-2: Pointer（指す）の共有状態。main が書き q が読む gen / done、q が書き main が読む木は、錠の中の 1 か所だけ
test("Pointer: gen / done / tree は錠（NSLock）の中でだけ読み書きし、木の 4 つ（key・els・win・name）は 1 度に書く", () => {
  const s = swift("Point.swift");
  expect(s).toContain("private let lock = NSLock()");
  expect(s).toMatch(/var gen: Int \{ get \{ locked \{ _gen \} \} set \{ locked \{ _gen = newValue \} \} \}/);
  expect(s).toMatch(/var done: Bool \{ get \{ locked \{ _done \} \} set \{ locked \{ _done = newValue \} \} \}/);
  expect(s).toMatch(/var tree: Tree \{ get \{ locked \{ _tree \} \} set \{ locked \{ _tree = newValue \} \} \}/);
  expect(s).toMatch(/tree = Tree\(key: tk, els: .*?, win: w, name: winName\)/); // 4 つ 1 度に
  for (const old of ["var treeKey", "var win0", "var done = false", "var gen = 0", "treeKey = tk", "win0 = winName", "me.win\n"]) expect(s.includes(old), old).toBe(false); // 錠の外の素の var を戻さない
  expect(/^    var (els|win)\b/m.test(s)).toBe(false); // class の直下の素の els / win（Tree の中の欄は 8 桁目から）
  expect(s).toContain("let t = tree"); // context（main）は写しで読む
  expect(s).toContain("let w = me.tree.win"); // 指した窓の渡しも写しで
});
