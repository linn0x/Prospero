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
                Button("新建 CLI 会话") { newSession(project) }
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
          Button("新建 CLI", action: newSession)
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
  let openSubagent: (RunningStatus.Session.Subagent) -> Void

  @State private var transcript: SubagentTranscript?
  @State private var interactions = LocalSessionInteractions.empty
  @State private var terminalFrame: TerminalRenderFrame?
  @State private var lastSeq: Int?
  @State private var loadError: String?
  @State private var actionError: String?
  @State private var draft = ""
  @State private var sending = false

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
    .task(id: session.id) { await refreshLoop() }
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
          Text(session.kind == "structured" ? "Chat UI" : "Shell · CLI")
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(.quaternary, in: Capsule())
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
    VStack(spacing: 0) {
      if transcript?.events.isEmpty != false {
        ContentUnavailableView(
          "\(AgentVisuals.name(session.agent)) 已就绪",
          systemImage: "sparkles",
          description: Text("在下方输入任务，Prospero 会直接投递给 Code Agent。")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if let transcript {
        AgentTranscriptList(transcript: transcript)
      }

      if !interactions.permissions.isEmpty || !interactions.questions.isEmpty {
        Divider()
        ScrollView {
          VStack(spacing: 10) {
            ForEach(interactions.permissions) { prompt in
              LocalPermissionCard(prompt: prompt) { reply in
                respondPermission(prompt, reply: reply)
              }
            }
            ForEach(interactions.questions) { prompt in
              LocalQuestionCard(prompt: prompt) { answers, cancelled in
                respondQuestion(prompt, answers: answers, cancelled: cancelled)
              }
            }
          }
          .padding(12)
        }
        .frame(maxHeight: 280)
      }

      Divider()
      AgentComposer(
        agentName: AgentVisuals.name(session.agent),
        draft: $draft,
        sending: sending,
        enabled: session.status != "done" && session.status != "died",
        send: sendDraft
      )
    }
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
            Task {
              if let error = await daemon.sendLocalTerminalInput(id: session.id, dataB64: dataB64) {
                actionError = error
              }
            }
          },
          resize: { cols, rows in
            Task { _ = await daemon.resizeLocalTerminal(id: session.id, cols: cols, rows: rows) }
          }
        )
        .id(terminalPort)
      } else if loadError == nil {
        ProgressView("正在载入终端…")
          .tint(.white)
          .foregroundStyle(.white)
      }
    }
  }

  private func refreshLoop() async {
    while !Task.isCancelled {
      do {
        if let frame = try await daemon.loadLocalSessionFrame(id: session.id, knownSeq: lastSeq) {
          lastSeq = frame.seq
          switch frame {
          case .structured(_, let payload):
            transcript = try SubagentTranscript.decode(
              payload,
              agentName: AgentVisuals.name(session.agent)
            )
            interactions = try LocalSessionInteractions.decode(payload)
          case .terminal(let seq, let ansi, let cols, let rows):
            terminalFrame = TerminalRenderFrame(seq: seq, ansi: ansi, cols: cols, rows: rows)
          }
        }
        loadError = nil
      } catch {
        loadError = error.localizedDescription
      }
      do {
        try await Task.sleep(for: .milliseconds(450))
      } catch {
        return
      }
    }
  }

  private func sendDraft() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
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

  private func respondPermission(_ prompt: LocalPermissionPrompt, reply: String) {
    Task {
      if let error = await daemon.respondLocalPermission(
        id: session.id,
        requestID: prompt.requestID,
        reply: reply
      ) {
        actionError = error
      }
    }
  }

  private func respondQuestion(
    _ prompt: LocalQuestionPrompt,
    answers: [(questionID: String, values: [String])],
    cancelled: Bool
  ) {
    Task {
      if let error = await daemon.respondLocalQuestion(
        id: session.id,
        requestID: prompt.requestID,
        answers: answers,
        cancelled: cancelled
      ) {
        actionError = error
      }
    }
  }
}

private struct AgentTranscriptList: View {
  let transcript: SubagentTranscript

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 10) {
          ForEach(transcript.events) { event in
            SubagentTranscriptEventRow(event: event)
              .id(event.id)
          }
          Color.clear.frame(height: 1).id("transcript-bottom")
        }
        .padding(18)
        .frame(maxWidth: 860)
        .frame(maxWidth: .infinity)
      }
      .onChange(of: transcript.evSeq) { _, _ in
        withAnimation(.easeOut(duration: 0.16)) {
          proxy.scrollTo("transcript-bottom", anchor: .bottom)
        }
      }
    }
  }
}

private struct AgentComposer: View {
  let agentName: String
  @Binding var draft: String
  let sending: Bool
  let enabled: Bool
  let send: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 7) {
        Image(systemName: "sparkles")
          .foregroundStyle(.blue)
        Text("发给 \(agentName)")
          .font(.caption.weight(.bold))
        Text("Return 发送")
          .font(.caption2)
          .foregroundStyle(.tertiary)
        Spacer()
      }
      HStack(alignment: .bottom, spacing: 10) {
        TextField("描述任务、补充上下文或继续追问…", text: $draft, axis: .vertical)
          .textFieldStyle(.plain)
          .lineLimit(1...5)
          .font(.body)
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 11))
          .onSubmit(send)
          .disabled(!enabled || sending)
        Button(action: send) {
          Group {
            if sending {
              ProgressView().controlSize(.small)
            } else {
              Image(systemName: "arrow.up")
                .font(.body.weight(.bold))
            }
          }
          .frame(width: 18, height: 18)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!enabled || sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .help("发送给 \(agentName)")
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(Color(nsColor: .windowBackgroundColor))
  }
}

private struct LocalPermissionCard: View {
  let prompt: LocalPermissionPrompt
  let respond: (String) -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Rectangle().fill(.orange.opacity(0.75)).frame(width: 3)
      VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 9) {
        Image(systemName: "hand.raised.fill")
          .foregroundStyle(.orange)
        VStack(alignment: .leading, spacing: 2) {
          Text("需要你的批准")
            .font(.caption.weight(.bold))
            .foregroundStyle(.orange)
          Text(prompt.summary.isEmpty ? prompt.action : prompt.summary)
            .font(.callout.weight(.semibold))
        }
        Spacer()
      }
      if !prompt.resources.isEmpty {
        VStack(alignment: .leading, spacing: 3) {
          ForEach(prompt.resources.prefix(4), id: \.self) { resource in
            Text(resource)
              .font(.system(.caption, design: .monospaced))
              .textSelection(.enabled)
              .lineLimit(3)
          }
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.black.opacity(0.055), in: RoundedRectangle(cornerRadius: 7))
      }
      HStack {
        Button("拒绝", role: .destructive) { respond("reject") }
        Spacer()
        Button("始终允许") { respond("always") }
        Button("允许一次") { respond("once") }
          .buttonStyle(.borderedProminent)
      }
      }
      .padding(.vertical, 12)
    }
    .padding(.leading, 1)
  }
}

private struct LocalQuestionCard: View {
  let prompt: LocalQuestionPrompt
  let respond: ([(questionID: String, values: [String])], Bool) -> Void

  @State private var selections: [String: Set<String>] = [:]
  @State private var other: [String: String] = [:]

  private var answers: [(questionID: String, values: [String])] {
    prompt.questions.map { question in
      var values = Array(selections[question.id] ?? []).sorted()
      if let custom = other[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines),
         !custom.isEmpty {
        values.append(custom)
      }
      return (question.id, values)
    }
  }

  private var ready: Bool { answers.allSatisfy { !$0.values.isEmpty } }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Rectangle().fill(.indigo.opacity(0.75)).frame(width: 3)
      VStack(alignment: .leading, spacing: 12) {
      Label("Agent 需要你的回答", systemImage: "questionmark.bubble.fill")
        .font(.callout.weight(.bold))
        .foregroundStyle(.indigo)
      ForEach(prompt.questions) { question in
        VStack(alignment: .leading, spacing: 8) {
          if !question.header.isEmpty {
            Text(question.header.uppercased())
              .font(.caption2.weight(.bold))
              .foregroundStyle(.secondary)
          }
          Text(question.question)
            .font(.callout.weight(.semibold))
          if !question.options.isEmpty {
            FlowLayout(spacing: 7) {
              ForEach(question.options) { option in
                let selected = selections[question.id]?.contains(option.label) == true
                Button {
                  toggle(option.label, for: question)
                } label: {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).font(.caption.weight(.semibold))
                    if let detail = option.detail, !detail.isEmpty {
                      Text(detail).font(.caption2).foregroundStyle(.secondary)
                    }
                  }
                  .padding(.horizontal, 9)
                  .padding(.vertical, 7)
                  .background(
                    selected ? Color.indigo.opacity(0.14) : Color.secondary.opacity(0.07),
                    in: RoundedRectangle(cornerRadius: 8)
                  )
                  .overlay(
                    RoundedRectangle(cornerRadius: 8)
                      .stroke(selected ? Color.indigo.opacity(0.55) : Color.clear)
                  )
                }
                .buttonStyle(.plain)
              }
            }
          }
          if question.allowOther || question.options.isEmpty {
            SecureOrPlainField(
              placeholder: "其他答案…",
              value: Binding(
                get: { other[question.id] ?? "" },
                set: { other[question.id] = $0 }
              ),
              secure: question.secret
            )
          }
        }
      }
      HStack {
        Button("取消问题") { respond([], true) }
          .foregroundStyle(.secondary)
        Spacer()
        Button("提交回答") { respond(answers, false) }
          .buttonStyle(.borderedProminent)
          .disabled(!ready)
      }
      }
      .padding(.vertical, 12)
    }
    .padding(.leading, 1)
  }

  private func toggle(_ label: String, for question: LocalAgentQuestion) {
    if question.multiSelect {
      var values = selections[question.id] ?? []
      if values.contains(label) { values.remove(label) } else { values.insert(label) }
      selections[question.id] = values
    } else {
      selections[question.id] = [label]
    }
  }
}

private struct SecureOrPlainField: View {
  let placeholder: String
  @Binding var value: String
  let secure: Bool

  var body: some View {
    Group {
      if secure {
        SecureField(placeholder, text: $value)
      } else {
        TextField(placeholder, text: $value, axis: .vertical)
          .lineLimit(1...3)
      }
    }
    .textFieldStyle(.roundedBorder)
  }
}

/// 很小的自适应标签布局，避免问题选项在窄窗口里被硬挤成一行。
private struct FlowLayout: Layout {
  var spacing: CGFloat

  func sizeThatFits(
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout ()
  ) -> CGSize {
    arrange(proposal: proposal, subviews: subviews).size
  }

  func placeSubviews(
    in bounds: CGRect,
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout ()
  ) {
    let result = arrange(proposal: proposal, subviews: subviews)
    for (index, point) in result.points.enumerated() {
      subviews[index].place(
        at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
        proposal: .unspecified
      )
    }
  }

  private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
    let maxWidth = proposal.width ?? .infinity
    var x: CGFloat = 0
    var y: CGFloat = 0
    var rowHeight: CGFloat = 0
    var usedWidth: CGFloat = 0
    var points: [CGPoint] = []
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > 0, x + size.width > maxWidth {
        x = 0
        y += rowHeight + spacing
        rowHeight = 0
      }
      points.append(CGPoint(x: x, y: y))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
      usedWidth = max(usedWidth, x - spacing)
    }
    return (CGSize(width: usedWidth, height: y + rowHeight), points)
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

struct TerminalRenderFrame: Equatable {
  let seq: Int
  let ansi: String
  let cols: Int
  let rows: Int
}

/// 复用手机端已经验证过的 xterm 页面。画面和输入都留在 Mac App 内，
/// daemon 只提供静态页面；会话数据仍走带本机 control token 的接口。
private struct MacTerminalSurface: NSViewRepresentable {
  let port: Int
  let sessionID: String
  let frame: TerminalRenderFrame
  let input: (String) -> Void
  let resize: (Int, Int) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(input: input, resize: resize)
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
    context.coordinator.resize = resize
    context.coordinator.push(frame)
  }

  static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "prospero")
    webView.stopLoading()
  }

  @MainActor
  final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    weak var webView: WKWebView?
    var input: (String) -> Void
    var resize: (Int, Int) -> Void
    private var ready = false
    private var pending: TerminalRenderFrame?
    private var renderedSeq: Int?

    init(input: @escaping (String) -> Void, resize: @escaping (Int, Int) -> Void) {
      self.input = input
      self.resize = resize
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
        if let pending { push(pending) }
      case "input":
        if let dataB64 = body["data"] as? String { input(dataB64) }
      case "resized":
        if let cols = body["cols"] as? Int, let rows = body["rows"] as? Int,
           (10...500).contains(cols), (5...300).contains(rows) {
          resize(cols, rows)
        }
      default:
        break
      }
    }

    func push(_ frame: TerminalRenderFrame) {
      guard renderedSeq != frame.seq else { return }
      pending = frame
      guard ready, let webView else { return }
      let message: [String: Any] = [
        "kind": "snapshot",
        "ansi": frame.ansi,
        "cols": frame.cols,
        "rows": frame.rows,
      ]
      guard
        let data = try? JSONSerialization.data(withJSONObject: message),
        let json = String(data: data, encoding: .utf8),
        let quotedData = try? JSONEncoder().encode(json),
        let quoted = String(data: quotedData, encoding: .utf8)
      else { return }
      renderedSeq = frame.seq
      pending = nil
      webView.evaluateJavaScript("window.__rx(\(quoted));")
    }
  }
}
