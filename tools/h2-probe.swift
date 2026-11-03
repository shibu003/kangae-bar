// H2 測定 probe（製品に入れない・単体）: 「人が他 app の窓をつかんで動かしている」を Kangae が知れるか・落とし先をカーソル付近に出せるか・その窓だけ隠して戻せるかを、実機で測る。
// build: swiftc tools/h2-probe.swift -o <out>/h2-probe   （1 file・外の package なし）
// 使い方:
//   h2-probe watch <秒> <出力.jsonl> [--hide offscreen|minimize] [--restore-after <秒>]
//       全 app の左ボタン down / dragged / up を見て、JSON 行で記録する（時刻 t は epoch ms・cursor は画面の左上原点）。
//       down: 窓（CGWindowList の最前面・layer 0）と AX の要素（タイトルバーの位置）。dragged: 窓が動いたか（CGWindowList を 10ms 間隔で）・AXMoved 通知がいつ来るか。
//       最初の dragged から 6pt 動いたら、カーソルの近く（右下 +100,+50 が中心）に nonactivating の panel を出す。up が panel の中なら「落とした」＝その窓の pid / windowID を出し、--hide なら AX でその窓だけ隠す。
//   h2-probe target <秒> <x> <y>
//       測る相手: 同じ app に窓を 2 つ（H2-A / H2-B・文字入力欄つき）出す。1 つだけ隠せるか・隠れた窓へ cua-driver が効くかを測るための、自前の対象。
//   h2-probe hide <pid> <windowID> corner|offscreen|minimize       その窓 1 つだけを AX で隠す（元の枠を出力する）
//   h2-probe unhide <pid> <windowID> corner|offscreen|minimize <x> <y> <w> <h>   元の枠へ戻す（minimize は AXMinimized=false）
//   h2-probe frontmost   前面 app を 1 行で出す
import Cocoa
import ApplicationServices

let args = CommandLine.arguments
func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
var outFile: FileHandle?
func log(_ o: [String: Any]) {
    var m = o; m["t"] = Int(nowMs())
    guard let d = try? JSONSerialization.data(withJSONObject: m, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) else { return }
    let line = (s + "\n").data(using: .utf8)!
    FileHandle.standardOutput.write(line)
    outFile?.write(line)
}
func r(_ x: CGRect) -> [Int] { [Int(x.minX.rounded()), Int(x.minY.rounded()), Int(x.width.rounded()), Int(x.height.rounded())] }
func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? .zero } // 左上原点
func front() -> [String: Any] { let a = NSWorkspace.shared.frontmostApplication; return ["pid": Int(a?.processIdentifier ?? 0), "name": a?.localizedName ?? ""] }

struct Win { let id: CGWindowID; let pid: pid_t; let owner: String; let title: String; let bounds: CGRect; let onScreen: Bool }
func windows(_ opt: CGWindowListOption, _ id: CGWindowID = kCGNullWindowID) -> [Win] {
    ((CGWindowListCopyWindowInfo(opt, id) as? [[String: Any]]) ?? []).compactMap { w in
        guard let id = w[kCGWindowNumber as String] as? CGWindowID, let pid = w[kCGWindowOwnerPID as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: b as CFDictionary),
              (w[kCGWindowLayer as String] as? Int) == 0 else { return nil }
        return Win(id: id, pid: pid_t(pid), owner: w[kCGWindowOwnerName as String] as? String ?? "", title: w[kCGWindowName as String] as? String ?? "", bounds: rect, onScreen: (w[kCGWindowIsOnscreen as String] as? Bool) ?? false)
    }
}

// AX
func axStr(_ e: AXUIElement, _ a: String) -> String? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v as? String : nil }
func axFrame(_ w: AXUIElement) -> CGRect? {
    var pv: CFTypeRef?, sv: CFTypeRef?
    guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &pv) == .success, AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &sv) == .success else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &p); AXValueGetValue(sv as! AXValue, .cgSize, &s)
    return CGRect(origin: p, size: s)
}
func axSetPos(_ w: AXUIElement, _ p: CGPoint) -> AXError { var pp = p; return AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &pp)!) }
// 押した点の AX 要素 → 親をたどって AXWindow まで。chain はたどった role/subrole（タイトルバーが要素として見えるか・何として見えるか）
func axHit(_ p: CGPoint) -> (win: AXUIElement?, info: [String: Any]) {
    var el: AXUIElement?
    let e = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &el)
    guard e == .success, let hit = el else { return (nil, ["err": Int(e.rawValue)]) }
    var chain: [String] = [], cur: AXUIElement? = hit, win: AXUIElement?
    for _ in 0..<12 {
        guard let c = cur else { break }
        let role = axStr(c, kAXRoleAttribute) ?? "?"
        chain.append(role + "/" + (axStr(c, kAXSubroleAttribute) ?? "") + (axStr(c, kAXTitleAttribute).map { ":" + $0 } ?? ""))
        if role == kAXWindowRole as String { win = c; break }
        var par: CFTypeRef?
        cur = AXUIElementCopyAttributeValue(c, kAXParentAttribute as CFString, &par) == .success ? (par as! AXUIElement) : nil
    }
    return (win, ["chain": chain, "ax_window_frame": win.flatMap { axFrame($0) }.map { r($0) } ?? []])
}

// 状態
var hideMode: String?, onlyPid: pid_t = 0, restoreAfter = 4.0, panelOnDrag = false // 既定: 窓が実際に動いたのを見てから panel を出す（content の drag では出さない）。--panel-on-drag: 6pt 動いたら出す
var downT = 0.0, downP = CGPoint.zero, firstDragT = 0.0
var target: Win?, targetAX: AXUIElement?, boundsAtDown = CGRect.zero, lastB = CGRect.zero
var dragEvents = 0, axMoved = 0, movedSeen = false, inPanel = false, inGesture = false, extraUps = 0
var sampler: Timer?, observer: AXObserver?
var panel: NSPanel?
var trackEnter = 0, trackExit = 0, trackMove = 0
let H = NSScreen.screens.first?.frame.height ?? 0
func ms(_ t: Double) -> Int { Int(t - downT) }

final class Zone: NSView {
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: self, userInfo: nil))
    }
    override func mouseEntered(with e: NSEvent) { trackEnter += 1; log(["ev": "panel-tracking", "kind": "entered", "since_down_ms": ms(nowMs())]) }
    override func mouseExited(with e: NSEvent) { trackExit += 1; log(["ev": "panel-tracking", "kind": "exited", "since_down_ms": ms(nowMs())]) }
    override func mouseMoved(with e: NSEvent) { trackMove += 1 }
}

func showPanel(near c: CGPoint) {
    let w: CGFloat = 180, h: CGFloat = 70
    let p = NSPanel(contentRect: NSRect(x: c.x + 100 - w / 2, y: H - (c.y + 50) - h / 2, width: w, height: h), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    p.level = .statusBar; p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = true
    p.hidesOnDeactivate = false; p.becomesKeyOnlyIfNeeded = true; p.ignoresMouseEvents = false
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    let z = Zone(frame: NSRect(x: 0, y: 0, width: w, height: h))
    z.wantsLayer = true; z.layer?.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.85).cgColor; z.layer?.cornerRadius = 14
    let l = NSTextField(labelWithString: "ここへ落とす"); l.textColor = .white; l.font = .boldSystemFont(ofSize: 15); l.frame = NSRect(x: 0, y: 24, width: w, height: 22); l.alignment = .center
    z.addSubview(l); p.contentView = z
    let before = front()
    p.orderFrontRegardless()
    panel = p
    log(["ev": "panel-shown", "cursor": [Int(c.x), Int(c.y)], "panel_frame_cg": r(CGRect(x: p.frame.minX, y: H - p.frame.maxY, width: w, height: h)), "since_down_ms": ms(nowMs()), "focus_before": before, "focus_after": front(), "kangae_isActive": NSApp.isActive, "panel_isKey": p.isKeyWindow, "panel_canBecomeKey": p.canBecomeKey])
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { log(["ev": "panel-focus+150ms", "focus": front(), "kangae_isActive": NSApp.isActive, "panel_isKey": p.isKeyWindow]) }
}

let axCb: AXObserverCallback = { _, _, notif, _ in
    axMoved += 1
    log(["ev": "ax-notif", "notif": notif as String, "since_down_ms": ms(nowMs()), "since_firstdrag_ms": firstDragT > 0 ? Int(nowMs() - firstDragT) : -1, "cursor": [Int(cursor().x), Int(cursor().y)]])
}
func observe(_ pid: pid_t, _ win: AXUIElement?) {
    var o: AXObserver?
    guard AXObserverCreate(pid, axCb, &o) == .success, let obs = o else { return log(["ev": "ax-observer", "ok": false]) }
    let app = AXUIElementCreateApplication(pid)
    let a = AXObserverAddNotification(obs, app, kAXWindowMovedNotification as CFString, nil)
    let b = win.map { AXObserverAddNotification(obs, $0, kAXMovedNotification as CFString, nil).rawValue } ?? -1
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
    observer = obs
    log(["ev": "ax-observer", "ok": true, "app_AXWindowMoved_err": Int(a.rawValue), "win_AXMoved_err": Int(b)])
}

let W = NSScreen.screens.first?.frame.width ?? 0
func doHide(_ win: AXUIElement, _ mode: String) -> AXError {
    switch mode {
    case "minimize": return AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
    case "corner": return axSetPos(win, CGPoint(x: W - 1, y: H - 1)) // AeroSpace が別 workspace の窓を置く所（右下の角・1px だけ残る）
    default: return axSetPos(win, CGPoint(x: 6000, y: 300))
    }
}
func axWindowFor(_ pid: pid_t, _ cg: CGRect) -> AXUIElement? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &v) == .success, let ws = v as? [AXUIElement] else { return nil }
    return ws.first { axFrame($0).map { abs($0.minX - cg.minX) < 3 && abs($0.minY - cg.minY) < 3 && abs($0.width - cg.width) < 3 } ?? false }
}
func hide(_ win: AXUIElement, _ mode: String, _ w: Win) {
    let orig = axFrame(win)
    let err = doHide(win, mode)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
        let cg = windows([.optionAll]).filter { $0.pid == w.pid }
        log(["ev": "hide", "mode": mode, "ax_err": Int(err.rawValue), "orig": orig.map { r($0) } ?? [], "ax_after": axFrame(win).map { r($0) } ?? [],
             "windows_of_app": cg.map { ["id": Int($0.id), "title": $0.title, "bounds": r($0.bounds), "onScreen": $0.onScreen] }, "frontmost": front()])
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + restoreAfter) {
        var v: CFTypeRef?
        let wasMin = AXUIElementCopyAttributeValue(win, kAXMinimizedAttribute as CFString, &v) == .success && (v as? Bool) == true
        let e2: AXError = mode == "minimize" ? AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, kCFBooleanFalse) : (orig.map { axSetPos(win, $0.origin) } ?? .failure)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            let cg = windows([.optionAll]).first { $0.id == w.id }
            log(["ev": "restore", "mode": mode, "was_minimized": wasMin, "ax_err": Int(e2.rawValue), "ax_after": axFrame(win).map { r($0) } ?? [], "cg_bounds": cg.map { r($0.bounds) } ?? [], "cg_onScreen": cg?.onScreen ?? false, "expected": orig.map { r($0) } ?? []])
        }
    }
}

func onDown() {
    let p = cursor()
    inGesture = true
    downT = nowMs(); downP = p; firstDragT = 0; dragEvents = 0; axMoved = 0; movedSeen = false; inPanel = false; trackEnter = 0; trackExit = 0; trackMove = 0
    let t0 = nowMs()
    let cgNaive = windows(.optionOnScreenOnly).first { $0.pid != getpid() && $0.bounds.contains(p) } // 点の最前面の CG 窓（透明な全画面 overlay を拾う事がある: run5 で Cua Driver の overlay を返した）
    let t1 = nowMs()
    let hit = axHit(p)
    let t2 = nowMs()
    targetAX = hit.win
    // 窓の特定は AX の hit-test が主: AX の窓の pid と枠で CG の窓番号を突き合わせる。AX が窓を返さない時だけ最前面の CG 窓
    var axPidV: pid_t = 0
    if let aw = hit.win, let f = axFrame(aw) {
        AXUIElementGetPid(aw, &axPidV)
        // AX の枠と CG の枠は数 px ずれる事がある（実測 run5: 7px）。同じ pid・同じ大きさの窓のうち、原点が一番近い物
        target = windows(.optionOnScreenOnly).filter { $0.pid == axPidV && abs($0.bounds.width - f.width) < 3 && abs($0.bounds.height - f.height) < 3 && hypot($0.bounds.minX - f.minX, $0.bounds.minY - f.minY) < 30 }
            .min { hypot($0.bounds.minX - f.minX, $0.bounds.minY - f.minY) < hypot($1.bounds.minX - f.minX, $1.bounds.minY - f.minY) }
    }
    let axMatched = target != nil
    if target == nil { target = cgNaive }
    boundsAtDown = target?.bounds ?? .zero; lastB = boundsAtDown
    log(["ev": "down", "cursor": [Int(p.x), Int(p.y)], "cgwindowlist_ms": Int(t1 - t0), "ax_pid": Int(axPidV), "ax_matched_cg": axMatched, "cg_onscreen_of_ax_pid": windows(.optionOnScreenOnly).filter { $0.pid == axPidV }.map { r($0.bounds) }, "cg_topmost_naive": cgNaive.map { ["id": Int($0.id), "pid": Int($0.pid), "owner": $0.owner, "bounds": r($0.bounds)] } ?? [:], "ax_hittest_ms": Int(t2 - t1), "frontmost": front(), "cg_window": target.map { ["id": Int($0.id), "pid": Int($0.pid), "owner": $0.owner, "title": $0.title, "bounds": r($0.bounds), "y_from_top": Int(p.y - $0.bounds.minY)] } ?? [:], "ax": hit.info])
    if onlyPid != 0, let t = target, t.pid != onlyPid { log(["ev": "ignored-not-target-pid", "pid": Int(t.pid), "owner": t.owner]); target = nil; targetAX = nil }
    if let t = target {
        observe(t.pid, hit.win)
        sampler?.invalidate()
        let s = Timer(timeInterval: 0.01, repeats: true) { _ in
            guard let t = target, let b = windows([.optionIncludingWindow], t.id).first?.bounds, b != lastB else { return }
            lastB = b
            if !movedSeen && (abs(b.minX - boundsAtDown.minX) > 2 || abs(b.minY - boundsAtDown.minY) > 2) {
                movedSeen = true
                log(["ev": "window-moving-detected", "since_down_ms": ms(nowMs()), "since_firstdrag_ms": firstDragT > 0 ? Int(nowMs() - firstDragT) : -1])
                if !panelOnDrag && panel == nil && inGesture { showPanel(near: cursor()) }
            }
            log(["ev": "cg-bounds", "b": r(b), "since_down_ms": ms(nowMs()), "since_firstdrag_ms": firstDragT > 0 ? Int(nowMs() - firstDragT) : -1, "cursor": [Int(cursor().x), Int(cursor().y)]])
        }
        RunLoop.main.add(s, forMode: .common)
        sampler = s
    }
}
func onDrag() {
    guard inGesture else { return }
    dragEvents += 1
    let c = cursor()
    if firstDragT == 0 { firstDragT = nowMs(); log(["ev": "drag-first", "since_down_ms": ms(firstDragT)]) }
    if panelOnDrag, panel == nil, hypot(c.x - downP.x, c.y - downP.y) > 6 { showPanel(near: c) }
    if let p = panel {
        let now = p.frame.contains(NSEvent.mouseLocation)
        if now != inPanel { inPanel = now; log(["ev": "cursor-in-panel", "in": now, "via": "globalMonitor+frame.contains", "since_down_ms": ms(nowMs()), "cursor": [Int(c.x), Int(c.y)]]) }
    }
}
func onUp() {
    guard inGesture else { extraUps += 1; return log(["ev": "extra-up-ignored", "n": extraUps]) } // cua-driver の drag は mouseUp を 2 回出す事がある（実測 run1）
    inGesture = false
    let c = cursor(), dropped = inPanel && target != nil
    let w = target
    log(["ev": "up", "cursor": [Int(c.x), Int(c.y)], "drag_events": dragEvents, "ax_moved_count": axMoved, "window_moved_seen_by_cg_sampling": movedSeen, "in_panel_at_up": inPanel,
         "panel_tracking": ["entered": trackEnter, "exited": trackExit, "moved": trackMove], "dropped": dropped ? ["windowID": Int(w!.id), "pid": Int(w!.pid), "owner": w!.owner, "title": w!.title] : NSNull(), "frontmost": front()])
    if dropped, let m = hideMode, let a = targetAX, let w = w { hide(a, m, w) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        sampler?.invalidate(); sampler = nil
        if let o = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode); observer = nil }
        panel?.orderOut(nil); panel = nil
    }
}

let mode = args.count > 1 ? args[1] : ""
if mode == "frontmost" {
    print(front())
} else if mode == "watch", args.count >= 4 {
    let secs = Double(args[2]) ?? 60
    FileManager.default.createFile(atPath: args[3], contents: nil); outFile = FileHandle(forWritingAtPath: args[3])
    panelOnDrag = args.contains("--panel-on-drag")
    if let i = args.firstIndex(of: "--only-pid"), i + 1 < args.count { onlyPid = pid_t(args[i + 1]) ?? 0 } // この pid の窓以外には panel も hide も出さない（run3: owner の窓を掴んだ事故の再発防止）
    if let i = args.firstIndex(of: "--hide"), i + 1 < args.count { hideMode = args[i + 1] }
    if let i = args.firstIndex(of: "--restore-after"), i + 1 < args.count { restoreAfter = Double(args[i + 1]) ?? 4 }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    log(["ev": "start", "pid": Int(getpid()), "ax_trusted": AXIsProcessTrusted(), "frontmost": front(), "screens": NSScreen.screens.map { r($0.frame) }, "hide": hideMode ?? "none", "load": ProcessInfo.processInfo.systemUptime])
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { n in
        let a = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        log(["ev": "app-activated", "pid": Int(a?.processIdentifier ?? 0), "name": a?.localizedName ?? "", "is_kangae_probe": a?.processIdentifier == getpid(), "during_drag": downT > 0 && firstDragT > 0, "since_down_ms": ms(nowMs())])
    }
    NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { _ in onDown() }
    NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDragged]) { _ in onDrag() }
    NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseUp]) { _ in onUp() }
    DispatchQueue.main.asyncAfter(deadline: .now() + secs) { log(["ev": "end"]); exit(0) }
    app.run()
} else if mode == "hide" || mode == "unhide", args.count >= 5, let pid = Int32(args[2]), let wid = UInt32(args[3]) {
    guard let w = windows(.optionAll).first(where: { $0.id == wid && $0.pid == pid }), let ax = axWindowFor(pid, w.bounds) else { print("{\"ok\":false,\"why\":\"AX の窓が見つかりません\"}"); exit(0) }
    let orig = axFrame(ax)
    var err: AXError
    if mode == "hide" { err = doHide(ax, args[4]) }
    else if args[4] == "minimize" { err = AXUIElementSetAttributeValue(ax, kAXMinimizedAttribute as CFString, kCFBooleanFalse) }
    else { err = axSetPos(ax, CGPoint(x: Double(args[5]) ?? 0, y: Double(args[6]) ?? 0)) }
    usleep(600_000)
    let after = windows(.optionAll).first { $0.id == wid }
    log(["ev": mode, "how": args[4], "ax_err": Int(err.rawValue), "before": orig.map { r($0) } ?? [], "ax_after": axFrame(ax).map { r($0) } ?? [], "cg_bounds": after.map { r($0.bounds) } ?? [], "cg_onScreen": after?.onScreen ?? false,
         "siblings": windows(.optionAll).filter { $0.pid == pid && $0.id != wid && $0.bounds.height > 30 }.map { ["id": Int($0.id), "title": $0.title, "bounds": r($0.bounds), "onScreen": $0.onScreen] }])
} else if mode == "topat", args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) {
    // 点の最前面の窓（drag を始める前の確認用: 掴むのが目的の窓か）
    let w = windows(.optionOnScreenOnly).first { $0.bounds.contains(CGPoint(x: x, y: y)) }
    print(w.map { "\($0.pid) \($0.id) \($0.owner) \($0.title)" } ?? "none")
} else if mode == "target", args.count >= 5 {
    let secs = Double(args[2]) ?? 60, x = Double(args[3]) ?? 900, y = Double(args[4]) ?? 500
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    var keep: [NSWindow] = []
    for (i, name) in ["H2-A", "H2-B"].enumerated() {
        let w = NSWindow(contentRect: NSRect(x: x + Double(i) * 340, y: H - y - 200, width: 320, height: 200), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = name; w.isReleasedWhenClosed = false
        let f = NSTextField(frame: NSRect(x: 20, y: 80, width: 280, height: 24)); f.stringValue = "init-" + name; f.setAccessibilityLabel("field-" + name)
        w.contentView!.addSubview(f)
        w.orderFront(nil)
        keep.append(w)
    }
    print("target pid \(getpid()) windows:", windows(.optionAll).filter { $0.pid == getpid() }.map { "\($0.id)@\(r($0.bounds))" })
    DispatchQueue.main.asyncAfter(deadline: .now() + secs) { exit(0) }
    app.run()
} else {
    print("usage: watch <秒> <out.jsonl> [--hide offscreen|minimize] [--restore-after N] | target <秒> <x> <y> | frontmost")
}
