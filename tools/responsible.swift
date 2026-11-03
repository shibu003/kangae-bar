// アクセシビリティ等の許可（TCC）が誰に付くか = 「責任を負う process」（responsibility）を測る。W4h-2。
// 使い方: responsible <pid>...   各 pid の responsible pid とその名前を出す（読むだけ）
import AppKit
@_silgen_name("responsibility_get_pid_responsible_for_pid") func responsibility_get_pid_responsible_for_pid(_ pid: pid_t) -> pid_t
for a in CommandLine.arguments.dropFirst() {
    guard let pid = Int32(a) else { continue }
    let r = responsibility_get_pid_responsible_for_pid(pid)
    func name(_ p: pid_t) -> String { NSRunningApplication(processIdentifier: p)?.localizedName ?? (Process.launchPath(of: p) ?? "?") }
    print("pid \(pid) → responsible \(r) (\(name(r)))")
}
extension Process { static func launchPath(of pid: pid_t) -> String? { var buf = [CChar](repeating: 0, count: 4096); return proc_pidpath(pid, &buf, 4096) > 0 ? String(cString: buf) : nil } }
