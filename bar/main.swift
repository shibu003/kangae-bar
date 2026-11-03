// Kangae Bar — ⌥Space で出る / 消える浮く窓。常駐（~/.kangae/bar.json）の /panel を WKWebView に出すだけ。
// 画面収録も Accessibility も使わない。WebView は開いた時に作り、閉じたら捨てる。
import Cocoa
import Carbon.HIToolbox
import WebKit

// 試験用 KANGAE_BAR_OFFSCREEN: 窓を画面の外（-20000）に置く。AppKit は窓を画面内へ引き戻すので、その補正を外す。メニューバーの「考」も作らない
let offscreen = ProcessInfo.processInfo.environment["KANGAE_BAR_OFFSCREEN"] != nil
// 窓の一番上の薄い帯（信号機の行の右の空き）は窓を動かす持ち手。WKWebView はマウスを食うので、帯の中の押下だけ窓の drag に回す。帯の下の押す物は動かさない（W74）
let dragBand: CGFloat = 16
final class DragWeb: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true } // 非 active でも 1 回目を web に渡す（W99）。帯の mouseDown は変えない
    override func mouseDown(with e: NSEvent) {
        if convert(e.locationInWindow, from: nil).y > bounds.height - dragBand { window?.performDrag(with: e) } else { super.mouseDown(with: e) }
    }
}
final class Bar: NSPanel {
    override var canBecomeKey: Bool { true }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { offscreen ? frameRect : super.constrainFrameRect(frameRect, to: screen) }
}

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSMenuDelegate {
    let panel = Bar(
        contentRect: NSRect(x: 0, y: 0, width: 460, height: 640),
        styleMask: [.nonactivatingPanel, .titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
        backing: .buffered, defer: false)
    var web: WKWebView?
    var note: NSTextField!
    var status: NSStatusItem?
    var sig: DispatchSourceSignal?
    var ref: EventHotKeyRef?
    var keyName = ""
    var cands: [[String]] = []
    var cur = -1
    let confPath = ProcessInfo.processInfo.environment["KANGAE_BAR_CONF"] ?? NSHomeDirectory() + "/.kangae/bar.conf"
    var snipSig: DispatchSourceSignal?
    var pointSig: DispatchSourceSignal?
    var pointer: Pointer?
    var leaseLink: LeaseLink?
    var badge: Badge?
    var openRoot: Int? = Int(ProcessInfo.processInfo.environment["KANGAE_BAR_OPEN_ROOT"] ?? "") // 試験用: 最初に開く会話を env でも渡せる。// 囲んだ後に出す時、panel が最初に開く会話（panel の localStorage の panel-root を書く）
    var listTurn = false // W98: 右上の印が 2 件以上の時、panel を読む前に一覧を「あなたの番です」で開く
    var wantSettings = false // W104: 「設定を開く」を、panel を読む前に頼まれた印
    var glass: BarGlass!
    let glassRadius: CGFloat = 22

    func applicationDidFinishLaunching(_ n: Notification) {
        // 「編集」menu（W74c・CEO「bar の中の文字を全て copy できるように」）。accessory の app は main menu が無く、⌘C / ⌘A / ⌘V が WebView へ届かなかった。menu は画面に出ない（LSUIElement）が、key equivalent は効く
        let main = NSMenu(), edit = NSMenu(title: "編集")
        for (t, sel, k) in [("切り取り", #selector(NSText.cut(_:)), "x"), ("コピー", #selector(NSText.copy(_:)), "c"), ("貼り付け", #selector(NSText.paste(_:)), "v"), ("すべてを選択", #selector(NSText.selectAll(_:)), "a")] { edit.addItem(withTitle: t, action: sel, keyEquivalent: k) }
        main.addItem(withTitle: "編集", action: nil, keyEquivalent: "").submenu = edit
        NSApp.mainMenu = main
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        // 左上の 3 つ（W74b: CEO「赤・オレンジ・緑が消えてる」で戻した。緑 = 拡大・もう一度で戻る）。× は消す（bar を終わる）・− はしまう（⌃Space で戻る）。panel は miniaturize を持たないので自分で受ける
        if let x = panel.standardWindowButton(.closeButton) {
            x.target = self; x.action = #selector(quitBar); x.toolTip = "消す（bar を終わる。常駐は生きたまま）"
        }
        if let m = panel.standardWindowButton(.miniaturizeButton) {
            m.target = self; m.action = #selector(stow) // tooltip は hotkey が決まってから
        }
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true // 押した view が key を要る時だけ key になる。前面の app は nonactivatingPanel のまま（W99）
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 320, height: 240)
        panel.maxSize = NSSize(width: 100_000, height: 100_000) // 横も縦も縁で広げられる（W74b）
        if !panel.setFrameUsingName("KangaeBar") { panel.center() }
        panel.setFrameAutosaveName("KangaeBar")

        // ガラス: macOS 26 は OS の NSGlassEffectView（Glass.swift）。無ければ macOS 14 の 3 層（ぼかし + 縁の屈折光 + 艶）
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        glass = makeBarGlass(bounds: panel.contentView!.bounds, radius: glassRadius)
        panel.contentView!.addSubview(glass.view)
        if let s = glass.sheen { panel.contentView!.addSubview(s) }
        fputs("glass: \(glass.native ? "NSGlassEffectView" : "NSVisualEffectView+Sheen（NSGlassEffectView は引けない）")\n", stderr)

        // 折り返す・選べる（「macOS が止めました」の次の一手の 1 行を人が copy できる）
        note = NSTextField(wrappingLabelWithString: "")
        note.alignment = .center
        note.isSelectable = true
        note.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        note.frame = NSRect(x: 24, y: 220, width: 412, height: 200)

        if !offscreen { status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength) }
        status?.button?.title = "考"
        registerHotKey()
        fputs("hotkey: \(keyName)\n", stderr)
        panel.standardWindowButton(.miniaturizeButton)?.toolTip = "しまう（\(keyName) で戻る）"
        let menu = NSMenu()
        menu.delegate = self
        status?.menu = menu
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("app.kangae.bar.show"), object: nil, queue: .main) { [unowned self] _ in if !self.panel.isVisible || self.daemonStop != nil { self.show() } } // 止められた文を出したまま開き直された（印を消した後）= もう一度起こす

        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, ud in
            Unmanaged<App>.fromOpaque(ud!).takeUnretainedValue().toggle()
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
        signal(SIGUSR1, SIG_IGN) // 外から出す / 消す（試験用: kill -USR1 <pid>）
        let sig = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        sig.setEventHandler { [unowned self] in self.toggle() }
        sig.resume()
        self.sig = sig
        installSnip()
        installBadge() // LeaseLink が数を問い合わせるので先に
        installLease()
        installFront()
        // 人が開いた時（Finder の double-click・open = LaunchServices が起こすので親は launchd）は最初から窓を出す。--relaunch（しまった後の起こし直し）と試験の直 exec は出さない
        // （LSUIElement で Dock に出ないので、出さないと「開いても何も出ない」になる・W7n）
        if CommandLine.arguments.contains("--show") || (getppid() == 1 && !CommandLine.arguments.contains("--relaunch")) { toggle() } else { ensureDaemon() }
    }

    // 窓を出さずに常駐だけは起きている形にする（W55・実機: open -g … --relaunch で bar だけ起きて常駐が起きなかった）。panel を出さない起動（--relaunch・試験の直 exec）でも、常駐が居なければ起こす。
    // 前面は取らない（Process を起こすだけ）・panel は人が開いた時だけ。居る = bar.json の pid が生きている（HTTP で見ない: 混んだ機械で 2 秒の応答待ちが外れても二重に起こさない・ネットワークの設定にも左右されない）。--daemon は二重起動しても自分で終わる
    func ensureDaemon() {
        if let d = FileManager.default.contents(atPath: barPath()),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           let pid = j["pid"] as? Int, isDaemonPid(pid) { return }
        startDaemon()
    }

    // menu を開くたびに作り直す（常駐・hotkey・動いている bar の数は開いた時の値を見せる）
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "app.kangae.bar").filter { $0.processIdentifier != getpid() }
        let hot = keyName == "なし" ? "hotkey なし" : keyName
        let line = daemonInfo() != nil ? "つながっています ・ \(hot)" : "Kangae が起きていません"
        menu.addItem(withTitle: line, action: nil, keyEquivalent: "")
        if !others.isEmpty { menu.addItem(withTitle: "🔴 余分な bar が \(others.count) 個動いています", action: nil, keyEquivalent: "") }
        menu.addItem(.separator())
        menu.addItem(withTitle: "出す / 消す (\(keyName))", action: #selector(toggle), keyEquivalent: "").target = self
        menu.addItem(withTitle: "画面を囲んで聞く", action: #selector(snip), keyEquivalent: "").target = self
        menu.addItem(withTitle: "指して渡す", action: #selector(pointGive), keyEquivalent: "").target = self
        menu.addItem(withTitle: "設定を開く", action: #selector(openSettings), keyEquivalent: "").target = self
        let sub = NSMenu(title: "その他")
        sub.addItem(withTitle: "カーソルで指すだけ", action: #selector(point), keyEquivalent: "").target = self
        sub.addItem(withTitle: "hotkey を次の候補に変える（他の app と重なる時）", action: #selector(nextKey), keyEquivalent: "").target = self
        if keyName == "なし" { sub.addItem(withTitle: "hotkey が全部使われています（~/.kangae/bar.conf の hotkey= で指定）", action: nil, keyEquivalent: "") }
        if !others.isEmpty { sub.addItem(withTitle: "余分な bar を全部終わらせる（\(others.count) 個）", action: #selector(killOthers), keyEquivalent: "").target = self }
        sub.addItem(withTitle: "全部終わる（bar も 常駐も）", action: #selector(quitAll), keyEquivalent: "").target = self
        let more = NSMenuItem(title: "その他", action: nil, keyEquivalent: "")
        more.submenu = sub
        menu.addItem(more)
        menu.addItem(.separator())
        menu.addItem(withTitle: "終わる", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    func daemonInfo() -> (port: Int, pid: Int)? {
        guard let d = FileManager.default.contents(atPath: barPath()),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let port = j["port"] as? Int, let pid = j["pid"] as? Int, isDaemonPid(pid) else { return nil }
        return (port, pid)
    }

    @objc func killOthers() {
        for a in NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "app.kangae.bar") where a.processIdentifier != getpid() { a.forceTerminate() }
    }

    @objc func quitAll() {
        killOthers()
        // 人が押した「全部終わる」だけが印を置く（拡張が常駐を起こし直さないように）。logout / shutdown の SIGTERM では置かない。常駐は起きた時に印を消す
        let env = ProcessInfo.processInfo.environment
        let home = env["KANGAE_HOME"] ?? NSHomeDirectory() + "/Library/Application Support/Kangae"
        try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
        try? String(Int(Date().timeIntervalSince1970 * 1000)).write(toFile: home + "/quit", atomically: true, encoding: .utf8)
        if let d = daemonInfo() { kill(pid_t(d.pid), SIGTERM) }
        if let r = ref { UnregisterEventHotKey(r) }
        exit(0)
    }

    // ~/.kangae/bar.conf の「hotkey=ctrl+space」（option/ctrl/shift/cmd の組 + space）を先頭に、既定の順で試す。戻り値が失敗なら次へ
    // ponytail: 他 app が先に取っていても成功を返す事がある（Raycast で実測）。その場合は bar.conf で変える
    func registerHotKey() {
        let mods: [String: (UInt32, String)] = ["option": (UInt32(optionKey), "⌥"), "alt": (UInt32(optionKey), "⌥"), "ctrl": (UInt32(controlKey), "⌃"), "control": (UInt32(controlKey), "⌃"), "shift": (UInt32(shiftKey), "⇧"), "cmd": (UInt32(cmdKey), "⌘"), "command": (UInt32(cmdKey), "⌘")]
        cands = [["option"], ["ctrl"], ["option", "shift"], ["ctrl", "option"]]
        if let c = try? String(contentsOfFile: confPath, encoding: .utf8),
           let l = c.split(separator: "\n").first(where: { $0.hasPrefix("hotkey=") }) {
            let parts = l.dropFirst(7).lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.last == "space", parts.dropLast().allSatisfy({ mods[$0] != nil }), parts.count > 1 { let want = Array(parts.dropLast()); if let i = cands.firstIndex(of: want) { cands = Array(cands[i...] + cands[..<i]) } else { cands.insert(want, at: 0) } }
        }
        // 試験用: 先頭 N 個を自分で先に取り、戻り値の失敗（eventHotKeyExistsErr）を本物で踏ませる
        var held: [EventHotKeyRef?] = []
        for c in cands.prefix(Int(ProcessInfo.processInfo.environment["KANGAE_BAR_TEST_TAKEN"] ?? "") ?? 0) {
            var r: EventHotKeyRef?
            RegisterEventHotKey(UInt32(kVK_Space), c.reduce(UInt32(0)) { $0 | mods[$1]!.0 }, EventHotKeyID(signature: 0x54455354, id: 1), GetApplicationEventTarget(), 0, &r)
            held.append(r)
        }
        for (i, c) in cands.enumerated() {
            let m = c.reduce(UInt32(0)) { $0 | mods[$1]!.0 }
            if RegisterEventHotKey(UInt32(kVK_Space), m, EventHotKeyID(signature: 0x4B424152, id: 1), GetApplicationEventTarget(), 0, &ref) == noErr {
                keyName = c.map { mods[$0]!.1 }.joined() + "Space"
                cur = i
                return
            }
        }
        keyName = "なし"
    }

    // 重なっている app が居ても登録は成功を返すので、人が menu から次の候補へ移す（bar.conf に書いて起こし直す）
    // 起こし直す。新しい方は旧が終わって lock が空くまで待つ（--relaunch）ので、2 つ同時に生きる窓は無い
    func relaunch() -> Never {
        if let r = ref { UnregisterEventHotKey(r) }
        let p = Process()
        p.executableURL = Bundle.main.executableURL
        p.arguments = ["--relaunch"]
        try? p.run()
        exit(0)
    }

    @objc func nextKey() {
        let n = cands[(cur + 1) % cands.count]
        try? "hotkey=\(n.joined(separator: "+"))+space\n".write(toFile: confPath, atomically: true, encoding: .utf8)
        relaunch()
    }

    @objc func toggle() { panel.isVisible ? hide() : show() }

    // W104: 出ていなければ出す（出ていれば隠さない）。読めていれば歯車を開く。まだ無ければ user script が起動時に開く。
    @objc func openSettings() {
        if !panel.isVisible { show() }
        if let w = web {
            w.evaluateJavaScript("window.kangaeOpenSettings?.()", completionHandler: nil)
        } else {
            wantSettings = true
        }
    }

    @objc func stow() { hide() } // − ＝ しまう（常駐も hotkey も生きたまま）

    @objc func quitBar() { // × ＝ 消す（bar だけ終わる。常駐は生きたままなので会話は残る）
        panel.saveFrame(usingName: "KangaeBar")
        if let r = ref { UnregisterEventHotKey(r) }
        exit(0)
    }

    func hide() {
        panel.saveFrame(usingName: "KangaeBar")
        panel.orderOut(nil)
        // WebKit は閉じても rss を返さない（W1c 実測: WebView 捨て・新 ProcessPool・nonPersistent・キャッシュ消去のどれでも 18→44 MB のまま）ので、自分を起こし直して待機を軽く保つ。状態は常駐側にある
        relaunch()
    }

    func show() {
        assertMain()
        daemonStop = nil // 前に止められた文は、人が開き直したら 1 回だけ忘れて起こし直す（覚えたままだと印を消しても bar を終わるまで同じ文のまま・review16）
        say("つなぎ中…")
        if offscreen { panel.setFrameOrigin(NSPoint(x: -20000, y: -20000)) }
        panel.makeKeyAndOrderFront(nil)
        connect(0)
    }

    // bar.json が無い / 繋がらないなら常駐を起こし、起きるまで 0.25 秒ごとに見る。回数でなく 30 秒の締切（Date 基準）— 遅い機械では 1 周が延びる
    var connectSince: Date?
    func connect(_ tries: Int) {
        guard panel.isVisible, web == nil else { return }
        let retry = {
            if let s = self.daemonStop { return self.say(s) } // 常駐が殺された。待っても起きないので次の一手を出したまま止まる
            if tries == 0 { self.connectSince = Date(); self.say("本体を起こしています…"); self.startDaemon() }
            let waited = Int(Date().timeIntervalSince(self.connectSince ?? Date()))
            if waited >= 30 { return self.note.stringValue == "本体が見つかりません" ? () : self.say("本体を起こせませんでした（\(waited) 秒待った・もう一度開いてください）") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.connect(tries + 1) }
        }
        guard let url = barURL() else { return retry() }
        var req = URLRequest(url: url, timeoutInterval: 2)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { _, r, _ in
            DispatchQueue.main.async {
                guard self.panel.isVisible, self.web == nil else { return }
                guard (r as? HTTPURLResponse)?.statusCode == 200 else { return retry() }
                self.note.removeFromSuperview()
                let conf = WKWebViewConfiguration()
                // 信号機（× −）の右端 + 余白を panel の頭の逃がしに渡す（重なると × が ‹ の上に乗って、戻るつもりで bar を終わらせる）。KANGAE_BAR_INSET は試験用の上書き
                conf.userContentController.addUserScript(WKUserScript(source: "document.documentElement.style.setProperty('--bar-inset-left','\(self.lightsInset())px')", injectionTime: .atDocumentStart, forMainFrameOnly: true))
                if let r = self.openRoot {
                    conf.userContentController.addUserScript(WKUserScript(source: "try{localStorage.setItem('panel-root','\(r)')}catch(e){}", injectionTime: .atDocumentStart, forMainFrameOnly: true))
                    self.openRoot = nil
                }
                if self.listTurn {
                    conf.userContentController.addUserScript(WKUserScript(source: "window.__kangaeList='turn'", injectionTime: .atDocumentStart, forMainFrameOnly: true))
                    self.listTurn = false
                }
                if self.wantSettings {
                    conf.userContentController.addUserScript(WKUserScript(source: "window.__kangaeSettings=1", injectionTime: .atDocumentStart, forMainFrameOnly: true))
                    self.wantSettings = false
                }
                let w = DragWeb(frame: self.panel.contentView!.bounds, configuration: conf)
                w.autoresizingMask = [.width, .height]
                w.setValue(false, forKey: "drawsBackground")
                w.underPageBackgroundColor = .clear // 頁の地の白を描かせない（すりガラスを透かす）
                self.glass.add(w, in: self.panel.contentView!)
                w.navigationDelegate = self
                w.load(URLRequest(url: url))
                self.web = w
                if let f = ProcessInfo.processInfo.environment["KANGAE_BAR_PROBE"] { self.probe(w, f) }
            }
        }.resume()
    }

    // 常駐の探し方（最初に見つかった物）: KANGAE_DAEMON（試験用）→ .app 同梱 → ~/.kangae/bin/kangae → repo 相対（dist/kangae → bun src/main.ts）。どれも --daemon は二重起動しても自分で終わる
    func startDaemon() {
        let repo = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fm = FileManager.default
        let env = ProcessInfo.processInfo.environment
        let p = Process()
        let bins = [env["KANGAE_DAEMON"], Bundle.main.resourcePath.map { $0 + "/bin/kangae" }, NSHomeDirectory() + "/.kangae/bin/kangae", repo.path + "/dist/kangae"]
        if let d = bins.compactMap({ $0 }).first(where: { fm.isExecutableFile(atPath: $0) }) {
            p.executableURL = URL(fileURLWithPath: d)
            p.arguments = ["--daemon"]
        } else if fm.fileExists(atPath: repo.path + "/src/main.ts") {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["bun", repo.path + "/src/main.ts", "--daemon"]
            p.environment = env.merging(["PATH": (env["PATH"] ?? "") + ":" + NSHomeDirectory() + "/.bun/bin:/opt/homebrew/bin:/usr/local/bin"]) { $1 }
        } else {
            return say("本体が見つかりません")
        }
        p.standardInput = nil; p.standardOutput = nil; p.standardError = nil
        // 同梱の常駐が signal で終わったら黙らない（隔離の印つきの未公証の実行 file は macOS が SIGKILL で止める・W7n）
        let path = p.executableURL!.path
        let started = Date()
        p.terminationHandler = { t in
            guard t.terminationReason == .uncaughtSignal else { return }
            let s = stopNote(path: path, signal: t.terminationStatus, quarantined: getxattr(path, "com.apple.quarantine", nil, 0, 0, 0) >= 0, ranFor: Date().timeIntervalSince(started))
            DispatchQueue.main.async { self.daemonStop = s; self.say(s) }
        }
        try? p.run()
    }
    var daemonStop: String?

    // 左上の信号機（window 座標）の右端 + 8pt。panel の頭はここより右から始める
    func lightsInset() -> Int {
        if let v = ProcessInfo.processInfo.environment["KANGAE_BAR_INSET"], let n = Int(v) { return n }
        let xs = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { t in panel.standardWindowButton(t).map { $0.convert($0.bounds, to: nil).maxX } }
        return Int((xs.max() ?? 0).rounded(.up)) + 8
    }

    // 試験用（KANGAE_BAR_PROBE=<json の出力先>）: 信号機の矩形（web 座標・上が 0）の中に、押せる物（button / a / input）が在るかを、会話の画面と一覧の画面で数える
    func probe(_ w: WKWebView, _ path: String) {
        let H = panel.contentView!.bounds.height
        let lights = [NSWindow.ButtonType.closeButton, .miniaturizeButton].compactMap { t -> [Double]? in
            guard let b = panel.standardWindowButton(t) else { return nil }
            let r = b.convert(b.bounds, to: nil)
            return [Double(r.minX), Double(H - r.maxY), Double(r.width), Double(r.height)]
        }
        let f = panel.frame
        let vis = NSScreen.screens.contains { $0.frame.intersects(f) }
        let js = """
        return (async()=>{const L=\(lights);const out={lights:L,window:{frame:[\(f.minX),\(f.minY),\(f.width),\(f.height)],onScreen:\(vis)},screens:{}};
        const look=()=>{const hits=[];for(const [x,y,w,h] of L)for(const fx of [.1,.5,.9])for(const fy of [.1,.5,.9]){const e=document.elementFromPoint(x+w*fx,y+h*fy);const t=e&&e.closest('button,a,input,textarea,[role=button]');if(t)hits.push((t.id||t.className||t.tagName)+'@'+Math.round(x+w*fx)+','+Math.round(y+h*fy))}
          const r=id=>{const e=document.getElementById(id);if(!e)return null;const b=e.getBoundingClientRect();return b.width?[b.x,b.y,b.width,b.height]:null};return {hits,back:r('hd-list'),more:r('hd-more'),inset:getComputedStyle(document.documentElement).getPropertyValue('--bar-inset-left')}};
        await new Promise(r=>setTimeout(r,1500));out.screens.dm=look();
        const b=document.getElementById('hd-list');if(b){b.click();await new Promise(r=>setTimeout(r,800));out.screens.list=look()}
        return JSON.stringify(out)})()
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            w.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
                if case .success(let v) = r, let s = v as? String { try? s.write(toFile: path, atomically: true, encoding: .utf8) }
                else { try? "\(r)".write(toFile: path, atomically: true, encoding: .utf8) }
            }
        }
    }

    func say(_ s: String) {
        assertMain()
        fputs("note: \(s.replacingOccurrences(of: "\n", with: " / "))\n", stderr) // 試験が読む（docs/verify/w7n）
        note.stringValue = s
        if note.superview == nil { panel.contentView!.addSubview(note) }
    }

    // bar.json の pid が「まだ常駐」か（review29）。pid だけ見ると、落ちた常駐の bar.json（再起動後も ~/.kangae に残る）の pid を別の process が使い回した時に、
    // 常駐が居ない bar が「居る」と読んで起こさず（W55）、「終わる」が無関係な process に SIGTERM を送る。実行 file の名前（kangae・dev の bun）まで見る
    func isDaemonPid(_ pid: Int) -> Bool {
        guard pid > 1, kill(pid_t(pid), 0) == 0 || errno == EPERM else { return false }
        var buf = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid_t(pid), &buf, UInt32(buf.count)) > 0 else { return false }
        let n = URL(fileURLWithPath: String(cString: buf)).lastPathComponent
        return n == "kangae" || n == "bun" || n.hasPrefix("kangae-")
    }

    func barPath() -> String { ProcessInfo.processInfo.environment["KANGAE_BAR"] ?? NSHomeDirectory() + "/.kangae/bar.json" }

    func barURL() -> URL? {
        guard let d = FileManager.default.contents(atPath: barPath()),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let port = j["port"] as? Int, let token = j["token"] as? String else { return nil }
        return URL(string: "http://127.0.0.1:\(port)/panel?token=\(token)")
    }
}

// 常駐が signal で殺された時の文。理由（印・置き場所）と次の一手を 1 枚に。app の場所は常駐の path から（.app/Contents/Resources/bin/kangae）
// ranFor = 常駐を起こしてから止まるまでの秒。SIGKILL でも印が無く、しばらく動いた後なら安全の確認ではなく強制終了（xattr は勧めない）
func stopNote(path: String, signal: Int32, quarantined: Bool, ranFor: TimeInterval) -> String {
    let app = path.range(of: ".app/").map { String(path[..<$0.lowerBound]) + ".app" } ?? path
    if app.contains("/AppTranslocation/") {
        return "macOS が Kangae Bar の部品を止めました（ダウンロードした場所のまま開いたため・signal \(signal)）\n次の一手: Kangae Bar.app を Finder で「アプリケーション」フォルダへ移してから、開き直してください"
    }
    // ponytail: 5 秒で安全の確認か強制終了かを見分ける（Gatekeeper は起動直後に殺す）。外れたら codesign の検査を足す
    if quarantined || (signal == SIGKILL && ranFor < 5) {
        let why = quarantined ? "ダウンロードの印が付いていて、Apple の確認を受けていないため" : "macOS の安全の確認で止められたようです"
        return "macOS が Kangae Bar の部品を止めました（\(why)・signal \(signal)）\n次の一手: ターミナルで次の 1 行を打ってから、Kangae Bar を開き直してください（ダウンロードの印を消すだけで、他は変わりません）\nxattr -dr com.apple.quarantine '\(app)'"
    }
    let what = signal == SIGKILL ? "強制終了されました" : "止まりました"
    return "Kangae Bar の部品が\(what)（signal \(signal)）\n次の一手: Kangae Bar を開き直してください。続く時は「考」のメニューで「全部終わる」→ 開き直す"
}

// 単一 instance: flock は process が死ねば OS が放すので、落ちた後に lock が残らない。取れなければ先の bar に「出して」と伝えて終わる
let lockFd = open(ProcessInfo.processInfo.environment["KANGAE_BAR_LOCK"] ?? NSHomeDirectory() + "/.kangae/bar.lock", O_RDWR | O_CREAT, 0o600)
var locked = false
for _ in 0..<(CommandLine.arguments.contains("--relaunch") ? 60 : 1) {
    if lockFd >= 0 && flock(lockFd, LOCK_EX | LOCK_NB) == 0 { locked = true; break }
    usleep(50_000)
}
if !locked {
    DistributedNotificationCenter.default().postNotificationName(Notification.Name("app.kangae.bar.show"), object: nil, userInfo: nil, deliverImmediately: true)
    usleep(200_000)
    exit(0)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = App()
app.delegate = delegate
app.run()
