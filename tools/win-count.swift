// 画面に出ている物を数える（I-5「画面に我々の物を増やさない」の検査）。人の画面の写真は撮らない。
// 使い方: swiftc -O tools/win-count.swift -o /tmp/win-count && /tmp/win-count <pid> [<pid>...]
//   指した pid の窓だけを CGWindowListCopyWindowInfo で数え、JSON を 1 行出す（他の app の窓は読まない）。
//   onscreen = 画面の並びに載っている窓 / visible = そのうち bounds が実際の画面（NSScreen）と重なる窓
//   dock = Dock に出る app（activationPolicy=regular）の数と、指した pid がその中に居るか
import AppKit

let pids = Set(CommandLine.arguments.dropFirst().compactMap { Int32($0) })
let screens = NSScreen.screens.map { $0.frame }
func visible(_ b: CGRect) -> Bool { screens.contains { $0.intersects(b) } }
func rows(_ opt: CGWindowListOption) -> [[String: Any]] {
    let all = (CGWindowListCopyWindowInfo(opt, kCGNullWindowID) as? [[String: Any]]) ?? []
    return all.compactMap { w in
        guard let pid = w[kCGWindowOwnerPID as String] as? Int32, pids.contains(pid) else { return nil }
        let b = CGRect(dictionaryRepresentation: w[kCGWindowBounds as String] as! CFDictionary) ?? .zero
        return ["pid": Int(pid), "layer": w[kCGWindowLayer as String] as? Int ?? -1, "alpha": w[kCGWindowAlpha as String] as? Double ?? 1,
                "x": Int(b.minX), "y": Int(b.minY), "w": Int(b.width), "h": Int(b.height), "onScreenArea": visible(b)]
    }
}
// 実際に見える窓 = layer 0（通常の窓）で 1x1 の補助窓ではない物
func real(_ r: [[String: Any]]) -> [[String: Any]] { r.filter { ($0["layer"] as? Int) == 0 && ($0["w"] as? Int ?? 0) > 50 && ($0["h"] as? Int ?? 0) > 50 } }
let on = real(rows(.optionOnScreenOnly))
let any = real(rows(.optionAll))
// 全 layer（floating の bar の窓も・小さい窓も）: 指した pid の窓の総数と、実際の画面（NSScreen）に重なる数
let everyAll = rows(.optionAll).count
let everyVisible = rows(.optionOnScreenOnly).filter { $0["onScreenArea"] as? Bool == true }.count
let regular = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
let mine = regular.filter { pids.contains($0.processIdentifier) }
let out: [String: Any] = [
    "onscreen": on.count, "visible": on.filter { $0["onScreenArea"] as? Bool == true }.count,
    "allWindows": any.count, "windows": any,
    "everyLayerAll": everyAll, "everyLayerOnscreenWindows": rows(.optionOnScreenOnly).filter { $0["onScreenArea"] as? Bool == true }, "everyLayerVisible": everyVisible, "dockApps": regular.count, "dockMine": mine.count,
]
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
