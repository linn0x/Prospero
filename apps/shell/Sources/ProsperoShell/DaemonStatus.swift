import Foundation

/// `~/.prospero` 里 daemon 自己维护的状态。壳只读,不写 —— 配置的权威仍是 CLI。
struct DaemonStatus: Sendable, Equatable {
  var port: Int = 7423
  var bind: String?
  var notifyURL: String?
  /// Relay 的公开配置和运行时状态。不存在表示旧版 daemon，设置页会安全降级。
  var relay: RelayStatus?
  var devices: [Device] = []
  var agentAccounts: [AgentAccount] = []

  struct Device: Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var allowShell: Bool
    var allowOrchestration: Bool
    var bound: Bool
    var lastSeenAt: Double?
  }

  struct AgentAccount: Sendable, Equatable, Identifiable {
    var id: String
    var agent: String
    var name: String
    var managed: Bool
    var isDefault: Bool
  }

  var bindLabel: String { bind ?? "全部网卡" }

  static var home: URL {
    if let override = ProcessInfo.processInfo.environment["PROSPERO_HOME"] {
      return URL(fileURLWithPath: override)
    }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".prospero")
  }

  /// status.json 的原始解析结果。调用方拿到后可以同时喂给 `DaemonStatus.load(runtimeRoot:)`
  /// 和 `RunningStatus.load(root:)`,避免同一个文件在一次刷新里被解析两遍。
  /// 文件不存在时返回空字典 —— 与「daemon 没在跑」是同一个含义。
  static func readRuntimeRoot() -> [String: Any] {
    guard let data = try? Data(contentsOf: RunningStatus.fileURL),
          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [:] }
    return value
  }

  /// 读 config.json + devices.json。文件不存在是正常状态(还没跑过 daemon),不是错误。
  ///
  /// `runtimeRoot` 传入已解析好的 status.json 可以省掉一次重复解析;不传则自行读取,
  /// 自检等一次性调用点保持原样。
  static func load(runtimeRoot: [String: Any]? = nil) -> DaemonStatus {
    var status = DaemonStatus()
    var configRoot: [String: Any]?

    if let data = try? Data(contentsOf: home.appendingPathComponent("config.json")),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      configRoot = obj
      status.port = obj["port"] as? Int ?? 7423
      status.bind = obj["bind"] as? String
      if let notify = obj["notify"] as? [String: Any] {
        status.notifyURL = notify["url"] as? String
      }
    }

    // status.json 只提供运行中的公开 relay 快照。不要把整个对象缓存到模型中：
    // 它还含本机 control token，而 RelayStatus 只挑选允许展示的字段。
    status.relay = RelayStatus.parse(
      config: configRoot,
      runtime: runtimeRoot ?? Self.readRuntimeRoot()
    )

    // devices.json 是 { "devices": [...] },不是裸数组 —— 按裸数组读会永远得到 0 台,
    // 而"配对成功"提示正是靠设备列表变化触发的,所以这里错了整个功能都是哑的。
    if let data = try? Data(contentsOf: home.appendingPathComponent("devices.json")),
       let root = try? JSONSerialization.jsonObject(with: data),
       let arr = (root as? [String: Any])?["devices"] as? [[String: Any]]
                 ?? root as? [[String: Any]] {
      status.devices = arr.enumerated().map { index, d in
        Device(
          id: d["token"] as? String ?? "\(d["name"] as? String ?? "device")-\(index)",
          name: d["name"] as? String ?? "(未命名)",
          allowShell: d["allowShell"] as? Bool ?? false,
          allowOrchestration: d["allowOrchestration"] as? Bool
            ?? (d["allowShell"] as? Bool ?? false),
          bound: d["clientPubKey"] != nil,
          lastSeenAt: d["lastSeenAt"] as? Double
        )
      }
    }

    // 账号元数据只含名称与隔离目录 ID；真实凭据位于各账号目录的 0600 私有文件。
    var storedAccounts: [[String: Any]] = []
    var defaults: [String: String] = [:]
    if let data = try? Data(contentsOf: home.appendingPathComponent("agent-accounts.json")),
       let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      storedAccounts = root["accounts"] as? [[String: Any]] ?? []
      defaults = root["defaults"] as? [String: String] ?? [:]
    }
    let nativeIDs = ["claude": "native-claude", "codex": "native-codex"]
    status.agentAccounts = nativeIDs.map { agent, id in
      AgentAccount(
        id: id,
        agent: agent,
        name: "本机默认",
        managed: false,
        isDefault: (defaults[agent] ?? id) == id
      )
    }
    status.agentAccounts.append(contentsOf: storedAccounts.compactMap { account in
      guard let id = account["id"] as? String,
            let agent = account["agent"] as? String,
            agent == "claude" || agent == "codex" else { return nil }
      return AgentAccount(
        id: id,
        agent: agent,
        name: account["name"] as? String ?? agent,
        managed: true,
        isDefault: defaults[agent] == id
      )
    })

    return status
  }
}
