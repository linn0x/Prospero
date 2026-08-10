import Foundation

/// daemon 落盘的 `~/.prospero/orchestration.json`。
///
/// Mac 壳和 daemon 同机，读快照比再造一条控制通道更可靠；daemon 重启、壳重开后
/// 仍从同一份持久化真相恢复。写操作（Gate 决策）仍走 daemon 的回环鉴权接口。
struct OrchestrationStatus: Sendable, Equatable {
  struct Run: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var objective: String
    var status: String
    var coordinatorSessionId: String?
    var createdAt: Double
    var updatedAt: Double
  }

  struct Task: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var runId: String
    var title: String
    var status: String
    var result: String?
    var createdAt: Double
    var updatedAt: Double
  }

  struct Dispatch: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var runId: String
    var taskId: String
    var sessionId: String
    var state: String
    var startedAt: Double
    var settledAt: Double?
  }

  struct Gate: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var runId: String
    var taskId: String?
    var question: String
    var options: [String]
    var status: String
    var decision: String?
    var createdAt: Double
    var resolvedAt: Double?
  }

  var runs: [Run] = []
  var tasks: [Task] = []
  var dispatches: [Dispatch] = []
  var gates: [Gate] = []

  static var fileURL: URL {
    DaemonStatus.home.appendingPathComponent("orchestration.json")
  }

  static func load() -> OrchestrationStatus {
    guard let data = try? Data(contentsOf: fileURL),
          let stored = try? JSONDecoder().decode(Stored.self, from: data)
    else { return OrchestrationStatus() }
    return OrchestrationStatus(
      runs: stored.runs.values.sorted { $0.updatedAt > $1.updatedAt },
      tasks: stored.tasks.values.sorted { $0.createdAt < $1.createdAt },
      dispatches: stored.dispatches.values.sorted { $0.startedAt > $1.startedAt },
      gates: stored.gates.values.sorted { $0.createdAt > $1.createdAt }
    )
  }

  private struct Stored: Codable {
    var runs: [String: Run] = [:]
    var tasks: [String: Task] = [:]
    var dispatches: [String: Dispatch] = [:]
    var gates: [String: Gate] = [:]
  }
}
