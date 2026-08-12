import Foundation
import Observation

/// Mac 工作台里的项目就是一个规范化后的工作目录。项目列表单独持久化，
/// 因而最后一个会话结束后，用户仍然可以从项目重新启动 Agent。
struct LocalProjectSummary: Identifiable, Sendable, Equatable {
  let path: String
  let sessions: [RunningStatus.Session]

  var id: String { path }

  var name: String {
    if path == "/" { return "/" }
    let component = URL(fileURLWithPath: path).lastPathComponent
    return component.isEmpty ? path : component
  }

  var activeCount: Int {
    sessions.reduce(0) { count, session in
      switch session.status {
      case "starting", "running", "waiting_approval", "waiting_input": count + 1
      default: count
      }
    }
  }

  var pendingCount: Int {
    sessions.reduce(0) { $0 + $1.pendingInteractions }
  }
}

@MainActor
@Observable
final class LocalProjectStore {
  private(set) var paths: [String]

  private static let defaultsKey = "localAgentProjectPaths"

  init() {
    if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
       let stored = try? JSONDecoder().decode([String].self, from: data) {
      var seen = Set<String>()
      paths = stored.compactMap { raw in
        let path = Self.normalizePath(raw)
        return seen.insert(path).inserted ? path : nil
      }
    } else {
      paths = []
    }
  }

  /// 不解析符号链接，只统一 `~`、`.` 与尾部斜杠；展示和 daemon 使用同一路径语义。
  nonisolated static func normalizePath(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "" }
    let expanded = (trimmed as NSString).expandingTildeInPath
    let normalized = URL(fileURLWithPath: expanded).standardizedFileURL.path
    return normalized.isEmpty ? "/" : normalized
  }

  func add(_ rawPath: String) {
    let path = Self.normalizePath(rawPath)
    guard !path.isEmpty else { return }
    var next = paths.filter { $0 != path }
    next.insert(path, at: 0)
    paths = next
    persist()
  }

  /// 会话可能由手机或 CLI 创建；看到新的 cwd 时也记为 Mac 项目。
  func rememberSessionDirectories(_ rawPaths: [String]) {
    var next = paths
    var seen = Set(next)
    for rawPath in rawPaths {
      let path = Self.normalizePath(rawPath)
      guard !path.isEmpty, seen.insert(path).inserted else { continue }
      next.append(path)
    }
    guard next != paths else { return }
    paths = next
    persist()
  }

  /// 只移除工作台书签，不触碰项目文件。仍有会话的目录会继续显示。
  func remove(_ rawPath: String) {
    let path = Self.normalizePath(rawPath)
    let next = paths.filter { $0 != path }
    guard next != paths else { return }
    paths = next
    persist()
  }

  func summaries(for sessions: [RunningStatus.Session]) -> [LocalProjectSummary] {
    var orderedPaths = paths
    var seen = Set(orderedPaths)
    for session in sessions {
      let path = Self.normalizePath(session.cwd)
      guard !path.isEmpty, seen.insert(path).inserted else { continue }
      orderedPaths.append(path)
    }
    return orderedPaths.map { path in
      LocalProjectSummary(
        path: path,
        sessions: sessions.filter { Self.normalizePath($0.cwd) == path }
      )
    }
  }

  private func persist() {
    guard let data = try? JSONEncoder().encode(paths) else { return }
    UserDefaults.standard.set(data, forKey: Self.defaultsKey)
  }
}
