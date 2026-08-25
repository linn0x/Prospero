import AppKit
import SwiftUI
import WebKit

/// 项目是 Mac 工作台的第一层；会话只在其工作目录所属的项目下出现。
private struct ProjectRailRow: View {
  let project: LocalProjectSummary
  let selected: Bool
  /// 独立项目栏不需要展示折叠状态；合并栏传入后才显示箭头。
  var expanded: Bool? = nil

  var body: some View {
    HStack(spacing: 7) {
      Image(systemName: selected ? "folder.fill" : "folder")
        .font(.system(size: 11))
        .foregroundStyle(selected ? Color.accentColor : .secondary)
        .frame(width: 14)
      Text(project.name)
        .font(.system(size: 12, weight: selected ? .semibold : .medium))
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 4)
      if project.pendingCount > 0 {
        Text(String(project.pendingCount))
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(.orange)
          .padding(.horizontal, 5)
          .padding(.vertical, 2)
          .background(.orange.opacity(0.16), in: Capsule())
      } else if project.activeCount > 0 {
        Label(String(project.activeCount), systemImage: "bolt.fill")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(.green)
      } else {
        Text("\(project.sessions.count)")
          .font(.system(size: 9))
          .foregroundStyle(.tertiary)
      }
      if let expanded {
        Image(systemName: expanded ? "chevron.down" : "chevron.right")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(.tertiary)
          .frame(width: 9)
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(
      selected ? Color.accentColor.opacity(0.14) : Color.clear,
      in: RoundedRectangle(cornerRadius: 7)
    )
    .contentShape(RoundedRectangle(cornerRadius: 7))
    // 完整路径挪进 tooltip:侧栏里每行都印一遍全路径,是最占宽度又最少被读的一列。
    .help(project.path)
  }
}

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
      HStack(spacing: 6) {
        Text("项目与会话")
          .font(.system(size: 12, weight: .semibold))
        Text("\(projects.count)")
          .font(.system(size: 10))
          .foregroundStyle(.tertiary)
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
      .padding(.horizontal, 10)
      .padding(.vertical, 8)

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
          LazyVStack(spacing: 3) {
            ForEach(projects) { project in
              projectSection(project)
            }
          }
          .padding(.horizontal, 6)
          .padding(.vertical, 7)
        }
      }
    }
    .background(Color(nsColor: .windowBackgroundColor))
  }

  @ViewBuilder
  private func projectSection(_ project: LocalProjectSummary) -> some View {
    let selected = selectedProjectPath == project.path
    let expanded = expandedProjectPaths.contains(project.path)
    VStack(spacing: 3) {
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
          LazyVStack(spacing: 3) {
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
          .padding(.leading, 12)
        }
      }
    }
  }
}

private struct SessionRailRow: View {
  let session: RunningStatus.Session
  let selected: Bool

  private var accent: Color { AgentVisuals.statusColor(session) }
  private var title: String {
    session.preview?.isEmpty == false ? session.preview! : session.title
  }

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      AgentAvatar(agent: session.agent, size: 22, active: AgentVisuals.isActive(session))
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 5) {
          // Agent 名不再单独占一行:头像的字母和配色已经说明了是谁,
          // 而预览文本里通常也带着它。
          Text(title)
            .font(
              session.kind == "pty"
                ? .system(size: 11, weight: selected ? .semibold : .regular, design: .monospaced)
                : .system(size: 11.5, weight: selected ? .semibold : .regular)
            )
            .foregroundStyle(.primary)
            .lineLimit(1)
          Spacer(minLength: 2)
          Text(session.kind == "pty" ? "tmux" : "chat")
            .font(.system(size: 8.5, weight: .bold, design: .monospaced))
            .foregroundStyle(session.kind == "pty" ? TerminalPalette.green : Color.secondary)
        }
        HStack(spacing: 4) {
          Circle().fill(accent).frame(width: 5, height: 5)
          Text(AgentVisuals.shortStatus(session))
            .font(.system(size: 9.5, weight: session.pendingInteractions > 0 ? .semibold : .regular))
            .foregroundStyle(session.pendingInteractions > 0 ? accent : .secondary)
            .lineLimit(1)
        }
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .background(
      selected ? Color.accentColor.opacity(0.14) : Color.clear,
      in: RoundedRectangle(cornerRadius: 8)
    )
    .overlay {
      RoundedRectangle(cornerRadius: 8)
        .stroke(
          session.pendingInteractions > 0 ? accent.opacity(0.55) : Color.clear,
          lineWidth: 1
        )
    }
    .contentShape(RoundedRectangle(cornerRadius: 8))
    // 工作目录不再逐行重复 —— 会话本来就挂在项目节点下面。截断掉的预览给 tooltip。
    .help(title)
  }
}

struct LocalSessionWorkspace: View {
  @Bindable var daemon: DaemonController
  let session: RunningStatus.Session
  let interrupt: () -> Void
  let kill: () -> Void
  /// 只有以 sheet 弹出时(账号登录终端)才给:sheet 没有标题栏关闭键,而 PTY 会话里
  /// Esc 属于 Agent 的 TUI,不能拿去当取消键 —— 于是必须留一个显式的出口。
  var close: (() -> Void)? = nil

  @State private var timeline = ChatTimeline()
  /// 终端帧走旁路,不做 @State:见 TerminalFrameStream 的说明。
  @State private var terminalStream = TerminalFrameStream()
  /// 仅用于"首帧到达后把占位换成终端",一次性翻转,不随每帧变化。
  @State private var terminalReady = false
  @State private var daemonPID: Int32?
  @State private var loadError: String?
  @State private var actionError: String?
  @State private var draft = ""
  @State private var sending = false
  @State private var pendingActions: Set<String> = []
  @State private var selectedSubagent: ChatTimeline.Subagent?

  /// 专注模式:两侧边栏让位,终端占满窗口。三处视图绑同一个键,
  /// 头部按下时侧栏那边会跟着变 —— UserDefaults 在这里就是那根共享的线。
  @AppStorage("focusTerminal") private var focusTerminal = false

  private var accent: Color { AgentVisuals.statusColor(session) }
  private var terminalPort: Int { daemon.running?.port ?? 7423 }
  /// PTY 会话整块走终端配色:头部、提示条、错误条与画面同一片深色。
  /// 以前是一条浅色系统外壳直接压在 #1a1b26 上,中间那道色缝正好横在视线里。
  /// 结构化会话是文档式界面,继续用系统浅色。
  private var terminalMode: Bool { session.kind == "pty" }

  var body: some View {
    VStack(spacing: 0) {
      workspaceHeader
      if terminalMode {
        TerminalPalette.border.frame(height: 1)
      } else {
        Divider()
      }

      if session.pendingInteractions > 0 {
        attentionBanner
      }

      Group {
        if terminalMode {
          terminalWorkspace
        } else {
          structuredWorkspace
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)

      if let loadError {
        if terminalMode {
          TerminalPalette.border.frame(height: 1)
        } else {
          Divider()
        }
        Label(loadError, systemImage: "wifi.exclamationmark")
          .font(.caption)
          .foregroundStyle(terminalMode ? TerminalPalette.yellow : .orange)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background { if terminalMode { TerminalPalette.surface } }
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
    HStack(spacing: 12) {
      AgentAvatar(
        agent: session.agent,
        size: terminalMode ? 30 : 42,
        active: AgentVisuals.isActive(session)
      )
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 7) {
          Text(AgentVisuals.name(session.agent))
            .font(terminalMode ? .system(size: 13, weight: .semibold) : .headline)
            .foregroundStyle(terminalMode ? TerminalPalette.foreground : .primary)
          if terminalMode {
            TerminalBadge(text: "tmux", tint: TerminalPalette.green)
              .help("zsh 终端：⌘C/⌘V 复制粘贴，⌥←/⌥→ 按词移动；滚轮进入 tmux 历史，q 返回；⌥ 拖动直接选择")
          } else {
            Text("Chat")
              .font(.caption2.weight(.medium))
              .foregroundStyle(.secondary)
              .padding(.horizontal, 7)
              .padding(.vertical, 3)
              .background(.quaternary, in: Capsule())
          }
          if let policy = session.approvalPolicy {
            Text(AgentVisuals.policyName(policy))
              .font(.caption2.weight(.medium))
              .foregroundStyle(policyTint(policy))
          }
        }
        HStack(spacing: 6) {
          Circle().fill(accent).frame(width: 6, height: 6)
          Text(session.statusLabel)
            .font(.caption.weight(.semibold))
            .foregroundStyle(accent)
          Text("·")
            .foregroundStyle(terminalMode ? AnyShapeStyle(TerminalPalette.dim) : AnyShapeStyle(.tertiary))
          // 终端里路径用等宽:它和画面里的 prompt 是同一件东西,对齐了才像一体。
          Text(session.cwd)
            .font(terminalMode ? .system(size: 11, design: .monospaced) : .caption)
            .foregroundStyle(terminalMode ? TerminalPalette.dim : .secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 12)
      if terminalMode { terminalHeaderActions } else { standardHeaderActions }
    }
    .padding(.horizontal, terminalMode ? 14 : 18)
    .padding(.vertical, terminalMode ? 9 : 12)
    .background { if terminalMode { TerminalPalette.surface } }
  }

  private func policyTint(_ policy: String) -> Color {
    guard policy == "yolo" else { return terminalMode ? TerminalPalette.dim : .secondary }
    return terminalMode ? TerminalPalette.yellow : .orange
  }

  /// 终端头部的控件全部走 chip 样式:系统 `.bordered` 会在深色上画出一块浅灰板。
  @ViewBuilder
  private var terminalHeaderActions: some View {
    Button {
      NSWorkspace.shared.open(URL(fileURLWithPath: session.cwd))
    } label: {
      Image(systemName: "folder")
    }
    .buttonStyle(TerminalChipButtonStyle(tint: TerminalPalette.secondary))
    .help("在 Finder 中打开工作目录")

    Button(action: interrupt) {
      Label("停止本轮", systemImage: "stop.circle")
    }
    .buttonStyle(TerminalChipButtonStyle(tint: TerminalPalette.yellow))
    .disabled(!AgentVisuals.canInterrupt(session))

    if close == nil {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) { focusTerminal.toggle() }
      } label: {
        Image(
          systemName: focusTerminal
            ? "arrow.down.right.and.arrow.up.left"
            : "arrow.up.left.and.arrow.down.right"
        )
      }
      // 快捷键只挂在工具栏那颗上:两处声明同一个 key equivalent 会打架。
      .buttonStyle(TerminalChipButtonStyle(tint: focusTerminal ? TerminalPalette.cyan : TerminalPalette.secondary))
      .help(focusTerminal ? "退出专注模式(⇧⌘F)" : "专注模式:隐藏侧栏,终端占满窗口(⇧⌘F)")
    }

    Menu {
      Button("结束并删除会话", role: .destructive, action: kill)
    } label: {
      Image(systemName: "ellipsis")
        .foregroundStyle(TerminalPalette.secondary)
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()

    if let close {
      Button("完成", action: close)
        .buttonStyle(TerminalChipButtonStyle(tint: TerminalPalette.blue, filled: true))
    }
  }

  @ViewBuilder
  private var standardHeaderActions: some View {
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

    if let close {
      Button("完成", action: close)
        .buttonStyle(.borderedProminent)
    }
  }

  private var attentionBanner: some View {
    HStack(spacing: 11) {
      Image(systemName: session.pendingPermissions > 0 ? "hand.raised.fill" : "questionmark.bubble.fill")
        .font(.title3)
        .foregroundStyle(attentionTint)
      VStack(alignment: .leading, spacing: 2) {
        Text(session.pendingPermissions > 0 ? "\(AgentVisuals.name(session.agent)) 正在等待你的批准" : "\(AgentVisuals.name(session.agent)) 需要你的回答")
          .font(.callout.weight(.bold))
          .foregroundStyle(terminalMode ? TerminalPalette.foreground : .primary)
        Text("处理后 Agent 会自动继续，不需要重新发送提示。")
          .font(.caption)
          .foregroundStyle(terminalMode ? TerminalPalette.secondary : .secondary)
      }
      Spacer()
      Text("待处理 \(session.pendingInteractions)")
        .font(.caption.weight(.bold))
        .foregroundStyle(attentionTint)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(attentionTint.opacity(0.13), in: Capsule())
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 11)
    .background(attentionTint.opacity(terminalMode ? 0.14 : 0.08))
    .overlay(alignment: .bottom) {
      Rectangle().fill(attentionTint.opacity(0.24)).frame(height: 1)
    }
  }

  private var attentionTint: Color { terminalMode ? TerminalPalette.yellow : .orange }

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
      // 与 term.html 的 xterm 主题同色,窗口留白不会在终端周围露出一圈异色。
      TerminalPalette.background
      if terminalReady {
        MacTerminalSurface(
          port: terminalPort,
          sessionID: session.id,
          stream: terminalStream,
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
            terminalStream.resync()
          }
        )
        .id(terminalPort)
      } else if loadError == nil {
        // 等首帧的这一两秒里,别让用户盯着一块纯黑。给一行等宽提示,
        // 和终端里将要出现的内容是同一种语言。
        VStack(spacing: 10) {
          ProgressView()
            .controlSize(.small)
            .tint(TerminalPalette.blue)
          Text("正在接入 tmux 会话…")
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(TerminalPalette.dim)
        }
      } else {
        VStack(spacing: 10) {
          Image(systemName: "terminal")
            .font(.system(size: 30))
            .foregroundStyle(TerminalPalette.dim)
          Text("无法载入终端")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(TerminalPalette.foreground)
          Text("会话内容留在 tmux 里没有丢,正在自动重试。")
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(TerminalPalette.dim)
        }
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
        } else if let frame = try await daemon.loadLocalTerminalFrame(
          id: session.id, afterSeq: terminalStream.lastSeq
        ) {
          receivedTerminalFrame = true
          switch frame {
          case .terminalSnapshot(let seq, let ansi, let cols, let rows):
            terminalStream.lastSeq = seq
            terminalStream.push(.snapshot(seq: seq, ansi: ansi, cols: cols, rows: rows))
          case .terminalDelta(let baseSeq, let seq, let dataB64):
            guard terminalStream.lastSeq == baseSeq else {
              terminalStream.resync()
              throw LocalSessionControlFailure("终端增量游标不连续，正在重新同步")
            }
            terminalStream.lastSeq = seq
            terminalStream.push(.output(baseSeq: baseSeq, seq: seq, dataB64: dataB64))
          }
          // 只有首帧会改状态;之后每帧都只是引用类型内部的流动,不重建视图。
          if !terminalReady { terminalReady = true }
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

/// 终端帧的旁路通道:从长轮询直接送到 WebView,不经过 SwiftUI 状态。
///
/// 之前 terminalFrame / lastTerminalSeq 都是 LocalSessionWorkspace 上的 @State。
/// tmux 里没有本地回显 —— 每敲一个字符都要绕一圈回来才显示,于是每个字符都
/// 触发一次整个工作区视图体(侧栏、头部、输入框、终端)的重新求值。打字越快
/// 帧越密,重建越频繁,表现就是"输入很多字符时卡卡的"。
///
/// 引用类型在这里是关键:视图只持有一个不变的引用,帧的流动不再是状态变化。
@MainActor
final class TerminalFrameStream {
  /// 长轮询游标。属于循环自身的进度,不是 UI 状态。
  var lastSeq: Int?

  private weak var sink: TerminalFrameSink?
  /// WebView 要等首帧到达后才创建,在此之前的帧先存下来,不能丢。
  private var buffered: [TerminalRenderFrame] = []

  func attach(_ sink: TerminalFrameSink) {
    self.sink = sink
    let queued = buffered
    buffered.removeAll()
    for frame in queued { sink.push(frame) }
  }

  func push(_ frame: TerminalRenderFrame) {
    if let sink { sink.push(frame) } else { buffered.append(frame) }
  }

  /// 游标不连续时重新拉快照;缓冲里的旧帧已被新快照取代。
  func resync() {
    lastSeq = nil
    buffered.removeAll()
  }
}

/// TerminalFrameStream 的下游。由 MacTerminalSurface.Coordinator 实现。
@MainActor
protocol TerminalFrameSink: AnyObject {
  func push(_ frame: TerminalRenderFrame)
}

enum MacTerminalShortcut: Equatable {
  case copy
  case paste
  case selectAll
  case clear
  case beginningOfLine
  case endOfLine
  case deleteToBeginning
  case deleteToEnd

  init?(event: NSEvent) {
    guard event.type == .keyDown else { return nil }
    let modifiers = event.modifierFlags.intersection([.command, .shift, .option, .control])
    guard modifiers == .command else { return nil }
    switch event.keyCode {
    case 123, 126: self = .beginningOfLine // ⌘← / ⌘↑
    case 124, 125: self = .endOfLine       // ⌘→ / ⌘↓
    case 51: self = .deleteToBeginning    // ⌘⌫
    case 117: self = .deleteToEnd         // ⌘⌦
    default:
      switch event.charactersIgnoringModifiers?.lowercased() {
      case "c": self = .copy
      case "v": self = .paste
      case "a": self = .selectAll
      case "k": self = .clear
      default: return nil
      }
    }
  }
}

/// WKWebView normally forwards pasteboard key equivalents through its hidden
/// editor view, but that route is unreliable once xterm owns focus. Intercept
/// only the standard terminal commands; every Ctrl/Option/TUI key still goes
/// through xterm and the PTY unchanged.
@MainActor
private final class MacTerminalWebView: WKWebView {
  var terminalShortcut: ((MacTerminalShortcut) -> Void)?

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    guard let shortcut = MacTerminalShortcut(event: event) else {
      return super.performKeyEquivalent(with: event)
    }
    terminalShortcut?(shortcut)
    return true
  }
}

/// 复用手机端已经验证过的 xterm 页面。画面和输入都留在 Mac App 内，
/// daemon 只提供静态页面；会话数据仍走带本机 control token 的接口。
private struct MacTerminalSurface: NSViewRepresentable {
  let port: Int
  let sessionID: String
  let stream: TerminalFrameStream
  let input: @MainActor (String) async -> String?
  let inputError: @MainActor (String) -> Void
  let resize: @MainActor (Int, Int) async -> String?
  let resync: @MainActor () -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(input: input, inputError: inputError, resize: resize, resync: resync)
  }

  func makeNSView(context: Context) -> MacTerminalWebView {
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
    let webView = MacTerminalWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.setValue(false, forKey: "drawsBackground")
    webView.terminalShortcut = { [weak coordinator = context.coordinator] shortcut in
      coordinator?.perform(shortcut)
    }
    context.coordinator.webView = webView
    if let url = URL(string: "http://127.0.0.1:\(port)/term.html") {
      webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }
    // 帧从此直接进 Coordinator,不再经过 SwiftUI 的 updateNSView。
    stream.attach(context.coordinator)
    return webView
  }

  func updateNSView(_ webView: MacTerminalWebView, context: Context) {
    context.coordinator.input = input
    context.coordinator.inputError = inputError
    context.coordinator.resize = resize
    context.coordinator.resync = resync
  }

  static func dismantleNSView(_ webView: MacTerminalWebView, coordinator: Coordinator) {
    coordinator.cancel()
    webView.terminalShortcut = nil
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "prospero")
    webView.stopLoading()
  }

  @MainActor
  final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, TerminalFrameSink {
    weak var webView: MacTerminalWebView?
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
      case "clipboardCopy":
        if let text = body["text"] as? String { copyToPasteboard(text) }
      case "clipboardPaste":
        pasteFromPasteboard()
      case "resized":
        if let cols = body["cols"] as? Int, let rows = body["rows"] as? Int,
           (10...500).contains(cols), (5...300).contains(rows) {
          enqueueResize(cols: cols, rows: rows)
        }
      default:
        break
      }
    }

    func perform(_ shortcut: MacTerminalShortcut) {
      switch shortcut {
      case .copy:
        copySelection()
      case .paste:
        pasteFromPasteboard()
      case .selectAll:
        sendControl(["kind": "selectAll"])
        sendControl(["kind": "toast", "text": "已选择终端内容"])
      case .clear:
        sendControl(["kind": "clear"])
        enqueueText("\u{0c}") // zsh clear-screen; TUI 会按自己的语义重绘
        sendControl(["kind": "toast", "text": "已清屏"])
      case .beginningOfLine:
        enqueueText("\u{01}") // zsh beginning-of-line
      case .endOfLine:
        enqueueText("\u{05}") // zsh end-of-line
      case .deleteToBeginning:
        enqueueText("\u{15}") // zsh backward-kill-line
      case .deleteToEnd:
        enqueueText("\u{0b}") // zsh kill-line
      }
    }

    private func copySelection() {
      webView?.evaluateJavaScript("term.hasSelection() ? term.getSelection() : ''") {
        [weak self] result, _ in
        Task { @MainActor in
          guard let self else { return }
          guard let text = result as? String, !text.isEmpty else {
            self.sendControl(["kind": "toast", "text": "按住 ⌥ 拖动选择文本"])
            return
          }
          self.copyToPasteboard(text)
        }
      }
    }

    private func copyToPasteboard(_ text: String) {
      guard !text.isEmpty else { return }
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
      sendControl(["kind": "toast", "text": "已复制"])
    }

    private func pasteFromPasteboard() {
      guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else {
        sendControl(["kind": "toast", "text": "剪贴板为空"])
        return
      }
      // Let xterm's public paste API add bracketed-paste markers when zsh or a
      // TUI requested them; writing raw bytes here would lose that protection.
      sendControl(["kind": "paste", "text": text])
      sendControl(["kind": "toast", "text": "已粘贴"])
    }

    private func enqueueText(_ text: String) {
      enqueueInput(Data(text.utf8).base64EncodedString())
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
      // 一次过桥送完所有已排队的帧。evaluateJavaScript 要把数据序列化两遍、
      // 拼成 JS 源码再交给引擎 eval,每帧都付一次这笔开销;而页面侧的 handle
      // 本来就是按批调用的。输出洪峰(或快速打字的逐字回显)下差别最明显。
      var messages: [[String: Any]] = []
      var cursor = renderedSeq
      var renderedTo: Int?
      drain: while let frame = pendingFrames.first {
        switch frame {
        case .snapshot(let seq, let ansi, let cols, let rows):
          messages.append(["kind": "snapshot", "ansi": ansi, "cols": cols, "rows": rows])
          cursor = seq
          renderedTo = seq
        case .output(let baseSeq, let seq, let dataB64):
          guard cursor == baseSeq else {
            // 第一帧就断链:整段作废,重新拉快照。若前面已攒到有效帧,
            // 先把它们送出去,断链的那帧留到下一轮按同样规则处理。
            if messages.isEmpty {
              pendingFrames.removeAll()
              resync()
              return
            }
            break drain
          }
          messages.append(["kind": "output", "dataB64": dataB64])
          cursor = seq
          renderedTo = seq
        }
        pendingFrames.removeFirst()
      }
      guard let renderedTo, !messages.isEmpty else { return }
      guard
        let data = try? JSONSerialization.data(withJSONObject: messages),
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
            self.renderedSeq = renderedTo
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
