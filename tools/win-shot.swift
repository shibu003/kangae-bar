// 指した pid の窓（layer を問わず幅 200 以上）の CGWindowID を 1 行出す。人の画面は読まない・撮らない（撮るのは screencapture -l <id> で、その窓だけ）。
// 使い方: swiftc -O tools/win-shot.swift -o /tmp/win-shot && /tmp/win-shot <pid>
import AppKit
let pid = Int32(CommandLine.arguments.dropFirst().first ?? "") ?? 0
let all = (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]]) ?? []
for w in all where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
    let b = CGRect(dictionaryRepresentation: w[kCGWindowBounds as String] as! CFDictionary) ?? .zero
    if b.width >= 200, b.height >= 200, (w[kCGWindowIsOnscreen as String] as? Bool) == true { print(w[kCGWindowNumber as String] as! Int); break }
}
