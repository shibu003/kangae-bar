// bar の WKWebView（bar/main.swift と同じ構成）に頁を読ませ、人の画面に窓を出さずに PNG にする（明・暗 × 閉じた形・開いた形）。
// 使い方: swiftc -O tools/bar-shot.swift -o <bin> && <bin> <url> <outDir> <preload.js> <hex backdrop 明> <hex backdrop 暗>
// 窓: .accessory・画面の外（x=-30000）・orderOut のまま・canBecomeKey/canBecomeMain false。前面にもキーの先にもならない。
// すりガラスは OS の合成なので写らない。WebView の絵を、色を決めた地（backdrop 引数）に重ねる（Chromium 側も同じ地・同じ preload）。
import Cocoa
import WebKit

final class Quiet: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
func hex(_ s: String) -> NSColor {
    let v = UInt32(s.replacingOccurrences(of: "#", with: ""), radix: 16) ?? 0
    return NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
}
let a = CommandLine.arguments
guard a.count >= 6, let url = URL(string: a[1]) else { print("usage: bar-shot <url> <outDir> <preload.js> <lightHex> <darkHex>"); exit(2) }
let out = a[2], pre = (try? String(contentsOfFile: a[3])) ?? ""
let app = NSApplication.shared; app.setActivationPolicy(.accessory)

func shoot(dark: Bool, openAll: Bool, height: CGFloat, _ done: @escaping () -> Void) {
    let name = (dark ? "dark" : "light") + (openAll ? "-open" : "")
    let panel = Quiet(contentRect: NSRect(x: -30000, y: -30000, width: 460, height: height), styleMask: [.nonactivatingPanel, .titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    panel.titlebarAppearsTransparent = true
    panel.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    panel.setFrame(NSRect(x: -30000, y: -30000, width: 460, height: height), display: false) // titled 窓は画面内に寄せられるので、置いた後に外へ戻す
    let conf = WKWebViewConfiguration()
    conf.userContentController.addUserScript(WKUserScript(source: "document.documentElement.style.setProperty('--bar-inset-left','78px')", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    conf.userContentController.addUserScript(WKUserScript(source: pre, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let w = WKWebView(frame: panel.contentView!.bounds, configuration: conf)
    w.autoresizingMask = [.width, .height]
    w.setValue(false, forKey: "drawsBackground")
    w.underPageBackgroundColor = .clear
    panel.contentView!.addSubview(w)
    w.load(URLRequest(url: url))
    // 既定は orderOut のまま。WebKit が見えない窓の描画を止めて白になる時だけ BARSHOT_ORDER=1（画面の外の窓に orderBack・前面は取らない）
    if ProcessInfo.processInfo.environment["BARSHOT_ORDER"] == "1" { panel.orderBack(nil) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
        let js = openAll ? "document.querySelectorAll('details').forEach(d=>d.open=true);document.documentElement.scrollTop=0;'ok'" : "'ok'"
        w.evaluateJavaScript(js) { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                w.takeSnapshot(with: nil) { img, err in
                    guard let img = img else { print("\(name): snapshot 失敗 \(String(describing: err))"); done(); return }
                    let sz = img.size
                    let comp = NSImage(size: sz)
                    comp.lockFocus()
                    hex(dark ? a[5] : a[4]).setFill(); NSRect(origin: .zero, size: sz).fill()
                    img.draw(in: NSRect(origin: .zero, size: sz))
                    comp.unlockFocus()
                    if let t = comp.tiffRepresentation, let rep = NSBitmapImageRep(data: t), let png = rep.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: "\(out)/wk-\(name).png"))
                        print("\(name): \(Int(sz.width))x\(Int(sz.height)) -> \(out)/wk-\(name).png")
                    }
                    panel.orderOut(nil)
                    done()
                }
            }
        }
    }
}
// 4 枚を順に（窓は 1 枚ごとに作って捨てる）
let jobs: [(Bool, Bool, CGFloat)] = [(false, false, 640), (true, false, 640), (false, true, 1500), (true, true, 1500)]
func next(_ i: Int) { if i == jobs.count { print("done"); exit(0) }; shoot(dark: jobs[i].0, openAll: jobs[i].1, height: jobs[i].2) { next(i + 1) } }
DispatchQueue.main.async { next(0) }
DispatchQueue.main.asyncAfter(deadline: .now() + 90) { print("timeout"); exit(1) }
app.run()
