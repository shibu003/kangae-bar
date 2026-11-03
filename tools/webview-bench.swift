// WKWebView（bar と同じ engine）で頁を小さい窓に出し、頁が window.webkit.messageHandlers.done に投げた JSON を出して終わる。frame 時間の測り用。
// 使い方: swiftc -O tools/webview-bench.swift -o /tmp/webview-bench && /tmp/webview-bench <html> <query> [<out.png>]
// 窓は前に出さない（nonactivating・.accessory）。出ている時間は 6〜9 秒。
import Cocoa
import WebKit
final class H: NSObject, WKScriptMessageHandler {
    var shot: String?; var w: NSWindow!
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        print(m.body)
        if let s = shot { let id = w.windowNumber; Process.launchedProcess(launchPath: "/usr/sbin/screencapture", arguments: ["-x", "-o", "-l", "\(id)", s]).waitUntilExit() }
        exit(0)
    }
}
let a = CommandLine.arguments
let url = URL(fileURLWithPath: a[1])
let app = NSApplication.shared; app.setActivationPolicy(.accessory)
let h = H(); h.shot = a.count > 3 ? a[3] : nil
let conf = WKWebViewConfiguration(); conf.userContentController.add(h, name: "done")
let panel = NSPanel(contentRect: NSRect(x: 80, y: 80, width: 460, height: 420), styleMask: [.nonactivatingPanel, .titled], backing: .buffered, defer: false)
let web = WKWebView(frame: panel.contentView!.bounds, configuration: conf)
panel.contentView!.addSubview(web); h.w = panel
var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!; comps.query = a[2]
web.loadFileURL(comps.url!, allowingReadAccessTo: url.deletingLastPathComponent())
panel.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + 25) { print("{\"timeout\":true}"); exit(1) }
app.run()
