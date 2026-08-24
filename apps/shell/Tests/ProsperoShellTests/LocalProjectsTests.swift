@testable import ProsperoShell
import XCTest

/// 侧栏被 worker-task 淹掉过两次:先是工作树被记成书签,清掉书签后又发现
/// 分组根本不来自书签,而是每个会话的 cwd 都会临时建组。两条路径各锁一次。
@MainActor
final class LocalProjectsTests: XCTestCase {
  private func session(cwd: String, status: String, id: String = UUID().uuidString) -> RunningStatus.Session {
    RunningStatus.Session(
      id: id,
      agent: "codex",
      kind: "structured",
      title: "worker",
      cwd: cwd,
      accountId: nil,
      accountName: nil,
      status: status,
      pendingPermissions: 0,
      pendingQuestions: 0,
      busySince: nil,
      createdAt: 0,
      approvalPolicy: nil,
      preview: nil,
      subagents: []
    )
  }

  private let repo = "/Users/dev/Documents/Prospero"
  private var worktree: String {
    "/Users/dev/Documents/.prospero-worktrees/Prospero/worker-task_abc-1"
  }

  func testWorktreePathsAreRecognized() {
    XCTAssertTrue(LocalProjectStore.isWorktreePath(worktree))
    XCTAssertFalse(LocalProjectStore.isWorktreePath(repo))
  }

  func testFinishedWorkerSessionsDoNotCreateProjectGroups() {
    let store = LocalProjectStore()
    let summaries = store.summaries(for: [
      session(cwd: repo, status: "running"),
      session(cwd: worktree, status: "done"),
      session(cwd: worktree, status: "died"),
    ])
    XCTAssertFalse(
      summaries.contains { LocalProjectStore.isWorktreePath($0.path) },
      "收工的 worker 不该在项目栏留下分组"
    )
    XCTAssertEqual(summaries.first { $0.path == repo }?.sessions.count, 1)
  }

  func testLiveWorkerSessionStillReachable() {
    let store = LocalProjectStore()
    let summaries = store.summaries(for: [session(cwd: worktree, status: "running")])
    // 还在跑的 worker 得点得到 —— 需要接管或看它卡在哪。
    XCTAssertEqual(summaries.first { $0.path == worktree }?.sessions.count, 1)
  }

  func testWorktreeDirectoriesAreNotBookmarked() {
    let store = LocalProjectStore()
    let before = store.paths
    store.rememberSessionDirectories([worktree])
    XCTAssertEqual(store.paths, before, "工作树是一次性的,不该沉淀成书签")
  }
}
