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
    case .sessions: "会话"
    case .goals: "Goal"
    case .devices: "设备"
    case .logs: "日志"
    case .settings: "设置"
    }
  }

  var symbol: String {
    switch self {
    case .overview: "square.grid.2x2"
    case .sessions: "bubble.left.and.text.bubble.right"
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
  @State private var selection: DashboardPage = .overview

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
          SessionsDashboard(daemon: daemon)
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
            daemon.restart()
          } label: {
            Label("重启 daemon", systemImage: "arrow.clockwise")
          }
          .disabled(daemon.state == .starting)
        }
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
      .background(.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
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
  @Bindable var daemon: DaemonController
  @State private var sessionToKill: RunningStatus.Session?
  @State private var actionError: String?

  private var sessions: [RunningStatus.Session] {
    (daemon.running?.sessions ?? []).sorted {
      if ($0.pendingInteractions > 0) != ($1.pendingInteractions > 0) {
        return $0.pendingInteractions > 0
      }
      return $0.createdAt > $1.createdAt
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      if sessions.isEmpty {
        ContentUnavailableView(
          "没有会话",
          systemImage: "bubble.left.and.exclamationmark.bubble.right",
          description: Text(daemon.running == nil ? "daemon 启动后会在这里显示会话。" : "从手机新建一个 Agent 会话即可。")
        )
      } else {
        List(sessions) { session in
          SessionManagementRow(
            session: session,
            interrupt: { run(session, action: .interrupt) },
            kill: { sessionToKill = session }
          )
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
        }
        .listStyle(.inset)
      }
    }
    .navigationTitle("会话")
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

  private func run(_ session: RunningStatus.Session, action: DaemonController.SessionAction) {
    Task {
      if let error = await daemon.controlSession(id: session.id, action: action) {
        actionError = error.isEmpty ? "daemon 拒绝了操作" : error
      }
      sessionToKill = nil
    }
  }
}

private struct SessionManagementRow: View {
  let session: RunningStatus.Session
  let interrupt: () -> Void
  let kill: () -> Void

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
          Button("中断", action: interrupt)
            .disabled(
              session.status == "idle" || session.status == "completed" ||
              session.status == "done" || session.status == "died"
            )
          Button("结束", role: .destructive, action: kill)
        }
        .buttonStyle(.borderless)
        }
        if !session.subagents.isEmpty {
          Divider()
          VStack(alignment: .leading, spacing: 7) {
            Text("子 Agent").font(.caption).foregroundStyle(.secondary)
            ForEach(session.subagents) { child in
              HStack(spacing: 9) {
                Circle()
                  .fill(child.status == "running" || child.status == "starting" ? Color.blue : Color.secondary)
                  .frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 2) {
                  Text(child.name).font(.callout).fontWeight(.medium)
                  if let preview = child.preview, !preview.isEmpty {
                    Text(preview).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                  }
                }
                Spacer()
                Text(child.statusLabel).font(.caption).foregroundStyle(.secondary)
                if child.canMessage {
                  Label("手机可对话", systemImage: "iphone")
                    .font(.caption2)
                    .foregroundStyle(.blue)
                }
              }
              .padding(.leading, 8)
            }
          }
        }
      }
    }
  }
}

private struct GoalsDashboard: View {
  @Bindable var daemon: DaemonController
  @State private var customDecisions: [String: String] = [:]
  @State private var actionError: String?

  private var runs: [OrchestrationStatus.Run] {
    daemon.orchestration.runs.filter { $0.status == "active" }
  }

  var body: some View {
    Group {
      if runs.isEmpty {
        ContentUnavailableView(
          "没有进行中的 Goal",
          systemImage: "point.3.connected.trianglepath.dotted",
          description: Text("在 iPhone/iPad 的新会话页选择 Goal 后，协调者、任务与人工决策会显示在这里。")
        )
      } else {
        List(runs) { run in
          GoalRunRow(
            run: run,
            tasks: daemon.orchestration.tasks.filter { $0.runId == run.id },
            dispatches: daemon.orchestration.dispatches.filter { $0.runId == run.id },
            gates: daemon.orchestration.gates.filter { $0.runId == run.id && $0.status == "pending" },
            customDecisions: $customDecisions,
            resolve: resolveGate
          )
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
        }
        .listStyle(.inset)
      }
    }
    .navigationTitle("Goal")
    .toolbar {
      Button {
        daemon.refresh()
      } label: {
        Label("刷新", systemImage: "arrow.clockwise")
      }
    }
    .alert("无法提交决策", isPresented: Binding(
      get: { actionError != nil },
      set: { if !$0 { actionError = nil } }
    )) {
      Button("好") { actionError = nil }
    } message: {
      Text(actionError ?? "未知错误")
    }
  }

  private func resolveGate(_ gate: OrchestrationStatus.Gate, decision: String) {
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
}

private struct GoalRunRow: View {
  let run: OrchestrationStatus.Run
  let tasks: [OrchestrationStatus.Task]
  let dispatches: [OrchestrationStatus.Dispatch]
  let gates: [OrchestrationStatus.Gate]
  @Binding var customDecisions: [String: String]
  let resolve: (OrchestrationStatus.Gate, String) -> Void

  private var completedTasks: Int { tasks.filter { $0.status == "done" }.count }
  private var activeWorkers: Int {
    dispatches.filter { $0.state == "starting" || $0.state == "running" }.count
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
          }
          Spacer()
          Text("进行中")
            .font(.caption)
            .foregroundStyle(.green)
        }

        if !gates.isEmpty {
          Divider()
          ForEach(gates) { gate in
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
            .padding(12)
            .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
          }
        }
      }
    }
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
