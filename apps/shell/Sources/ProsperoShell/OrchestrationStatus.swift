import Foundation

/// daemon 落盘的 `~/.prospero/orchestration.json`。
///
/// Mac 壳和 daemon 同机，读快照比再造一条控制通道更可靠；daemon 重启、壳重开后
/// 仍从同一份持久化真相恢复。写操作走 daemon 的回环鉴权接口。
struct OrchestrationStatus: Sendable, Equatable {
  struct Automation: Codable, Sendable, Equatable {
    var state: String
    var agent: String
    var approvalPolicy: String
    var workspace: String
    var cwd: String
    var workspacePath: String
    var branch: String?
    var startedAt: Double
    var updatedAt: Double
    var lastError: String?
  }

  struct Run: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var objective: String
    var status: String
    var coordinatorSessionId: String?
    /// 旧 daemon 的快照没有此字段，按 0 处理。
    var graphRevision: Int?
    /// 旧 daemon 没有此字段；nil 表示仍由人逐个派发。
    var automation: Automation?
    var createdAt: Double
    var updatedAt: Double
  }

  struct Task: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var runId: String
    var title: String
    var spec: String
    var deps: [String]
    var parentId: String?
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
    var worktreePath: String?
    var state: String
    var startedAt: Double
    var settledAt: Double?
    var outcome: String?
  }

  /// 已登记的工作树独立于 Run/Dispatch 历史；Run 删除后仍要让用户能检查和清理它。
  struct WorktreeInspection: Codable, Sendable, Equatable {
    var state: String
    var targetRef: String
    var checkedAt: Double
    var pathExists: Bool
    var registered: Bool?
    var dirty: Bool?
    var branch: String?
    var aheadCommitCount: Int?
    var equivalentCommitCount: Int?
    var message: String?
  }

  struct WorktreeCleanup: Codable, Sendable, Equatable {
    var removedAt: Double
    var branchDeleted: Bool
    var warning: String?
  }

  struct WorktreeAsset: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var kind: String
    var runId: String
    var taskId: String?
    var dispatchId: String?
    var repo: String
    var path: String
    var branch: String?
    var state: String
    var createdAt: Double
    var updatedAt: Double
    var runDeletedAt: Double?
    var lastInspection: WorktreeInspection?
    var cleanup: WorktreeCleanup?
    var legacy: Bool
    var lastError: String?
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
  var worktreeAssets: [WorktreeAsset] = []
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
      worktreeAssets: (stored.worktreeAssets ?? [:]).values.sorted { $0.updatedAt > $1.updatedAt },
      gates: stored.gates.values.sorted { $0.createdAt > $1.createdAt }
    )
  }

  private struct Stored: Codable {
    var runs: [String: Run] = [:]
    var tasks: [String: Task] = [:]
    var dispatches: [String: Dispatch] = [:]
    /// v1 状态文件没有该键；缺失时不能让整个编排快照解码失败。
    var worktreeAssets: [String: WorktreeAsset]?
    var gates: [String: Gate] = [:]
  }
}

/// The warning is pure so the UI and regression tests keep legacy automation
/// paths visible when an older daemon has not supplied asset records yet.
func orchestrationRunDeletionNotice(
  assets: [OrchestrationStatus.WorktreeAsset],
  tasks: [OrchestrationStatus.Task],
  automation: OrchestrationStatus.Automation?
) -> String {
  let preservedAssets = assets.filter { $0.state != "cleaned" }
  if !preservedAssets.isEmpty {
    let workerCount = preservedAssets.filter { $0.kind == "worker" }.count
    let locations = preservedAssets.map { asset in
      let task = asset.taskId.flatMap { id in tasks.first { $0.id == id } }
      let owner = asset.kind == "run"
        ? "共享 Run 工作树"
        : "worker：\(task?.title ?? asset.taskId ?? "已删除任务")"
      return "\(owner)\n\(asset.path)"
    }.joined(separator: "\n\n")
    return "\n\n删除编排不会清理全部 \(preservedAssets.count) 个关联工作树（其中 \(workerCount) 个 worker 工作树）。它们会保留在主机上：\n\(locations)"
  }

  guard assets.isEmpty,
        automation?.workspace == "run",
        let workspacePath = automation?.workspacePath,
        !workspacePath.isEmpty
  else { return "" }
  return "\n\n删除编排不会清理自动 Run 工作树。它会保留在主机上：\n\(workspacePath)"
}

/// Mac 可视化编辑器里的本地节点；id 在一次发布内稳定，用来表达依赖关系。
struct OrchestrationGraphDraftNode: Identifiable, Sendable, Equatable {
  var id: String = UUID().uuidString
  var title: String
  var spec: String
  var deps: Set<String> = []
}
