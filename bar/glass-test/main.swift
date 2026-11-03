// 使い方: swiftc bar/Glass.swift bar/glass-test/main.swift -o /tmp/glass-test && /tmp/glass-test   （BREAK=1 で分岐を壊して赤を見る）
import Cocoa

@objc(FakeGlassEffectView) final class FakeGlass: NSView {
    @objc var cornerRadius: CGFloat = 0
    @objc var contentView: NSView?
}

var bad = 0
func check(_ n: String, _ ok: Bool) { print("\(ok ? "PASS" : "FAIL") \(n)"); if !ok { bad += 1 } }
let r = NSRect(x: 0, y: 0, width: 460, height: 640)
let broken = ProcessInfo.processInfo.environment["BREAK"] != nil

let n = makeBarGlass(bounds: r, radius: 22, lookup: { $0 == "NSGlassEffectView" && !broken ? FakeGlass.self : nil })
check("class が在る → NSGlassEffectView 側を使う", n.view is FakeGlass && n.native)
check("26 では Sheen を重ねない", n.sheen == nil)
check("cornerRadius が 22 で渡る", (n.view as? FakeGlass)?.cornerRadius == 22)
check("contentView に host が入る", n.native && n.host != nil && (n.view as? FakeGlass)?.contentView === n.host)
let w = NSView(frame: .zero); let root = NSView(frame: r)
n.add(w, in: root)
check("WebView はガラスの中身に載る", w.superview === n.host && root.subviews.isEmpty)

let o = makeBarGlass(bounds: r, radius: 22, lookup: { _ in nil })
check("class が無い → 今の 3 層（ぼかし + Sheen）", o.view is NSVisualEffectView && o.sheen != nil && !o.native)
check("この Mac（14）の本物の lookup は NSGlassEffectView を引けない or 引けたら native", (NSClassFromString("NSGlassEffectView") == nil) == !makeBarGlass(bounds: r, radius: 22).native)
exit(bad == 0 ? 0 : 1)
