// 試験の的の app（owner の TextEdit など本物の app を的にしない）。窓 1 つ・NSTextView 1 つ・状態を保存しない。
// 使い方: swiftc -O tools/scratch-pad.swift -o <dir>/ScratchPad.app/Contents/MacOS/ScratchPad（+ Info.plist。docs/verify/w4a2/uc.ts が組む）
//   open -g -n -a <dir>/ScratchPad.app --args "<窓の題>"   ← -g = 前に出さない・-n = 毎回新しい process
// 前に出さない: activate を呼ばない。保存しない: window.isRestorable = false / NSQuitAlwaysKeepsWindows = false（~/Library に何も残さない）
import AppKit

// --ghost の窓だけを、人の Space を動かさずに別の Space へ置く（W4h・私用 API）。SIGUSR2 = --hop-to=<space id> へ足し、今の Space から外す
@_silgen_name("CGSMainConnectionID") func CGSMainConnectionID() -> Int32
@_silgen_name("CGSGetActiveSpace") func CGSGetActiveSpace(_ c: Int32) -> Int
@_silgen_name("CGSAddWindowsToSpaces") func CGSAddWindowsToSpaces(_ c: Int32, _ wins: CFArray, _ spaces: CFArray)
@_silgen_name("CGSRemoveWindowsFromSpaces") func CGSRemoveWindowsFromSpaces(_ c: Int32, _ wins: CFArray, _ spaces: CFArray)
@_silgen_name("CGSCopySpacesForWindows") func CGSCopySpacesForWindows(_ c: Int32, _ mask: Int32, _ wins: CFArray) -> Unmanaged<CFArray>?

UserDefaults.standard.register(defaults: ["NSQuitAlwaysKeepsWindows": false])
let title = CommandLine.arguments.dropFirst().first ?? "Scratch Pad"
// --ghost: 全 Space に参加する透明な窓として画面に載せる（人には見えず前面も取らない・W4h）。SIGUSR1 で参加を外す（窓が別 Space に残る状態を作る）
let ghost = CommandLine.arguments.contains("--ghost")

// --ghost の窓は NSPanel（nonactivatingPanel）で、キーにもメインにもならない = 前面にもキーの先にもならず、人の打鍵を飲まない（AX の読み書きは窓の AX 要素に直接届く）
final class GhostPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var ghostSource: DispatchSourceSignal?
    var hopSource: DispatchSourceSignal?
    func applicationDidFinishLaunching(_ n: Notification) {
        let mask: NSWindow.StyleMask = [.titled, .closable, .resizable, .miniaturizable]
        let rect = NSRect(x: 80, y: 80, width: 480, height: 320)
        if ghost {
            let panel = GhostPanel(contentRect: rect, styleMask: mask.union(.nonactivatingPanel), backing: .buffered, defer: false)
            panel.hidesOnDeactivate = false // NSPanel は app が非 active だと隠れる既定
            window = panel
        } else {
            window = NSWindow(contentRect: rect, styleMask: mask, backing: .buffered, defer: false)
        }
        window.title = title
        window.isRestorable = false
        window.isReleasedWhenClosed = false
        let scroll = NSTextView.scrollableTextView()
        window.contentView = scroll
        (scroll.documentView as? NSTextView)?.font = .systemFont(ofSize: 14)
        tv = scroll.documentView as? NSTextView
        // --buttons: 「送信」「削除」「閉じる」の button を足す（W8a の的）。押されたら --log=<path> に 1 行足す（押された事の証拠）
        if CommandLine.arguments.contains("--buttons") {
            let bar = NSStackView(views: ["送信", "削除", "閉じる"].map { NSButton(title: $0, target: self, action: #selector(pressed(_:))) })
            let stack = NSStackView(views: [scroll, bar])
            stack.orientation = .vertical
            window.contentView = stack
        }
        if ghost {
            window.alphaValue = 0
            window.ignoresMouseEvents = true
            window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
            window.orderBack(nil) // 前面を取らずに画面に載せる
            signal(SIGUSR1, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
            src.setEventHandler { [self] in self.window.collectionBehavior = [] }
            src.resume()
            ghostSource = src
            signal(SIGUSR2, SIG_IGN)
            let hop = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
            hop.setEventHandler { [self] in
                let c = CGSMainConnectionID(), wins = [self.window.windowNumber] as CFArray
                let to = CommandLine.arguments.first { $0.hasPrefix("--hop-to=") }.flatMap { Int($0.dropFirst(9)) } ?? 1
                let from = CGSGetActiveSpace(c)
                self.window.collectionBehavior = []
                CGSAddWindowsToSpaces(c, wins, [to] as CFArray)
                CGSRemoveWindowsFromSpaces(c, wins, [from] as CFArray)
                FileHandle.standardError.write("hop \(from)->\(to) now=\(String(describing: CGSCopySpacesForWindows(c, 7, wins)?.takeUnretainedValue()))\n".data(using: .utf8)!)
            }
            hop.resume()
            hopSource = hop
        } else {
            window.orderFront(nil) // makeKeyAndOrderFront / activate は使わない（前面を奪わない）
        }
        extras()
    }
    var second: NSWindow?
    // W11b: --second=<題> = 同じ app の 2 枚目の窓（資源ごとの排他の的）/ --menu = 主 menu に「遅い保存」（cmd+k）。押されたら --log に menu-start / menu-end を足す
    func extras() {
        if let t = CommandLine.arguments.first(where: { $0.hasPrefix("--second=") }).map({ String($0.dropFirst(9)) }) {
            let w = ghost ? GhostPanel(contentRect: NSRect(x: 120, y: 60, width: 480, height: 320), styleMask: [.titled, .closable, .resizable, .nonactivatingPanel], backing: .buffered, defer: false) : NSWindow(contentRect: NSRect(x: 120, y: 60, width: 480, height: 320), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            (w as? NSPanel)?.hidesOnDeactivate = false
            w.title = t
            w.isRestorable = false
            w.isReleasedWhenClosed = false
            w.contentView = NSTextView.scrollableTextView()
            if ghost { w.alphaValue = 0; w.ignoresMouseEvents = true; w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]; w.orderBack(nil) } else { w.orderFront(nil) }
            second = w
        }
        if CommandLine.arguments.contains("--menu") {
            let main = NSMenu(), top = NSMenuItem(), sub = NSMenu(title: "Kangae")
            sub.addItem(NSMenuItem(title: "遅い保存", action: #selector(slowSave), keyEquivalent: "k"))
            top.submenu = sub
            main.addItem(top)
            NSApp.mainMenu = main
        }
    }
    @objc func slowSave() {
        note("menu-start")
        Thread.sleep(forTimeInterval: 1.0)
        note("menu-end")
    }
    func note(_ line: String) {
        guard let path = CommandLine.arguments.first(where: { $0.hasPrefix("--log=") }).map({ String($0.dropFirst(6)) }) else { return }
        let data = "\(line) \(Date().timeIntervalSince1970)\n".data(using: .utf8)!
        if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(data); h.closeFile() } else { FileManager.default.createFile(atPath: path, contents: data) }
    }
    var tv: NSTextView?
    @objc func pressed(_ b: NSButton) {
        if b.title == "送信" { tv?.string += "\n【送信しました】" } // 送った事が窓に見える（W11f: 結果不明の後に読み直して確かめられる）
        guard let path = CommandLine.arguments.first(where: { $0.hasPrefix("--log=") }).map({ String($0.dropFirst(6)) }) else { return }
        let line = "\(b.title)\n".data(using: .utf8)!
        if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(line); h.closeFile() } else { FileManager.default.createFile(atPath: path, contents: line) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { false }
}

let app = NSApplication.shared
app.setActivationPolicy(CommandLine.arguments.contains("--accessory") ? .accessory : .regular) // --accessory: Dock に出ず、窓は人が見ている Space に載る（W4h）
let d = Delegate()
app.delegate = d
app.run()
