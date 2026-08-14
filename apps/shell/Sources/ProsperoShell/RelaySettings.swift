import Foundation
import Observation

/// Relay 的公开状态。这里故意没有 hostSecret、设备凭证或 route ticket 字段：
/// Shell 既不需要它们，也绝不能把它们带进 View、日志或诊断输出。
struct RelayStatus: Sendable, Equatable {
  enum ConnectionState: String, Sendable, Equatable {
    case disabled
    case offline
    case connecting
    case connected
    case error
    case unknown

    var label: String {
      switch self {
      case .disabled: "已关闭"
      case .offline: "离线"
      case .connecting: "正在连接"
      case .connected: "已连接"
      case .error: "连接出错"
      case .unknown: "状态未知"
      }
    }
  }

  var enabled: Bool
  /// 用户在 `prosperod relay enable --url` 中设置的覆盖地址。nil 表示使用发布默认地址。
  var configuredURL: String?
  /// daemon/CLI 发布的默认地址；Shell 不读取或写入构建配置来猜测它。
  var publishedDefaultURL: String?
  var effectiveURL: String?
  var connectionState: ConnectionState
  var connectedAt: Double?
  var lastError: String?
  var retryAfterMs: Int?

  var displayURL: String? { effectiveURL ?? configuredURL ?? publishedDefaultURL }

  var retryHint: String? {
    guard let retryAfterMs, retryAfterMs > 0 else { return nil }
    if retryAfterMs < 1_000 { return "将在不足 1 秒后重试" }
    let seconds = Int((Double(retryAfterMs) / 1_000).rounded(.up))
    if seconds < 60 { return "将在约 \(seconds) 秒后重试" }
    return "将在约 \(Int((Double(seconds) / 60).rounded(.up))) 分钟后重试"
  }

  /// 解析 config.json 的 relay 小节和 status.json/CLI status 的运行时小节。
  /// 两者都可能来自不同版本的 daemon，因此字段缺失永远不是解析失败。
  static func parse(
    config: [String: Any]?,
    runtime: [String: Any]?
  ) -> RelayStatus? {
    let configRelay = dictionary(named: "relay", in: config)
    let runtimeRelay = dictionary(named: "relay", in: runtime)
    guard configRelay != nil || runtimeRelay != nil else { return nil }

    let configuredURL = string(named: ["url", "urlOverride", "overrideURL", "overrideUrl"], in: configRelay)
      ?? string(named: ["configuredURL", "configuredUrl", "urlOverride", "overrideURL", "overrideUrl"], in: runtimeRelay)
    let defaultURL = string(named: ["defaultURL", "defaultUrl", "defaultRelayURL", "defaultRelayUrl", "publishedDefaultURL", "publishedDefaultUrl"], in: runtimeRelay)
      ?? string(named: ["defaultURL", "defaultUrl", "defaultRelayURL", "defaultRelayUrl"], in: configRelay)
    let effectiveURL = string(named: ["effectiveURL", "effectiveUrl", "relayURL", "relayUrl", "url"], in: runtimeRelay)
      ?? configuredURL
      ?? defaultURL
    let enabled = bool(named: "enabled", in: runtimeRelay)
      ?? bool(named: "enabled", in: configRelay)
      ?? false
    let stateName = string(named: ["state", "connectionState", "connection_state", "status"], in: runtimeRelay)
    let lastError = RelayRedaction.redact(
      string(named: ["lastError", "last_error", "error"], in: runtimeRelay) ?? ""
    )

    return RelayStatus(
      enabled: enabled,
      configuredURL: configuredURL,
      publishedDefaultURL: defaultURL,
      effectiveURL: effectiveURL,
      connectionState: ConnectionState(rawValue: stateName, enabled: enabled),
      connectedAt: number(named: ["connectedAt", "connected_at", "lastConnectedAt", "last_connected_at", "lastReadyAt", "last_ready_at"], in: runtimeRelay),
      lastError: lastError.isEmpty ? nil : lastError,
      retryAfterMs: integer(named: ["retryAfterMs", "retry_after_ms"], in: runtimeRelay)
        ?? retryDelay(from: runtimeRelay)
    )
  }

  /// `prosperod relay status --json` 返回 relay 小节本身；兼容少量早期构建返回
  /// `{ relay: { ... } }` 的包装形状。
  static func parseCLIStatus(_ output: String, fallback: RelayStatus? = nil) -> RelayStatus? {
    guard let data = output.data(using: .utf8),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    let candidate: [String: Any]
    if let nested = root["relay"] as? [String: Any] {
      candidate = nested
    } else {
      candidate = root
    }

    let syntheticConfig: [String: Any]? = fallback.map {
      var value: [String: Any] = ["enabled": $0.enabled]
      if let url = $0.configuredURL { value["url"] = url }
      if let url = $0.publishedDefaultURL { value["defaultUrl"] = url }
      return ["relay": value]
    }
    return parse(config: syntheticConfig, runtime: ["relay": candidate])
  }

  private static func dictionary(named name: String, in root: [String: Any]?) -> [String: Any]? {
    root?[name] as? [String: Any]
  }

  private static func string(named names: [String], in root: [String: Any]?) -> String? {
    for name in names {
      if let value = root?[name] as? String, !value.isEmpty { return value }
    }
    return nil
  }

  private static func bool(named name: String, in root: [String: Any]?) -> Bool? {
    if let value = root?[name] as? Bool { return value }
    if let value = root?[name] as? NSNumber { return value.boolValue }
    return nil
  }

  private static func number(named names: [String], in root: [String: Any]?) -> Double? {
    for name in names {
      if let value = root?[name] as? Double { return value }
      if let value = root?[name] as? Int { return Double(value) }
      if let value = root?[name] as? NSNumber { return value.doubleValue }
    }
    return nil
  }

  private static func integer(named names: [String], in root: [String: Any]?) -> Int? {
    for name in names {
      if let value = root?[name] as? Int { return value }
      if let value = root?[name] as? NSNumber { return value.intValue }
    }
    return nil
  }

  /// 兼容 daemon 早期把下一次重连时间（Unix 毫秒）而非相对 delay 写进状态快照的形式。
  private static func retryDelay(from root: [String: Any]?) -> Int? {
    guard let retryAt = number(named: ["retryAt", "retry_at", "nextRetryAt", "next_retry_at"], in: root)
    else { return nil }
    let milliseconds = retryAt > 10_000_000_000 ? retryAt : retryAt * 1_000
    return max(0, Int(milliseconds - Date().timeIntervalSince1970 * 1_000))
  }
}

private extension RelayStatus.ConnectionState {
  init(rawValue: String?, enabled: Bool) {
    guard enabled else {
      self = .disabled
      return
    }
    switch rawValue?.lowercased() {
    case "connected", "ready", "online": self = .connected
    case "connecting", "reconnecting", "registering", "starting", "backoff": self = .connecting
    case "error", "failed": self = .error
    case "offline", "disconnected", "stopped", "idle": self = .offline
    case "disabled": self = .disabled
    case .none: self = .offline
    default: self = .unknown
    }
  }
}

/// 与 protocol 的 relay URL 部署策略逐字对齐：正式构建只接受 wss；debug 时
/// `ws` 也只能落在显式的 loopback 地址，且 CLI 会附带 `--dev`。
enum RelayURLValidator {
  static let maxLength = 2_048

  struct ValidationError: Error, Equatable, Sendable {
    var message: String
  }

  static func validate(_ rawValue: String, allowInsecureLoopback: Bool) -> Result<String, ValidationError> {
    let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return .success("") }
    guard value.count <= maxLength,
          let components = URLComponents(string: value),
          let scheme = components.scheme?.lowercased(),
          let host = components.host?.lowercased(),
          !host.isEmpty
    else { return .failure(ValidationError(message: "Relay URL 无效")) }

    guard components.user == nil,
          components.password == nil,
          components.percentEncodedQuery == nil,
          components.fragment == nil
    else { return .failure(ValidationError(message: "Relay URL 不可包含凭证、查询参数或片段")) }

    if scheme == "wss" { return .success(value) }
    if allowInsecureLoopback && scheme == "ws" && isLoopback(host) { return .success(value) }
    return .failure(ValidationError(message: "Relay URL 必须使用 wss；仅开发构建可使用本机回环 ws"))
  }

  private static func isLoopback(_ host: String) -> Bool {
    host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
  }
}

/// 不把敏感值放进 shell.log 或 UI 错误。这是 daemon 脱敏的第二层保护，不能替代 daemon
/// 端的安全日志策略，但可防止旧版/第三方 CLI 在失败输出中意外泄露字段值。
enum RelayRedaction {
  static func redact(_ value: String) -> String {
    var redacted = value
    let patterns = [
      #"(?i)([\"']?(?:hostSecret|deviceToken|relayToken|token)[\"']?\s*[:=]\s*[\"']?)([^\s\"',}\]]+)([\"']?)"#,
      #"(?i)([?&](?:hostSecret|deviceToken|relayToken|token)=)([^&#\s]+)"#,
    ]
    let replacements = ["$1[已隐藏]$3", "$1[已隐藏]"]
    for (pattern, replacement) in zip(patterns, replacements) {
      guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
      let range = NSRange(redacted.startIndex..., in: redacted)
      redacted = regex.stringByReplacingMatches(
        in: redacted,
        range: range,
        withTemplate: replacement
      )
    }
    return redacted
  }
}

struct RelayCLIPaths: Sendable, Equatable {
  var node: String?
  var cli: String?
}

struct RelayCLIResult: Sendable, Equatable {
  var status: Int32
  var output: String
}

protocol RelayCommandExecuting: Sendable {
  func run(node: String, arguments: [String]) async -> RelayCLIResult
}

struct SystemRelayCommandExecutor: RelayCommandExecuting {
  func run(node: String, arguments: [String]) async -> RelayCLIResult {
    await Task.detached(priority: .userInitiated) {
      let proc = Process()
      proc.executableURL = URL(fileURLWithPath: node)
      proc.arguments = arguments
      let pipe = Pipe()
      proc.standardOutput = pipe
      proc.standardError = pipe
      do {
        try proc.run()
      } catch {
        return RelayCLIResult(status: -1, output: "无法运行 prosperod: \(error.localizedDescription)")
      }
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      proc.waitUntilExit()
      return RelayCLIResult(status: proc.terminationStatus, output: String(decoding: data, as: UTF8.self))
    }.value
  }
}

enum RelayCLIInvocation: Equatable {
  case enable(url: String?, development: Bool)
  case disable
  case status
  case rotateKey

  func arguments(cli: String) -> [String] {
    switch self {
    case .enable(let url, let development):
      var args = [cli, "relay", "enable"]
      if let url, !url.isEmpty { args.append(contentsOf: ["--url", url]) }
      if development { args.append("--dev") }
      return args
    case .disable:
      return [cli, "relay", "disable"]
    case .status:
      return [cli, "relay", "status", "--json"]
    case .rotateKey:
      return [cli, "relay", "rotate-key", "--yes"]
    }
  }
}

@MainActor
@Observable
final class RelaySettingsModel {
  private(set) var relay: RelayStatus?
  private(set) var isWorking = false
  private(set) var cliSupported: Bool?
  private(set) var actionError: String?
  var urlInput: String

  private let paths: () -> RelayCLIPaths
  private let executor: any RelayCommandExecuting
  private let allowInsecureLoopback: Bool
  private var hasEditedURL = false

  init(
    status: DaemonStatus = .load(),
    paths: @escaping () -> RelayCLIPaths = {
      RelayCLIPaths(node: Locator.findNode(), cli: Locator.findCLI())
    },
    executor: any RelayCommandExecuting = SystemRelayCommandExecutor(),
    allowInsecureLoopback: Bool = RelaySettingsModel.developmentAllowsInsecureLoopback
  ) {
    relay = status.relay
    urlInput = status.relay?.configuredURL ?? ""
    self.paths = paths
    self.executor = executor
    self.allowInsecureLoopback = allowInsecureLoopback
  }

  var isEnabled: Bool { relay?.enabled == true }

  var validationError: String? {
    switch RelayURLValidator.validate(urlInput, allowInsecureLoopback: allowInsecureLoopback) {
    case .success: nil
    case .failure(let error): error.message
    }
  }

  func noteURLChanged() {
    hasEditedURL = true
    actionError = nil
  }

  /// DaemonController 的文件快照刷新时调用。CLI 最新状态优先；用户正在编辑时绝不覆盖输入。
  func consume(_ status: DaemonStatus) {
    guard !isWorking else { return }
    if let relay = status.relay {
      self.relay = relay
      if !hasEditedURL { urlInput = relay.configuredURL ?? "" }
    }
  }

  func refresh() async {
    await invoke(.status, refreshAfterSuccess: false)
  }

  func setEnabled(_ enabled: Bool) async {
    if enabled {
      switch RelayURLValidator.validate(urlInput, allowInsecureLoopback: allowInsecureLoopback) {
      case .failure(let error):
        actionError = error.message
        return
      case .success(let url):
        await invoke(.enable(
          url: url.isEmpty ? nil : url,
          development: allowInsecureLoopback && url.lowercased().hasPrefix("ws:")
        ))
      }
    } else {
      await invoke(.disable)
    }
  }

  func rotateKey() async {
    await invoke(.rotateKey)
  }

  private func invoke(_ invocation: RelayCLIInvocation, refreshAfterSuccess: Bool = true) async {
    guard !isWorking else { return }
    guard let node = paths().node, let cli = paths().cli else {
      actionError = "找不到 node 或 prosperod"
      return
    }
    isWorking = true
    actionError = nil
    let result = await executor.run(node: node, arguments: invocation.arguments(cli: cli))
    isWorking = false
    let output = RelayRedaction.redact(result.output).trimmingCharacters(in: .whitespacesAndNewlines)
    guard result.status == 0 else {
      if case .status = invocation, Self.indicatesUnsupportedRelayCommand(output) {
        cliSupported = false
        relay = nil
      } else {
        actionError = output.isEmpty ? "prosperod 未能完成 Relay 操作" : output
      }
      return
    }

    cliSupported = true
    if case .status = invocation {
      guard let parsed = RelayStatus.parseCLIStatus(output, fallback: relay) else {
        actionError = "prosperod 返回了无法识别的 Relay 状态"
        return
      }
      relay = parsed
      if !hasEditedURL { urlInput = parsed.configuredURL ?? "" }
      return
    }

    if refreshAfterSuccess { await invoke(.status, refreshAfterSuccess: false) }
  }

  private static func indicatesUnsupportedRelayCommand(_ output: String) -> Bool {
    let value = output.lowercased()
    return value.contains("unknown command") || value.contains("unknown subcommand") || value.contains("relay is not")
  }

  private static var developmentAllowsInsecureLoopback: Bool {
    #if DEBUG
      true
    #else
      false
    #endif
  }
}
