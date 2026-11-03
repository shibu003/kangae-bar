// bar のガラス。macOS 26 は OS の NSGlassEffectView を名前で引いて使い（rio-window の glass.rs と同じ形・この Mac の SDK には型が無いので KVC）、
// 引けなければ macOS 14 の層（NSVisualEffectView + Sheen）。26 では Sheen を重ねない（OS のガラスと二重になる）。
import Cocoa

// Liquid Glass の見え方 = 縁の屈折光 + 上からの艶。macOS 26 の API はこの OS に無いので層で作る。
// 当たり判定は通す（下の WebView が押せる）。大きさが変わる度に path を引き直す。
final class Sheen: NSView {
    let gloss = CAGradientLayer()   // 上からの艶
    let rim = CAGradientLayer()     // 縁の光（上が強い）
    let mask = CAShapeLayer()
    var radius: CGFloat = 22
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var isFlipped: Bool { true }
    func install() {
        wantsLayer = true
        gloss.colors = [NSColor.white.withAlphaComponent(0.34).cgColor, NSColor.white.withAlphaComponent(0.07).cgColor, NSColor.clear.cgColor]
        gloss.locations = [0, 0.16, 0.5]
        gloss.masksToBounds = true
        rim.colors = [NSColor.white.withAlphaComponent(0.95).cgColor, NSColor.white.withAlphaComponent(0.18).cgColor, NSColor.white.withAlphaComponent(0.55).cgColor]
        rim.locations = [0, 0.45, 1]
        mask.fillColor = NSColor.clear.cgColor
        mask.strokeColor = NSColor.black.cgColor
        mask.lineWidth = 1.6
        rim.mask = mask
        layer?.addSublayer(gloss)
        layer?.addSublayer(rim)
    }
    override func layout() {
        super.layout()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        gloss.frame = bounds; gloss.cornerRadius = radius
        rim.frame = bounds
        mask.frame = bounds
        mask.path = CGPath(roundedRect: bounds.insetBy(dx: 0.8, dy: 0.8), cornerWidth: radius - 0.8, cornerHeight: radius - 0.8, transform: nil)
        CATransaction.commit()
    }
}

struct BarGlass {
    let view: NSView
    let sheen: Sheen?     // 14 の層の時だけ
    let host: NSView?     // 26: ガラスの contentView（WebView はここに入れる）
    var native: Bool { host != nil }

    // WebView を載せる。26 はガラスの中身へ、14 は艶の下へ
    func add(_ v: NSView, in root: NSView) {
        if let h = host { v.frame = h.bounds; h.addSubview(v) } else { root.addSubview(v, positioned: .below, relativeTo: sheen) }
    }
}

func makeBarGlass(bounds: NSRect, radius: CGFloat, lookup: (String) -> AnyClass? = { NSClassFromString($0) }) -> BarGlass {
    if let cls = lookup("NSGlassEffectView") as? NSView.Type {
        let g = cls.init(frame: bounds)
        g.autoresizingMask = [.width, .height]
        let host = NSView(frame: bounds)
        host.autoresizingMask = [.width, .height]
        if g.responds(to: Selector(("setCornerRadius:"))) { g.setValue(radius, forKey: "cornerRadius") }
        if g.responds(to: Selector(("setContentView:"))) { g.setValue(host, forKey: "contentView") } else { g.addSubview(host) }
        return BarGlass(view: g, sheen: nil, host: host)
    }
    let v = NSVisualEffectView(frame: bounds)
    v.material = .sidebar
    v.blendingMode = .behindWindow
    v.state = .active
    v.autoresizingMask = [.width, .height]
    v.wantsLayer = true
    v.layer?.cornerRadius = radius
    v.layer?.masksToBounds = true
    let s = Sheen(frame: bounds)
    s.radius = radius
    s.autoresizingMask = [.width, .height]
    s.install()
    return BarGlass(view: v, sheen: s, host: nil)
}
