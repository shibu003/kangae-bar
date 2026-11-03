// 別の Space の窓の AX を、人の Space を動かさず・前に出さずに取れるかの測り（W4h）。上流: alt-tab-macos の src/macos/api-wrappers/AXUIElement.swift:238-292
// （_AXUIElementCreateWithRemoteToken の token を id で総当たりして、別 Space の窓の要素を拾う）。
// 使い方: swiftc -O tools/space-probe.swift -o <bin> && <bin> <pid> <window_id> [budget_ms=3000] [set-value]
//   出す物（JSON 1 行）: activeSpace（前後）・trusted・見つけた窓の root・同じ窓に属する要素の role の数・TextArea の値の読み・書き・読み戻し
import AppKit
import ApplicationServices

@_silgen_name("_AXUIElementCreateWithRemoteToken") func _AXUIElementCreateWithRemoteToken(_ d: CFData) -> Unmanaged<AXUIElement>?
@_silgen_name("_AXUIElementGetWindow") func _AXUIElementGetWindow(_ e: AXUIElement, _ out: UnsafeMutablePointer<CGWindowID>) -> AXError
@_silgen_name("CGSMainConnectionID") func CGSMainConnectionID() -> Int32
@_silgen_name("CGSGetActiveSpace") func CGSGetActiveSpace(_ c: Int32) -> Int

let a = CommandLine.arguments
guard a.count >= 3, let pid = Int32(a[1]), let wid = UInt32(a[2]) else { print("usage: space-probe <pid> <window_id> [budget_ms] [set-value]"); exit(2) }
let budget = Double(a.count > 3 ? a[3] : "3000") ?? 3000
let doSet = a.count > 4 && a[4] == "set-value"
let space0 = CGSGetActiveSpace(CGSMainConnectionID())
let prime = a.count > 5 && a[5] == "prime" // 走査の前に app の AX を起こす（AXEnhancedUserInterface / AXManualAccessibility / kAXWindows）
if prime {
    let ap = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetAttributeValue(ap, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(ap, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    _ = AXUIElementCopyAttributeValue(ap, kAXWindowsAttribute as CFString, UnsafeMutablePointer<CFTypeRef?>.allocate(capacity: 1))
    Thread.sleep(forTimeInterval: 0.5)
}
let t0 = Date()

func attr(_ e: AXUIElement, _ k: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, k as CFString, &v) == .success ? v : nil }

let token = CFDataCreateMutable(kCFAllocatorDefault, 20)!
CFDataSetLength(token, 20)
let b = CFDataGetMutableBytePtr(token)!
memset(b, 0, 20)
var p = pid; memcpy(b, &p, 4)
var magic = Int32(0x636f636f); memcpy(b + 8, &magic, 4)

var roles: [String: Int] = [:]
var winRoot: AXUIElement?
var textArea: AXUIElement?
var scanned: UInt64 = 0
var lastHitId: UInt64 = 0
var made = 0
var sample: [String] = []
var maxMadeId: UInt64 = 0
var widSeen: [UInt32: Int] = [:]
var roleSeen: [String: Int] = [:]
var id: UInt64 = 0
while Date().timeIntervalSince(t0) * 1000 < budget {
    var i = id; memcpy(b + 12, &i, 8)
    id += 1; scanned += 1
    guard let el = _AXUIElementCreateWithRemoteToken(token)?.takeRetainedValue() else { continue }
    made += 1; maxMadeId = id
    var w: CGWindowID = 0
    let gw = _AXUIElementGetWindow(el, &w)
    if sample.count < 6 { sample.append("id\(id - 1) role=\((attr(el, kAXRoleAttribute) as? String) ?? "?") wid=\(gw == .success ? Int(w) : -1)") }
    if gw == .success { widSeen[w, default: 0] += 1 }
    if roleSeen.count < 20 || roleSeen[(attr(el, kAXRoleAttribute) as? String) ?? "?"] != nil { roleSeen[(attr(el, kAXRoleAttribute) as? String) ?? "?", default: 0] += 1 }
    guard gw == .success, w == wid else { continue }
    let role = (attr(el, kAXRoleAttribute) as? String) ?? "?"
    roles[role, default: 0] += 1
    lastHitId = id
    if role == "AXWindow" { winRoot = el }
    if role == "AXTextArea" { textArea = el }
}
func s(_ v: CFTypeRef?) -> String { (v as? String) ?? "" }
let app = AXUIElementCreateApplication(pid)
let axWindows = (attr(app, kAXWindowsAttribute) as? [AXUIElement])?.count
let before = textArea.map { s(attr($0, kAXValueAttribute)) }
var setResult = "未実施"
var readBack: String? = nil
if doSet, let ta = textArea {
    let r = AXUIElementSetAttributeValue(ta, kAXValueAttribute as CFString, "probe-w4h" as CFString)
    setResult = "\(r.rawValue)"
    readBack = s(attr(ta, kAXValueAttribute))
}
let children = winRoot.flatMap { attr($0, kAXChildrenAttribute) as? [AXUIElement] }?.count
// 正規の道: kAXWindows → 目的の wid の窓 → kAXChildren を辿る（別 Space の窓を kAXWindows が返すか・木が辿れるか）
var walk: [String: Any] = [:]
let appEl = AXUIElementCreateApplication(pid)
let wins = (attr(appEl, kAXWindowsAttribute) as? [AXUIElement]) ?? []
walk["appChildren"] = (attr(appEl, kAXChildrenAttribute) as? [AXUIElement])?.count as Any
walk["focusedWindow"] = attr(appEl, kAXFocusedWindowAttribute) != nil
walk["mainWindow"] = attr(appEl, kAXMainWindowAttribute) != nil
let target = wins.first { var w: CGWindowID = 0; return _AXUIElementGetWindow($0, &w) == .success && w == wid }
walk["windowsListed"] = wins.count
walk["targetInWindows"] = target != nil
if let root = target {
    var queue = [root], n = 0, rs: [String: Int] = [:], area: AXUIElement?
    while !queue.isEmpty && n < 2000 {
        let e = queue.removeFirst(); n += 1
        let r = (attr(e, kAXRoleAttribute) as? String) ?? "?"
        rs[r, default: 0] += 1
        if r == "AXTextArea" || r == "AXTextField" { area = e }
        if let ch = attr(e, kAXChildrenAttribute) as? [AXUIElement] { queue += ch }
    }
    walk["elements"] = n; walk["roles"] = rs
    if let ta = area {
        walk["textAreaValueLength"] = s(attr(ta, kAXValueAttribute)).count
        if doSet {
            walk["setAXError"] = AXUIElementSetAttributeValue(ta, kAXValueAttribute as CFString, "probe-w4h" as CFString).rawValue
            walk["readBack"] = s(attr(ta, kAXValueAttribute))
        }
    }
}
let out: [String: Any] = [
    "trusted": AXIsProcessTrusted(), "activeSpaceBefore": space0, "activeSpaceAfter": CGSGetActiveSpace(CGSMainConnectionID()),
    "scannedIds": scanned, "elementsCreated": made, "maxCreatedId": maxMadeId, "sample": sample, "windowIdsSeen": widSeen.map { "\($0.key):\($0.value)" }, "rolesSeen": roleSeen, "kAXWindowsCount": axWindows as Any, "lastHitId": lastHitId, "elementsOfWindow": roles.values.reduce(0, +), "roles": roles,
    "walk": walk, "windowRootFound": winRoot != nil, "windowChildren": children as Any, "textAreaFound": textArea != nil,
    "valueBeforeLength": before.map { $0.count } as Any, "setValueAXError": setResult, "valueReadBack": readBack as Any,
]
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
