// 別の Space の窓を、普通の AX（kAXWindows → kAXChildren）で読むだけの helper（W4h）。cua-driver は別 Space の窓を自分から拒否して要素 0 を返す（off_space_or_ax_unresolved）が、
// 長く動いている app の窓は AX の側では別プロセスから読める（docs/verify/w4h/probe/RESULT.md）。人の Space は動かさない・前に出さない・書かない。
// 使い方: ax-read <pid> <window_id> [max_elements=300] [hold_ms=0]   hold_ms は試験用（読んだ後に生きたままでいる時間・画面に何も出ない事を測る）
// 配る形は小さな .app「Kangae Bar 読み取り」（tools/build-reader.sh）。LaunchServices 経由で起こすと、許可（TCC）はその .app に付く＝誰が常駐を起こしても同じ 1 つの名前（W4h-3）。許可のダイアログ（prompt）は出さない（前面を取る）
// 出す物（JSON 1 行）: {found, elements:[{depth, role, label, value}], truncated}。found:false = AX がその窓を持っていない（一度も画面に出ていない窓など）
import AppKit
import ApplicationServices

@_silgen_name("_AXUIElementGetWindow") func _AXUIElementGetWindow(_ e: AXUIElement, _ out: UnsafeMutablePointer<CGWindowID>) -> AXError

let a = CommandLine.arguments
guard a.count >= 3, let pid = Int32(a[1]), let wid = UInt32(a[2]) else { print("{\"error\":\"usage: ax-read <pid> <window_id> [max]\"}"); exit(2) }
let maxN = Int(a.count > 3 ? a[3] : "300") ?? 300
let holdMs = Int(a.count > 4 ? a[4] : "0") ?? 0
func attr(_ e: AXUIElement, _ k: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, k as CFString, &v) == .success ? v : nil }
func str(_ v: CFTypeRef?) -> String { if let s = v as? String { return s }; if let n = v as? NSNumber { return n.stringValue }; return "" }
@_silgen_name("responsibility_get_pid_responsible_for_pid") func responsibility_get_pid_responsible_for_pid(_ pid: pid_t) -> pid_t
// 許可（TCC）は「責任を負う process」に付く（W4h-2 の測り）。無い時は、誰に出せばよいかを名前で返す
func finish(_ code: Int32 = 0) -> Never { fflush(stdout); if holdMs > 0 { Thread.sleep(forTimeInterval: Double(holdMs) / 1000) }; exit(code) }
guard AXIsProcessTrusted() else {
    let r = responsibility_get_pid_responsible_for_pid(getpid())
    let name = NSRunningApplication(processIdentifier: r)?.localizedName ?? ""
    print(String(data: try! JSONSerialization.data(withJSONObject: ["error": "no-ax-permission", "responsible": name]), encoding: .utf8)!)
    finish(3)
}
let wins = (attr(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
guard let root = wins.first(where: { var w: CGWindowID = 0; return _AXUIElementGetWindow($0, &w) == .success && w == wid }) else { print("{\"found\":false}"); finish() }
// W8e: 人が覗き窓の絵を押した時だけ使う。その窓を raise して app を前に出す（読む処理とは別の口・同じ許可の名前）
if a.count > 3 && a[3] == "raise" {
    AXUIElementSetAttributeValue(root, kAXMainAttribute as CFString, kCFBooleanTrue)
    let r = AXUIElementPerformAction(root, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue) // macOS 14+ でも効く前面化
    print("{\"raised\":\(r == .success)}")
    finish()
}
var out: [[String: Any]] = []
var queue: [(AXUIElement, Int)] = [(root, 0)]
var truncated = false
while !queue.isEmpty {
    if out.count >= maxN { truncated = true; break }
    let (e, d) = queue.removeFirst()
    let role = str(attr(e, kAXRoleAttribute)).replacingOccurrences(of: "AX", with: "")
    let label = [str(attr(e, kAXTitleAttribute)), str(attr(e, kAXDescriptionAttribute))].first { !$0.isEmpty } ?? ""
    out.append(["depth": d, "role": role, "label": String(label.prefix(80)), "value": String(str(attr(e, kAXValueAttribute)).prefix(80))])
    if d < 40, let ch = attr(e, kAXChildrenAttribute) as? [AXUIElement] { queue += ch.map { ($0, d + 1) } }
}
let resp = responsibility_get_pid_responsible_for_pid(getpid())
print(String(data: try! JSONSerialization.data(withJSONObject: ["found": true, "elements": out, "truncated": truncated, "responsible": NSRunningApplication(processIdentifier: resp)?.localizedName ?? "", "responsiblePid": Int(resp), "pid": Int(getpid())]), encoding: .utf8)!)
finish()
