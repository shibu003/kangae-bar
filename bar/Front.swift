// 前面の app を panel に教える（W6a・mod の札を出すため）。見るだけ: NSWorkspace の通知と frontmostApplication を読んで JS に渡す。
// activate・makeKey・窓を前に出す呼び出しは一切しない（I-1）。bar 自身（panel は nonactivating なので前面にならない）は渡さない。
import Cocoa
import WebKit

extension App {
    func installFront() {
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] n in
            self?.pushFront(n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
        }
    }
    // panel の読み込みが済んだ時、また前面が替わった時に呼ぶ。panel が無い・まだ読めていない時は何もしない
    func pushFront(_ app: NSRunningApplication? = NSWorkspace.shared.frontmostApplication) {
        guard let web = web, let app = app, app.processIdentifier != getpid() else { return }
        let name = app.localizedName ?? ""
        guard let j = try? JSONSerialization.data(withJSONObject: [name], options: []), let arr = String(data: j, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.kangaeFront&&window.kangaeFront(\(arr)[0],\(app.processIdentifier))", completionHandler: nil)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { pushFront() }
}
