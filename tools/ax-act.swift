// 別プロセスから 1 つの app の窓を AX で読む・押す・書く・動かす（W4c の probe 用・的は自分の ScratchPad だけ）。前面は取らない（activate を呼ばない）。
// 使い方: swiftc -O tools/ax-act.swift -o <bin> && <bin> <pid> <op> [args]
//   op: state | write <text> | press | hide | unhide | setpos <x> <y> | minimize | unminimize
// 出す物: JSON 1 行（窓の数・窓の位置・minimized・app の hidden・TextArea の値の長さ・読み戻し・各 AXError の rawValue）
import AppKit
import ApplicationServices

let a = CommandLine.arguments
guard a.count >= 3, let pid = Int32(a[1]) else { print("usage: ax-act <pid> <op> [args]"); exit(2) }
func attr(_ e: AXUIElement, _ k: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, k as CFString, &v) == .success ? v : nil }
func find(_ root: AXUIElement, _ role: String) -> AXUIElement? {
    var q = [root], n = 0
    while !q.isEmpty && n < 500 {
        let e = q.removeFirst(); n += 1
        if (attr(e, kAXRoleAttribute) as? String) == role { return e }
        if let c = attr(e, kAXChildrenAttribute) as? [AXUIElement] { q += c }
    }
    return nil
}
let nsapp = NSRunningApplication(processIdentifier: pid)
let app = AXUIElementCreateApplication(pid)
let wins = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
var out: [String: Any] = ["windowsListed": wins.count, "appHidden": nsapp?.isHidden as Any]
func point(_ e: AXUIElement) -> [Double]? {
    var p = CGPoint.zero
    guard let v = attr(e, kAXPositionAttribute), AXValueGetValue(v as! AXValue, .cgPoint, &p) else { return nil }
    return [Double(p.x), Double(p.y)]
}
let w = wins.first
if let w {
    out["position"] = point(w) as Any
    out["minimized"] = attr(w, kAXMinimizedAttribute) as Any
}
let ta = w.flatMap { find($0, "AXTextArea") }
out["textAreaFound"] = ta != nil
out["textAreaLen"] = ta.map { ((attr($0, kAXValueAttribute) as? String) ?? "").count } as Any
switch a[2] {
case "write":
    if let ta { out["setAXError"] = AXUIElementSetAttributeValue(ta, kAXValueAttribute as CFString, (a.count > 3 ? a[3] : "w4c") as CFString).rawValue; out["readBack"] = (attr(ta, kAXValueAttribute) as? String) as Any }
case "press": // 窓の AXButton（信号機）の 1 つ目ではなく zoom を押す。ScratchPad の的の窓だけ
    if let w, let z = attr(w, kAXZoomButtonAttribute) { out["pressAXError"] = AXUIElementPerformAction(z as! AXUIElement, kAXPressAction as CFString).rawValue }
case "hide": out["hideReturned"] = nsapp?.hide() as Any
case "unhide": out["unhideReturned"] = nsapp?.unhide() as Any
case "setpos":
    if let w, a.count > 4, let x = Double(a[3]), let y = Double(a[4]) {
        var p = CGPoint(x: x, y: y)
        out["setPosAXError"] = AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &p)!).rawValue
    }
case "minimize": if let w { out["minAXError"] = AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanTrue).rawValue }
case "unminimize": if let w { out["minAXError"] = AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse).rawValue }
default: break
}
if ["setpos", "minimize", "unminimize", "hide", "unhide"].contains(a[2]) {
    Thread.sleep(forTimeInterval: 0.5)
    let w2 = ((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).first
    out["after"] = ["windowsListed": ((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).count, "position": w2.flatMap(point) as Any, "minimized": w2.flatMap { attr($0, kAXMinimizedAttribute) } as Any, "appHidden": nsapp?.isHidden as Any]
}
let d = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: d, encoding: .utf8)!)
