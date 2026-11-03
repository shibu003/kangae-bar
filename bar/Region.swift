// 画面を囲んで聞く（W2a）。bar は撮らない: 囲むのは透明な overlay だけ、撮る・AX を読むのは cua-driver（mcp を 1 本・名前付き session）。
// 画面収録の許可は cua-driver 側が持つ。bar は CGWindowList / ScreenCaptureKit を一切呼ばない。
import Cocoa
import Carbon.HIToolbox

// ---------- 囲む overlay（描くだけ・下の app にクリックは通さない・前面を奪わない） ----------
final class Veil: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class VeilView: NSView {
    var start: NSPoint?
    var cur: NSPoint?
    var done: ((NSRect?) -> Void)!
    override var acceptsFirstResponder: Bool { true }
    var rect: NSRect? {
        guard let s = start, let c = cur else { return nil }
        return NSRect(x: min(s.x, c.x), y: min(s.y, c.y), width: abs(s.x - c.x), height: abs(s.y - c.y))
    }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
    override func mouseDown(with e: NSEvent) { start = convert(e.locationInWindow, from: nil); cur = start; needsDisplay = true }
    override func mouseDragged(with e: NSEvent) { cur = convert(e.locationInWindow, from: nil); needsDisplay = true }
    override func mouseUp(with e: NSEvent) {
        cur = convert(e.locationInWindow, from: nil)
        guard let r = rect, r.width >= 8, r.height >= 8 else { start = nil; cur = nil; needsDisplay = true; return } // 点だけは取消にしない（やり直せる）
        done(window!.convertToScreen(convert(r, to: nil)))
    }
    override func keyDown(with e: NSEvent) { if e.keyCode == 53 { done(nil) } else { super.keyDown(with: e) } } // Esc
    override func draw(_ dirty: NSRect) {
        NSColor.black.withAlphaComponent(0.25).setFill()
        bounds.fill()
        guard let r = rect else { return }
        NSColor.clear.setFill()
        r.fill(using: .copy)
        NSColor.systemBlue.setStroke()
        let p = NSBezierPath(rect: r)
        p.lineWidth = 2
        p.stroke()
    }
}

// 前面を奪わないので Esc は前面の app に届く。囲んでいる間だけ Esc を Carbon の hotkey で受ける（許可は要らない）
var hotFns: [UInt32: () -> Void] = [:] // id → 押された時の処理（Esc は 1・指す時の Tab は 2・⇧Tab は 3）
var escHandler: EventHandlerRef?
func escArm(_ cancel: @escaping () -> Void) -> EventHotKeyRef? { hotArm(UInt32(kVK_Escape), 0, 1, cancel) }
func hotArm(_ code: UInt32, _ mods: UInt32, _ id: UInt32, _ fn: @escaping () -> Void) -> EventHotKeyRef? {
    hotFns[id] = fn
    if escHandler == nil {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, ev, _ in
            var id = EventHotKeyID()
            GetEventParameter(ev, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard id.signature == 0x45534331 else { return OSStatus(eventNotHandledErr) } // 後から入れた handler が先に呼ばれる。⌥Space は main.swift の方へ流す
            hotFns[id.id]?()
            return noErr
        }, 1, &spec, nil, &escHandler)
    }
    var ref: EventHotKeyRef?
    RegisterEventHotKey(code, mods, EventHotKeyID(signature: 0x45534331, id: id), GetApplicationEventTarget(), 0, &ref)
    return ref
}

// ---------- cua-driver mcp（1 本の接続・名前付き session。1 回ずつ call を打つと前面を奪われる） ----------
final class Cua {
    static func path() -> String? {
        let h = NSHomeDirectory()
        return [h + "/.local/bin/cua-driver", "/usr/local/bin/cua-driver", "/opt/homebrew/bin/cua-driver", "/Applications/CuaDriver.app/Contents/MacOS/cua-driver"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }
    let p = Process()
    let inp = Pipe(), out = Pipe()
    var buf = Data()
    var n = 1
    let label = "kangae-bar-\(getpid())-\(Int(Date().timeIntervalSince1970))" // 閉じた label は再利用できない（実測）
    init?() {
        guard let path = Cua.path() else { return nil }
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["mcp"]
        p.standardInput = inp; p.standardOutput = out; p.standardError = nil
        guard (try? p.run()) != nil else { return nil }
        _ = rpc("initialize", ["protocolVersion": "2024-11-05", "capabilities": [:], "clientInfo": ["name": "kangae-bar", "version": "1"]])
        send(["jsonrpc": "2.0", "method": "notifications/initialized"])
    }
    func send(_ o: [String: Any]) {
        guard var d = try? JSONSerialization.data(withJSONObject: o) else { return }
        d.append(10)
        inp.fileHandleForWriting.write(d)
    }
    func line() -> Data? {
        while true {
            if let i = buf.firstIndex(of: 10) { let l = buf[buf.startIndex..<i]; buf.removeSubrange(buf.startIndex...i); return Data(l) }
            let c = out.fileHandleForReading.availableData
            if c.isEmpty { return nil }
            buf.append(c)
        }
    }
    func rpc(_ method: String, _ params: [String: Any]) -> [String: Any]? {
        let id = n; n += 1
        send(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
        while let l = line() {
            guard let j = try? JSONSerialization.jsonObject(with: l) as? [String: Any], j["id"] as? Int == id else { continue }
            return j["result"] as? [String: Any]
        }
        return nil
    }
    func call(_ tool: String, _ args: [String: Any]) -> [String: Any]? {
        (rpc("tools/call", ["name": tool, "arguments": args.merging(["session": label]) { $1 }]))?["structuredContent"] as? [String: Any]
    }
    func close() { _ = call("end_session", [:]); p.terminate() }
}

// ---------- 囲んだ結果 → 切り出し → 文脈 → 常駐の attach ----------
extension App {
    func installSnip() {
        let b = NSButton(title: "囲む", target: self, action: #selector(snip))
        b.bezelStyle = .inline
        let acc = NSTitlebarAccessoryViewController()
        let p = NSButton(title: "指す", target: self, action: #selector(point))
        p.bezelStyle = .inline
        let g = NSButton(title: "渡す", target: self, action: #selector(pointGive))
        g.bezelStyle = .inline
        g.toolTip = "窓を指して、見ている会話の agent に渡す"
        acc.view = NSStackView(views: [g, p, b])
        acc.layoutAttribute = .right
        panel.addTitlebarAccessoryViewController(acc)
        // menu の項目は menuNeedsUpdate が毎回作る（起動時の menu は空なので at: 1 に挿すと NSMenu が落ちる）
        signal(SIGWINCH, SIG_IGN) // 試験用: kill -WINCH <pid> で指し始める
        let s3 = DispatchSource.makeSignalSource(signal: SIGWINCH, queue: .main)
        s3.setEventHandler { [unowned self] in self.point() }
        s3.resume()
        pointSig = s3
        signal(SIGUSR2, SIG_IGN) // 試験用: kill -USR2 <pid> で囲み始める
        let s2 = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
        s2.setEventHandler { [unowned self] in self.snip() }
        s2.resume()
        snipSig = s2
    }

    // WebView が出ている間は say（NSTextField）が絵に被るので、menu bar の字で知らせる
    func tell(_ s: String) {
        assertMain()
        if web == nil { return say(s) }
        status?.button?.title = s
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.status?.button?.title = "考" }
    }

    @objc func snip() {
        guard Cua.path() != nil else { return tell("画面を読む準備ができていません") }
        let front = NSWorkspace.shared.frontmostApplication // 囲む前の前面（bar は前面にならない）
        let wasVisible = panel.isVisible
        panel.orderOut(nil)
        var veils: [Veil] = []
        var finished = false
        var escRef: EventHotKeyRef?
        let finish: (NSRect?) -> Void = { [unowned self] r in
            guard !finished else { return }
            finished = true
            if let e = escRef { UnregisterEventHotKey(e) }
            NSCursor.pop()
            veils.forEach { $0.orderOut(nil) }
            veils = []
            if wasVisible { panel.makeKeyAndOrderFront(nil) }
            guard let r = r else { return } // Esc: 何も貼らない
            guard NSScreen.screens.first?.frame.contains(r) ?? false else { return tell("今は主画面だけ囲めます") } // Driver の撮影は主画面だけ。ずらして貼らない
            tell("画面を読んでいます…")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { // overlay が画面から消えてから撮る
                DispatchQueue.global().async { self.grab(r, front) }
            }
        }
        NSCursor.crosshair.push()
        escRef = escArm { finish(nil) }
        for sc in NSScreen.screens {
            let v = Veil(contentRect: sc.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            v.level = .screenSaver
            v.isOpaque = false; v.backgroundColor = .clear; v.hasShadow = false
            v.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            let view = VeilView(frame: NSRect(origin: .zero, size: sc.frame.size))
            view.done = finish
            v.contentView = view
            v.setFrame(sc.frame, display: true)
            v.orderFrontRegardless()
            v.makeKey()
            v.makeFirstResponder(view)
            veils.append(v)
        }
    }

    // r は AppKit の画面座標（左下原点・pt）。cua は左上原点・主画面の pt / px
    // 指す（Point.swift）は自分の session と文脈を渡す。captured は撮り終わりに main で呼ぶ（隠した bar を戻す）
    func grab(_ r: NSRect, _ front: NSRunningApplication?, cua given: Cua? = nil, ctx override: String? = nil, captured: (() -> Void)? = nil) {
        let h = NSScreen.screens.first?.frame.height ?? 0
        let top = NSRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height)
        let fail = { (m: String) in NSLog("snip: %@", m); DispatchQueue.main.async { self.tell(m) } }
        guard let cua = given ?? Cua() else { captured.map { c in DispatchQueue.main.async(execute: c) }; return fail("画面を読む準備ができていません") }
        defer { cua.close() }
        defer { captured.map { c in DispatchQueue.main.async(execute: c) } }
        let png = NSTemporaryDirectory() + "kangae-desktop-\(getpid()).png"
        defer { try? FileManager.default.removeItem(atPath: png) }
        let d0 = cua.call("get_desktop_state", ["screenshot_out_file": png])
        NSLog("snip: desktop %@ exists=%d", String(describing: d0).prefix(300) as CVarArg, FileManager.default.fileExists(atPath: png) ? 1 : 0)
        guard let d = d0, let scale = d["scale_factor"] as? Double,
              let img = NSImage(contentsOfFile: png)?.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let crop = img.cropping(to: CGRect(x: top.minX * scale, y: top.minY * scale, width: top.width * scale, height: top.height * scale)),
              let data = NSBitmapImageRep(cgImage: crop).representation(using: .png, properties: [:]) else { return fail("画面を読めませんでした") }

        // 文脈: 前面の app 名・窓の題・矩形に重なる AX の文字（menu は除く）
        var ctx = ["前面の app: \(front?.localizedName ?? "不明")"]
        if override == nil, let pid = front?.processIdentifier,
           let ws = cua.call("list_windows", ["pid": Int(pid), "on_screen_only": true])?["windows"] as? [[String: Any]],
           let w = ws.max(by: { ($0["z_index"] as? Int ?? -1) < ($1["z_index"] as? Int ?? -1) }), let wid = w["window_id"] as? Int {
            ctx.append("窓の題: \(w["title"] as? String ?? "")")
            if let s = cua.call("get_window_state", ["pid": Int(pid), "window_id": wid, "include_screenshot": false, "max_depth": 40, "max_elements": 1500, "timeout_ms": 4000]),
               let els = s["elements"] as? [[String: Any]] {
                var seen = Set<String>(), lines: [String] = []
                for e in els {
                    let role = e["role"] as? String ?? ""
                    guard !role.hasPrefix("AXMenu"), let f = e["frame"] as? [String: Double] else { continue }
                    let fr = CGRect(x: f["x"] ?? 0, y: f["y"] ?? 0, width: f["w"] ?? 0, height: f["h"] ?? 0) // 実測: frame は画面の pt（左上原点）
                    guard fr.intersects(top) else { continue }
                    for k in ["label", "value"] {
                        if let t = (e[k] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty, seen.insert(t).inserted { lines.append(String(t.prefix(300))) }
                    }
                }
                if !lines.isEmpty { ctx.append("囲んだ範囲の文字:\n" + lines.prefix(60).joined(separator: "\n")) }
            }
        }
        NSLog("snip: ctx %@", ctx.joined(separator: " | "))
        let text = override ?? ctx.joined(separator: "\n")
        DispatchQueue.main.async { // 見ている会話は WebView に聞く（開いていない / 聞けなければ nil = 常駐が最新の session を選ぶ）
            guard let w = self.web else { return self.attach(data, text, nil) }
            w.evaluateJavaScript("window.kangaeRoot") { v, _ in self.attach(data, text, (v as? NSNumber)?.intValue) }
        }
    }

    func attach(_ png: Data, _ text: String, _ rootId: Int?) {
        guard let u = barURL(), var c = URLComponents(url: u, resolvingAgainstBaseURL: false) else { return DispatchQueue.main.async { self.tell("本体に繋がりません") } }
        c.scheme = "ws"; c.path = "/ws"
        let t = URLSession.shared.webSocketTask(with: c.url!)
        t.resume()
        let id = UUID().uuidString
        var msg: [String: Any] = ["id": id, "op": "attach", "text": text, "image": png.base64EncodedString()]
        if let r = rootId { msg["rootId"] = r }
        t.send(.string(String(data: try! JSONSerialization.data(withJSONObject: msg), encoding: .utf8)!)) { _ in }
        // 常駐は全 port へ {type:history} なども流す。自分の id の返事が来るまで読む
        func reply() {
            t.receive { r in
                if case .success(.string(let s)) = r {
                    guard let j = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any], j["id"] as? String == id else { return reply() }
                    t.cancel(with: .normalClosure, reason: nil)
                    let root = j["ok"] as? Bool == true ? j["rootId"] as? Int : nil
                    DispatchQueue.main.async {
                        guard let root = root else { return self.tell("会話に貼れませんでした") }
                        if !self.panel.isVisible { self.openRoot = root; self.show() } // 隠れていたら出す（貼った会話を開いた状態で）
                    }
                } else {
                    t.cancel(with: .normalClosure, reason: nil)
                    DispatchQueue.main.async { self.tell("会話に貼れませんでした") }
                }
            }
        }
        reply()
    }
}
