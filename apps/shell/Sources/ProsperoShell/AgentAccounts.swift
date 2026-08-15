import Foundation
import Observation
import SwiftUI

/// Public, secret-free account snapshot returned by the daemon's account protocol.
/// This deliberately mirrors `AgentAccountSchema`; credentials are write-only and
/// never become part of a SwiftUI model, status file, or diagnostic string.
struct CodeAgentAccount: Codable, Sendable, Equatable, Identifiable {
  enum Agent: String, Codable, Sendable, CaseIterable {
    case claude
    case codex

    var title: String { self == .claude ? "Claude Code" : "Codex" }
  }

  enum Status: String, Codable, Sendable {
    case signedIn = "signed_in"
    case signedOut = "signed_out"
    case unavailable
    case error

    var label: String {
      switch self {
      case .signedIn: "已登录"
      case .signedOut: "未登录"
      case .unavailable: "CLI 未安装"
      case .error: "状态读取失败"
      }
    }

    var color: Color {
      switch self {
      case .signedIn: .green
      case .signedOut: .secondary
      case .unavailable: .orange
      case .error: .red
      }
    }
  }

  struct APIProfile: Codable, Sendable, Equatable {
    let provider: String
    let baseUrl: String
    let model: String

    var providerLabel: String {
      provider == "openai_compatible" ? "OpenAI 兼容 API" : "Anthropic 兼容 API"
    }
  }

  let id: String
  let agent: Agent
  let name: String
  let managed: Bool
  let isDefault: Bool
  let status: Status
  let apiProfile: APIProfile?
  let authMethod: String?
  let detail: String?
  let createdAt: Int
  let updatedAt: Int
  let activeSessions: Int

  var environmentLabel: String {
    if apiProfile != nil { return "Prospero API Profile" }
    return managed ? "Prospero 独立环境" : "现有本机环境（兼容旧会话）"
  }
}

struct AgentAccountControlResponse: Codable, Sendable, Equatable {
  let type: String
  let requestId: String
  let action: String
  let ok: Bool
  let accounts: [CodeAgentAccount]
  let sessionId: String?
  let error: String?
}

/// Exact C2S account message shapes accepted by `/_prospero/control/accounts`.
/// Secrets exist only while JSON encoding the corresponding request body.
enum AgentAccountOperation: Sendable, Equatable {
  case list
  case create(agent: CodeAgentAccount.Agent, name: String)
  case createAPI(agent: CodeAgentAccount.Agent, name: String, baseURL: String, model: String, apiKey: String)
  case configureAPI(accountID: String, baseURL: String, model: String, apiKey: String)
  case rename(accountID: String, name: String)
  case setDefault(accountID: String)
  case login(accountID: String, cols: Int = 120, rows: Int = 40)
  case setCredential(accountID: String, kind: CredentialKind, credential: String)
  case logout(accountID: String)
  case delete(accountID: String)

  enum CredentialKind: String, Sendable, Equatable {
    case oauthToken = "oauth_token"
    case apiKey = "api_key"
  }

  var body: [String: Any] {
    switch self {
    case .list:
      ["type": "agent.accounts.list"]
    case let .create(agent, name):
      ["type": "agent.account.create", "agent": agent.rawValue, "name": name]
    case let .createAPI(agent, name, baseURL, model, apiKey):
      [
        "type": "agent.account.api.create", "agent": agent.rawValue, "name": name,
        "baseUrl": baseURL, "model": model, "apiKey": apiKey,
      ]
    case let .configureAPI(accountID, baseURL, model, apiKey):
      [
        "type": "agent.account.api.configure", "accountId": accountID,
        "baseUrl": baseURL, "model": model, "apiKey": apiKey,
      ]
    case let .rename(accountID, name):
      ["type": "agent.account.rename", "accountId": accountID, "name": name]
    case let .setDefault(accountID):
      ["type": "agent.account.default", "accountId": accountID]
    case let .login(accountID, cols, rows):
      ["type": "agent.account.login", "accountId": accountID, "cols": cols, "rows": rows]
    case let .setCredential(accountID, kind, credential):
      [
        "type": "agent.account.credential.set", "accountId": accountID,
        "credentialKind": kind.rawValue, "credential": credential,
      ]
    case let .logout(accountID):
      ["type": "agent.account.logout", "accountId": accountID]
    case let .delete(accountID):
      ["type": "agent.account.delete", "accountId": accountID]
    }
  }
}

struct AgentAccountControlFailure: LocalizedError, Sendable, Equatable {
  let message: String
  var errorDescription: String? { message }
}

enum AgentAccountInputValidator {
  static func name(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return (1...80).contains(trimmed.count) ? nil : "账号名称应为 1–80 个字符"
  }

  static func credential(_ value: String, apiKey: Bool) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    let lowerBound = apiKey ? 1 : 20
    guard (lowerBound...8192).contains(trimmed.count),
          !trimmed.contains("\n"), !trimmed.contains("\r"), !trimmed.contains("\0")
    else { return "凭据格式无效" }
    return nil
  }

  static func apiProfile(baseURL: String, model: String) -> String? {
    let address = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    let modelName = model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !address.isEmpty, address.count <= 2000,
          !modelName.isEmpty, modelName.count <= 300,
          let parts = URLComponents(string: address), let scheme = parts.scheme?.lowercased(),
          let host = parts.host, !host.isEmpty,
          parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil
    else { return "API 地址或模型名称格式无效" }
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
    guard scheme == "https" || (scheme == "http" && loopback) else {
      return "API 地址必须使用 HTTPS（localhost 可使用 HTTP）"
    }
    return nil
  }
}

/// Testable editor state. The view keeps it transient; it never persists secret fields.
struct AgentAccountEditorState: Equatable, Identifiable {
  enum Mode: Equatable {
    case create(CodeAgentAccount.Agent)
    case rename(CodeAgentAccount)
    case credential(CodeAgentAccount, AgentAccountOperation.CredentialKind)
    case createAPI(CodeAgentAccount.Agent)
    case configureAPI(CodeAgentAccount)
  }

  let id = UUID()
  let mode: Mode
  var name: String = ""
  var baseURL: String = ""
  var model: String = ""
  var secret: String = ""

  init(mode: Mode) {
    self.mode = mode
    switch mode {
    case let .rename(account): name = account.name
    case let .configureAPI(account):
      name = account.name
      baseURL = account.apiProfile?.baseUrl ?? ""
      model = account.apiProfile?.model ?? ""
    default: break
    }
  }

  var title: String {
    switch mode {
    case .create: "新增独立账号"
    case .rename: "重命名账号"
    case .credential: "安全导入凭据"
    case .createAPI: "新增 API Profile"
    case .configureAPI: "重新配置 API Profile"
    }
  }
}

@MainActor
@Observable
final class AgentAccountsModel {
  private let daemon: DaemonController
  private(set) var accounts: [CodeAgentAccount] = []
  private(set) var isLoading = false
  private(set) var busyAccountID: String?
  var actionError: String?

  init(daemon: DaemonController) {
    self.daemon = daemon
  }

  func refresh() async {
    isLoading = true
    defer { isLoading = false }
    do {
      let response = try await daemon.performAgentAccountOperation(.list)
      accounts = response.accounts
      actionError = response.ok ? nil : (response.error ?? "无法读取账号")
    } catch {
      actionError = error.localizedDescription
    }
  }

  /// Returns the official CLI login session id when the operation started one.
  @discardableResult
  func perform(_ operation: AgentAccountOperation, accountID: String? = nil) async -> String? {
    busyAccountID = accountID
    actionError = nil
    defer { busyAccountID = nil }
    do {
      let response = try await daemon.performAgentAccountOperation(operation)
      accounts = response.accounts
      if !response.ok {
        actionError = response.error ?? "账号操作失败"
        return nil
      }
      return response.sessionId
    } catch {
      actionError = error.localizedDescription
      return nil
    }
  }
}

extension DaemonController {
  /// Sends one exact protocol account message to the authenticated loopback plane.
  /// No secret is placed in process arguments, status state, or the shell log.
  func performAgentAccountOperation(
    _ operation: AgentAccountOperation,
  ) async throws -> AgentAccountControlResponse {
    guard let running, !running.controlToken.isEmpty else {
      throw AgentAccountControlFailure(message: "daemon 未运行或版本过旧，无法管理本机账号")
    }
    guard let url = URL(string: "http://127.0.0.1:\(running.port)/_prospero/control/accounts") else {
      throw AgentAccountControlFailure(message: "无法构造账号控制地址")
    }
    var body = operation.body
    let requestID = UUID().uuidString
    body["requestId"] = requestID
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(running.controlToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await URLSession.shared.data(for: request)
    let http = response as? HTTPURLResponse
    if let decoded = try? JSONDecoder().decode(AgentAccountControlResponse.self, from: data),
       decoded.type == "agent.accounts.result", decoded.requestId == requestID {
      // Validation and in-use failures are structured account results. Keep the
      // snapshot, but let the view present the daemon's non-secret explanation.
      return decoded
    }
    let status = http?.statusCode ?? 0
    switch status {
    case 401: throw AgentAccountControlFailure(message: "本机控制口令已失效，请刷新或重启 daemon")
    case 403: throw AgentAccountControlFailure(message: "账号控制接口只允许本机回环访问")
    case 404: throw AgentAccountControlFailure(message: "当前 daemon 不支持账号管理，请升级并重启 daemon")
    case 413: throw AgentAccountControlFailure(message: "账号请求过大")
    default:
      throw AgentAccountControlFailure(message: "daemon 拒绝了账号操作（HTTP \(status)）")
    }
  }
}

struct AgentAccountsDashboard: View {
  @Bindable var daemon: DaemonController
  @State private var model: AgentAccountsModel
  @State private var editor: AgentAccountEditorState?
  @State private var credentialChoice: CodeAgentAccount?
  @State private var dangerAction: AccountDangerAction?
  @State private var loginSession: RunningStatus.Session?

  init(daemon: DaemonController) {
    self.daemon = daemon
    _model = State(initialValue: AgentAccountsModel(daemon: daemon))
  }

  private var grouped: [(CodeAgentAccount.Agent, [CodeAgentAccount])] {
    CodeAgentAccount.Agent.allCases.map { agent in
      (agent, model.accounts.filter { $0.agent == agent })
    }
  }

  var body: some View {
    accountContent
      .navigationTitle("Code Agent 账号")
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button { Task { await model.refresh() } } label: {
            Label("刷新", systemImage: "arrow.clockwise")
          }
          .disabled(model.isLoading)
        }
      }
      .task { await model.refresh() }
      .sheet(item: $editor) { state in
        AgentAccountEditorSheet(
          state: state,
          isSubmitting: model.busyAccountID == "editor",
          submit: { next in await submitEditor(next) },
          cancel: { editor = nil }
        )
      }
      .confirmationDialog(
        "导入 Claude 凭据",
        isPresented: Binding(get: { credentialChoice != nil }, set: { if !$0 { credentialChoice = nil } }),
        titleVisibility: .visible,
        presenting: credentialChoice
      ) { account in
        Button("订阅账号令牌") {
          editor = AgentAccountEditorState(mode: .credential(account, .oauthToken))
        }
        Button("Console API Key") {
          editor = AgentAccountEditorState(mode: .credential(account, .apiKey))
        }
        Button("取消", role: .cancel) {}
      } message: { _ in
        Text("凭据只会通过本机加密控制请求写入账号的私有安全存储，之后不会显示。")
      }
      .confirmationDialog(
        dangerAction?.title ?? "确认操作",
        isPresented: Binding(get: { dangerAction != nil }, set: { if !$0 { dangerAction = nil } }),
        titleVisibility: .visible,
        presenting: dangerAction
      ) { action in
        Button(action.confirmLabel, role: .destructive) {
          Task { await confirmDanger(action) }
        }
        Button("取消", role: .cancel) {}
      } message: { action in
        Text(action.message)
      }
      .sheet(item: $loginSession) { session in
        LocalSessionWorkspace(
          daemon: daemon,
          session: session,
          interrupt: { Task { _ = await daemon.controlSession(id: session.id, action: .interrupt) } },
          kill: { Task { _ = await daemon.controlSession(id: session.id, action: .kill) } },
          launchCLI: {},
          openSubagent: { _ in }
        )
        .frame(minWidth: 900, minHeight: 620)
      }
  }

  private var accountContent: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header
        errorNotice
        accountList
      }
      .padding(24)
      .frame(maxWidth: 980, alignment: .leading)
    }
  }

  @ViewBuilder
  private var errorNotice: some View {
    if let error = model.actionError {
      Label(error, systemImage: "exclamationmark.triangle.fill")
        .foregroundStyle(.red)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
  }

  @ViewBuilder
  private var accountList: some View {
    if model.isLoading && model.accounts.isEmpty {
      ProgressView("正在读取本机账号…")
        .frame(maxWidth: .infinity, minHeight: 180)
    } else {
      ForEach(grouped, id: \.0) { agent, accounts in
        accountSection(agent: agent, accounts: accounts)
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("本机 Code Agent 账号").font(.title2.weight(.semibold))
      Text("管理 Claude Code 与 Codex 的本机默认环境、独立账号和 API Profile。登录会在本机官方 CLI 终端中完成。")
        .foregroundStyle(.secondary)
      if daemon.running == nil {
        Label("daemon 未运行或没有可用的控制口令；账号信息不会从磁盘猜测。", systemImage: "lock.trianglebadge.exclamationmark")
          .font(.callout)
          .foregroundStyle(.orange)
      } else if case .externallyRunning = daemon.state {
        Label("正在使用终端启动的 daemon；操作仍通过它的本机回环控制接口完成。", systemImage: "terminal")
          .font(.callout)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func accountSection(agent: CodeAgentAccount.Agent, accounts: [CodeAgentAccount]) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Label(agent.title, systemImage: agent == .claude ? "sparkles" : "chevron.left.forwardslash.chevron.right")
          .font(.headline)
        Spacer()
        Button("新增独立账号") {
          editor = AgentAccountEditorState(mode: .create(agent))
        }
        Button("新增 API Profile") {
          editor = AgentAccountEditorState(mode: .createAPI(agent))
        }
      }
      if accounts.isEmpty {
        Text("正在等待 daemon 返回账号快照。")
          .foregroundStyle(.secondary)
          .padding(.vertical, 16)
      } else {
        ForEach(accounts) { account in
          accountCard(account)
        }
      }
    }
    .padding(16)
    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 14))
  }

  private func accountCard(_ account: CodeAgentAccount) -> some View {
    let busy = model.busyAccountID == account.id
    return VStack(alignment: .leading, spacing: 9) {
      HStack(alignment: .firstTextBaseline) {
        Text(account.name).font(.headline)
        if account.isDefault {
          Text("默认").font(.caption.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 2)
            .background(.blue.opacity(0.16), in: Capsule())
        }
        Spacer()
        Circle().fill(account.status.color).frame(width: 8, height: 8)
        Text(account.status.label).font(.caption).foregroundStyle(.secondary)
      }
      HStack(spacing: 5) {
        Text(account.environmentLabel)
        if let method = account.authMethod { Text("· \(method)") }
        if account.activeSessions > 0 { Text("· \(account.activeSessions) 个活动会话") }
      }
      .font(.subheadline).foregroundStyle(.secondary)
      if let profile = account.apiProfile {
        Text("\(profile.providerLabel) · \(profile.model)\n\(profile.baseUrl)")
          .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
      }
      if let detail = account.detail {
        Text(detail).font(.caption).foregroundStyle(.secondary)
      }
      Divider()
      HStack(spacing: 10) {
        if account.apiProfile != nil {
          Button("重新配置") { editor = AgentAccountEditorState(mode: .configureAPI(account)) }
          Button("替换 API Key") { editor = AgentAccountEditorState(mode: .credential(account, .apiKey)) }
        } else {
          Button(account.agent == .claude && account.managed ? "生成导入令牌" : account.status == .signedIn ? "重新登录" : "登录") {
            login(account)
          }
          if account.agent == .claude && account.managed {
            Button("导入凭据") { credentialChoice = account }
          }
        }
        if !account.isDefault {
          Button("设为默认") { Task { _ = await model.perform(.setDefault(accountID: account.id), accountID: account.id) } }
        }
        if account.managed {
          Button("重命名") { editor = AgentAccountEditorState(mode: .rename(account)) }
        }
        if account.status == .signedIn {
          Button(account.apiProfile == nil ? "注销" : "移除密钥", role: .destructive) {
            dangerAction = .logout(account)
          }
        }
        if account.managed {
          Button("删除", role: .destructive) {
            if account.activeSessions > 0 {
              model.actionError = "这个账号仍有 \(account.activeSessions) 个活动会话，请先结束它们。"
            } else {
              dangerAction = .delete(account)
            }
          }
        }
        if busy { ProgressView().controlSize(.small) }
      }
      .disabled(busy)
      .buttonStyle(.bordered)
    }
    .padding(14)
    .background(.background, in: RoundedRectangle(cornerRadius: 10))
  }

  private func submitEditor(_ state: AgentAccountEditorState) async -> Bool {
    let result: String?
    switch state.mode {
    case .create:
      result = AgentAccountInputValidator.name(state.name)
    case .rename:
      result = AgentAccountInputValidator.name(state.name)
    case let .credential(_, kind):
      result = AgentAccountInputValidator.credential(state.secret, apiKey: kind == .apiKey)
    case .createAPI, .configureAPI:
      result = AgentAccountInputValidator.name(state.name)
        ?? AgentAccountInputValidator.apiProfile(baseURL: state.baseURL, model: state.model)
        ?? AgentAccountInputValidator.credential(state.secret, apiKey: true)
    }
    if let result { model.actionError = result; return false }

    switch state.mode {
    case let .create(agent):
      _ = await model.perform(.create(agent: agent, name: state.name.trimmingCharacters(in: .whitespacesAndNewlines)), accountID: "editor")
    case let .rename(account):
      _ = await model.perform(.rename(accountID: account.id, name: state.name.trimmingCharacters(in: .whitespacesAndNewlines)), accountID: "editor")
    case let .credential(account, kind):
      _ = await model.perform(.setCredential(accountID: account.id, kind: kind, credential: state.secret.trimmingCharacters(in: .whitespacesAndNewlines)), accountID: "editor")
    case let .createAPI(agent):
      _ = await model.perform(.createAPI(agent: agent, name: state.name.trimmingCharacters(in: .whitespacesAndNewlines), baseURL: state.baseURL.trimmingCharacters(in: .whitespacesAndNewlines), model: state.model.trimmingCharacters(in: .whitespacesAndNewlines), apiKey: state.secret.trimmingCharacters(in: .whitespacesAndNewlines)), accountID: "editor")
    case let .configureAPI(account):
      _ = await model.perform(.configureAPI(accountID: account.id, baseURL: state.baseURL.trimmingCharacters(in: .whitespacesAndNewlines), model: state.model.trimmingCharacters(in: .whitespacesAndNewlines), apiKey: state.secret.trimmingCharacters(in: .whitespacesAndNewlines)), accountID: "editor")
    }
    return model.actionError == nil
  }

  private func login(_ account: CodeAgentAccount) {
    Task {
      guard let sessionID = await model.perform(.login(accountID: account.id), accountID: account.id) else { return }
      daemon.refresh()
      try? await Task.sleep(for: .milliseconds(180))
      daemon.refresh()
      guard let session = daemon.running?.sessions.first(where: { $0.id == sessionID }) else {
        model.actionError = "登录终端已创建，但暂时无法在工作台中打开；请在项目会话页刷新后重试。"
        return
      }
      loginSession = session
    }
  }

  private func confirmDanger(_ action: AccountDangerAction) async {
    switch action {
    case let .logout(account):
      _ = await model.perform(.logout(accountID: account.id), accountID: account.id)
    case let .delete(account):
      _ = await model.perform(.delete(accountID: account.id), accountID: account.id)
    }
  }
}

private enum AccountDangerAction: Identifiable {
  case logout(CodeAgentAccount)
  case delete(CodeAgentAccount)

  var id: String {
    switch self {
    case let .logout(account): "logout-\(account.id)"
    case let .delete(account): "delete-\(account.id)"
    }
  }

  var title: String {
    switch self {
    case let .logout(account): account.apiProfile == nil ? "注销账号？" : "移除 API Key？"
    case .delete: "删除独立账号环境？"
    }
  }

  var confirmLabel: String {
    switch self {
    case let .logout(account): account.apiProfile == nil ? "注销" : "移除"
    case .delete: "删除"
    }
  }

  var message: String {
    switch self {
    case let .logout(account):
      return account.apiProfile == nil
        ? "从 \(account.name) 的独立环境注销 \(account.agent.title)？"
        : "移除 \(account.name) 的 API Key？该独立配置与会话历史会保留。"
    case let .delete(account):
      return "会注销 \(account.name)，并删除它的本机配置、会话历史和插件状态。项目文件不会删除。"
    }
  }
}

private struct AgentAccountEditorSheet: View {
  @State private var state: AgentAccountEditorState
  let isSubmitting: Bool
  let submit: (AgentAccountEditorState) async -> Bool
  let cancel: () -> Void
  @State private var validationError: String?

  init(
    state: AgentAccountEditorState,
    isSubmitting: Bool,
    submit: @escaping (AgentAccountEditorState) async -> Bool,
    cancel: @escaping () -> Void,
  ) {
    _state = State(initialValue: state)
    self.isSubmitting = isSubmitting
    self.submit = submit
    self.cancel = cancel
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(state.title).font(.title3.weight(.semibold))
      form
      if let validationError {
        Text(validationError).font(.caption).foregroundStyle(.red)
      }
      HStack {
        Spacer()
        Button("取消", action: cancel).keyboardShortcut(.cancelAction)
        Button("保存") {
          Task {
            validationError = localValidation
            guard validationError == nil else { return }
            if await submit(state) { cancel() }
          }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(isSubmitting)
      }
    }
    .padding(24)
    .frame(width: 480)
  }

  @ViewBuilder
  private var form: some View {
    switch state.mode {
    case .create, .rename:
      TextField("账号名称", text: $state.name)
    case .credential:
      SecureField("凭据", text: $state.secret)
      Text("凭据仅用于此独立账号，保存后不会再显示。")
        .font(.caption).foregroundStyle(.secondary)
    case .createAPI:
      TextField("Profile 名称", text: $state.name)
      apiFields
    case .configureAPI:
      apiFields
    }
  }

  private var apiFields: some View {
    Group {
      TextField("API 地址", text: $state.baseURL)
      TextField("模型", text: $state.model)
      SecureField("API Key", text: $state.secret)
      Text("地址和模型可查看；API Key 仅写入账号私有安全存储，替换时必须重新输入。")
        .font(.caption).foregroundStyle(.secondary)
    }
  }

  private var localValidation: String? {
    switch state.mode {
    case .create, .rename:
      AgentAccountInputValidator.name(state.name)
    case let .credential(_, kind):
      AgentAccountInputValidator.credential(state.secret, apiKey: kind == .apiKey)
    case .createAPI:
      AgentAccountInputValidator.name(state.name)
        ?? AgentAccountInputValidator.apiProfile(baseURL: state.baseURL, model: state.model)
        ?? AgentAccountInputValidator.credential(state.secret, apiKey: true)
    case .configureAPI:
      AgentAccountInputValidator.apiProfile(baseURL: state.baseURL, model: state.model)
        ?? AgentAccountInputValidator.credential(state.secret, apiKey: true)
    }
  }
}
