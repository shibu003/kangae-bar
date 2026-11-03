// 丸い icon + 右上の赤い数字（W15）。agent の仕事が終わった（まだ見ていない報告がある）時だけ画面の隅に出し、押すと報告の窓を開く。1 件ならその会話、2 件以上なら「あなたの番です」の一覧（W98）。
// 数は常駐の op "unread" が持つ（Lease.swift の LeaseLink が問い合わせて set に渡す）。見る = panel が agentRead → 常駐が roots を知らせる → 数が減る。
// 前面もキーの先も取らない: 非 activating の panel・canBecomeKey/Main false・orderFrontRegardless（activate はしない）。full screen の Space の上にも出る。
// 出さない: ~/.kangae/bar.conf に icon=off の 1 行。
import Cocoa
import WebKit

// 窓・view に触る関数の頭に置く。DEBUG の build（swiftc -D DEBUG）だけで main 以外なら止める＝落ちる前に気付く。本番（-O・DEBUG 無し）では何もしない
@inline(__always) func assertMain() {
    #if DEBUG
    dispatchPrecondition(condition: .onQueue(.main))
    #endif
}

final class BadgePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class BadgeView: NSView {
    var n = 0 { didSet { needsDisplay = true; setAccessibilityLabel("報告 \(n) 件"); toolTip = n > 0 ? "終わった報告が \(n) 件あります（押すと開きます）" : nil } }
    var onClick: (() -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) { if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?() } }
    override func draw(_ r: NSRect) {
        let disc = NSRect(x: 4, y: 4, width: 44, height: 44)
        NSColor(white: 0.12, alpha: 0.92).setFill()
        NSBezierPath(ovalIn: disc).fill()
        let k = NSAttributedString(string: "考", attributes: [.font: NSFont.systemFont(ofSize: 22, weight: .medium), .foregroundColor: NSColor.white])
        k.draw(at: NSPoint(x: disc.midX - k.size().width / 2, y: disc.midY - k.size().height / 2))
        guard n > 0 else { return }
        let t = NSAttributedString(string: n > 99 ? "99+" : "\(n)", attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .bold), .foregroundColor: NSColor.white])
        let w = max(24, t.size().width + 12)
        let dot = NSRect(x: bounds.maxX - w, y: bounds.maxY - 24, width: w, height: 24)
        NSColor.systemRed.setFill()
        let p = NSBezierPath(roundedRect: dot, xRadius: 12, yRadius: 12)
        p.fill()
        NSColor.white.setStroke(); p.lineWidth = 1.5; p.stroke()
        t.draw(at: NSPoint(x: dot.midX - t.size().width / 2, y: dot.midY - t.size().height / 2))
    }
}

final class Badge {
    let panel = BadgePanel(contentRect: NSRect(x: 0, y: 0, width: 72, height: 56), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    let view = BadgeView(frame: NSRect(x: 0, y: 0, width: 72, height: 56))
    var rootIds: [Int] = []

    init(open: @escaping (Int?) -> Void, list: @escaping () -> Void) {
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentView = view
        view.onClick = { [unowned self] in
            if self.rootIds.count >= 2 {
                list() // 2 件以上: 一覧を「あなたの番です」で開く（読む前に印を付ける）
                open(nil) // 会話は開かない。Bar を出す
            } else {
                open(self.rootIds.first) // 1 件: その会話
            }
        }
    }

    // 常駐の unread の返事。0 なら消す・あれば右上の隅（メニューバーの下）に出す
    func set(_ n: Int, _ ids: [Int]) {
        guard Thread.isMainThread else { return DispatchQueue.main.async { self.set(n, ids) } } // 窓（NSPanel）は main だけ。呼ぶ側が背景 thread でも落ちない（本番）
        assertMain()
        rootIds = ids
        view.n = n
        if let f = ProcessInfo.processInfo.environment["KANGAE_BAR_BADGE_PNG"], n > 0, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) { // 試験用: 画面に出さず絵だけ撮る
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: f))
        }
        guard n > 0 else { return panel.orderOut(nil) }
        if offscreen { panel.setFrameOrigin(NSPoint(x: -20000, y: -20000)) }
        else if let s = NSScreen.screens.first?.visibleFrame { panel.setFrameOrigin(NSPoint(x: s.maxX - 72 - 8, y: s.maxY - 56 - 8)) }
        panel.orderFrontRegardless() // 前に並べるだけ。app は activate しない
    }
}

extension App {
    func installBadge() {
        if let c = try? String(contentsOfFile: confPath, encoding: .utf8), c.split(separator: "\n").contains(where: { $0.trimmingCharacters(in: .whitespaces).lowercased() == "icon=off" }) { return }
        badge = Badge(open: { [unowned self] root in
            self.openRoot = root // panel が最初に開く会話（開くと agentRead で既読）。nil は会話を指定しない
            if !self.panel.isVisible { self.show() }
        }, list: { [unowned self] in
            self.askTurnList()
        })
    }

    // 一覧を「あなたの番です」で開く。既に読んでいる panel には JS。まだ無い時は読み込みの user script が拾う印（listTurn）
    func askTurnList() {
        if let w = web {
            w.evaluateJavaScript("window.__kangaeList='turn';window.kangaeOpenList?.('turn')", completionHandler: nil)
        } else {
            listTurn = true
        }
    }
}
