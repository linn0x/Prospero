import AppKit
import SwiftUI

private enum DashboardPage: String, CaseIterable, Identifiable {
  case overview
  case sessions
  case goals
  case devices
  case logs
  case settings

  var id: String { rawValue }

  var title: String {
    switch self {
    case .overview: "概览"
    case .sessions: "项目"
    case .goals: "编排"
    case .devices: "设备"
    case .logs: "日志"
    case .settings: "设置"
    }
  }

  var symbol: String {
    switch self {
    case .overview: "square.grid.2x2"
    case .sessions: "folder"
    case .goals: "point.3.connected.trianglepath.dotted"
    case .devices: "iphone.and.arrow.forward"
    case .logs: "text.alignleft"
    case .settings: "gearshape"
    }
  }
}

struct ProsperoDashboard: View {
  @Bindable var daemon: DaemonController
  @Bindable var pairing: PairingModel
  @State private var projects = LocalProjectStore()
  @State private var selection: DashboardPage = .sessions
  @State private var showingSessionLauncher = false
  @State private var startingSession = false
  @State private var sessionLaunchError: String?
  @State private var sessionLaunchDirectory: String?
  @State private var sessionLaunchAgent: String?
  @State private var selectedProjectPath: String?
  @State private var selectedSessionID: String?

  private var suggestedSessionDirectory: String {
    sessionLaunchDirectory
      ?? selectedProjectPath
      ?? daemon.running?.sessions.max { $0.createdAt < $1.createdAt }?.cwd
      ?? FileManager.default.homeDirectoryForCurrentUser.path
  }

  var body: some View {
    NavigationSplitView {
      List(DashboardPage.allCases, selection: $selection) { page in
        Label(page.title, systemImage: page.symbol)
          .tag(page)
          .padding(.vertical, 4)
      }
      .navigationTitle("Prospero")
      .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 260)
    } detail: {
      Group {
        switch selection {
        case .overview:
          OverviewDashboard(daemon: daemon)
        case .sessions:
          SessionsDashboard(
            daemon: daemon,
            projects: projects,
            selectedProjectPath: $selectedProjectPath,
            selectedSessionID: $selectedSessionID,
            newSession: { directory in presentSessionLauncher(directory) },
            newSessionForAgent: { directory, agent in
              presentSessionLauncher(directory, agent: agent)
            }
          )
        case .goals:
          GoalsDashboard(daemon: daemon)
        case .devices:
          DevicesDashboard(daemon: daemon, pairing: pairing)
        case .logs:
          LogsDashboard(daemon: daemon)
        case .settings:
          SettingsDashboard(daemon: daemon)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color(nsColor: .windowBackgroundColor))
      .toolbar {
        ToolbarItemGroup(placement: .primaryAction) {
          DaemonStatusPill(daemon: daemon)
          Button {
            presentSessionLauncher(selectedProjectPath)
          } label: {
            Label("新建 CLI", systemImage: "plus.circle.fill")
          }
          .disabled(daemon.running?.controlToken.isEmpty != false || startingSession)
          .help("在当前项目的 Shell 中启动 Agent CLI")
          Button {
            daemon.restart()
          } label: {
            Label("重启 daemon", systemImage: "arrow.clockwise")
          }
          .disabled(daemon.state == .starting)
        }
      }
    }
    .sheet(isPresented: $showingSessionLauncher, onDismiss: {
      sessionLaunchDirectory = nil
      sessionLaunchAgent = nil
    }) {
      LocalSessionComposer(
        initialDirectory: suggestedSessionDirectory,
        initialAgent: sessionLaunchAgent ?? "codex",
        accounts: daemon.status.agentAccounts,
        isSubmitting: startingSession,
        submit: { agent, kind, cwd, policy, accountId in
          startSession(agent: agent, kind: kind, cwd: cwd, policy: policy, accountId: accountId)
        },
        cancel: { showingSessionLauncher = false }
      )
    }
    .alert("启动 Agent 失败", isPresented: Binding(
      get: { sessionLaunchError != nil },
      set: { if !$0 { sessionLaunchError = nil } }
    )) {
      Button("好") { sessionLaunchError = nil }
    } message: {
      Text(sessionLaunchError ?? "未知错误")
    }
  }

  private func presentSessionLauncher(_ directory: String?, agent: String? = nil) {
    sessionLaunchDirectory = directory
    sessionLaunchAgent = agent
    showingSessionLauncher = true
  }

  private func startSession(
    agent: String,
    kind: String,
    cwd: String,
    policy: String,
    accountId: String?
  ) {
    startingSession = true
    Task {
      let result = await daemon.createLocalSession(
        agent: agent,
        kind: kind,
        cwd: cwd,
        approvalPolicy: policy,
        accountId: accountId
      )
      startingSession = false
      if let error = result.error {
        sessionLaunchError = error.isEmpty ? "daemon 拒绝创建会话" : error
      } else {
        showingSessionLauncher = false
        projects.add(cwd)
        selectedProjectPath = LocalProjectStore.normalizePath(cwd)
        selectedSessionID = result.id
        selection = .sessions
      }
    }
  }
}

private struct DaemonStatusPill: View {
  @Bindable var daemon: DaemonController

  private var color: Color {
    switch daemon.state {
    case .running, .externallyRunning: .green
    case .starting: .orange
    case .failed: .red
    case .stopped: .secondary
    }
  }

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(color).frame(width: 8, height: 8)
      Text(daemon.stateLabel)
        .font(.caption)
        .lineLimit(1)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(.quaternary, in: Capsule())
  }
}

private struct OverviewDashboard: View {
  @Bindable var daemon: DaemonController
  @Environment(\.openWindow) private var openWindow

  private var sessions: [RunningStatus.Session] { daemon.running?.sessions ?? [] }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        VStack(alignment: .leading, spacing: 6) {
          Text("远程 Agent 控制中心")
            .font(.system(size: 30, weight: .semibold))
          Text("会话会跨 Mac App 与 daemon 重启恢复，手机断线后也可继续。")
            .foregroundStyle(.secondary)
        }

        HStack(spacing: 16) {
          MetricCard(
            title: "Daemon",
            value: daemon.running == nil ? "未运行" : "在线",
            detail: "端口 \(daemon.status.port) · \(daemon.status.bindLabel)",
            symbol: "server.rack",
            tint: daemon.running == nil ? .orange : .green
          )
          MetricCard(
            title: "活跃会话",
            value: String(sessions.count),
            detail: sessions.isEmpty ? "等待新会话" : "待审批 \(daemon.running?.pendingApprovals ?? 0)",
            symbol: "bubble.left.and.text.bubble.right",
            tint: .blue
          )
          MetricCard(
            title: "已配对设备",
            value: String(daemon.status.devices.count),
            detail: daemon.status.devices.isEmpty ? "尚无设备" : "可从设备页撤销",
            symbol: "iphone",
            tint: .purple
          )
        }

        DashboardCard {
          VStack(alignment: .leading, spacing: 14) {
            HStack {
              Label("持久化状态", systemImage: "externaldrive.fill.badge.checkmark")
                .font(.headline)
              Spacer()
              Text(persistenceLabel)
                .foregroundStyle(persistenceReady ? .green : .orange)
            }
            Divider()
            PersistenceRow(
              title: "对话会话",
              detail: "事件历史 + Codex / Claude / OpenCode / Grok 原生上下文",
              enabled: daemon.running?.persistence.structured == true
            )
            PersistenceRow(
              title: "终端会话",
              detail: "tmux 托管进程与完整终端画面",
              enabled: daemon.running?.persistence.pty == true
            )
          }
        }

        DashboardCard {
          HStack(spacing: 12) {
            daemonControl
            Button {
              daemon.restart()
            } label: {
              Label("保存并重启", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.borderedProminent)

            Button {
              openWindow(id: "pairing")
              NSApp.activate(ignoringOtherApps: true)
            } label: {
              Label("配对设备", systemImage: "qrcode")
            }
            Spacer()
            Button("打开数据目录") {
              NSWorkspace.shared.open(DaemonStatus.home)
            }
          }
        }

        if !sessions.isEmpty {
          VStack(alignment: .leading, spacing: 10) {
            Text("最近会话").font(.title2.bold())
            ForEach(sessions.prefix(4)) { session in
              CompactSessionRow(session: session)
            }
          }
        }
      }
      .padding(30)
      .frame(maxWidth: 980, alignment: .leading)
    }
    .navigationTitle("概览")
  }

  @ViewBuilder
  private var daemonControl: some View {
    switch daemon.state {
    case .running:
      Button(role: .destructive) { daemon.stop() } label: {
        Label("停止", systemImage: "stop.fill")
      }
    case .starting:
      Button("启动中…") {}.disabled(true)
    case .externallyRunning:
      Text("由其他进程管理").foregroundStyle(.secondary)
    case .stopped, .failed:
      Button { daemon.start() } label: {
        Label("启动", systemImage: "play.fill")
      }
    }
  }

  private var persistenceReady: Bool {
    daemon.running?.persistence.structured == true && daemon.running?.persistence.pty == true
  }

  private var persistenceLabel: String {
    guard daemon.running != nil else { return "等待 daemon" }
    return persistenceReady ? "全部启用" : "部分启用"
  }
}

private struct MetricCard: View {
  let title: String
  let value: String
  let detail: String
  let symbol: String
  let tint: Color

  var body: some View {
    DashboardCard {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Text(title).foregroundStyle(.secondary)
          Spacer()
          Image(systemName: symbol).foregroundStyle(tint)
        }
        Text(value).font(.system(size: 28, weight: .semibold, design: .rounded))
        Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity)
  }
}

private struct DashboardCard<Content: View>: View {
  let content: Content

  init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  var body: some View {
    content
      .padding(18)
      .frame(maxWidth: .infinity, alignment: .leading)
      // 只让页面级分组成为一张卡片。内容里的状态、任务和操作用分隔线表达，
      // 避免在窗口底色、主卡片和小卡片之间形成三层嵌套。
      .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(.quaternary, lineWidth: 1)
      }
  }
}

private struct PersistenceRow: View {
  let title: String
  let detail: String
  let enabled: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: enabled ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
        .foregroundStyle(enabled ? .green : .orange)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).fontWeight(.medium)
        Text(detail).font(.caption).foregroundStyle(.secondary)
      }
    }
  }
}

private struct CompactSessionRow: View {
  let session: RunningStatus.Session

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: session.symbolName)
        .foregroundStyle(session.pendingInteractions > 0 ? .orange : .blue)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 3) {
        Text(session.title).fontWeight(.medium)
        Text(session.preview?.isEmpty == false ? session.preview! : session.cwd)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer()
      Text(session.statusLabel).font(.caption).foregroundStyle(.secondary)
    }
    .padding(12)
    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
  }
}

private struct SessionsDashboard: View {
  private struct SelectedSubagent: Identifiable {
    let session: RunningStatus.Session
    let subagent: RunningStatus.Session.Subagent
    var id: String { "\(session.id):\(subagent.id)" }
  }

  @Bindable var daemon: DaemonController
  @Bindable var projects: LocalProjectStore
  @Binding var selectedProjectPath: String?
  @Binding var selectedSessionID: String?
  let newSession: (String?) -> Void
  let newSessionForAgent: (String?, String) -> Void
  @State private var sessionToKill: RunningStatus.Session?
  @State private var selectedSubagent: SelectedSubagent?
  @State private var actionError: String?
  @State private var expandedProjectPaths: Set<String> = []
  /// HSplitView 在外层 NavigationSplitView 隐藏/显示后会重新计算分栏。
  /// 这里把用户拖出的宽度存进偏好，重建后仍按同一宽度排版。
  @AppStorage("projectSessionSidebarWidth") private var storedProjectSidebarWidth = 320.0
  @State private var sidebarDragOrigin: CGFloat?

  private static let projectSidebarMinWidth: CGFloat = 270
  private static let projectSidebarMaxWidth: CGFloat = 480
  private static let workspaceMinWidth: CGFloat = 460

  private var sessions: [RunningStatus.Session] {
    (daemon.running?.sessions ?? []).sorted {
      if ($0.pendingInteractions > 0) != ($1.pendingInteractions > 0) {
        return $0.pendingInteractions > 0
      }
      return $0.createdAt > $1.createdAt
    }
  }

  private var projectSummaries: [LocalProjectSummary] {
    projects.summaries(for: sessions)
  }

  private var selectedProject: LocalProjectSummary? {
    guard let selectedProjectPath else { return nil }
    return projectSummaries.first { $0.path == selectedProjectPath }
  }

  var body: some View {
    GeometryReader { proxy in
      let sidebarWidth = projectSidebarWidth(for: proxy.size.width)
      HStack(spacing: 0) {
        ProjectSessionSidebar(
          projects: projectSummaries,
          selectedProjectPath: $selectedProjectPath,
          selectedSessionID: $selectedSessionID,
          expandedProjectPaths: $expandedProjectPaths,
          addProject: chooseProject,
          newSession: { newSession($0.path) },
          removeProject: removeProject
        )
        .frame(width: sidebarWidth)

        sidebarDivider(availableWidth: proxy.size.width, displayedWidth: sidebarWidth)

        workspace
          .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .navigationTitle("项目与会话")
    .onAppear {
      synchronizeProjects()
      selectAvailableProject()
      selectAvailableSession()
      expandSelectedProject()
    }
    .onChange(of: sessions.map { "\($0.id):\($0.cwd)" }) { _, _ in
      synchronizeProjects()
      selectAvailableProject()
      selectAvailableSession()
      expandSelectedProject()
    }
    .onChange(of: selectedProjectPath) { _, _ in
      selectAvailableSession()
      expandSelectedProject()
    }
    .sheet(item: $selectedSubagent) { selected in
      SubagentTranscriptSheet(
        daemon: daemon,
        session: selected.session,
        subagent: selected.subagent
      )
    }
    .alert("结束会话？", isPresented: Binding(
      get: { sessionToKill != nil },
      set: { if !$0 { sessionToKill = nil } }
    ), presenting: sessionToKill) { session in
      Button("结束并删除", role: .destructive) { run(session, action: .kill) }
      Button("取消", role: .cancel) {}
    } message: { session in
      Text("“\(session.title)”会从持久化列表删除；终端会话对应的 tmux 进程也会结束。")
    }
    .alert("操作失败", isPresented: Binding(
      get: { actionError != nil },
      set: { if !$0 { actionError = nil } }
    )) {
      Button("好") { actionError = nil }
    } message: {
      Text(actionError ?? "未知错误")
    }
  }

  private var selectedSession: RunningStatus.Session? {
    guard let selectedSessionID, let selectedProject else { return nil }
    return selectedProject.sessions.first { $0.id == selectedSessionID }
  }

  @ViewBuilder
  private var workspace: some View {
    if let project = selectedProject {
      if let selected = selectedSession {
        LocalSessionWorkspace(
          daemon: daemon,
          session: selected,
          interrupt: { run(selected, action: .interrupt) },
          kill: { sessionToKill = selected },
          launchCLI: { newSessionForAgent(project.path, selected.agent) },
          openSubagent: { child in
            selectedSubagent = SelectedSubagent(session: selected, subagent: child)
          }
        )
        .id(selected.id)
      } else {
        EmptyProjectWorkspace(
          project: project,
          daemonIsRunning: daemon.running != nil,
          newSession: { newSession(project.path) }
        )
      }
    } else {
      EmptyProjectSelection(
        daemonIsRunning: daemon.running != nil,
        chooseProject: chooseProject
      )
    }
  }

  private func projectSidebarWidth(for availableWidth: CGFloat) -> CGFloat {
    let maxWidth = max(
      Self.projectSidebarMinWidth,
      min(Self.projectSidebarMaxWidth, availableWidth - Self.workspaceMinWidth)
    )
    return min(max(CGFloat(storedProjectSidebarWidth), Self.projectSidebarMinWidth), maxWidth)
  }

  private func sidebarDivider(availableWidth: CGFloat, displayedWidth: CGFloat) -> some View {
    Color(nsColor: .separatorColor)
      .frame(width: 1)
      .overlay {
        Color.clear
          .frame(width: 12)
          .contentShape(Rectangle())
          .onHover { hovering in
            (hovering ? NSCursor.resizeLeftRight : NSCursor.arrow).set()
          }
          .gesture(
            DragGesture(minimumDistance: 0)
              .onChanged { value in
                if sidebarDragOrigin == nil { sidebarDragOrigin = displayedWidth }
                guard let sidebarDragOrigin else { return }
                let maxWidth = max(
                  Self.projectSidebarMinWidth,
                  min(Self.projectSidebarMaxWidth, availableWidth - Self.workspaceMinWidth)
                )
                storedProjectSidebarWidth = Double(min(
                  max(sidebarDragOrigin + value.translation.width, Self.projectSidebarMinWidth),
                  maxWidth
                ))
              }
              .onEnded { _ in sidebarDragOrigin = nil }
          )
      }
  }

  private func synchronizeProjects() {
    projects.rememberSessionDirectories(sessions.map(\.cwd))
  }

  private func selectAvailableProject() {
    if let selectedProjectPath,
       projectSummaries.contains(where: { $0.path == selectedProjectPath }) {
      return
    }
    selectedProjectPath = projectSummaries.first?.path
  }

  private func selectAvailableSession() {
    guard let selectedProject else {
      selectedSessionID = nil
      return
    }
    if let selectedSessionID,
       selectedProject.sessions.contains(where: { $0.id == selectedSessionID }) {
      return
    }
    selectedSessionID = selectedProject.sessions.first?.id
  }

  /// 选中其他项目时自然展开；用户手动收起当前项目时 selection 不会变化，
  /// 所以不会被这个同步逻辑立刻抢回展开状态。
  private func expandSelectedProject() {
    if let selectedProjectPath {
      expandedProjectPaths.insert(selectedProjectPath)
    }
  }

  private func chooseProject() {
    let panel = NSOpenPanel()
    panel.title = "添加 Agent 项目"
    panel.prompt = "添加项目"
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false
    if let selectedProjectPath {
      panel.directoryURL = URL(fileURLWithPath: selectedProjectPath)
    }
    if panel.runModal() == .OK, let directory = panel.url {
      projects.add(directory.path)
      selectedProjectPath = LocalProjectStore.normalizePath(directory.path)
      selectAvailableSession()
    }
  }

  private func removeProject(_ project: LocalProjectSummary) {
    projects.remove(project.path)
    selectAvailableProject()
    selectAvailableSession()
  }

  private func run(_ session: RunningStatus.Session, action: DaemonController.SessionAction) {
    Task {
      if let error = await daemon.controlSession(id: session.id, action: action) {
        actionError = error.isEmpty ? "daemon 拒绝了操作" : error
      }
      sessionToKill = nil
    }
  }
}

private struct EmptyProjectSelection: View {
  let daemonIsRunning: Bool
  let chooseProject: () -> Void

  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: "folder.badge.plus")
        .font(.system(size: 42, weight: .light))
        .foregroundStyle(.secondary)
      Text("添加一个项目")
        .font(.title2.weight(.semibold))
      Text(daemonIsRunning
        ? "选择代码目录后，可在该项目中创建并管理 Agent CLI 会话。"
        : "daemon 启动后，选择代码目录来创建 Agent CLI 会话。")
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
      Button("选择项目文件夹…", action: chooseProject)
        .buttonStyle(.borderedProminent)
    }
    .padding(32)
  }
}

private struct EmptyProjectWorkspace: View {
  let project: LocalProjectSummary
  let daemonIsRunning: Bool
  let newSession: () -> Void

  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: "terminal")
        .font(.system(size: 42, weight: .light))
        .foregroundStyle(.secondary)
      Text("\(project.name) 还没有会话")
        .font(.title2.weight(.semibold))
      Text("新 Agent 默认在内嵌 Shell 中运行原生 CLI。")
        .foregroundStyle(.secondary)
      Button("新建 CLI 会话", action: newSession)
        .buttonStyle(.borderedProminent)
        .disabled(!daemonIsRunning)
    }
    .padding(32)
  }
}

private struct LocalSessionComposer: View {
  let initialDirectory: String
  let accounts: [DaemonStatus.AgentAccount]
  let isSubmitting: Bool
  let submit: (String, String, String, String, String?) -> Void
  let cancel: () -> Void

  @State private var agent: String
  @State private var cwd: String
  @State private var accountId = ""

  init(
    initialDirectory: String,
    initialAgent: String,
    accounts: [DaemonStatus.AgentAccount],
    isSubmitting: Bool,
    submit: @escaping (String, String, String, String, String?) -> Void,
    cancel: @escaping () -> Void
  ) {
    self.initialDirectory = initialDirectory
    self.accounts = accounts
    self.isSubmitting = isSubmitting
    self.submit = submit
    self.cancel = cancel
    _agent = State(initialValue: initialAgent)
    _cwd = State(initialValue: initialDirectory)
    let initialAccounts = accounts.filter { $0.agent == initialAgent }
    _accountId = State(
      initialValue: initialAccounts.first(where: \.isDefault)?.id
        ?? initialAccounts.first?.id
        ?? ""
    )
  }

  private var selectableAccounts: [DaemonStatus.AgentAccount] {
    accounts.filter { $0.agent == agent }
  }

  private var cleanDirectory: String {
    cwd.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var directoryIsValid: Bool {
    var isDirectory: ObjCBool = false
    return !cleanDirectory.isEmpty &&
      FileManager.default.fileExists(atPath: cleanDirectory, isDirectory: &isDirectory) &&
      isDirectory.boolValue
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(spacing: 12) {
        Image(systemName: agent == "shell" ? "terminal.fill" : "cpu")
          .font(.title2)
          .foregroundStyle(.blue)
          .frame(width: 38, height: 38)
          .background(.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 9))
        VStack(alignment: .leading, spacing: 3) {
          Text("在项目中启动 Agent").font(.title2.bold())
          Text("默认在内嵌 Shell 中直接运行 Agent 的原生 CLI。")
            .font(.callout)
            .foregroundStyle(.secondary)
        }
      }

      Form {
        Picker("Agent", selection: $agent) {
          Text("Codex（默认）").tag("codex")
          Text("Claude Code").tag("claude")
          Text("OpenCode").tag("opencode")
          Text("Grok").tag("grok")
          Text("Trae").tag("trae")
          Divider()
          Text("Shell").tag("shell")
        }
        .onChange(of: agent) { _, _ in
          accountId = selectableAccounts.first(where: \.isDefault)?.id
            ?? selectableAccounts.first?.id
            ?? ""
        }

        if agent == "claude" || agent == "codex" {
          Picker("账号环境", selection: $accountId) {
            ForEach(selectableAccounts) { account in
              Text(account.isDefault ? "\(account.name)（默认）" : account.name)
                .tag(account.id)
            }
          }
        }

        HStack(spacing: 8) {
          TextField("工作目录", text: $cwd)
            .textFieldStyle(.roundedBorder)
          Button("选择…", action: chooseDirectory)
        }
      }
      .formStyle(.grouped)

      Text(helpText)
        .font(.caption)
        .foregroundStyle(.secondary)

      HStack {
        if !directoryIsValid {
          Label("请选择存在的文件夹", systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.orange)
        }
        Spacer()
        Button("取消", action: cancel)
          .disabled(isSubmitting)
        Button {
          submit(agent, "pty", cleanDirectory, "standard", accountId.isEmpty ? nil : accountId)
        } label: {
          if isSubmitting {
            ProgressView().controlSize(.small)
          } else {
            Text(agent == "shell" ? "启动 Shell" : "启动 Agent CLI")
          }
        }
        .buttonStyle(.borderedProminent)
        .keyboardShortcut(.defaultAction)
        .disabled(isSubmitting || !directoryIsValid)
      }
    }
    .padding(24)
    .frame(width: 540)
  }

  private var helpText: String {
    if agent == "shell" {
      return "Shell 使用登录终端并由 tmux 托管，daemon 或 Mac App 重启后仍可恢复。"
    }
    if agent == "codex" {
      return "Codex 将以 --dangerously-bypass-approvals-and-sandbox 启动：不请求审批，也不使用沙箱。"
    }
    if agent == "claude" {
      return "Claude 将以 --dangerously-skip-permissions 启动：跳过所有权限确认。"
    }
    return "Shell 会直接启动 \(agent) CLI，并由 tmux 托管；daemon 或 Mac App 重启后仍可恢复。"
  }

  private func chooseDirectory() {
    let panel = NSOpenPanel()
    panel.title = "选择 Agent 工作目录"
    panel.prompt = "选择"
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false
    if directoryIsValid {
      panel.directoryURL = URL(fileURLWithPath: cleanDirectory)
    }
    if panel.runModal() == .OK, let selected = panel.url {
      cwd = selected.path
    }
  }
}

private struct SessionManagementRow: View {
  let session: RunningStatus.Session
  let interrupt: () -> Void
  let kill: () -> Void
  let openSubagent: (RunningStatus.Session.Subagent) -> Void

  var body: some View {
    DashboardCard {
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .top, spacing: 14) {
        Image(systemName: session.kind == "pty" ? "terminal" : "bubble.left.and.text.bubble.right")
          .font(.title2)
          .foregroundStyle(session.pendingInteractions > 0 ? .orange : .blue)
          .frame(width: 34, height: 34)
          .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        VStack(alignment: .leading, spacing: 7) {
          HStack(spacing: 8) {
            Text(session.title).font(.headline)
            Text(session.kind == "pty" ? "终端" : "对话")
              .font(.caption2)
              .padding(.horizontal, 7).padding(.vertical, 3)
              .background(.quaternary, in: Capsule())
            if let policy = session.approvalPolicy {
              Text(policy.uppercased()).font(.caption2).foregroundStyle(.secondary)
            }
            if let accountName = session.accountName {
              Text(accountName)
                .font(.caption2)
                .padding(.horizontal, 7).padding(.vertical, 3)
                .background(.blue.opacity(0.1), in: Capsule())
            }
          }
          if let preview = session.preview, !preview.isEmpty {
            Text(preview).font(.callout).foregroundStyle(.secondary).lineLimit(2)
          }
          HStack(spacing: 12) {
            Label(session.statusLabel, systemImage: session.symbolName)
            Text(session.cwd).lineLimit(1).truncationMode(.middle)
          }
          .font(.caption)
          .foregroundStyle(.secondary)
        }
        Spacer(minLength: 16)
        HStack(spacing: 8) {
          Button("打开目录") {
            NSWorkspace.shared.open(URL(fileURLWithPath: session.cwd))
          }
          .buttonStyle(.borderless)
          Button(action: interrupt) {
            Label("停止本轮", systemImage: "stop.circle")
          }
            .buttonStyle(.bordered)
            .tint(.orange)
            .disabled(
              session.status == "idle" || session.status == "completed" ||
              session.status == "done" || session.status == "died"
            )
          Button("结束", role: .destructive, action: kill)
            .buttonStyle(.borderless)
        }
        }
        if !session.subagents.isEmpty {
          Divider()
          VStack(alignment: .leading, spacing: 7) {
            Text("子 Agent").font(.caption).foregroundStyle(.secondary)
            ForEach(session.subagents) { child in
              Button {
                openSubagent(child)
              } label: {
                HStack(spacing: 10) {
                  SubagentIdentityBadge(subagent: child, compact: true)
                  VStack(alignment: .leading, spacing: 2) {
                    if let task = child.task, !task.isEmpty {
                      Text(task).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    } else if let preview = child.preview, !preview.isEmpty {
                      Text(preview).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    } else {
                      Text("查看消息、推理与工具过程")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    }
                  }
                  Spacer()
                  Text(child.statusLabel).font(.caption).foregroundStyle(.secondary)
                  Label("查看过程", systemImage: "chevron.right")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.blue)
                }
                .contentShape(Rectangle())
                .padding(.horizontal, 8)
                .padding(.vertical, 7)
                .overlay(alignment: .bottom) {
                  Rectangle().fill(.quaternary).frame(height: 1)
                }
              }
              .buttonStyle(.plain)
              .help("查看 \(child.name) 的独立对话和工具过程")
            }
          }
        }
      }
    }
  }
}

private struct GoalsDashboard: View {
  @Bindable var daemon: DaemonController
  @State private var showingGraphComposer = false
  @State private var activeRunsExpanded = true
  @State private var endedRunsExpanded = false

  private func newestFirst(_ runs: [OrchestrationStatus.Run]) -> [OrchestrationStatus.Run] {
    runs.sorted { left, right in
      left.updatedAt == right.updatedAt ? left.id < right.id : left.updatedAt > right.updatedAt
    }
  }

  private var activeRuns: [OrchestrationStatus.Run] {
    newestFirst(daemon.orchestration.runs.filter { $0.status == "active" })
  }

  private var endedRuns: [OrchestrationStatus.Run] {
    newestFirst(daemon.orchestration.runs.filter { $0.status != "active" })
  }

  /// A deletion tombstone is authoritative; a missing Run covers interrupted
  /// snapshots and legacy records restored after the Run history was removed.
  private var orphanWorktreeAssets: [OrchestrationStatus.WorktreeAsset] {
    let currentRunIDs = Set(daemon.orchestration.runs.map(\.id))
    return daemon.orchestration.worktreeAssets.filter {
      $0.runDeletedAt != nil || !currentRunIDs.contains($0.runId)
    }
  }

  var body: some View {
    Group {
      if activeRuns.isEmpty && endedRuns.isEmpty && orphanWorktreeAssets.isEmpty {
        ContentUnavailableView(
          "还没有编排",
          systemImage: "point.3.connected.trianglepath.dotted",
          description: Text("可视化新建任务图，或在 iPhone/iPad 上启动一个 Goal 协调者。")
        )
      } else {
        ScrollView {
          LazyVStack(spacing: 14) {
            if !activeRuns.isEmpty {
              GoalRunSection(
                title: "进行中的编排",
                runs: activeRuns,
                daemon: daemon,
                expanded: $activeRunsExpanded
              )
            }
            if !endedRuns.isEmpty {
              GoalRunSection(
                title: "已结束的编排",
                runs: endedRuns,
                daemon: daemon,
                expanded: $endedRunsExpanded
              )
            }
            if !orphanWorktreeAssets.isEmpty {
              DeletedRunWorktreeAssetsSection(
                assets: orphanWorktreeAssets,
                daemon: daemon
              )
            }
          }
          .frame(maxWidth: 980, alignment: .leading)
          .frame(maxWidth: .infinity)
          .padding(30)
        }
      }
    }
    .navigationTitle("编排")
    .toolbar {
      Button {
        showingGraphComposer = true
      } label: {
        Label("可视化新建", systemImage: "point.3.connected.trianglepath.dotted")
      }
      .buttonStyle(.borderedProminent)
      Button {
        daemon.refresh()
      } label: {
        Label("刷新", systemImage: "arrow.clockwise")
      }
    }
    .sheet(isPresented: $showingGraphComposer) {
      VisualGraphComposer(daemon: daemon)
    }
  }
}

private struct GoalRunSection: View {
  let title: String
  let runs: [OrchestrationStatus.Run]
  @Bindable var daemon: DaemonController
  @Binding var expanded: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 8) {
          Image(systemName: expanded ? "chevron.down" : "chevron.right")
            .font(.caption.weight(.bold))
            .foregroundStyle(.secondary)
          Text(title).font(.headline)
          Text("\(runs.count)")
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(.quaternary, in: Capsule())
          Spacer()
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(expanded ? "折叠" : "展开")\(title)")

      if expanded {
        ForEach(runs) { run in
          GoalRunRow(run: run, daemon: daemon)
        }
      }
    }
  }
}

/// 在发布前把任务、依赖和并行分支放在同一张画布上检查；提交时由 daemon 原子落盘。
private struct VisualGraphComposer: View {
  private enum Mode {
    case create
    case edit(runId: String, baseRevision: Int)
  }

  private struct DraftSnapshot: Equatable {
    var objective: String
    var nodes: [OrchestrationGraphDraftNode]
  }

  @Bindable var daemon: DaemonController
  @Environment(\.dismiss) private var dismiss
  private let mode: Mode
  private let persistedIDs: Set<String>
  private let lockedIDs: Set<String>
  private let baselineNodes: [OrchestrationGraphDraftNode]
  @State private var objective: String
  @State private var nodes: [OrchestrationGraphDraftNode]
  @State private var selectedID: String?
  @State private var operationID = UUID().uuidString
  @State private var submitting = false
  @State private var submitError: String?
  @State private var undoStack: [DraftSnapshot] = []
  @State private var redoStack: [DraftSnapshot] = []

  init(daemon: DaemonController) {
    self.daemon = daemon
    mode = .create
    persistedIDs = []
    lockedIDs = []
    let first = OrchestrationGraphDraftNode(title: "任务 1", spec: "")
    baselineNodes = [first]
    _objective = State(initialValue: "")
    _nodes = State(initialValue: [first])
    _selectedID = State(initialValue: first.id)
  }

  init(
    daemon: DaemonController,
    run: OrchestrationStatus.Run,
    tasks: [OrchestrationStatus.Task]
  ) {
    self.daemon = daemon
    mode = .edit(runId: run.id, baseRevision: run.graphRevision ?? 0)
    persistedIDs = Set(tasks.map(\.id))
    lockedIDs = Set(tasks.filter { $0.status != "pending" }.map(\.id))
    let saved = tasks.map { task in
      OrchestrationGraphDraftNode(
        id: task.id,
        title: task.title,
        spec: task.spec,
        deps: Set(task.deps)
      )
    }
    baselineNodes = saved
    let initial = saved.isEmpty
      ? [OrchestrationGraphDraftNode(title: "任务 1", spec: "")]
      : saved
    _objective = State(initialValue: run.objective)
    _nodes = State(initialValue: initial)
    _selectedID = State(initialValue: initial.first?.id)
  }

  private var isEditing: Bool {
    if case .edit = mode { return true }
    return false
  }

  private var selectedIndex: Int? {
    guard let selectedID else { return nil }
    return nodes.firstIndex { $0.id == selectedID }
  }

  private var editableNodes: [OrchestrationGraphDraftNode] {
    nodes.filter { !lockedIDs.contains($0.id) }
  }

  private var deletedPersistedIDs: [String] {
    Array(persistedIDs.subtracting(Set(nodes.map(\.id)))).sorted()
  }

  private var hasChanges: Bool {
    !isEditing || nodes != baselineNodes
  }

  private var validationMessage: String? {
    if objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "先填写这次编排的目标"
    }
    if editableNodes.isEmpty && deletedPersistedIDs.isEmpty { return "添加一个新的可编辑任务" }
    if editableNodes.contains(where: { $0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
      return "每个可编辑任务都需要标题"
    }
    if editableNodes.contains(where: { $0.spec.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
      return "每个可编辑任务都需要交付说明"
    }
    if graphHasCycle { return "依赖关系存在环，请先调整" }
    return nil
  }

  private var canPublish: Bool {
    validationMessage == nil && hasChanges && !submitting
  }

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          VStack(alignment: .leading, spacing: 3) {
            Text(isEditing ? "编辑任务图" : "可视化新建编排").font(.title2.bold())
            Text("连线从前置任务指向后续任务；运行中和已结束的节点只读。")
              .font(.callout)
              .foregroundStyle(.secondary)
          }
          Spacer()
          HStack(spacing: 8) {
            Button { undo() } label: { Image(systemName: "arrow.uturn.backward") }
              .disabled(undoStack.isEmpty)
              .help("撤销")
            Button { redo() } label: { Image(systemName: "arrow.uturn.forward") }
              .disabled(redoStack.isEmpty)
              .help("重做")
            Button { addNode() } label: { Label("添加任务", systemImage: "plus") }
              .buttonStyle(.bordered)
          }
        }
        if isEditing {
          HStack {
            Text(objective).font(.headline)
            Spacer()
            if case .edit(_, let revision) = mode {
              Text("基于 revision \(revision)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            }
          }
          .padding(10)
          .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        } else {
          TextField("这次编排要达成什么目标？", text: objectiveBinding)
            .textFieldStyle(.roundedBorder)
        }
      }
      .padding(20)

      Divider()

      HStack(spacing: 0) {
        GraphDraftCanvas(nodes: nodes, lockedIDs: lockedIDs, selection: $selectedID)
          .frame(maxWidth: .infinity, maxHeight: .infinity)

        Divider()

        inspector
          .frame(width: 310)
      }

      Divider()

      HStack {
        if let validationMessage {
          Label(validationMessage, systemImage: "exclamationmark.circle")
            .font(.callout)
            .foregroundStyle(.secondary)
        } else if !hasChanges {
          Label("任务图尚未修改", systemImage: "circle")
            .font(.callout)
            .foregroundStyle(.secondary)
        } else {
          Label(
            isEditing
              ? "将原子更新 \(editableNodes.count) 个待派发节点，删除 \(deletedPersistedIDs.count) 个"
              : "将一次性创建 \(nodes.count) 个任务",
            systemImage: "checkmark.circle"
          )
          .font(.callout)
          .foregroundStyle(.green)
        }
        Spacer()
        Button("取消") { dismiss() }
        Button {
          publish()
        } label: {
          if submitting {
            ProgressView().controlSize(.small)
          } else {
            Text(isEditing ? "保存任务图" : "发布任务图")
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(!canPublish)
      }
      .padding(16)
    }
    .frame(minWidth: 980, idealWidth: 1080, minHeight: 620, idealHeight: 700)
    .alert("发布失败", isPresented: Binding(
      get: { submitError != nil },
      set: { if !$0 { submitError = nil } }
    )) {
      Button("好") { submitError = nil }
    } message: {
      Text(submitError ?? "未知错误")
    }
  }

  @ViewBuilder
  private var inspector: some View {
    if let index = selectedIndex {
      let locked = lockedIDs.contains(nodes[index].id)
      VStack(alignment: .leading, spacing: 14) {
        HStack {
          Text("任务设置").font(.headline)
          if locked {
            Label("只读", systemImage: "lock.fill")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Spacer()
          Button(role: .destructive) {
            removeSelectedNode()
          } label: {
            Image(systemName: "trash")
          }
          .buttonStyle(.borderless)
          .disabled(locked || (!isEditing && nodes.count == 1))
          .help(
            locked
              ? "运行中或已结束的任务保留历史，不能删除"
              : persistedIDs.contains(nodes[index].id) ? "删除这个待派发任务" : "删除新任务"
          )
        }
        TextField("任务标题", text: nodeTitleBinding(nodes[index].id))
          .textFieldStyle(.roundedBorder)
          .disabled(locked)
        Text("交付说明与验收条件")
          .font(.caption)
          .foregroundStyle(.secondary)
        TextEditor(text: nodeSpecBinding(nodes[index].id))
          .frame(minHeight: 120)
          .padding(7)
          .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
          .disabled(locked)

        Text("前置依赖").font(.headline)
        if nodes.count == 1 {
          Text("添加更多任务后可在这里建立依赖。")
            .font(.callout)
            .foregroundStyle(.secondary)
        } else {
          ScrollView {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(nodes.filter { $0.id != nodes[index].id }) { candidate in
                let selectedNodeID = nodes[index].id
                let wouldCycle = !nodes[index].deps.contains(candidate.id) &&
                  dependsTransitively(from: candidate.id, on: selectedNodeID)
                Toggle(candidate.title.isEmpty ? "未命名任务" : candidate.title, isOn: Binding(
                  get: { nodes[index].deps.contains(candidate.id) },
                  set: { enabled in setDependency(candidate.id, on: selectedNodeID, enabled: enabled) }
                ))
                .disabled(locked || wouldCycle)
                .help(wouldCycle ? "添加这个依赖会形成环" : "")
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        Spacer()
      }
      .padding(18)
    } else {
      ContentUnavailableView("选择一个任务", systemImage: "cursorarrow.click")
    }
  }

  private var objectiveBinding: Binding<String> {
    Binding(
      get: { objective },
      set: { value in
        guard value != objective else { return }
        recordSnapshot()
        objective = value
      }
    )
  }

  private func nodeTitleBinding(_ id: String) -> Binding<String> {
    Binding(
      get: { nodes.first(where: { $0.id == id })?.title ?? "" },
      set: { value in updateNode(id) { $0.title = value } }
    )
  }

  private func nodeSpecBinding(_ id: String) -> Binding<String> {
    Binding(
      get: { nodes.first(where: { $0.id == id })?.spec ?? "" },
      set: { value in updateNode(id) { $0.spec = value } }
    )
  }

  private func updateNode(_ id: String, change: (inout OrchestrationGraphDraftNode) -> Void) {
    guard let index = nodes.firstIndex(where: { $0.id == id }), !lockedIDs.contains(id) else { return }
    var next = nodes[index]
    change(&next)
    guard next != nodes[index] else { return }
    recordSnapshot()
    nodes[index] = next
  }

  private func setDependency(_ dependency: String, on nodeID: String, enabled: Bool) {
    updateNode(nodeID) { node in
      if enabled { node.deps.insert(dependency) }
      else { node.deps.remove(dependency) }
    }
  }

  private func addNode() {
    recordSnapshot()
    let node = OrchestrationGraphDraftNode(title: "任务 \(nodes.count + 1)", spec: "")
    nodes.append(node)
    selectedID = node.id
  }

  private func removeSelectedNode() {
    guard let selectedID,
          !lockedIDs.contains(selectedID),
          isEditing || nodes.count > 1
    else { return }
    recordSnapshot()
    nodes.removeAll { $0.id == selectedID }
    for index in nodes.indices { nodes[index].deps.remove(selectedID) }
    self.selectedID = nodes.first?.id
  }

  private var currentSnapshot: DraftSnapshot {
    DraftSnapshot(objective: objective, nodes: nodes)
  }

  private func recordSnapshot() {
    let snapshot = currentSnapshot
    if undoStack.last != snapshot {
      undoStack.append(snapshot)
      if undoStack.count > 80 { undoStack.removeFirst(undoStack.count - 80) }
    }
    redoStack.removeAll()
  }

  private func restore(_ snapshot: DraftSnapshot) {
    objective = snapshot.objective
    nodes = snapshot.nodes
    if selectedID == nil || !nodes.contains(where: { $0.id == selectedID }) {
      selectedID = nodes.first?.id
    }
  }

  private func undo() {
    guard let previous = undoStack.popLast() else { return }
    redoStack.append(currentSnapshot)
    restore(previous)
  }

  private func redo() {
    guard let next = redoStack.popLast() else { return }
    undoStack.append(currentSnapshot)
    restore(next)
  }

  private func dependsTransitively(from start: String, on target: String) -> Bool {
    var seen = Set<String>()
    func visit(_ id: String) -> Bool {
      if id == target { return true }
      guard seen.insert(id).inserted,
            let node = nodes.first(where: { $0.id == id })
      else { return false }
      return node.deps.contains(where: visit)
    }
    return visit(start)
  }

  private var graphHasCycle: Bool {
    var visiting = Set<String>()
    var visited = Set<String>()
    func visit(_ id: String) -> Bool {
      if visiting.contains(id) { return true }
      if visited.contains(id) { return false }
      visiting.insert(id)
      defer {
        visiting.remove(id)
        visited.insert(id)
      }
      guard let node = nodes.first(where: { $0.id == id }) else { return false }
      return node.deps.contains(where: visit)
    }
    return nodes.contains { visit($0.id) }
  }

  private func publish() {
    guard canPublish else { return }
    submitting = true
    let source = isEditing ? editableNodes : nodes
    let cleanNodes = source.map { node in
      OrchestrationGraphDraftNode(
        id: node.id,
        title: node.title.trimmingCharacters(in: .whitespacesAndNewlines),
        spec: node.spec.trimmingCharacters(in: .whitespacesAndNewlines),
        deps: node.deps
      )
    }
    Task {
      let error: String?
      switch mode {
      case .create:
        error = await daemon.createOrchestrationGraph(
          objective: objective.trimmingCharacters(in: .whitespacesAndNewlines),
          nodes: cleanNodes,
          operationId: operationID
        )
      case .edit(let runId, let baseRevision):
        error = await daemon.applyOrchestrationGraph(
          runId: runId,
          baseRevision: baseRevision,
          nodes: cleanNodes,
          deleteTaskIds: deletedPersistedIDs,
          operationId: operationID
        )
      }
      submitting = false
      if let error {
        submitError = error
      } else {
        dismiss()
      }
    }
  }
}

/// 自动按依赖层级排布；编辑依赖时节点与连线即时重排。
private struct GraphDraftCanvas: View {
  let nodes: [OrchestrationGraphDraftNode]
  let lockedIDs: Set<String>
  @Binding var selection: String?

  private let nodeWidth: CGFloat = 188
  private let nodeHeight: CGFloat = 76

  private struct Layout {
    var positions: [String: CGPoint]
    var size: CGSize
  }

  var body: some View {
    let layout = makeLayout()
    ScrollView([.horizontal, .vertical]) {
      ZStack {
        Canvas { context, _ in
          for node in nodes {
            guard let end = layout.positions[node.id] else { continue }
            for dependency in node.deps {
              guard let start = layout.positions[dependency] else { continue }
              let from = CGPoint(x: start.x + nodeWidth / 2, y: start.y)
              let to = CGPoint(x: end.x - nodeWidth / 2, y: end.y)
              let bend = (from.x + to.x) / 2
              var edge = Path()
              edge.move(to: from)
              edge.addCurve(
                to: to,
                control1: CGPoint(x: bend, y: from.y),
                control2: CGPoint(x: bend, y: to.y)
              )
              context.stroke(edge, with: .color(.secondary.opacity(0.48)), lineWidth: 2)
              var arrow = Path()
              arrow.move(to: to)
              arrow.addLine(to: CGPoint(x: to.x - 8, y: to.y - 5))
              arrow.addLine(to: CGPoint(x: to.x - 8, y: to.y + 5))
              arrow.closeSubpath()
              context.fill(arrow, with: .color(.secondary.opacity(0.62)))
            }
          }
        }

        ForEach(nodes) { node in
          Button {
            selection = node.id
          } label: {
            VStack(alignment: .leading, spacing: 7) {
              Text(node.title.isEmpty ? "未命名任务" : node.title)
                .font(.headline)
                .lineLimit(1)
              HStack {
                Label("\(node.deps.count) 个依赖", systemImage: "arrow.triangle.branch")
                Spacer()
                if lockedIDs.contains(node.id) {
                  Image(systemName: "lock.fill").foregroundStyle(.secondary)
                } else {
                  Image(systemName: node.spec.isEmpty ? "exclamationmark.circle" : "checkmark.circle.fill")
                    .foregroundStyle(node.spec.isEmpty ? .orange : .green)
                }
              }
              .font(.caption)
              .foregroundStyle(.secondary)
            }
            .padding(12)
            .frame(width: nodeWidth, height: nodeHeight, alignment: .leading)
            .background(
              selection == node.id
                ? Color.accentColor.opacity(0.13)
                : lockedIDs.contains(node.id)
                  ? Color.secondary.opacity(0.08)
                  : Color(nsColor: .controlBackgroundColor),
              in: RoundedRectangle(cornerRadius: 11, style: .continuous)
            )
            .overlay {
              RoundedRectangle(cornerRadius: 11, style: .continuous)
                .stroke(selection == node.id ? Color.accentColor : Color.secondary.opacity(0.22), lineWidth: selection == node.id ? 2 : 1)
            }
          }
          .buttonStyle(.plain)
          .position(layout.positions[node.id] ?? .zero)
        }
      }
      .frame(width: layout.size.width, height: layout.size.height)
    }
    .background(.quaternary.opacity(0.16))
    .accessibilityLabel("任务依赖图")
  }

  private func makeLayout() -> Layout {
    var memo: [String: Int] = [:]
    func level(_ id: String, stack: Set<String> = []) -> Int {
      if let cached = memo[id] { return cached }
      guard !stack.contains(id), let node = nodes.first(where: { $0.id == id }) else { return 0 }
      let nextStack = stack.union([id])
      let value = node.deps.isEmpty
        ? 0
        : (node.deps.map { level($0, stack: nextStack) }.max() ?? -1) + 1
      memo[id] = value
      return value
    }

    var rows: [Int: Int] = [:]
    var positions: [String: CGPoint] = [:]
    for node in nodes {
      let column = level(node.id)
      let row = rows[column, default: 0]
      rows[column] = row + 1
      positions[node.id] = CGPoint(
        x: 34 + nodeWidth / 2 + CGFloat(column) * (nodeWidth + 94),
        y: 34 + nodeHeight / 2 + CGFloat(row) * (nodeHeight + 42)
      )
    }
    let columns = (memo.values.max() ?? 0) + 1
    let rowCount = max(rows.values.max() ?? 1, 1)
    return Layout(
      positions: positions,
      size: CGSize(
        width: max(640, 68 + CGFloat(columns) * nodeWidth + CGFloat(max(columns - 1, 0)) * 94),
        height: max(480, 68 + CGFloat(rowCount) * nodeHeight + CGFloat(max(rowCount - 1, 0)) * 42)
      )
    )
  }
}

private struct GoalRunRow: View {
  let run: OrchestrationStatus.Run
  @Bindable var daemon: DaemonController
  @State private var customDecisions: [String: String] = [:]
  @State private var showingTaskComposer = false
  @State private var showingGraphEditor = false
  @State private var showingAutomationComposer = false
  @State private var showingDeleteConfirmation = false
  @State private var showingCompleteConfirmation = false
  @State private var showingAbandonConfirmation = false
  @State private var dispatchingTask: OrchestrationStatus.Task?
  @State private var actionError: String?

  private var tasks: [OrchestrationStatus.Task] {
    daemon.orchestration.tasks.filter { $0.runId == run.id }
  }
  private var dispatches: [OrchestrationStatus.Dispatch] {
    daemon.orchestration.dispatches.filter { $0.runId == run.id }
  }
  private var gates: [OrchestrationStatus.Gate] {
    daemon.orchestration.gates.filter { $0.runId == run.id && $0.status == "pending" }
  }
  private var worktreeAssets: [OrchestrationStatus.WorktreeAsset] {
    daemon.orchestration.worktreeAssets.filter {
      $0.runId == run.id && $0.runDeletedAt == nil
    }
  }
  private var manual: Bool { run.coordinatorSessionId == nil }
  private var automationRunning: Bool { run.automation?.state == "running" }

  private var completedTasks: Int { tasks.filter { $0.status == "done" }.count }
  private var activeWorkers: Int {
    dispatches.filter { $0.state == "starting" || $0.state == "running" }.count
  }
  private var completionBlockers: [String] {
    let unfinished = tasks.filter { $0.status != "done" && $0.status != "cancelled" }.count
    return [
      activeWorkers > 0 ? "还有 \(activeWorkers) 个 worker 正在运行" : nil,
      unfinished > 0 ? "还有 \(unfinished) 个任务尚未结束" : nil,
      !gates.isEmpty ? "还有 \(gates.count) 个 Gate 待处理" : nil,
      automationRunning ? "自动执行仍在运行" : nil,
    ].compactMap { $0 }
  }
  private var deleteMessage: String {
    "“\(run.objective)”及其任务、消息和 Gate 会从编排列表中删除。" +
      orchestrationRunDeletionNotice(
        assets: worktreeAssets,
        tasks: tasks,
        automation: run.automation
      )
  }

  var body: some View {
    DashboardCard {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .top, spacing: 12) {
          Image(systemName: "point.3.connected.trianglepath.dotted")
            .font(.title2)
            .foregroundStyle(.purple)
            .frame(width: 34, height: 34)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
          VStack(alignment: .leading, spacing: 5) {
            Text(run.objective).font(.headline)
            Text("任务 \(completedTasks)/\(tasks.count) 已完成 · \(activeWorkers) 个 worker 运行中")
              .font(.caption)
              .foregroundStyle(.secondary)
            Text("任务图 revision \(run.graphRevision ?? 0)")
              .font(.caption2.monospacedDigit())
              .foregroundStyle(.tertiary)
          }
          Spacer()
          VStack(alignment: .trailing, spacing: 8) {
            HStack(spacing: 8) {
              Text("\(manual ? "手工" : "协调者") · \(run.status)")
                .font(.caption)
                .foregroundStyle(manual ? .blue : .purple)
              Button {
                if activeWorkers > 0 {
                  actionError = "还有 \(activeWorkers) 个 worker 正在运行。请先完成或停止这些会话，再删除编排。"
                } else {
                  showingDeleteConfirmation = true
                }
              } label: {
                Image(systemName: "trash")
              }
              .buttonStyle(.borderless)
              .foregroundStyle(.red)
              .help("删除编排")
            }
            if run.status == "active" {
              HStack(spacing: 6) {
                Button {
                  if completionBlockers.isEmpty {
                    showingCompleteConfirmation = true
                  } else {
                    actionError = "暂时不能完成：\(completionBlockers.joined(separator: "；"))。"
                  }
                } label: {
                  Label("完成", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.green)
                .help("标记这个 Run 已完成")

                Button {
                  if activeWorkers > 0 {
                    actionError = "还有 \(activeWorkers) 个 worker 正在运行。请先停止它们，避免留下游离工作。"
                  } else {
                    showingAbandonConfirmation = true
                  }
                } label: {
                  Label("放弃", systemImage: "xmark.circle.fill")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)
                .help("放弃这个 Run")
              }
            }
            if manual {
              VStack(alignment: .trailing, spacing: 6) {
                if run.status == "active" {
                  if automationRunning {
                    Button {
                      Task {
                        if let error = await daemon.pauseOrchestrationAutomation(runId: run.id) {
                          actionError = error
                        }
                      }
                    } label: {
                      Label("暂停自动", systemImage: "pause.fill")
                    }
                    .tint(.orange)
                  } else {
                    Button {
                      showingAutomationComposer = true
                    } label: {
                      Label(run.automation?.state == "paused" ? "继续自动" : "自动运行", systemImage: "play.fill")
                    }
                    .tint(.purple)
                  }
                }
                if !automationRunning {
                  HStack(spacing: 6) {
                    Button {
                      showingGraphEditor = true
                    } label: {
                      Label("编辑图", systemImage: "pencil")
                    }
                    Button {
                      showingTaskComposer = true
                    } label: {
                      Label("任务", systemImage: "plus")
                    }
                  }
                }
              }
              .buttonStyle(.bordered)
              .controlSize(.small)
            }
          }
        }

        if let automation = run.automation {
          HStack(alignment: .top, spacing: 10) {
            Rectangle().fill(.purple.opacity(0.7)).frame(width: 3)
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Label("自动执行 · \(automation.state)", systemImage: "gearshape.2.fill")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(.purple)
                Spacer()
                Text(automation.agent).font(.caption.monospaced()).foregroundStyle(.secondary)
              }
              Text("\(automation.workspace == "run" ? "共享 Run worktree" : "当前目录") · \(automation.workspacePath)")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2)
              if let error = automation.lastError, !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(.orange)
              }
            }
          }
          .padding(.leading, 1)
        }

        if !worktreeAssets.isEmpty {
          Divider()
          WorktreeAssetSection(
            assets: worktreeAssets,
            tasks: tasks,
            daemon: daemon,
            reportError: { actionError = $0 }
          )
        }

        if !tasks.isEmpty {
          Divider()
          VStack(spacing: 8) {
            ForEach(tasks) { task in
              OrchestrationTaskRow(
                task: task,
                allTasks: tasks,
                latestDispatch: dispatches
                  .filter { $0.taskId == task.id }
                  .sorted { $0.startedAt > $1.startedAt }
                  .first,
                canDispatch: manual && !automationRunning && isReady(task),
                onDispatch: { dispatchingTask = task },
                onStop: { stopWorker(task) },
                onCancel: { cancelTask(task) },
                onRetry: { retryTask(task) }
              )
            }
          }
        } else if manual {
          Text("还没有任务。添加任务后即可选择 Agent 派发。")
            .font(.callout)
            .foregroundStyle(.secondary)
        }

        if !gates.isEmpty {
          Divider()
          ForEach(gates) { gate in
            HStack(alignment: .top, spacing: 10) {
              Rectangle().fill(.orange.opacity(0.75)).frame(width: 3)
              VStack(alignment: .leading, spacing: 9) {
                Label("需要你的决定", systemImage: "hand.raised.fill")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(.orange)
                Text(gate.question).font(.callout)
                if gate.options.isEmpty {
                  HStack(spacing: 8) {
                    TextField("输入决定", text: Binding(
                      get: { customDecisions[gate.id] ?? "" },
                      set: { customDecisions[gate.id] = $0 }
                    ))
                    .textFieldStyle(.roundedBorder)
                    Button("确认") {
                      resolve(gate, customDecisions[gate.id] ?? "")
                    }
                    .disabled((customDecisions[gate.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                  }
                } else {
                  HStack(spacing: 8) {
                    ForEach(gate.options, id: \.self) { option in
                      Button(option) { resolve(gate, option) }
                        .buttonStyle(.bordered)
                    }
                  }
                }
              }
            }
            .padding(.leading, 1)
          }
        }
      }
    }
    .sheet(isPresented: $showingTaskComposer) {
      ManualTaskComposer(
        existingTasks: tasks,
        submit: { title, spec, deps in
          Task {
            if let error = await daemon.createOrchestrationTask(
              runId: run.id,
              title: title,
              spec: spec,
              deps: deps
            ) {
              actionError = error
            } else {
              showingTaskComposer = false
            }
          }
        },
        cancel: { showingTaskComposer = false }
      )
    }
    .sheet(isPresented: $showingGraphEditor) {
      VisualGraphComposer(daemon: daemon, run: run, tasks: tasks)
    }
    .sheet(isPresented: $showingAutomationComposer) {
      AutomationComposer(
        existing: run.automation,
        submit: { agent, cwd, workspace, policy in
          Task {
            if let error = await daemon.startOrchestrationAutomation(
              runId: run.id,
              agent: agent,
              cwd: cwd,
              workspace: workspace,
              approvalPolicy: policy
            ) {
              actionError = error
            } else {
              showingAutomationComposer = false
            }
          }
        },
        cancel: { showingAutomationComposer = false }
      )
    }
    .sheet(item: $dispatchingTask) { task in
      WorkerDispatchComposer(
        task: task,
        submit: { agent, cwd, worktree, policy in
          Task {
            if let error = await daemon.startOrchestrationWorker(
              taskId: task.id,
              agent: agent,
              cwd: cwd,
              worktree: worktree,
              approvalPolicy: policy
            ) {
              actionError = error
            } else {
              dispatchingTask = nil
            }
          }
        },
        cancel: { dispatchingTask = nil }
      )
    }
    .confirmationDialog(
      "删除这条编排？",
      isPresented: $showingDeleteConfirmation,
      titleVisibility: .visible
    ) {
      Button("删除编排", role: .destructive) {
        Task {
          if let error = await daemon.deleteOrchestrationRun(runId: run.id) {
            actionError = error
          }
        }
      }
      Button("取消", role: .cancel) {}
    } message: {
      Text(deleteMessage)
    }
    .confirmationDialog(
      "标记这个 Run 已完成？",
      isPresented: $showingCompleteConfirmation,
      titleVisibility: .visible
    ) {
      Button("完成") {
        Task {
          if let error = await daemon.completeOrchestrationRun(runId: run.id) {
            actionError = error
          }
        }
      }
      Button("取消", role: .cancel) {}
    } message: {
      Text("“\(run.objective)”会进入已结束的只读编排；关联工作树默认保留，便于检查和恢复。")
    }
    .confirmationDialog(
      "放弃这个 Run？",
      isPresented: $showingAbandonConfirmation,
      titleVisibility: .visible
    ) {
      Button("放弃 Run", role: .destructive) {
        Task {
          if let error = await daemon.abandonOrchestrationRun(runId: run.id) {
            actionError = error
          }
        }
      }
      Button("返回", role: .cancel) {}
    } message: {
      Text("“\(run.objective)”会进入已结束的只读编排；尚未执行的任务和待处理 Gate 会一并取消，关联工作树仍会保留。")
    }
    .alert("编排操作失败", isPresented: Binding(
      get: { actionError != nil },
      set: { if !$0 { actionError = nil } }
    )) {
      Button("好") { actionError = nil }
    } message: {
      Text(actionError ?? "未知错误")
    }
  }

  private func isReady(_ task: OrchestrationStatus.Task) -> Bool {
    task.status == "pending" && task.deps.allSatisfy { dependency in
      tasks.first { $0.id == dependency }?.status == "done"
    }
  }

  private func resolve(_ gate: OrchestrationStatus.Gate, _ decision: String) {
    let trimmed = decision.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    Task {
      if let error = await daemon.resolveGate(id: gate.id, decision: trimmed) {
        actionError = error.isEmpty ? "daemon 拒绝了这次决策" : error
      } else {
        customDecisions[gate.id] = ""
      }
    }
  }

  private func stopWorker(_ task: OrchestrationStatus.Task) {
    Task {
      if let error = await daemon.stopOrchestrationWorker(taskId: task.id) {
        actionError = error.isEmpty ? "daemon 拒绝停止 worker" : error
      }
    }
  }

  private func cancelTask(_ task: OrchestrationStatus.Task) {
    Task {
      if let error = await daemon.cancelOrchestrationTask(taskId: task.id) {
        actionError = error.isEmpty ? "daemon 拒绝取消任务" : error
      }
    }
  }

  private func retryTask(_ task: OrchestrationStatus.Task) {
    Task {
      if let error = await daemon.retryOrchestrationTask(taskId: task.id) {
        actionError = error.isEmpty ? "daemon 拒绝重试任务" : error
      }
    }
  }
}

private struct DeletedRunWorktreeAssetsSection: View {
  let assets: [OrchestrationStatus.WorktreeAsset]
  @Bindable var daemon: DaemonController
  @State private var expanded = false
  @State private var actionError: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: 8) {
          Image(systemName: expanded ? "chevron.down" : "chevron.right")
            .font(.caption.weight(.bold))
            .foregroundStyle(.secondary)
          Label("已删除编排遗留工作树", systemImage: "point.3.connected.trianglepath.dotted")
            .font(.headline)
          Text("\(assets.count)")
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(.quaternary, in: Capsule())
          Spacer()
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(expanded ? "折叠" : "展开")已删除编排遗留工作树")

      if expanded {
        Text("删除或缺失 Run 的工作树仍可检查、打开和安全清理。")
          .font(.caption)
          .foregroundStyle(.secondary)
        WorktreeAssetSection(
          assets: assets,
          tasks: [],
          daemon: daemon,
          reportError: { actionError = $0 }
        )
      }
    }
    .alert("工作树操作失败", isPresented: Binding(
      get: { actionError != nil },
      set: { if !$0 { actionError = nil } }
    )) {
      Button("好") { actionError = nil }
    } message: {
      Text(actionError ?? "未知错误")
    }
  }
}

private struct WorktreeAssetSection: View {
  let assets: [OrchestrationStatus.WorktreeAsset]
  let tasks: [OrchestrationStatus.Task]
  @Bindable var daemon: DaemonController
  let reportError: (String) -> Void
  @State private var summaryTarget: OrchestrationStatus.WorktreeAsset?
  @State private var cleanupTarget: OrchestrationStatus.WorktreeAsset?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Label("工作树", systemImage: "point.3.connected.trianglepath.dotted")
            .font(.caption.weight(.semibold))
          Text("状态由主机 Git 只读检查决定；清理前会再次核验。")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Text("\(assets.count)")
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(.quaternary, in: Capsule())
      }

      ForEach(assets) { asset in
        VStack(alignment: .leading, spacing: 5) {
          HStack(spacing: 8) {
            Text(owner(for: asset)).font(.caption.weight(.semibold)).lineLimit(1)
            Spacer()
            Text(stateLabel(for: asset))
              .font(.caption2.weight(.semibold))
              .foregroundStyle(stateColor(for: asset))
              .padding(.horizontal, 6)
              .padding(.vertical, 2)
              .background(stateColor(for: asset).opacity(0.12), in: Capsule())
          }
          Text("分支 · \(asset.branch ?? "detached")")
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
          Text(asset.path)
            .font(.caption2.monospaced())
            .foregroundStyle(.tertiary)
            .lineLimit(1)
            .textSelection(.enabled)
          Text(stateDetail(for: asset))
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)

          HStack(spacing: 7) {
            Button("打开路径") {
              NSWorkspace.shared.open(URL(fileURLWithPath: asset.path))
            }
            .buttonStyle(.borderless)
            .disabled(!pathCanOpen(asset))

            Button("查看摘要") { summaryTarget = asset }
              .buttonStyle(.borderless)

            Button("检查") {
              Task {
                if let error = await daemon.inspectOrchestrationWorktree(assetId: asset.id) {
                  reportError(error.isEmpty ? "daemon 拒绝检查工作树" : error)
                }
              }
            }
            .buttonStyle(.borderless)

            if canClean(asset) {
              Button("清理", role: .destructive) { cleanupTarget = asset }
                .buttonStyle(.borderless)
            }
          }
          .font(.caption)
        }
        .padding(9)
        .background(.quaternary.opacity(0.42), in: RoundedRectangle(cornerRadius: 8))
      }
      if assets.isEmpty {
        Text("这个 Run 尚未登记独立工作树。")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .alert("工作树摘要", isPresented: Binding(
      get: { summaryTarget != nil },
      set: { if !$0 { summaryTarget = nil } }
    )) {
      Button("关闭") { summaryTarget = nil }
    } message: {
      Text(summaryTarget.map { summary(for: $0) } ?? "尚未检查")
    }
    .confirmationDialog(
      "清理这个工作树？",
      isPresented: Binding(
        get: { cleanupTarget != nil },
        set: { if !$0 { cleanupTarget = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("清理工作树", role: .destructive) {
        guard let target = cleanupTarget else { return }
        cleanupTarget = nil
        Task {
          if let error = await daemon.cleanupOrchestrationWorktree(assetId: target.id) {
            reportError(error.isEmpty ? "daemon 拒绝清理工作树" : error)
          }
        }
      }
      Button("取消", role: .cancel) { cleanupTarget = nil }
    } message: {
      Text(cleanupTarget.map {
        "将移除：\n\($0.path)\n\n服务端会在执行前重新确认安全状态。分支默认保留，方便恢复。"
      } ?? "")
    }
  }

  private func owner(for asset: OrchestrationStatus.WorktreeAsset) -> String {
    if asset.kind == "run" { return "共享 Run 工作树" }
    guard let taskId = asset.taskId else { return "worker · 已删除任务" }
    return tasks.first { $0.id == taskId }?.title ?? "worker · \(taskId)"
  }

  private func state(for asset: OrchestrationStatus.WorktreeAsset) -> String {
    orchestrationWorktreeState(asset)
  }

  private func stateLabel(for asset: OrchestrationStatus.WorktreeAsset) -> String {
    switch state(for: asset) {
    case "dirty": "有未提交改动"
    case "unmerged": "未合并"
    case "equivalent": "已合并"
    case "safe_to_clean": "可清理"
    case "cleaned": "已清理"
    case "missing": "路径已丢失"
    case "unknown": "无法确认"
    default: "待检查"
    }
  }

  private func stateDetail(for asset: OrchestrationStatus.WorktreeAsset) -> String {
    if state(for: asset) == "cleaned" { return "目录已移除；分支默认保留" }
    if let message = asset.lastInspection?.message, !message.isEmpty { return message }
    return switch state(for: asset) {
    case "dirty": "请先提交、暂存或保留改动"
    case "unmerged": "分支仍有未合并提交"
    case "equivalent": "与目标 ref 等价，可安全清理"
    case "safe_to_clean": "服务端已确认没有待保留改动"
    case "cleaned": "目录已移除；分支默认保留"
    default: "尚未获得安全结论"
    }
  }

  private func stateColor(for asset: OrchestrationStatus.WorktreeAsset) -> Color {
    switch state(for: asset) {
    case "equivalent", "safe_to_clean": .green
    case "dirty", "unmerged": .orange
    case "missing", "unknown": .red
    default: .secondary
    }
  }

  private func pathCanOpen(_ asset: OrchestrationStatus.WorktreeAsset) -> Bool {
    state(for: asset) != "cleaned" && asset.lastInspection?.pathExists != false
  }

  private func canClean(_ asset: OrchestrationStatus.WorktreeAsset) -> Bool {
    orchestrationWorktreeCanClean(asset)
  }

  private func summary(for asset: OrchestrationStatus.WorktreeAsset) -> String {
    guard let inspection = asset.lastInspection else {
      var lines = ["尚未检查。点“检查”可让主机只读核验工作树状态。"]
      if let error = asset.lastError, !error.isEmpty { lines.append("诊断：\(error)") }
      return lines.joined(separator: "\n")
    }
    var lines = [
      "状态：\(stateLabel(for: asset))",
      "目标：\(inspection.targetRef)",
      "分支：\(inspection.branch ?? asset.branch ?? "detached")",
    ]
    if let count = inspection.aheadCommitCount { lines.append("待合并提交：\(count)") }
    if let count = inspection.equivalentCommitCount { lines.append("等价提交：\(count)") }
    if let message = inspection.message, !message.isEmpty { lines.append("说明：\(message)") }
    return lines.joined(separator: "\n")
  }
}

private struct OrchestrationTaskRow: View {
  private enum DestructiveAction {
    case stopWorker
    case cancelTask
  }

  let task: OrchestrationStatus.Task
  let allTasks: [OrchestrationStatus.Task]
  let latestDispatch: OrchestrationStatus.Dispatch?
  let canDispatch: Bool
  let onDispatch: () -> Void
  let onStop: () -> Void
  let onCancel: () -> Void
  let onRetry: () -> Void
  @State private var destructiveAction: DestructiveAction?

  private var dependencyNames: String {
    task.deps.compactMap { id in allTasks.first { $0.id == id }?.title }.joined(separator: "、")
  }

  private var statusColor: Color {
    switch task.status {
    case "done": .green
    case "failed", "cancelled": .red
    case "dispatched": .orange
    case "blocked": .yellow
    default: .secondary
    }
  }

  private var workerActive: Bool {
    latestDispatch?.state == "starting" || latestDispatch?.state == "running"
  }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Circle().fill(statusColor).frame(width: 8, height: 8).padding(.top, 6)
      VStack(alignment: .leading, spacing: 4) {
        Text(task.title).fontWeight(.semibold)
        Text(task.spec).font(.caption).foregroundStyle(.secondary).lineLimit(3)
        if !dependencyNames.isEmpty {
          Text("依赖：\(dependencyNames)").font(.caption2).foregroundStyle(.tertiary)
        }
        if let result = task.result, !result.isEmpty {
          Text(result).font(.caption).foregroundStyle(task.status == "done" ? .green : .red)
        }
        if let latestDispatch {
          Text("worker \(latestDispatch.sessionId) · \(latestDispatch.state)")
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
        }
      }
      Spacer()
      VStack(alignment: .trailing, spacing: 8) {
        Text(task.status).font(.caption).foregroundStyle(statusColor)
        if workerActive {
          Button(role: .destructive) {
            destructiveAction = .stopWorker
          } label: {
            Label("停止", systemImage: "stop.circle")
          }
          .buttonStyle(.bordered)
          .controlSize(.small)
        } else if task.status == "pending" || task.status == "blocked" {
          Button(role: .destructive) {
            destructiveAction = .cancelTask
          } label: {
            Label("取消", systemImage: "xmark.circle")
          }
          .buttonStyle(.bordered)
          .controlSize(.small)
        } else if task.status == "failed" {
          Button(action: onRetry) {
            Label("重试", systemImage: "arrow.clockwise")
          }
          .buttonStyle(.bordered)
          .controlSize(.small)
        }
        if canDispatch {
          Button("派发", action: onDispatch)
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
      }
    }
    .padding(.vertical, 11)
    .overlay(alignment: .bottom) {
      Rectangle().fill(.quaternary).frame(height: 1)
    }
    .confirmationDialog(
      destructiveAction == .stopWorker ? "停止这个 worker？" : "取消这个任务？",
      isPresented: Binding(
        get: { destructiveAction != nil },
        set: { if !$0 { destructiveAction = nil } }
      ),
      titleVisibility: .visible
    ) {
      if destructiveAction == .stopWorker {
        Button("停止 worker", role: .destructive) {
          destructiveAction = nil
          onStop()
        }
      } else {
        Button("取消任务", role: .destructive) {
          destructiveAction = nil
          onCancel()
        }
      }
      Button("返回", role: .cancel) { destructiveAction = nil }
    } message: {
      if destructiveAction == .stopWorker {
        Text("worker 会话将结束，任务会转为 failed，之后可以重试。")
      } else {
        Text("任务会转为 cancelled；取消不等同于完成，因此依赖它的下游任务不会自动运行。")
      }
    }
  }
}

private struct ManualTaskComposer: View {
  let existingTasks: [OrchestrationStatus.Task]
  let submit: (String, String, [String]) -> Void
  let cancel: () -> Void
  @State private var title = ""
  @State private var spec = ""
  @State private var deps: Set<String> = []

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("添加任务").font(.title2.bold())
      TextField("任务标题", text: $title)
      Text("交付要求与验收条件").font(.caption).foregroundStyle(.secondary)
      TextEditor(text: $spec)
        .frame(minHeight: 120)
        .padding(8)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 9))
      if !existingTasks.isEmpty {
        Text("前置依赖").font(.headline)
        ScrollView {
          VStack(alignment: .leading) {
            ForEach(existingTasks) { task in
              Toggle(task.title, isOn: Binding(
                get: { deps.contains(task.id) },
                set: { selected in
                  if selected { deps.insert(task.id) } else { deps.remove(task.id) }
                }
              ))
            }
          }
        }
        .frame(maxHeight: 160)
      }
      HStack {
        Spacer()
        Button("取消", action: cancel)
        Button("添加到任务图") {
          submit(
            title.trimmingCharacters(in: .whitespacesAndNewlines),
            spec.trimmingCharacters(in: .whitespacesAndNewlines),
            Array(deps)
          )
        }
        .buttonStyle(.borderedProminent)
        .disabled(
          title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
          spec.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
      }
    }
    .padding(24)
    .frame(width: 540)
  }
}

private struct WorkerDispatchComposer: View {
  let task: OrchestrationStatus.Task
  let submit: (String, String, String, String) -> Void
  let cancel: () -> Void
  @State private var agent = "codex"
  @State private var cwd = ""
  @State private var worktree = "new"
  @State private var policy = "standard"

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("派发 worker").font(.title2.bold())
      Text(task.title).font(.headline)
      Form {
        Picker("Agent", selection: $agent) {
          ForEach(["claude", "codex", "opencode", "grok", "trae"], id: \.self) { Text($0) }
        }
        TextField("项目完整路径", text: $cwd)
        Picker("工作目录", selection: $worktree) {
          Text("新 worktree（隔离）").tag("new")
          Text("当前目录").tag("none")
        }
        Picker("审批策略", selection: $policy) {
          ForEach(["strict", "standard", "yolo"], id: \.self) { Text($0) }
        }
      }
      .formStyle(.grouped)
      HStack {
        Spacer()
        Button("取消", action: cancel)
        Button("启动 worker") {
          submit(agent, cwd.trimmingCharacters(in: .whitespacesAndNewlines), worktree, policy)
        }
        .buttonStyle(.borderedProminent)
        .disabled(cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(24)
    .frame(width: 540)
  }
}

private struct AutomationComposer: View {
  let submit: (String, String, String, String) -> Void
  let cancel: () -> Void
  @State private var agent: String
  @State private var cwd: String
  @State private var workspace: String
  @State private var policy: String

  init(
    existing: OrchestrationStatus.Automation?,
    submit: @escaping (String, String, String, String) -> Void,
    cancel: @escaping () -> Void
  ) {
    self.submit = submit
    self.cancel = cancel
    _agent = State(initialValue: existing?.agent ?? "codex")
    _cwd = State(initialValue: existing?.cwd ?? "")
    _workspace = State(initialValue: existing?.workspace ?? "run")
    _policy = State(initialValue: existing?.approvalPolicy ?? "standard")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("一键运行任务图").font(.title2.bold())
      Text("daemon 按依赖安全串行推进；只有 worker 显式交付后才启动下游任务。")
        .font(.callout)
        .foregroundStyle(.secondary)
      Form {
        Picker("默认 Agent", selection: $agent) {
          ForEach(["claude", "codex", "opencode", "grok", "trae"], id: \.self) { Text($0) }
        }
        TextField("项目完整路径", text: $cwd)
        Picker("整张图的工作区", selection: $workspace) {
          Text("共享 Run worktree（推荐）").tag("run")
          Text("当前目录").tag("current")
        }
        Picker("审批策略", selection: $policy) {
          ForEach(["strict", "standard", "yolo"], id: \.self) { Text($0) }
        }
      }
      .formStyle(.grouped)
      Text(
        workspace == "run"
          ? "整张 Run 只创建一个隔离 worktree；上下游共享改动，同时不污染当前分支。"
          : "所有任务会直接修改所选目录；适合你已准备好的专用工作区。"
      )
      .font(.caption)
      .foregroundStyle(workspace == "run" ? Color.secondary : Color.orange)
      HStack {
        Spacer()
        Button("取消", action: cancel)
        Button("开始自动执行") {
          submit(
            agent,
            cwd.trimmingCharacters(in: .whitespacesAndNewlines),
            workspace,
            policy
          )
        }
        .buttonStyle(.borderedProminent)
        .disabled(cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(24)
    .frame(width: 560)
  }
}

private struct DevicesDashboard: View {
  @Bindable var daemon: DaemonController
  @Bindable var pairing: PairingModel
  @Environment(\.openWindow) private var openWindow
  @State private var deviceToRemove: DaemonStatus.Device?
  @State private var removalError: String?

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("已配对设备会持久保留，直到你主动撤销凭证。")
          .foregroundStyle(.secondary)
        Spacer()
        Button {
          pairing.reset()
          openWindow(id: "pairing")
          NSApp.activate(ignoringOtherApps: true)
        } label: {
          Label("配对新设备", systemImage: "qrcode")
        }
        .buttonStyle(.borderedProminent)
      }
      .padding(20)

      Divider()

      if daemon.status.devices.isEmpty {
        ContentUnavailableView(
          "尚无配对设备",
          systemImage: "iphone.slash",
          description: Text("生成二维码后，用 iPhone 上的 Prospero 扫码。")
        )
      } else {
        List(daemon.status.devices) { device in
          HStack(spacing: 14) {
            Image(systemName: "iphone")
              .font(.title2)
              .foregroundStyle(device.bound ? .green : .secondary)
              .frame(width: 38, height: 38)
              .background(.quaternary, in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 4) {
              Text(device.name).font(.headline)
              HStack(spacing: 10) {
                Text(device.bound ? "已绑定" : "等待首次连接")
                Text(device.allowShell ? "允许终端" : "禁止终端")
                Text(device.allowOrchestration ? "允许编排" : "只读编排")
                if let lastSeen = device.lastSeenAt {
                  Text("最近 \(relativeDate(lastSeen))")
                }
              }
              .font(.caption)
              .foregroundStyle(.secondary)
            }
            Spacer()
            Button("撤销", role: .destructive) { deviceToRemove = device }
          }
          .padding(.vertical, 7)
        }
      }
    }
    .navigationTitle("设备")
    .alert("撤销设备？", isPresented: Binding(
      get: { deviceToRemove != nil },
      set: { if !$0 { deviceToRemove = nil } }
    ), presenting: deviceToRemove) { device in
      Button("撤销凭证", role: .destructive) {
        removalError = daemon.revokeDevice(named: device.name)
        deviceToRemove = nil
      }
      Button("取消", role: .cancel) {}
    } message: { device in
      Text("“\(device.name)”会立即断开，之后必须重新扫码。所有同名记录会一起删除。")
    }
    .alert("撤销失败", isPresented: Binding(
      get: { removalError != nil },
      set: { if !$0 { removalError = nil } }
    )) {
      Button("好") { removalError = nil }
    } message: {
      Text(removalError ?? "未知错误")
    }
  }
}

private struct LogsDashboard: View {
  @Bindable var daemon: DaemonController

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("daemon 输出 · 最近 \(daemon.recentLog.count) 行")
          .foregroundStyle(.secondary)
        Spacer()
        Button("清空日志", role: .destructive) { daemon.clearLog() }
        Button("在 Finder 中显示") {
          NSWorkspace.shared.activateFileViewerSelecting([daemon.logURL])
        }
      }
      .padding(16)
      Divider()
      ScrollView {
        Text(daemon.recentLog.isEmpty ? "(暂无日志)" : daemon.recentLog.joined(separator: "\n"))
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(16)
      }
      .background(Color(nsColor: .textBackgroundColor))
    }
    .navigationTitle("日志")
  }
}

private struct SettingsDashboard: View {
  @Bindable var daemon: DaemonController
  @State private var loginEnabled = LoginItem.isEnabled
  @State private var loginError: String?

  var body: some View {
    Form {
      Section("启动") {
        Toggle("登录 Mac 时启动 Prospero", isOn: $loginEnabled)
          .onChange(of: loginEnabled) { _, enabled in
            if let error = LoginItem.setEnabled(enabled) {
              loginError = error
              loginEnabled = LoginItem.isEnabled
            }
          }
        if let loginError {
          Text(loginError).foregroundStyle(.red)
        }
      }

      Section("持久化") {
        LabeledContent("结构化对话", value: daemon.running?.persistence.structured == true ? "已启用" : "未启用")
        LabeledContent("终端 / tmux", value: daemon.running?.persistence.pty == true ? "已启用" : "未启用")
        Text("结束会话会删除对应持久化记录；仅关闭窗口或重启 App 不会删除。")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Section("运行环境") {
        LabeledContent("Node", value: Locator.findNode() ?? "未找到")
        LabeledContent("Daemon", value: Locator.findCLI() ?? "未找到")
        LabeledContent("数据目录", value: DaemonStatus.home.path)
        HStack {
          Button("打开数据目录") { NSWorkspace.shared.open(DaemonStatus.home) }
          Button("重新检测") { daemon.refresh() }
        }
      }

      Section("网络") {
        LabeledContent("端口", value: String(daemon.status.port))
        LabeledContent("监听", value: daemon.status.bindLabel)
        if let note = daemon.bonjourNote {
          LabeledContent("Bonjour", value: note)
        }
      }
    }
    .formStyle(.grouped)
    .padding(12)
    .navigationTitle("设置")
  }
}

private func relativeDate(_ milliseconds: Double) -> String {
  let seconds = milliseconds > 10_000_000_000 ? milliseconds / 1000 : milliseconds
  return Date(timeIntervalSince1970: seconds).formatted(.relative(presentation: .named))
}
