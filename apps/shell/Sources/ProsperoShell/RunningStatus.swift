import Foundation

/// daemon 运行时写的 `~/.prospero/status.json`。文件不存在 = daemon 没跑。
struct RunningStatus: Sendable, Equatable {
  var pid: Int32
  var startedAt: Double
  var port: Int
  var bind: String?
  var sessions: [Session]

  struct Session: Sendable, Equatable, Identifiable {
    var id: String
    var agent: String
    var kind: String
    var title: String
    var cwd: String
    var status: String
    var pendingPermissions: Int
    var busySince: Double?

    /// 会话状态对应的 SF Symbol。等审批要显眼 —— 那是最高频的远程操作。
    var symbolName: String {
      if pendingPermissions > 0 { return "hand.raised.fill" }
      switch status {
      case "running": return "circle.fill"
      case "waiting_approval": return "hand.raised.fill"
      case "idle": return "pause.circle"
      case "done": return "checkmark.circle"
      case "died": return "xmark.circle"
      default: return "circle"
      }
    }

    var statusLabel: String {
      if pendingPermissions > 0 {
        return "待审批 \(pendingPermissions)"
      }
      switch status {
      case "starting": return "启动中"
      case "running": return "运行中"
      case "waiting_approval": return "等待审批"
      case "idle": return "空闲"
      case "done": return "已完成"
      case "died": return "已退出"
      default: return status
      }
    }
  }

  static var fileURL: URL {
    DaemonStatus.home.appendingPathComponent("status.json")
  }

  /// 读不到就是没跑 —— daemon 退出时会删掉这个文件,不会留陈旧快照。
  static func load() -> RunningStatus? {
    guard let data = try? Data(contentsOf: fileURL),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let pid = obj["pid"] as? Int
    else { return nil }

    let rawSessions = obj["sessions"] as? [[String: Any]] ?? []
    return RunningStatus(
      pid: Int32(pid),
      startedAt: obj["startedAt"] as? Double ?? 0,
      port: obj["port"] as? Int ?? 7423,
      bind: obj["bind"] as? String,
      sessions: rawSessions.compactMap { s in
        guard let id = s["id"] as? String else { return nil }
        return Session(
          id: id,
          agent: s["agent"] as? String ?? "?",
          kind: s["kind"] as? String ?? "pty",
          title: s["title"] as? String ?? id,
          cwd: s["cwd"] as? String ?? "",
          status: s["status"] as? String ?? "unknown",
          pendingPermissions: s["pendingPermissions"] as? Int ?? 0,
          busySince: s["busySince"] as? Double
        )
      }
    )
  }

  /// 文件可能是上次崩溃留下的。进程还在才算数。
  var processAlive: Bool { kill(pid, 0) == 0 || errno == EPERM }

  var pendingApprovals: Int { sessions.reduce(0) { $0 + $1.pendingPermissions } }
}
