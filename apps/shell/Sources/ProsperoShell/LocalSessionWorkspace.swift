import AppKit
import SwiftUI
import WebKit

/// 项目是 Mac 工作台的第一层；会话只在其工作目录所属的项目下出现。
struct ProjectRail: View {
  let projects: [LocalProjectSummary]
  @Binding var selectedProjectPath: String?
  let addProject: () -> Void
  let newSession: (LocalProjectSummary) -> Void
  let removeProject: (LocalProjectSummary) -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
          Text("项目")
            .font(.headline)
          Text("\(projects.count) 个工作目录")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Button(action: addProject) {
          Image(systemName: "folder.badge.plus")
        }
        .buttonStyle(.borderless)
        .help("添加项目")
      }
      .padding(.horizontal, 13)
      .padding(.vertical, 12)

      Divider()

      if projects.isEmpty {
        VStack(spacing: 10) {
          Image(systemName: "folder")
            .font(.title2)
            .foregroundStyle(.tertiary)
          Text("还没有项目")
            .font(.callout.weight(.medium))
          Button("选择文件夹…", action: addProject)
            .buttonStyle(.link)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(16)
      } else {
        ScrollView {
          LazyVStack(spacing: 6) {
            ForEach(projects) { project in
              Button {
                selectedProjectPath = project.path
              } label: {
                ProjectRailRow(
                  project: project,
                  selected: selectedProjectPath == project.path
                )
              }
              .buttonStyle(.plain)
              .contextMenu {
                Button("新建会话") { newSession(project) }
                Button("在 Finder 中显示") {
                  NSWorkspace.shared.activateFileViewerSelecting([
                    URL(fileURLWithPath: project.path),
                  ])
                }
                Divider()
                Button("从项目列表移除", role: .destructive) {
                  removeProject(project)
                }
                .disabled(!project.sessions.isEmpty)
              }
            }
          }
          .padding(9)
        }
      }
    }
    .background(Color(nsColor: .windowBackgroundColor))
  }
}

private struct ProjectRailRow: View {
  let project: LocalProjectSummary
  let selected: Bool
  /// 独立项目栏不需要展示折叠状态；合并栏传入后才显示箭头。
  var expanded: Bool? = nil

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: selected ? "folder.fill" : "folder")
        .font(.title3)
        .foregroundStyle(selected ? Color.accentColor : .secondary)
        .frame(width: 25)
      VStack(alignment: .leading, spacing: 4) {
        Text(project.name)
          .font(.callout.weight(selected ? .semibold : .medium))
          .lineLimit(1)
        HStack(spacing: 5) {
          Text(project.path)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer(minLength: 3)
          if project.activeCount > 0 {
            Label(String(project.activeCount), systemImage: "bolt.fill")
              .foregroundStyle(.green)
          } else {
            Text("\(project.sessions.count)")
          }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
      }
      if project.pendingCount > 0 {
        Text(String(project.pendingCount))
          .font(.caption2.weight(.bold))
          .foregroundStyle(.orange)
          .padding(.horizontal, 6)
          .padding(.vertical, 3)
          .background(.orange.opacity(0.13), in: Capsule())
      }
      if let expanded {
        Image(systemName: expanded ? "chevron.down" : "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tertiary)
          .frame(width: 12)
      }
    }
    .padding(9)
    .background(
      selected ? Color.accentColor.opacity(0.12) : Color.clear,
      in: RoundedRectangle(cornerRadius: 9)
    )
    .contentShape(RoundedRectangle(cornerRadius: 9))
  }
}

/// Orca 式的“左侧会话、右侧工作区”，但把 Agent 身份和等待人处理的状态放到视觉第一层。
struct SessionRail: View {
  let projectName: String
  let sessions: [RunningStatus.Session]
  @Binding var selectedSessionID: String?
  let newSession: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
          Text("会话")
            .font(.headline)
          Text("\(projectName) · \(sessions.count) 个")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        let waiting = sessions.reduce(0) { $0 + $1.pendingInteractions }
        if waiting > 0 {
          Label(String(waiting), systemImage: "hand.raised.fill")
            .font(.caption.weight(.bold))
            .foregroundStyle(.orange)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.orange.opacity(0.12), in: Capsule())
        }
        Button(action: newSession) {
          Image(systemName: "plus")
        }
        .buttonStyle(.borderless)
        .help("在 \(projectName) 中新建 Agent CLI")
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 12)

      Divider()

      if sessions.isEmpty {
        VStack(spacing: 8) {
          Image(systemName: "terminal")
            .font(.title2)
            .foregroundStyle(.tertiary)
          Text("还没有会话")
            .font(.callout.weight(.medium))
          Button("新建会话", action: newSession)
            .buttonStyle(.link)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(16)
      } else {
        ScrollView {
          LazyVStack(spacing: 7) {
            ForEach(sessions) { session in
              Button {
                selectedSessionID = session.id
              } label: {
                SessionRailRow(
                  session: session,
                  selected: selectedSessionID == session.id
                )
              }
              .buttonStyle(.plain)
            }
          }
          .padding(10)
        }
      }
    }
    // 侧栏和工作区共用窗口表面；只用选中态区分会话，避免出现一列一层底色。
    .background(Color(nsColor: .windowBackgroundColor))
  }
}

/// 把「项目」和「会话」收进同一条工作台侧栏。
///
/// 外层已经有全局导航；再把项目与会话拆成两列，会让一个普通会话页变成四栏，
/// 终端反而没有足够的横向空间。项目作为分组标题，会话在其下缩进展示，既保留
/// 项目归属，也让 Mac 的主视图始终把空间留给 CLI。
struct ProjectSessionSidebar: View {
  let projects: [LocalProjectSummary]
  @Binding var selectedProjectPath: String?
  @Binding var selectedSessionID: String?
  @Binding var expandedProjectPaths: Set<String>
  let addProject: () -> Void
  let newSession: (LocalProjectSummary) -> Void
  let removeProject: (LocalProjectSummary) -> Void

  private var selectedProject: LocalProjectSummary? {
    guard let selectedProjectPath else { return nil }
    return projects.first { $0.path == selectedProjectPath }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
          Text("项目与会话")
            .font(.headline)
          Text("\(projects.count) 个工作目录")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Button(action: addProject) {
          Image(systemName: "folder.badge.plus")
        }
        .buttonStyle(.borderless)
        .help("添加项目")
        if let selectedProject {
          Button {
            newSession(selectedProject)
          } label: {
            Image(systemName: "plus")
          }
          .buttonStyle(.borderless)
          .help("在 \(selectedProject.name) 中新建 Agent CLI")
        }
      }
      .padding(.horizontal, 13)
      .padding(.vertical, 12)

      Divider()

      if projects.isEmpty {
        VStack(spacing: 10) {
          Image(systemName: "folder")
            .font(.title2)
            .foregroundStyle(.tertiary)
          Text("还没有项目")
            .font(.callout.weight(.medium))
          Button("选择文件夹…", action: addProject)
            .buttonStyle(.link)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(16)
      } else {
        ScrollView {
          LazyVStack(spacing: 7) {
            ForEach(projects) { project in
              projectSection(project)
            }
          }
          .padding(9)
        }
      }
    }
    .background(Color(nsColor: .windowBackgroundColor))
  }

  @ViewBuilder
  private func projectSection(_ project: LocalProjectSummary) -> some View {
    let selected = selectedProjectPath == project.path
    let expanded = expandedProjectPaths.contains(project.path)
    VStack(spacing: 5) {
      Button {
        if selected {
          if expanded {
            expandedProjectPaths.remove(project.path)
          } else {
            expandedProjectPaths.insert(project.path)
          }
        } else {
          selectedProjectPath = project.path
          expandedProjectPaths.insert(project.path)
        }
      } label: {
        ProjectRailRow(project: project, selected: selected, expanded: expanded)
      }
      .buttonStyle(.plain)
      .help(expanded ? "收起 \(project.name) 会话" : "展开 \(project.name) 会话")
      .contextMenu {
        Button("新建会话") { newSession(project) }
        Button("在 Finder 中显示") {
          NSWorkspace.shared.activateFileViewerSelecting([
            URL(fileURLWithPath: project.path),
          ])
        }
        Divider()
        Button("从项目列表移除", role: .destructive) {
          removeProject(project)
        }
        .disabled(!project.sessions.isEmpty)
      }

      if expanded {
        if project.sessions.isEmpty {
          Button("新建会话") { newSession(project) }
            .buttonStyle(.link)
            .font(.caption)
            .padding(.vertical, 8)
        } else {
          LazyVStack(spacing: 5) {
            ForEach(project.sessions) { session in
              Button {
                selectedProjectPath = project.path
                selectedSessionID = session.id
              } label: {
                SessionRailRow(
                  session: session,
                  selected: selectedSessionID == session.id
                )
              }
              .buttonStyle(.plain)
            }
          }
          .padding(.leading, 10)
        }
      }
    }
  }
}

private struct SessionRailRow: View {
  let session: RunningStatus.Session
  let selected: Bool

  private var accent: Color { AgentVisuals.statusColor(session) }

  var body: some View {
    HStack(spacing: 10) {
      AgentAvatar(agent: session.agent, size: 34, active: AgentVisuals.isActive(session))
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Text(AgentVisuals.name(session.agent))
            .font(.caption.weight(.semibold))
            .foregroundStyle(accent)
          if session.kind == "pty" {
            Text("CLI")
              .font(.system(size: 8, weight: .bold, design: .rounded))
              .foregroundStyle(.secondary)
              .padding(.horizontal, 4)
              .padding(.vertical, 2)
              .background(.quaternary, in: RoundedRectangle(cornerRadius: 3))
          } else {
            Text("移动端对话")
              .font(.system(size: 8, weight: .bold, design: .rounded))
              .foregroundStyle(.secondary)
              .padding(.horizontal, 4)
              .padding(.vertical, 2)
              .background(.quaternary, in: RoundedRectangle(cornerRadius: 3))
          }
        }
        Text(session.preview?.isEmpty == false ? session.preview! : session.title)
          .font(.callout.weight(selected ? .semibold : .regular))
          .foregroundStyle(.primary)
          .lineLimit(2)
        HStack(spacing: 5) {
          Circle().fill(accent).frame(width: 6, height: 6)
          Text(AgentVisuals.shortStatus(session))
            .font(.caption2.weight(session.pendingInteractions > 0 ? .semibold : .regular))
            .foregroundStyle(session.pendingInteractions > 0 ? accent : .secondary)
          Spacer(minLength: 4)
          Text(URL(fileURLWithPath: session.cwd).lastPathComponent)
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
      }
    }
    .padding(10)
    .background(
      selected ? Color.accentColor.opacity(0.12) : Color.clear,
      in: RoundedRectangle(cornerRadius: 11)
    )
    .overlay {
      RoundedRectangle(cornerRadius: 11)
        .stroke(
          session.pendingInteractions > 0 ? accent.opacity(0.55) : Color.clear,
          lineWidth: 1
        )
    }
    .contentShape(RoundedRectangle(cornerRadius: 11))
  }
}

struct LocalSessionWorkspace: View {
  @Bindable var daemon: DaemonController
  let session: RunningStatus.Session
  let interrupt: () -> Void
  let kill: () -> Void

  @State private var timeline = ChatTimeline()
  @State private var terminalFrame: TerminalRenderFrame?
  @State private var lastTerminalSeq: Int?
  @State private var daemonPID: Int32?
  @State private var loadError: String?
  @State private var actionError: String?
  @State private var draft = ""
  @State private var sending = false
  @State private var pendingActions: Set<String> = []
  @State private var selectedSubagent: ChatTimeline.Subagent?

  private var accent: Color { AgentVisuals.statusColor(session) }
  private var terminalPort: Int { daemon.running?.port ?? 7423 }

  var body: some View {
    VStack(spacing: 0) {
      workspaceHeader
      Divider()

      if session.pendingInteractions > 0 {
        attentionBanner
      }

      Group {
        if session.kind == "pty" {
          terminalWorkspace
        } else {
          structuredWorkspace
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)

      if let loadError {
        Divider()
        Label(loadError, systemImage: "wifi.exclamationmark")
          .font(.caption)
          .foregroundStyle(.orange)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .task(id: "\(session.id):\(daemon.running?.pid ?? 0)") {
      await refreshLoop()
    }
    .sheet(item: $selectedSubagent) { subagent in
      LocalSubagentWorkspace(
        daemon: daemon,
        sessionID: session.id,
        subagentID: String(subagent.id.dropFirst("subagent:".count)),
        subagentName: subagent.name
      )
    }
    .alert("会话操作失败", isPresented: Binding(
      get: { actionError != nil },
      set: { if !$0 { actionError = nil } }
    )) {
      Button("好") { actionError = nil }
    } message: {
      Text(actionError ?? "未知错误")
    }
  }

  private var workspaceHeader: some View {
    HStack(spacing: 13) {
      AgentAvatar(agent: session.agent, size: 42, active: AgentVisuals.isActive(session))
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text(AgentVisuals.name(session.agent))
            .font(.headline)
          Text(session.kind == "structured" ? "Chat" : "Shell · CLI")
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(.quaternary, in: Capsule())
          if session.kind == "pty" {
            Label("滚轮查看历史", systemImage: "clock.arrow.circlepath")
              .font(.caption2)
              .foregroundStyle(.tertiary)
              .help("滚轮进入 tmux 历史，q 返回；Option + 拖动选择文本")
          }
          if let policy = session.approvalPolicy {
            Text(AgentVisuals.policyName(policy))
              .font(.caption2.weight(.medium))
              .foregroundStyle(policy == "yolo" ? .orange : .secondary)
          }
        }
        HStack(spacing: 7) {
          Circle().fill(accent).frame(width: 7, height: 7)
          Text(session.statusLabel)
            .font(.caption.weight(.semibold))
            .foregroundStyle(accent)
          Text("·")
            .foregroundStyle(.tertiary)
          Text(session.cwd)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 12)
      Button {
        NSWorkspace.shared.open(URL(fileURLWithPath: session.cwd))
      } label: {
        Label("目录", systemImage: "folder")
      }
      .buttonStyle(.borderless)
      Button(action: interrupt) {
        Label("停止本轮", systemImage: "stop.circle")
      }
      .buttonStyle(.bordered)
      .tint(.orange)
      .disabled(!AgentVisuals.canInterrupt(session))
      Menu {
        Button("结束并删除会话", role: .destructive, action: kill)
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .menuStyle(.borderlessButton)
      .fixedSize()
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 12)
  }

  private var attentionBanner: some View {
    HStack(spacing: 11) {
      Image(systemName: session.pendingPermissions > 0 ? "hand.raised.fill" : "questionmark.bubble.fill")
        .font(.title3)
        .foregroundStyle(.orange)
      VStack(alignment: .leading, spacing: 2) {
        Text(session.pendingPermissions > 0 ? "\(AgentVisuals.name(session.agent)) 正在等待你的批准" : "\(AgentVisuals.name(session.agent)) 需要你的回答")
          .font(.callout.weight(.bold))
        Text("处理后 Agent 会自动继续，不需要重新发送提示。")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
      Text("待处理 \(session.pendingInteractions)")
        .font(.caption.weight(.bold))
        .foregroundStyle(.orange)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(.orange.opacity(0.13), in: Capsule())
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 11)
    .background(.orange.opacity(0.08))
    .overlay(alignment: .bottom) { Rectangle().fill(.orange.opacity(0.24)).frame(height: 1) }
  }

  @ViewBuilder
  private var structuredWorkspace: some View {
    ChatTimelineView(
      timeline: timeline,
      actions: ChatTimelineActions(
        send: sendChat,
        respondToPermission: { requestID, reply in respondPermission(requestID, reply: reply) },
        respondToQuestion: { requestID, answers, cancelled in
          respondQuestion(requestID, answers: answers, cancelled: cancelled)
        },
        loadToolOutput: loadToolOutput,
        openSubagent: openSubagent,
        isPending: { pendingActions.contains($0) }
      ),
      draft: $draft,
      isSending: sending,
      sendEnabled: daemon.running?.controlToken.isEmpty == false
    )
  }

  private var terminalWorkspace: some View {
    ZStack {
      Color(red: 0.035, green: 0.035, blue: 0.043)
      if let terminalFrame {
        MacTerminalSurface(
          port: terminalPort,
          sessionID: session.id,
          frame: terminalFrame,
          input: { dataB64 in
            await daemon.sendLocalTerminalInput(id: session.id, dataB64: dataB64)
          },
          inputError: { error in
            actionError = error
          },
          resize: { cols, rows in
            await daemon.resizeLocalTerminal(id: session.id, cols: cols, rows: rows)
          },
          resync: {
            lastTerminalSeq = nil
          }
        )
        .id(terminalPort)
      } else if loadError == nil {
        ProgressView("正在载入终端…")
          .tint(.white)
          .foregroundStyle(.white)
      } else {
        ContentUnavailableView(
          "无法载入终端",
          systemImage: "terminal",
          description: Text("保持会话内容不变，正在自动重试。")
        )
        .foregroundStyle(.white)
      }
    }
  }

  private func refreshLoop() async {
    var failedAttempts = 0
    while !Task.isCancelled {
      var receivedTerminalFrame = false
      do {
        if session.kind == "structured" {
          try await refreshStructuredTimeline()
        } else if let frame = try await daemon.loadLocalTerminalFrame(id: session.id, afterSeq: lastTerminalSeq) {
          receivedTerminalFrame = true
          switch frame {
          case .terminalSnapshot(let seq, let ansi, let cols, let rows):
            lastTerminalSeq = seq
            terminalFrame = .snapshot(seq: seq, ansi: ansi, cols: cols, rows: rows)
          case .terminalDelta(let baseSeq, let seq, let dataB64):
            guard lastTerminalSeq == baseSeq else {
              lastTerminalSeq = nil
              throw LocalSessionControlFailure("终端增量游标不连续，正在重新同步")
            }
            lastTerminalSeq = seq
            terminalFrame = .output(baseSeq: baseSeq, seq: seq, dataB64: dataB64)
          }
        }
        loadError = nil
        failedAttempts = 0
      } catch {
        loadError = error.localizedDescription
        failedAttempts = min(failedAttempts + 1, 5)
      }
      do {
        let delay: Int
        if failedAttempts > 0 {
          delay = min(8_000, 450 * (1 << failedAttempts))
        } else if session.kind == "pty" {
          // New daemons have already waited server-side; this tiny yield lets
          // SwiftUI hand the frame to xterm before the next local long poll.
          // Older daemons return 204 immediately, so 50 ms also avoids a spin.
          delay = receivedTerminalFrame ? 8 : 50
        } else {
          delay = 450
        }
        try await Task.sleep(for: .milliseconds(delay))
      } catch {
        return
      }
    }
  }

  private func refreshStructuredTimeline() async throws {
    let currentPID = daemon.running?.pid
    if daemonPID != currentPID {
      // A new daemon may have a lower event sequence. Its snapshot is authoritative and replaces
      // the retained UI only after a valid response arrives, so a transient restart keeps content.
      let snapshot = try await daemon.loadLocalStructuredSnapshot(id: session.id)
      timeline.reset(with: snapshot)
      daemonPID = currentPID
      return
    }
    let frame: LocalStructuredFrame?
    do {
      frame = try await daemon.loadLocalStructuredFrame(id: session.id, afterSeq: timeline.evSeq)
    } catch let failure as LocalSessionControlFailure where failure.message.contains("结构化会话增量") {
      // A malformed or discontinuous delta is never retried against the same cursor. Ask for the
      // authoritative snapshot immediately; if that fails, the outer loop retains existing UI and
      // backs off normally.
      timeline.reset(with: try await daemon.loadLocalStructuredSnapshot(id: session.id))
      return
    }
    guard let frame else {
      return // HTTP 204; no state mutation means no redraw.
    }
    switch frame {
    case .snapshot(let snapshot):
      timeline.reset(with: snapshot)
    case .delta(let delta):
      guard delta.baseSeq == timeline.evSeq else {
        // Never blend a reply for an old cursor into the visible transcript. The next request gets
        // an authoritative snapshot if the gap came from truncation or a daemon restart.
        timeline.reset(with: try await daemon.loadLocalStructuredSnapshot(id: session.id))
        return
      }
      for (offset, body) in delta.events.enumerated() {
        let result = timeline.apply(.init(evSeq: delta.baseSeq + offset + 1, body: body))
        if case .gap = result {
          timeline.reset(with: try await daemon.loadLocalStructuredSnapshot(id: session.id))
          return
        }
      }
    }
  }

  private func sendChat(_ value: String) {
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !sending else { return }
    draft = ""
    sending = true
    Task {
      if let error = await daemon.sendLocalChat(id: session.id, text: text) {
        draft = text
        actionError = error
      }
      sending = false
    }
  }

  private func respondPermission(_ requestID: String, reply: ChatPermissionReply) {
    let actionID = "permission:\(requestID)"
    guard pendingActions.insert(actionID).inserted else { return }
    Task {
      defer { pendingActions.remove(actionID) }
      if let error = await daemon.respondLocalPermission(
        id: session.id,
        requestID: requestID,
        reply: reply.rawValue
      ) {
        actionError = error
      }
    }
  }

  private func respondQuestion(
    _ requestID: String,
    answers: [ChatQuestionAnswer],
    cancelled: Bool
  ) {
    let actionID = "question:\(requestID)"
    guard pendingActions.insert(actionID).inserted else { return }
    Task {
      defer { pendingActions.remove(actionID) }
      if let error = await daemon.respondLocalQuestion(
        id: session.id,
        requestID: requestID,
        answers: cancelled ? [] : answers.map { ($0.questionID, $0.values) },
        cancelled: cancelled
      ) {
        actionError = error
      }
    }
  }

  private func loadToolOutput(_ callID: String) {
    let actionID = "tool:\(callID)"
    guard pendingActions.insert(actionID).inserted else { return }
    Task {
      defer { pendingActions.remove(actionID) }
      do {
        let result = try await daemon.loadLocalToolOutput(id: session.id, callID: callID)
        timeline.setToolOutput(callID: callID, output: result.output, truncated: result.truncated)
      } catch {
        actionError = error.localizedDescription
      }
    }
  }

  private func openSubagent(_ id: String) {
    let entryID = "subagent:\(id)"
    guard let entry = timeline.entries.first(where: { $0.id == entryID }), case .subagent(let child) = entry else {
      actionError = "这个子 Agent 已不在当前会话中"
      return
    }
    selectedSubagent = child
  }
}

/// Child conversations intentionally use the same `ChatTimeline` reducer and cards as the parent.
/// The endpoint currently supplies snapshots, so equal `evSeq` responses are ignored to avoid
/// recreating the visible child transcript on every polling pass.
private struct LocalSubagentWorkspace: View {
  @Bindable var daemon: DaemonController
  let sessionID: String
  let subagentID: String
  let subagentName: String

  @Environment(\.dismiss) private var dismiss
  @State private var timeline: ChatTimeline
  @State private var loadError: String?
  @State private var draft = ""

  init(daemon: DaemonController, sessionID: String, subagentID: String, subagentName: String) {
    self.daemon = daemon
    self.sessionID = sessionID
    self.subagentID = subagentID
    self.subagentName = subagentName
    _timeline = State(initialValue: ChatTimeline(scope: .subagent(subagentID)))
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "person.2.fill").foregroundStyle(.tint)
        VStack(alignment: .leading, spacing: 2) {
          Text(subagentName).font(.headline)
          Text("子 Agent 过程").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Button("完成") { dismiss() }
          .keyboardShortcut(.cancelAction)
      }
      .padding(.horizontal, 18)
      .padding(.vertical, 14)
      Divider()

      ChatTimelineView(
        timeline: timeline,
        showsComposer: false,
        draft: $draft
      )

      if let loadError {
        Divider()
        Label(loadError, systemImage: "wifi.exclamationmark")
          .font(.caption)
          .foregroundStyle(.orange)
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .frame(minWidth: 640, idealWidth: 820, minHeight: 520, idealHeight: 680)
    .task(id: "\(sessionID):\(subagentID):\(daemon.running?.pid ?? 0)") {
      await refreshLoop()
    }
  }

  private func refreshLoop() async {
    var failures = 0
    while !Task.isCancelled {
      do {
        let snapshot = try await daemon.loadLocalSubagentSnapshot(
          sessionID: sessionID,
          subagentID: subagentID
        )
        if snapshot.evSeq != timeline.evSeq || timeline.entries.isEmpty != snapshot.events.isEmpty {
          timeline.reset(with: snapshot)
        }
        loadError = nil
        failures = 0
      } catch {
        // A temporary read failure never clears the last usable child transcript.
        loadError = error.localizedDescription
        failures = min(failures + 1, 5)
      }
      do {
        try await Task.sleep(for: .milliseconds(min(8_000, 800 * (1 << failures))))
      } catch {
        return
      }
    }
  }
}

/// A compact identity treatment shared by the session list and the child-process sheet.
struct SubagentIdentityBadge: View {
  let subagent: RunningStatus.Session.Subagent
  var compact = false

  private var isActive: Bool {
    subagent.status == "running" || subagent.status == "starting"
  }

  private var tint: Color {
    if subagent.status == "failed" { return .red }
    if subagent.status == "waiting_input" { return .orange }
    return isActive ? .blue : .secondary
  }

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(tint).frame(width: 7, height: 7)
      Text(subagent.name)
        .font(compact ? .caption.weight(.semibold) : .callout.weight(.semibold))
        .lineLimit(1)
      if !compact, let role = subagent.role, !role.isEmpty, role != subagent.name {
        Text(role).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
      }
    }
    .padding(.horizontal, compact ? 8 : 10)
    .padding(.vertical, compact ? 4 : 6)
    .background(tint.opacity(0.10), in: Capsule())
    .overlay(Capsule().stroke(tint.opacity(0.25), lineWidth: 1))
  }
}

private struct AgentAvatar: View {
  let agent: String
  let size: CGFloat
  let active: Bool

  private var color: Color { AgentVisuals.agentColor(agent) }

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.28)
        .fill(
          LinearGradient(
            colors: [color.opacity(0.95), color.opacity(0.58)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
      Text(AgentVisuals.monogram(agent))
        .font(.system(size: size * 0.34, weight: .black, design: .rounded))
        .foregroundStyle(.white)
      if active {
        Circle()
          .fill(.green)
          .frame(width: max(8, size * 0.23), height: max(8, size * 0.23))
          .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 2))
          .offset(x: size * 0.38, y: size * 0.38)
      }
    }
    .frame(width: size, height: size)
    .shadow(color: color.opacity(active ? 0.24 : 0.08), radius: active ? 5 : 2, y: 2)
  }
}

private enum AgentVisuals {
  static func name(_ agent: String) -> String {
    switch agent {
    case "codex": "Codex"
    case "claude": "Claude Code"
    case "opencode": "OpenCode"
    case "grok": "Grok"
    case "trae": "Trae"
    case "shell": "Shell"
    default: agent.capitalized
    }
  }

  static func monogram(_ agent: String) -> String {
    switch agent {
    case "codex": "CX"
    case "claude": "CL"
    case "opencode": "OC"
    case "grok": "GR"
    case "trae": "TR"
    case "shell": ">_"
    default: String(agent.prefix(2)).uppercased()
    }
  }

  static func agentColor(_ agent: String) -> Color {
    switch agent {
    case "codex": Color(red: 0.16, green: 0.55, blue: 0.45)
    case "claude": Color(red: 0.82, green: 0.39, blue: 0.22)
    case "opencode": Color(red: 0.34, green: 0.42, blue: 0.86)
    case "grok": Color(red: 0.36, green: 0.36, blue: 0.40)
    case "trae": Color(red: 0.52, green: 0.34, blue: 0.86)
    default: Color(red: 0.20, green: 0.52, blue: 0.82)
    }
  }

  static func statusColor(_ session: RunningStatus.Session) -> Color {
    if session.pendingInteractions > 0 { return .orange }
    switch session.status {
    case "running", "starting": return .blue
    case "waiting_approval", "waiting_input": return .orange
    case "died": return .red
    case "completed": return .green
    default: return .secondary
    }
  }

  static func shortStatus(_ session: RunningStatus.Session) -> String {
    if session.pendingPermissions > 0 { return "等待批准 \(session.pendingPermissions)" }
    if session.pendingQuestions > 0 { return "等待回答 \(session.pendingQuestions)" }
    return session.statusLabel
  }

  static func isActive(_ session: RunningStatus.Session) -> Bool {
    session.status == "running" || session.status == "starting"
  }

  static func canInterrupt(_ session: RunningStatus.Session) -> Bool {
    !["idle", "completed", "done", "died"].contains(session.status)
  }

  static func policyName(_ policy: String) -> String {
    switch policy {
    case "strict": "严格审批"
    case "yolo": "YOLO"
    default: "标准审批"
    }
  }
}

enum TerminalRenderFrame: Equatable {
  case snapshot(seq: Int, ansi: String, cols: Int, rows: Int)
  case output(baseSeq: Int, seq: Int, dataB64: String)

  var seq: Int {
    switch self {
    case .snapshot(let seq, _, _, _): seq
    case .output(_, let seq, _): seq
    }
  }
}

/// 复用手机端已经验证过的 xterm 页面。画面和输入都留在 Mac App 内，
/// daemon 只提供静态页面；会话数据仍走带本机 control token 的接口。
private struct MacTerminalSurface: NSViewRepresentable {
  let port: Int
  let sessionID: String
  let frame: TerminalRenderFrame
  let input: @MainActor (String) async -> String?
  let inputError: @MainActor (String) -> Void
  let resize: @MainActor (Int, Int) async -> String?
  let resync: @MainActor () -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(input: input, inputError: inputError, resize: resize, resync: resync)
  }

  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    let bridge = """
      window.ReactNativeWebView = {
        postMessage: function(message) {
          window.webkit.messageHandlers.prospero.postMessage(message);
        }
      };
      """
    configuration.userContentController.addUserScript(
      WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    )
    configuration.userContentController.add(context.coordinator, name: "prospero")
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.setValue(false, forKey: "drawsBackground")
    context.coordinator.webView = webView
    if let url = URL(string: "http://127.0.0.1:\(port)/term.html") {
      webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }
    context.coordinator.push(frame)
    return webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    context.coordinator.input = input
    context.coordinator.inputError = inputError
    context.coordinator.resize = resize
    context.coordinator.resync = resync
    context.coordinator.push(frame)
  }

  static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
    coordinator.cancel()
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "prospero")
    webView.stopLoading()
  }

  @MainActor
  final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    weak var webView: WKWebView?
    var input: @MainActor (String) async -> String?
    var inputError: @MainActor (String) -> Void
    var resize: @MainActor (Int, Int) async -> String?
    var resync: @MainActor () -> Void
    private var ready = false
    private var pendingFrames: [TerminalRenderFrame] = []
    private var renderedSeq: Int?
    private var rendering = false
    private var pendingInput = Data()
    private var inputTask: Task<Void, Never>?
    private var pendingResize: (cols: Int, rows: Int)?
    private var resizeTask: Task<Void, Never>?

    init(
      input: @escaping @MainActor (String) async -> String?,
      inputError: @escaping @MainActor (String) -> Void,
      resize: @escaping @MainActor (Int, Int) async -> String?,
      resync: @escaping @MainActor () -> Void
    ) {
      self.input = input
      self.inputError = inputError
      self.resize = resize
      self.resync = resync
    }

    func userContentController(
      _ userContentController: WKUserContentController,
      didReceive message: WKScriptMessage
    ) {
      guard
        let raw = message.body as? String,
        let data = raw.data(using: .utf8),
        let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let kind = body["kind"] as? String
      else { return }
      switch kind {
      case "ready":
        ready = true
        // The shared page waits for its host-provided font before fitting. The
        // mobile host already sends this; without it Mac stayed at the launch
        // default 120x40 no matter how the window was resized.
        sendControl(["kind": "font", "size": 13])
        sendControl(["kind": "focus"])
        // tmux mouse mode owns ordinary pointer events so wheel gestures can
        // enter copy-mode. On macOS xterm requires this explicit option to
        // retain a native text-selection gesture alongside it.
        webView?.evaluateJavaScript("term.options.macOptionClickForcesSelection = true;")
        webView?.window?.makeFirstResponder(webView)
        drainFrames()
      case "input":
        if let dataB64 = body["data"] as? String { enqueueInput(dataB64) }
      case "resized":
        if let cols = body["cols"] as? Int, let rows = body["rows"] as? Int,
           (10...500).contains(cols), (5...300).contains(rows) {
          enqueueResize(cols: cols, rows: rows)
        }
      default:
        break
      }
    }

    func push(_ frame: TerminalRenderFrame) {
      switch frame {
      case .snapshot:
        // A snapshot is authoritative after attach, a ring gap or daemon
        // restart. Discard queued deltas from the superseded cursor.
        pendingFrames = [frame]
      case .output:
        if renderedSeq == frame.seq || pendingFrames.last?.seq == frame.seq { return }
        pendingFrames.append(frame)
      }
      drainFrames()
    }

    func cancel() {
      inputTask?.cancel()
      inputTask = nil
      resizeTask?.cancel()
      resizeTask = nil
      pendingInput.removeAll()
      pendingResize = nil
      pendingFrames.removeAll()
    }

    private func enqueueInput(_ dataB64: String) {
      guard let bytes = Data(base64Encoded: dataB64), !bytes.isEmpty else { return }
      pendingInput.append(bytes)
      guard inputTask == nil else { return }
      inputTask = Task { @MainActor [weak self] in
        // Coalesce key bursts/paste into one ordered local request. The old
        // per-key detached Tasks could race and deliver typed bytes out of order.
        await Task.yield()
        while let self, !self.pendingInput.isEmpty, !Task.isCancelled {
          let payload = self.pendingInput
          self.pendingInput.removeAll(keepingCapacity: true)
          if let error = await self.input(payload.base64EncodedString()) {
            self.inputError(error)
          }
        }
        self?.inputTask = nil
      }
    }

    private func enqueueResize(cols: Int, rows: Int) {
      pendingResize = (cols, rows)
      guard resizeTask == nil else { return }
      resizeTask = Task { @MainActor [weak self] in
        // Window drags can produce overlapping HTTP tasks. Keep only the
        // latest pending geometry and deliver each request in order so an old
        // response cannot resize tmux after a newer one.
        while let self, let next = self.pendingResize, !Task.isCancelled {
          self.pendingResize = nil
          if let error = await self.resize(next.cols, next.rows) {
            self.inputError(error)
          }
        }
        self?.resizeTask = nil
      }
    }

    private func drainFrames() {
      guard ready, !rendering, let webView, !pendingFrames.isEmpty else { return }
      let frame = pendingFrames.removeFirst()
      let message: [String: Any]
      switch frame {
      case .snapshot(_, let ansi, let cols, let rows):
        message = ["kind": "snapshot", "ansi": ansi, "cols": cols, "rows": rows]
      case .output(let baseSeq, _, let dataB64):
        guard renderedSeq == baseSeq else {
          pendingFrames.removeAll()
          resync()
          return
        }
        message = ["kind": "output", "dataB64": dataB64]
      }
      guard
        let data = try? JSONSerialization.data(withJSONObject: message),
        let json = String(data: data, encoding: .utf8),
        let quotedData = try? JSONEncoder().encode(json),
        let quoted = String(data: quotedData, encoding: .utf8)
      else { return }
      rendering = true
      webView.evaluateJavaScript("window.__rx(\(quoted));") { [weak self] _, error in
        Task { @MainActor in
          guard let self else { return }
          self.rendering = false
          if error == nil {
            self.renderedSeq = frame.seq
          } else {
            self.pendingFrames.removeAll()
            self.resync()
          }
          self.drainFrames()
        }
      }
    }

    private func sendControl(_ message: [String: Any]) {
      guard ready, let webView,
            let data = try? JSONSerialization.data(withJSONObject: message),
            let json = String(data: data, encoding: .utf8),
            let quotedData = try? JSONEncoder().encode(json),
            let quoted = String(data: quotedData, encoding: .utf8)
      else { return }
      webView.evaluateJavaScript("window.__rx(\(quoted));")
    }
  }
}
