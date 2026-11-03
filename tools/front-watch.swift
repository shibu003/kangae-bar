// 前面が変わった回数を数える（製品の不変条件「人の前面を奪わない」の検査）
// 使い方: swiftc -O tools/front-watch.swift -o /tmp/front-watch && /tmp/front-watch 60
//   60 秒の間、前面の app が変わる度に 1 行出し、最後に「変わった回数」を出す。
//   通しの受け入れでは **人が自分で切り替えた分を除いて 0** でなければならない。
// polling ではなく NSWorkspace の通知で受ける（CPU をほぼ使わない）。
//
// 前面の変化に加えて、人の画面に **新しく出た窓** も 1 行ずつ出す（holes-27）。OS の dialog（Gatekeeper は CoreServicesUIAgent）や
// 非 activating の窓は frontmost を替えないので、前面の記録だけでは「邪魔していない」を測れない。
//   "  1.25s  +win owner=CoreServicesUIAgent pid=123 layer=0 size=420x200"
// 窓の中身・題は読まない（owner 名・pid・layer・大きさだけ）。0.25 秒ごとに on-screen の窓 id の差を見る。
// 使い方: front-watch <秒> [--allow ownerA,ownerB]  — allow した owner の窓は "+win(許可)" で出し、数えない（W15 の丸い icon など CEO が許した物）。
// exit 0 = 前面の変化 0 かつ 許可外の新しい窓 0。
import AppKit

setvbuf(stdout, nil, _IOLBF, 0) // 行ごとに出す（pipe・kill でも、変わった行が失われない）
let seconds = Double(CommandLine.arguments.dropFirst().first.flatMap { $0.hasPrefix("--") ? nil : $0 } ?? "60") ?? 60
let start = Date()
var changes = 0
var newWins = 0
let args = Array(CommandLine.arguments.dropFirst())
let allow = Set((args.firstIndex(of: "--allow").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "").split(separator: ",").map(String.init))
var last = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
// 前面に来た物の pid と実行 file / bundle の path（人の Google Chrome と試験の Chrome を分けるため・W4h-3）。「A -> B」の形は変えず、後ろに付ける
func who(_ app: NSRunningApplication?) -> String {
    guard let a = app else { return "" }
    return "  pid=\(a.processIdentifier) path=\((a.bundleURL ?? a.executableURL)?.path ?? "?")"
}
let t0 = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss"; return f.string(from: start) }()
print("start front=\(last)\(who(NSWorkspace.shared.frontmostApplication))  t0=\(t0)") // t0 = 開始の時刻（tools/front-read.ts が「起こした時刻の前後」を絶対時刻で読む）
NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { n in
    let app = (n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.localizedName ?? "?"
    guard app != last else { return }
    changes += 1
    print(String(format: "%6.2fs  %@ -> %@", Date().timeIntervalSince(start), last, app) + who(n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication))
    last = app
}
// 新しく出た窓: 窓番号の集合の差。最初の一覧は「元から在った窓」なので出さない
func onScreen() -> [Int: String] {
    var m: [Int: String] = [:]
    for w in (CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]]) ?? [] {
        guard let id = w[kCGWindowNumber as String] as? Int else { continue }
        let b = CGRect(dictionaryRepresentation: w[kCGWindowBounds as String] as! CFDictionary) ?? .zero
        let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
        let tag = allow.contains(owner) ? "+win(許可)" : "+win"
        m[id] = "\(tag) owner=\(owner) pid=\(w[kCGWindowOwnerPID as String] as? Int ?? -1) layer=\(w[kCGWindowLayer as String] as? Int ?? -1) size=\(Int(b.width))x\(Int(b.height))"
    }
    return m
}
var seen = Set(onScreen().keys)
Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
    for (id, line) in onScreen() where !seen.contains(id) {
        seen.insert(id)
        if !line.hasPrefix("+win(許可)") { newWins += 1 }
        print(String(format: "%6.2fs  ", Date().timeIntervalSince(start)) + line)
    }
}
Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in
    print("end front=\(last)  前面が変わった回数=\(changes)  新しい窓=\(newWins)")
    exit(changes == 0 && newWins == 0 ? 0 : 1) // 0 件なら exit 0。検査にそのまま使える
}
// 時間より前に止められた（SIGTERM）時も、それまでの回数を出して終わる
signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { print("end front=\(last)  前面が変わった回数=\(changes)  新しい窓=\(newWins)（途中で止めた）"); exit(changes == 0 && newWins == 0 ? 0 : 1) }
term.resume()
RunLoop.main.run()
