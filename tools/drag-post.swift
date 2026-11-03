// W54b: 裏の窓へ「pid 宛ての drag の列」を送る小さな helper。**Kangae の門（src/lease.ts の配信）だけが呼ぶ**。実行には owner の許可が要る（SLEventPostToPid は非公開 API・docs/design-dragpost.md）。
// 列と欄は上流 cua-driver の background drag と同じ（出典 docs/verify/w54/SOURCES.md §2: mouse.rs:796-940・:1543-1590）: mouseMoved（primer）→ leftMouseDown → leftMouseDragged × steps → leftMouseUp。
// 本物のポインタを動かさない（CGEventPost ではなく pid 宛て）・窓を前面にしない。送り先は **その pid が持つ、指した窓番号の窓の中**だけ（pid と窓の持ち主が合わない・点が窓の外なら 1 つも送らない）。
// 使い方:
//   drag-post --selfcheck                                  起動時の自己確認: 自分の小さな窓へ drag の列を送り、自分の view に down / dragged / up が届き、本物のポインタが動かないかを確かめる。出力 {"ok":…}
//   drag-post drag <pid> <windowNumber> <fromX> <fromY> <toX> <toY> <steps> <durationMs>   座標は画面（左上原点）。出力 {"ok":…,"pointer":{"before":[x,y],"after":[x,y]}}
import AppKit
import Foundation

// 欄の番号（上流と同じ。src/dragpost.ts の FIELDS と揃える＝test が両方を突き合わせる）
let F_CLICK_STATE: UInt32 = 1, F_BUTTON_NUMBER: UInt32 = 3, F_SUBTYPE: UInt32 = 7
let F_WINDOW_NUMBER: UInt32 = 51, F_CLICK_GROUP: UInt32 = 58, F_WINDOW_UNDER: UInt32 = 91, F_WINDOW_UNDER_CAN_HANDLE: UInt32 = 92
let F_TARGET_PID: UInt32 = 40

typealias PostFn = @convention(c) (Int32, UnsafeMutableRawPointer) -> Void
typealias SetIntFn = @convention(c) (UnsafeMutableRawPointer, UInt32, Int64) -> Void
typealias SetLocFn = @convention(c) (UnsafeMutableRawPointer, Double, Double) -> Void
let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
func sym<T>(_ name: String, _ type: T.Type) -> T? { guard let p = dlsym(sky, name) ?? dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }; return unsafeBitCast(p, to: type) }
let slPost = sym("SLEventPostToPid", PostFn.self)
let slSet = sym("SLEventSetIntegerValueField", SetIntFn.self)
let setLoc = sym("CGEventSetWindowLocation", SetLocFn.self)

func say(_ o: [String: Any]) { if let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) { print(s) } }
func realPointer() -> [Double] { let p = CGEvent(source: nil)?.location ?? .zero; return [Double(p.x), Double(p.y)] }

// 窓の持ち主と位置（CGWindowList・読むだけ）。窓番号が pid の物でなければ nil
func windowBounds(pid: Int32, number: Int64) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(number)) as? [[String: Any]], let w = list.first else { return nil }
    guard (w[kCGWindowOwnerPID as String] as? Int32) == pid || (w[kCGWindowOwnerPID as String] as? Int) == Int(pid) else { return nil }
    guard let b = w[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { return nil }
    return r
}

// pid 宛ての drag の列を送る。成功 = 全部の event を post した（届いたかは受け手の話・自己確認と呼び出し側の読み直しで確かめる）
func sendDrag(pid: Int32, window: Int64, from: CGPoint, to: CGPoint, steps: Int, durationMs: Int) -> Bool {
    guard let post = slPost, let set = slSet else { return false }
    let src = CGEventSource(stateID: .hidSystemState)
    let gid = Int64(Date().timeIntervalSince1970 * 1e9) & 0x7fffffff
    func stamp(_ e: CGEvent, count: Int64, subtype: Int64, at: CGPoint) {
        let p = Unmanaged.passUnretained(e).toOpaque()
        setLoc?(p, Double(at.x), Double(at.y)) // 窓内の点（画面座標を渡すと WindowServer が窓内へ直す）
        set(p, F_CLICK_STATE, count); set(p, F_BUTTON_NUMBER, 0); set(p, F_SUBTYPE, subtype)
        set(p, F_WINDOW_NUMBER, window); set(p, F_CLICK_GROUP, gid); set(p, F_WINDOW_UNDER, window); set(p, F_WINDOW_UNDER_CAN_HANDLE, window)
        set(p, F_TARGET_PID, Int64(pid)) // Chromium の synthetic-event filter 用の宛先 pid
    }
    func fire(_ t: CGEventType, _ pt: CGPoint, count: Int64 = 1, subtype: Int64 = 0) -> Bool {
        guard let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: pt, mouseButton: .left) else { return false }
        stamp(e, count: count, subtype: subtype, at: pt)
        post(pid, Unmanaged.passUnretained(e).toOpaque())
        return true
    }
    guard fire(.mouseMoved, from, count: 0, subtype: 3) else { return false } // primer: AppKit の cursor-tracking の状態を窓に見せる
    usleep(12_000)
    guard fire(.leftMouseDown, from) else { return false }
    usleep(16_000)
    let n = max(1, steps), delay = UInt32(max(0, durationMs) * 1000 / n)
    for i in 1...n {
        let t = Double(i) / Double(n)
        guard fire(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)) else { return false }
        if delay > 0 { usleep(delay) }
    }
    usleep(50_000)
    guard fire(.leftMouseUp, to) else { return false }
    usleep(100_000)
    return true
}

let a = CommandLine.arguments
if a.count >= 2 && a[1] == "--selfcheck" {
    // 自分の小さな窓（ほぼ透明・前面にしない・画面の隅）へ列を送り、自分の view に届いたかと、本物のポインタが動かなかったかを見る
    guard slPost != nil, slSet != nil else { say(["ok": false, "why": "SkyLight の関数が見つかりません"]); exit(0) }
    final class V: NSView {
        var down = 0, dragged = 0, up = 0
        override func mouseDown(with e: NSEvent) { down += 1 }
        override func mouseDragged(with e: NSEvent) { dragged += 1 }
        override func mouseUp(with e: NSEvent) { up += 1 }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 120, height: 120), styleMask: [.borderless], backing: .buffered, defer: false)
    w.alphaValue = 0.01; w.level = .normal; w.ignoresMouseEvents = false
    let v = V(frame: w.contentView!.bounds); w.contentView!.addSubview(v)
    w.orderBack(nil) // 前面にしない
    let sh = NSScreen.screens.first?.frame.height ?? 0, fr = w.frame
    let top = sh - fr.origin.y - fr.height
    let from = CGPoint(x: fr.origin.x + 30, y: top + 30), to = CGPoint(x: fr.origin.x + 90, y: top + 90)
    let before = realPointer()
    DispatchQueue.global().async {
        let ok = sendDrag(pid: ProcessInfo.processInfo.processIdentifier, window: Int64(w.windowNumber), from: from, to: to, steps: 6, durationMs: 120)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            let after = realPointer()
            let moved = before != after
            let received = v.down >= 1 && v.dragged >= 1 && v.up >= 1
            say(["ok": ok && received && !moved, "posted": ok, "received": ["down": v.down, "dragged": v.dragged, "up": v.up], "pointer": ["before": before, "after": after], "why": !ok ? "送れません" : !received ? "自分の窓に届きませんでした" : moved ? "本物のポインタが動きました" : ""])
            exit(0)
        }
    }
    app.run()
} else if a.count >= 10 && a[1] == "drag", let pid = Int32(a[2]), let wn = Int64(a[3]), let fx = Double(a[4]), let fy = Double(a[5]), let tx = Double(a[6]), let ty = Double(a[7]), let steps = Int(a[8]), let dur = Int(a[9]) {
    guard let b = windowBounds(pid: pid, number: wn) else { say(["ok": false, "why": "その窓はその pid の物ではありません（何も送っていません）"]); exit(0) }
    let from = CGPoint(x: fx, y: fy), to = CGPoint(x: tx, y: ty)
    guard b.contains(from), b.contains(to) else { say(["ok": false, "why": "点が窓の外です（何も送っていません）"]); exit(0) }
    let before = realPointer()
    let ok = sendDrag(pid: pid, window: wn, from: from, to: to, steps: steps, durationMs: dur)
    say(["ok": ok, "pointer": ["before": before, "after": realPointer()], "why": ok ? "" : "送れませんでした"])
} else {
    say(["ok": false, "why": "usage: --selfcheck | drag <pid> <windowNumber> <fromX> <fromY> <toX> <toY> <steps> <durationMs>"])
}
