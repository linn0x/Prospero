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
      let deduped = stored.compactMap { raw -> String? in
        let path = Self.normalizePath(raw)
        return seen.insert(path).inserted ? path : nil
      }
      // 编排 worker 的隔离工作树曾经也被当成项目记下来:本机实测 96 个书签里
      // 有 87 个是它们。工作树是一次性的,daemon 建、daemon 收,书签栏留着它们
      // 只会把真实项目挤出视野 —— 一律清掉,真实项目一个不动。
      paths = deduped.filter { !Self.isWorktreePath($0) }
      if paths != deduped { persist() }
    } else {
      paths = []
    }
  }

  /// 工作树是 daemon 造的临时目录,由它自己回收 —— 书签栏不该替它记住这些路径。
  ///
  /// 判定只认默认布局 `<父目录>/.prospero-worktrees/<仓库名>/<工作树名>`。
  /// 设了 ESAYTREE_ROOT 的自定义根目录这里看不出来,那种情况下退回旧行为:
  /// 记下来、但也仅仅是多一个书签。
  nonisolated static func isWorktreePath(_ path: String) -> Bool {
    URL(fileURLWithPath: path).pathComponents.contains(".prospero-worktrees")
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
  ///
  /// 唯独工作树不记:每派发一个 worker 就会多出一个,任务做完目录就被回收,
  /// 留下的书签指向一个不存在的地方。它们仍然会因为「有活着的会话」而出现在
  /// 列表里(summaries 会为活跃会话的 cwd 临时建组),只是不再沉淀成书签。
  func rememberSessionDirectories(_ rawPaths: [String]) {
    var next = paths
    var seen = Set(next)
    for rawPath in rawPaths {
      let path = Self.normalizePath(rawPath)
      guard !path.isEmpty, !Self.isWorktreePath(path), seen.insert(path).inserted else { continue }
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

  /// 每个会话的 cwd 只归一化一次。
  ///
  /// 以前这里是 `orderedPaths.map { sessions.filter { normalizePath($0.cwd) == path } }`,
  /// 也就是 O(项目数 × 会话数) 次 `normalizePath` —— 而 normalizePath 里的
  /// `URL.standardizedFileURL` 并不便宜(实测 ~3.3 µs/次)。20 个项目 × 40 个会话时,
  /// 光这一个函数就要 4 ms。先分组再映射,归一化次数降到 O(会话数)。
  func summaries(for sessions: [RunningStatus.Session]) -> [LocalProjectSummary] {
    // 按会话原有顺序分组,保持与旧 filter 实现一致的组内次序。
    var grouped: [String: [RunningStatus.Session]] = [:]
    var discoveredPaths: [String] = []
    var seen = Set(paths)
    for session in sessions {
      let path = Self.normalizePath(session.cwd)
      guard !path.isEmpty else { continue }
      grouped[path, default: []].append(session)
      if seen.insert(path).inserted { discoveredPaths.append(path) }
    }
    return (paths + discoveredPaths).map { path in
      LocalProjectSummary(path: path, sessions: grouped[path] ?? [])
    }
  }

  private func persist() {
    guard let data = try? JSONEncoder().encode(paths) else { return }
    UserDefaults.standard.set(data, forKey: Self.defaultsKey)
  }
}
