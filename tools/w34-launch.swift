// NSWorkspace で app を「前面に出さず・hidden で」起こす（W34 の測定用）。使い方: w34-launch <bundle id> [開く path]
// path 付きは NSWorkspace.open([path], withApplicationAt:)（文書を開く Apple Event）。無しは openApplication。
import AppKit
let id = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "dev.zed.Zed"
let path = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : nil
guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { print("見つかりません: \(id)"); exit(2) }
let c = NSWorkspace.OpenConfiguration()
c.activates = false; c.hides = true; c.addsToRecentItems = false
let sem = DispatchSemaphore(value: 0)
if let path {
  NSWorkspace.shared.open([URL(fileURLWithPath: path)], withApplicationAt: url, configuration: c) { app, err in print("pid=\(app?.processIdentifier ?? -1) err=\(err?.localizedDescription ?? "なし")"); sem.signal() }
} else {
  NSWorkspace.shared.openApplication(at: url, configuration: c) { app, err in print("pid=\(app?.processIdentifier ?? -1) err=\(err?.localizedDescription ?? "なし")"); sem.signal() }
}
sem.wait()
