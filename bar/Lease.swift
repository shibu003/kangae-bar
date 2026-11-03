// 面を agent に渡す（W2d）の bar 側。(1) 常駐へ 1 回きりの op を送る (2) 人がその窓の app に触ったら取り戻しを常駐に伝える。
// 判断（世代・拒否）は全部常駐（src/lease.ts）。bar は「人が触った」を見て知らせるだけ。
import Cocoa

final class LeaseLink {
    unowned let app: App
    var task: URLSessionWebSocketTask?
    var pids = Set<Int>()
    init(_ app: App) { self.app = app }

    func connect() {
        guard let u = app.barURL(), var c = URLComponents(url: u, resolvingAgainstBaseURL: false) else { return retry() }
        c.scheme = "ws"; c.path = "/ws"
        let t = URLSession.shared.webSocketTask(with: c.url!)
        task = t
        t.resume()
        send(["id": "human-hello", "op": "humanHello"]) // 常駐は humanHello した口からだけ humanSeen を受ける
        list()
        unread()
        if let f = NSWorkspace.shared.frontmostApplication { seen("front", Int(f.processIdentifier)) } // つないだ時の前面（以後は通知で追う）
        listen(t)
    }
    func retry() { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.connect() } }
    func send(_ o: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) else { return }
        task?.send(.string(s)) { _ in }
    }
    var asks = 0
    func unread() { guard app.badge != nil else { return }; asks += 1; send(["id": "unread-\(asks)", "op": "unread"]) } // id は毎回変える（常駐は同じ id の返事を使い回す）
    func list() { send(["id": "lease-list", "op": "leaseList"]) }
    func listen(_ t: URLSessionWebSocketTask) {
        // receive の callback は URLSession の背景 thread で呼ばれる。窓（Badge.set → NSWindow）にも pids にも触るので、中身は全部 main に戻す（EXP-1 再走: ここから Badge.set が NSWindow を背景 thread で触って落ちた）
        t.receive { [weak self] r in
            DispatchQueue.main.async {
                guard let self = self, t === self.task else { return }
                guard case .success(.string(let s)) = r else { return self.retry() }
                if let j = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] {
                    if j["type"] as? String == "leases" { self.list() }
                    if j["type"] as? String == "roots" { self.unread() }
                    if (j["id"] as? String)?.hasPrefix("unread-") == true, let n = j["n"] as? Int { self.app.badge?.set(n, (j["rootIds"] as? [Int]) ?? []) }
                    if j["id"] as? String == "lease-list", let ls = j["leases"] as? [[String: Any]] {
                        self.pids = Set(ls.compactMap { ($0["surface"] as? [String: Any])?["pid"] as? Int })
                    }
                }
                self.listen(t)
            }
        }
    }
    // 人の今（W11d）: 前面になった app / 窓の中を押した app の pid だけ常駐へ（中身は読まない・渡していない app も。「離れた」の判定に要る）
    func seen(_ kind: String, _ pid: Int) {
        guard pid != Int(getpid()) else { return }
        send(["id": UUID().uuidString, "op": "humanSeen", "kind": kind, "pid": pid])
    }
    // 渡してある app に人が触った。常駐が世代を上げて agent を止める
    func touch(_ pid: Int) {
        guard pid != Int(getpid()), pids.contains(pid) else { return }
        send(["id": UUID().uuidString, "op": "leaseTouch", "pid": pid])
    }
}

extension App {
    // 常駐へ 1 回きりの op（返事の JSON を main で返す）
    func daemon(_ msg: [String: Any], _ done: @escaping ([String: Any]?) -> Void) {
        guard let u = barURL(), var c = URLComponents(url: u, resolvingAgainstBaseURL: false) else { return DispatchQueue.main.async { done(nil) } }
        c.scheme = "ws"; c.path = "/ws"
        let t = URLSession.shared.webSocketTask(with: c.url!)
        t.resume()
        let id = UUID().uuidString
        var m = msg; m["id"] = id
        t.send(.string(String(data: try! JSONSerialization.data(withJSONObject: m), encoding: .utf8)!)) { _ in }
        func reply() {
            t.receive { r in
                guard case .success(.string(let s)) = r else { t.cancel(with: .normalClosure, reason: nil); return DispatchQueue.main.async { done(nil) } }
                guard let j = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any], j["id"] as? String == id else { return reply() }
                t.cancel(with: .normalClosure, reason: nil)
                DispatchQueue.main.async { done(j) }
            }
        }
        reply()
    }

    func installLease() {
        let link = LeaseLink(self)
        leaseLink = link
        link.connect()
        // 前面にした / 窓の中を押した app が渡してある物なら「人が触った」
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { n in
            if let a = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { link.seen("front", Int(a.processIdentifier)); link.touch(Int(a.processIdentifier)) }
        }
        NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { _ in
            let p = NSEvent.mouseLocation
            let h = NSScreen.screens.first?.frame.height ?? 0
            let pt = CGPoint(x: p.x, y: h - p.y)
            let ws = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
            if let w = ws.first(where: { ($0[kCGWindowLayer as String] as? Int) == 0 && (($0[kCGWindowBounds as String] as? [String: Any]).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }?.contains(pt) ?? false) }),
               let pid = w[kCGWindowOwnerPID as String] as? Int { link.seen("input", pid); link.touch(pid) }
        }
    }
}
