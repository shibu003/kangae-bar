// UI の無い試験用の小さな .app（LSUIElement・窓なし）。bar の代役: 子 process を起こして、その責任（responsibility）が誰になるかを測るだけ。W4h-2
// 使い方: open -g -a SpawnProbe.app --args <出力 file>   子: /bin/sleep 20 を起こして pid を file に書き、20 秒後に終わる
import AppKit
let out = CommandLine.arguments.dropFirst().first ?? "/tmp/spawn-probe.txt"
let cmd = Array(CommandLine.arguments.dropFirst(2)) // 2 つ目以降 = 子に起こす command（無ければ sleep 20）
let p = Process(); p.executableURL = URL(fileURLWithPath: cmd.first ?? "/bin/sleep"); p.arguments = cmd.isEmpty ? ["20"] : Array(cmd.dropFirst())
let pipe = Pipe(); if !cmd.isEmpty { p.standardOutput = pipe }
try? p.run()
if !cmd.isEmpty { p.waitUntilExit(); try? pipe.fileHandleForReading.readDataToEndOfFile().write(to: URL(fileURLWithPath: out + ".child")); exit(0) }
try? "\(ProcessInfo.processInfo.processIdentifier) \(p.processIdentifier)".write(toFile: out, atomically: true, encoding: .utf8)
DispatchQueue.main.asyncAfter(deadline: .now() + 22) { exit(0) }
NSApplication.shared.setActivationPolicy(.prohibited)
NSApplication.shared.run()
