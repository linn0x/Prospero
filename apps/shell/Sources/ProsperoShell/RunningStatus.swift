import Foundation

/// daemon 运行时写的 `~/.prospero/status.json`。文件不存在 = daemon 没跑。
struct RunningStatus: Sendable, Equatable {
  var pid: Int32
  var startedAt: Double
  /// daemon 加载的代码的构建时间;和磁盘上的 dist 比,能发现"忘了重启"
  var builtAt: Double
  var port: Int
  var bind: String?
  var controlToken: String
  var persistence: Persistence
  var sessions: [Session]

  struct Persistence: Sendable, Equatable {
    var pty: Bool
    var structured: Bool
  }

  struct Session: Sendable, Equatable, Identifiable {
    var id: String
    var agent: String
    var kind: String
    var title: String
    var cwd: String
    var status: String
    var pendingPermissions: Int
    var pendingQuestions: Int
    var busySince: Double?
    var createdAt: Double
    var approvalPolicy: String?
    var preview: String?
    var subagents: [Subagent]

    struct Subagent: Sendable, Equatable, Identifiable {
      var id: String
      var name: String
      var status: String
      var canMessage: Bool
      var preview: String?

      var statusLabel: String {
        switch status {
        case "starting": return "启动中"
        case "running": return "工作中"
        case "waiting_input": return "待回答"
        case "idle": return "可对话"
        case "completed": return "已完成"
        case "failed": return "失败"
        case "stopped": return "已停止"
        default: return status
        }
      }
    }

    var pendingInteractions: Int { pendingPermissions + pendingQuestions }

    /// 会话状态对应的 SF Symbol。等审批要显眼 —— 那是最高频的远程操作。
    var symbolName: String {
      if pendingInteractions > 0 { return "hand.raised.fill" }
      switch status {
      case "running": return "circle.fill"
      case "waiting_approval": return "hand.raised.fill"
      case "waiting_input": return "questionmark.bubble.fill"
      case "idle": return "pause.circle"
      case "done": return "checkmark.circle"
      case "died": return "xmark.circle"
      default: return "circle"
      }
    }

    var statusLabel: String {
      if pendingInteractions > 0 {
        return "待处理 \(pendingInteractions)"
      }
      switch status {
      case "starting": return "启动中"
      case "running": return "运行中"
      case "waiting_approval": return "等待审批"
      case "waiting_input": return "等待回答"
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
      builtAt: obj["builtAt"] as? Double ?? 0,
      port: obj["port"] as? Int ?? 7423,
      bind: obj["bind"] as? String,
      controlToken: obj["controlToken"] as? String ?? "",
      persistence: {
        let raw = obj["persistence"] as? [String: Any]
        return Persistence(
          pty: raw?["pty"] as? Bool ?? false,
          structured: raw?["structured"] as? Bool ?? false
        )
      }(),
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
          pendingQuestions: s["pendingQuestions"] as? Int ?? 0,
          busySince: s["busySince"] as? Double,
          createdAt: s["createdAt"] as? Double ?? 0,
          approvalPolicy: s["approvalPolicy"] as? String,
          preview: s["preview"] as? String,
          subagents: (s["subagents"] as? [[String: Any]] ?? []).compactMap { child in
            guard let childID = child["id"] as? String else { return nil }
            return Session.Subagent(
              id: childID,
              name: child["name"] as? String ?? "子 Agent",
              status: child["status"] as? String ?? "unknown",
              canMessage: child["canMessage"] as? Bool ?? false,
              preview: child["preview"] as? String
            )
          }
        )
      }
    )
  }

  /// 文件可能是上次崩溃留下的。进程还在才算数。
  var processAlive: Bool { kill(pid, 0) == 0 || errno == EPERM }

  var pendingApprovals: Int { sessions.reduce(0) { $0 + $1.pendingInteractions } }

  /// 磁盘上的 daemon 代码是否比正在跑的这份新。
  /// 改完代码忘记重启会让手机侧的新功能被当成非法消息拒掉,而错误信息指不到原因。
  func isStale(cliPath: String?) -> Bool {
    guard builtAt > 0, let cliPath else { return false }
    let dir = URL(fileURLWithPath: cliPath).deletingLastPathComponent()
    let marker = dir.appendingPathComponent("status-file.js")
    guard
      let attrs = try? FileManager.default.attributesOfItem(atPath: marker.path),
      let mtime = attrs[.modificationDate] as? Date
    else { return false }
    // 留 2 秒容差,避免同一次构建里的写入顺序造成误报
    return mtime.timeIntervalSince1970 * 1000 > builtAt + 2000
  }
}
