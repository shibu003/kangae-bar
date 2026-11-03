import Foundation
import CoreGraphics
// 人の代わりに 1 秒ごとに 'z' を打つ（CGEvent・前面の app へ）
let n = Int(CommandLine.arguments[1])!
for _ in 0..<n {
  for down in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: 6, keyDown: down)!.post(tap: .cghidEventTap) }
  Thread.sleep(forTimeInterval: 1)
}
