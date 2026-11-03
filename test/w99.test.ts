// W99: Bar が非 active でも ○＜ の 1 回目が効く。DragWeb.acceptsFirstMouse は true。panel は nonactivatingPanel のまま。
// 帯（上 16pt）の mouseDown は変えない。実機は未測。build（swiftc / bar/build.sh）はこの file の W99-3。読む file を literal で名指す: "bar/main.swift"
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

function wkBodies(): { file: string; name: string; body: string }[] {
  const out: { file: string; name: string; body: string }[] = [];
  for (const file of readdirSync(join(root, "bar")).filter((n) => n.endsWith(".swift"))) {
    const src = code(readFileSync(join(root, "bar", file), "utf8"));
    const marks = [...src.matchAll(/(?:final\s+)?class\s+(\w+)\s*:\s*WKWebView\b/g)].map((m) => ({ name: m[1]!, i: m.index! }));
    for (let k = 0; k < marks.length; k++) {
      const mark = marks[k]!;
      const rest = src.slice(mark.i + 1);
      const nl = rest.search(/\n(?:final\s+)?class\s+/);
      out.push({ file, name: mark.name, body: src.slice(mark.i, nl < 0 ? src.length : mark.i + 1 + nl) });
    }
  }
  return out;
}

test("W99-1 WKWebView の subclass は acceptsFirstMouse が true。DragWeb の帯は元の mouseDown", () => {
  const bodies = wkBodies();
  expect(bodies.map((b) => `${b.file}:${b.name}`)).toEqual(["main.swift:DragWeb"]);
  for (const b of bodies) {
    expect(b.body).toMatch(/override func acceptsFirstMouse\(for \w+: NSEvent\?\) -> Bool \{ true \}/);
  }
  const drag = bodies[0]!.body;
  expect(drag).toContain("if convert(e.locationInWindow, from: nil).y > bounds.height - dragBand { window?.performDrag(with: e) } else { super.mouseDown(with: e) }");
});

test("W99-2 panel は nonactivatingPanel のまま。becomesKeyOnlyIfNeeded は true", () => {
  const main = code(readFileSync(join(root, "bar/main.swift"), "utf8"));
  expect(main).toMatch(/styleMask:\s*\[\s*\.nonactivatingPanel\b/);
  expect(main).toContain("panel.becomesKeyOnlyIfNeeded = true");
});

test("W99-3 bar の swift が swiftc で通る（w55 の作法。実行 file は /tmp。bar/build.sh は universal なのでここでは走らせない）", () => {
  const SWIFT = ["main.swift", "Glass.swift", "Region.swift", "Point.swift", "Lease.swift", "Front.swift", "Badge.swift"];
  const h = createHash("sha1");
  for (const f of SWIFT) h.update(readFileSync(join(root, "bar", f)));
  const dir = "/tmp/kangae-w99-bar";
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, `KangaeBar-${h.digest("hex").slice(0, 16)}`);
  if (!existsSync(bin)) {
    const tmp = `${bin}.${process.pid}.tmp`;
    const r = Bun.spawnSync(["swiftc", "-Onone", ...SWIFT.map((f) => join(root, "bar", f)), "-o", tmp], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`swiftc: ${r.stderr.toString().slice(-600)}`);
    renameSync(tmp, bin);
  }
  expect(existsSync(bin)).toBe(true);
});
