// カーソルで「指す」（W2c）。カーソルの下の窓 → その窓の AX の木から点を含む一番小さい要素 → Tab / ⇧Tab で親子。
// Driver に「点 → 要素」の tool は無いので、list_windows の bounds と get_window_state の frame の突き合わせは我々がやる。
// Driver は 1 本の名前付き session（Cua）を指している間だけ持つ。重い call は専用の直列 queue（bar は固まらない）。
import Cocoa
import Carbon.HIToolbox

struct Pick {
    var rect: CGRect // 左上原点の pt（Driver と同じ）
    var name: String
}

final class PointView: NSView {
    var hl: NSRect? // AppKit 座標
    var label = ""
    var moved: ((NSPoint) -> Void)!
    var pressed: (() -> Void)!
    override var acceptsFirstResponder: Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
    override func updateTrackingAreas() {
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeAlways, .inVisibleRect], owner: self))
    }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true } // 前面を奪わない panel の最初の押しも受ける
    override func mouseMoved(with e: NSEvent) { moved(NSEvent.mouseLocation) }
    override func mouseDown(with e: NSEvent) { pressed() }
    override func draw(_ dirty: NSRect) {
        NSColor.black.withAlphaComponent(0.01).setFill() // ほぼ透明。0 だと押しが下の app へ抜ける
        bounds.fill()
        if let r = hl {
            NSColor.systemBlue.withAlphaComponent(0.18).setFill()
            r.fill()
            NSColor.systemBlue.setStroke()
            let p = NSBezierPath(rect: r)
            p.lineWidth = 3
            p.stroke()
        }
        guard !label.isEmpty else { return }
        let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: NSColor.white]
        let sz = (label as NSString).size(withAttributes: a)
        let pad: CGFloat = 8
        let base = hl ?? NSRect(x: 40, y: 40, width: 0, height: 0)
        var box = NSRect(x: base.minX, y: base.maxY + 4, width: sz.width + pad * 2, height: sz.height + 6)
        if box.maxY > bounds.height - 26 { box.origin = NSPoint(x: base.minX + 6, y: min(base.maxY, bounds.height - 26) - box.height - 6) } // 上（menu bar の下）に出られなければ rect の中の左上（下は Dock に隠れる）
        box.origin.x = min(box.origin.x, bounds.width - box.width)
        NSColor.black.withAlphaComponent(0.8).setFill()
        NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6).fill()
        (label as NSString).draw(at: NSPoint(x: box.minX + pad, y: box.minY + 3), withAttributes: a)
    }
}

final class Pointer {
    let q = DispatchQueue(label: "kangae.point") // Driver の call は全部ここ（1 本ずつ）
    var cua: Cua?
    // 共有状態（barfix-2）: 画面（main）と Driver の取得（q）の両方から触る物は、錠の中の 1 か所に置く。
    // gen / done = main が書き q が読む（古い取得結果を捨てる・終わった後は何もしない）。tree = q が丸ごと書き main が読む（取ってある木。4 つを別々に書くと、読む側が半端な組を見る）
    struct Tree { var key = ""; var els: [[String: Any]] = []; var win: [String: Any] = [:]; var name = "" }
    private let lock = NSLock()
    private var _gen = 0, _done = false, _tree = Tree()
    private func locked<T>(_ f: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return f() }
    var gen: Int { get { locked { _gen } } set { locked { _gen = newValue } } } // 最後に動いた時の番号。古い取得結果は捨てる
    var done: Bool { get { locked { _done } } set { locked { _done = newValue } } }
    var tree: Tree { get { locked { _tree } } set { locked { _tree = newValue } } }
    var chain: [Pick] = []
    var idx = 0
    var key = ""
    var veil: Veil!
    var view: PointView!
    var refs: [EventHotKeyRef?] = []
    let finished: (Pick?, Pointer) -> Void
    let H = NSScreen.screens.first?.frame.height ?? 0
    var item: DispatchWorkItem?
    var frontObs: NSObjectProtocol?
    var idle: DispatchWorkItem?

    init(_ finished: @escaping (Pick?, Pointer) -> Void) { self.finished = finished }

    func start() {
        guard let sc = NSScreen.screens.first else { return }
        veil = Veil(contentRect: sc.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        veil.level = NSWindow.Level(rawValue: 2) // 他の app の窓の上・bar（.floating = 3）の下。取得中も bar を触れる
        veil.isOpaque = false; veil.backgroundColor = .clear; veil.hasShadow = false
        veil.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        veil.acceptsMouseMovedEvents = true
        view = PointView(frame: NSRect(origin: .zero, size: sc.frame.size))
        view.moved = { [unowned self] p in self.move(p) }
        view.pressed = { [unowned self] in if !self.chain.isEmpty { self.finish(self.chain[self.idx]) } }
        view.label = "指す: カーソルを物に合わせる ・ 押して決める ・ Tab 広げる ・ ⇧Tab 戻す ・ Esc やめる"
        veil.contentView = view
        veil.setFrame(sc.frame, display: true)
        veil.orderFrontRegardless()
        refs = [escArm { [unowned self] in self.finish(nil) },
                hotArm(UInt32(kVK_Tab), 0, 2) { [unowned self] in self.climb(1) },
                hotArm(UInt32(kVK_Tab), UInt32(shiftKey), 3) { [unowned self] in self.climb(-1) }]
        move(NSEvent.mouseLocation)
        // 不変条件 I-4: 機械全体の鍵（Esc / Tab）を握ったままにしない。
        // 人が別の app を前に出したら、また 60 秒何も起きなければ、指すのをやめて返す
        let front0 = NSWorkspace.shared.frontmostApplication?.processIdentifier
        frontObs = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] n in
            let pid = (n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            guard pid != front0, pid != getpid() else { return } // 同じ app の再活性と自分は無視
            self?.finish(nil) // 人が別の app に移った＝指すのをやめて、Esc / Tab を返す
        }
        idle = DispatchWorkItem { [weak self] in self?.finish(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: idle!)
    }

    func stop() {
        if let o = frontObs { NSWorkspace.shared.notificationCenter.removeObserver(o); frontObs = nil }
        idle?.cancel(); idle = nil
        refs.forEach { if let r = $0 { UnregisterEventHotKey(r) } }
        hotFns[2] = nil; hotFns[3] = nil
        veil?.orderOut(nil)
    }

    func finish(_ p: Pick?) {
        guard !done else { return }
        done = true
        item?.cancel()
        stop()
        finished(p, self)
    }

    func climb(_ d: Int) {
        guard !chain.isEmpty else { return }
        idx = max(0, min(chain.count - 1, idx + d))
        show()
    }

    func show() {
        guard idx < chain.count else { return }
        let p = chain[idx]
        view.hl = NSRect(x: p.rect.minX, y: H - p.rect.maxY, width: p.rect.width, height: p.rect.height)
        view.label = p.name + (chain.count > 1 ? "   （Tab 広げる \(idx + 1)/\(chain.count)）" : "")
        view.needsDisplay = true
    }

    func move(_ mouse: NSPoint) {
        gen += 1
        let g = gen
        let pt = CGPoint(x: mouse.x, y: H - mouse.y)
        item?.cancel()
        let w = DispatchWorkItem { [unowned self] in self.q.async { self.resolve(pt, g) } }
        item = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: w) // 動き続けている間は Driver を打たない
    }

    func resolve(_ pt: CGPoint, _ g: Int) {
        guard g == gen, !done else { return }
        if cua == nil { cua = Cua() }
        guard let cua = cua else { return say("画面を読む準備ができていません") }
        let me = Int(getpid())
        guard let ws = cua.call("list_windows", ["on_screen_only": true])?["windows"] as? [[String: Any]] else { return say("窓の一覧を読めませんでした") }
        func box(_ w: [String: Any]) -> CGRect? {
            guard let b = w["bounds"] as? [String: Double] else { return nil }
            return CGRect(x: b["x"] ?? 0, y: b["y"] ?? 0, width: b["width"] ?? 0, height: b["height"] ?? 0)
        }
        // 点を含む一番手前の窓。自分（bar）と Driver の overlay（layer ≠ 0）は除く
        let hit = ws.filter { ($0["pid"] as? Int) != me && ($0["layer"] as? Int ?? 0) == 0 && ($0["app_name"] as? String) != "Cua Driver" && (box($0)?.contains(pt) ?? false) }
            .max { ($0["z_index"] as? Int ?? -1) < ($1["z_index"] as? Int ?? -1) }
        guard let w = hit, let wb = box(w), let wid = w["window_id"] as? Int, let pid = w["pid"] as? Int else {
            return main { self.chain = []; self.view.hl = nil; self.view.label = "ここには窓がありません"; self.view.needsDisplay = true }
        }
        let app = w["app_name"] as? String ?? "?", title = w["title"] as? String ?? ""
        let tk = "\(pid):\(wid)"
        let winName = title.isEmpty ? app : "\(app) / \(title)"
        if tk != tree.key {
            main { self.chain = [Pick(rect: wb, name: winName)]; self.idx = 0; self.show(); self.view.label = "\(winName) を読んでいます…" } // 待っている事を画面の文字で出す
            // 実測: max_elements 400 / max_depth 40 まで広げないと menu で埋まる
            let s = cua.call("get_window_state", ["pid": pid, "window_id": wid, "include_screenshot": false, "max_depth": 40, "max_elements": 400, "timeout_ms": 4000])
            tree = Tree(key: tk, els: s?["elements"] as? [[String: Any]] ?? [], win: w, name: winName) // 4 つ 1 度に（読む側が半端な組を見ない）
            guard g == gen else { return } // 古い。後から来た move が（取ってある木で）引き直す
        }
        func fr(_ e: [String: Any]) -> CGRect? {
            guard let f = e["frame"] as? [String: Double] else { return nil }
            return CGRect(x: f["x"] ?? 0, y: f["y"] ?? 0, width: f["w"] ?? 0, height: f["h"] ?? 0)
        }
        let els = tree.els // この先は取ってある木の写しで読む
        let cand = els.filter { e in
            guard let f = fr(e), f.width > 0, f.height > 0, !(e["role"] as? String ?? "").hasPrefix("AXMenu") else { return false }
            return f.contains(pt)
        }
        var next: [Pick] = []
        if var e = cand.min(by: { (fr($0)!.width * fr($0)!.height) < (fr($1)!.width * fr($1)!.height) }) {
            let byIdx = Dictionary(els.compactMap { x in (x["element_index"] as? Int).map { ($0, x) } }) { a, _ in a }
            while true {
                if let f = fr(e), f.width > 0, f.height > 0 { next.append(Pick(rect: f, name: describe(e, winName))) }
                guard let p = e["parent_index"] as? Int, let pe = byIdx[p] else { break }
                e = pe
            }
        }
        if next.isEmpty || next.last!.rect != wb { next.append(Pick(rect: wb, name: winName)) } // 最後は窓ぜんたい
        let k = "\(tk):\(next.first!.rect)"
        main { if self.key != k { self.key = k; self.idx = 0 }; self.chain = next; self.idx = min(self.idx, next.count - 1); self.show() }
    }

    func describe(_ e: [String: Any], _ winName: String) -> String {
        let role = (e["role"] as? String ?? "").replacingOccurrences(of: "AX", with: "")
        let l = (e["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (e["value"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(40)) }
        return role == "Window" ? winName : (l.map { "\(role)「\(String($0.prefix(40)))」" } ?? role) + " ・ \(winName)"
    }

    func main(_ f: @escaping () -> Void) { DispatchQueue.main.async { if !self.done { f() } } }
    func say(_ s: String) { main { self.view.label = s; self.view.needsDisplay = true } }

    // 決まった物の文脈（app・窓の題・要素の名前と役割・その中の文字）
    func context(_ p: Pick) -> String {
        let t = tree // main が読む。q が書き換え中でも半端な組を見ない
        var lines = ["指した物: \(p.name)", "窓: \(t.name)", String(format: "範囲: x=%.0f y=%.0f w=%.0f h=%.0f（画面の pt）", p.rect.minX, p.rect.minY, p.rect.width, p.rect.height)]
        var seen = Set<String>(), texts: [String] = []
        // 指した物「の中」だけ。重なっただけの隣の部品を混ぜない（operator の実測: Button「=」に 3 . + が混ざった）
        let box = p.rect.insetBy(dx: -2, dy: -2)
        for e in t.els {
            guard !(e["role"] as? String ?? "").hasPrefix("AXMenu"), let f = e["frame"] as? [String: Double] else { continue }
            let r = CGRect(x: f["x"] ?? 0, y: f["y"] ?? 0, width: f["w"] ?? 0, height: f["h"] ?? 0)
            guard box.contains(r) else { continue }
            for k in ["label", "value"] {
                guard let t = (e[k] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { continue }
                guard !t.hasPrefix("_NS:"), !t.hasPrefix("AX") else { continue } // AppKit の内部の識別子（operator の実測: _NS:436）
                if seen.insert(t).inserted { texts.append(String(t.prefix(300))) }
            }
        }
        if !texts.isEmpty { lines.append("指した物の中の文字:\n" + texts.prefix(60).joined(separator: "\n")) }
        return lines.joined(separator: "\n")
    }
}

extension App {
    @objc func point() { startPoint(give: false) }
    @objc func pointGive() { startPoint(give: true) }

    // give = 指した窓を、見ている会話の agent に渡す（W2d）。絵は撮らず、窓の識別子（pid + window_id）だけを常駐の束縛表へ
    func startPoint(give: Bool) {
        guard Cua.path() != nil else { return self.tell("画面を読む準備ができていません") }
        guard pointer == nil else { return }
        let p = Pointer { [unowned self] pick, me in
            self.pointer = nil
            guard let pick = pick else { // Esc: 何も貼らない
                me.q.async { me.cua?.close() }
                return
            }
            if give {
                let w = me.tree.win
                me.q.async { me.cua?.close() }
                guard let pid = w["pid"] as? Int, let wid = w["window_id"] as? Int else { return self.tell("窓が分かりません") }
                let app = w["app_name"] as? String ?? "", title = w["title"] as? String ?? ""
                let send = { (root: Int?) in
                    var msg: [String: Any] = ["op": "leaseGive", "pid": pid, "windowId": wid, "app": app, "title": title]
                    if let r = root { msg["rootId"] = r }
                    self.daemon(msg) { j in
                        guard j?["ok"] as? Bool == true else { return self.tell((j?["hint"] as? String) ?? "渡せませんでした") }
                        self.tell("渡した: \(app)")
                        if !self.panel.isVisible { self.show() }
                    }
                }
                if let w = self.web { w.evaluateJavaScript("window.kangaeRoot") { v, _ in send((v as? NSNumber)?.intValue) } } else { send(nil) }
                return
            }
            self.tell("指した: \(pick.name)")
            let ctx = me.context(pick)
            let h = NSScreen.screens.first?.frame.height ?? 0
            let r = NSRect(x: pick.rect.minX, y: h - pick.rect.maxY, width: pick.rect.width, height: pick.rect.height)
            let hideBar = self.panel.isVisible && self.panel.frame.intersects(r) // bar が絵に写らないよう撮る間だけ隠す
            if hideBar { self.panel.orderOut(nil) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { // overlay が画面から消えてから撮る
                me.q.async { // 指している間の session をそのまま使う（新しく開くと前面を奪われる）
                    let c = me.cua
                    me.cua = nil
                    self.grab(r, nil, cua: c, ctx: ctx) { if hideBar { self.panel.makeKeyAndOrderFront(nil) } }
                }
            }
        }
        pointer = p
        p.start()
    }
}
