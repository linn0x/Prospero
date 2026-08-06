import Foundation

/// `~/.prospero` 里 daemon 自己维护的状态。壳只读,不写 —— 配置的权威仍是 CLI。
struct DaemonStatus: Sendable, Equatable {
  var port: Int = 7423
  var bind: String?
  var notifyURL: String?
  var devices: [Device] = []

  struct Device: Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var allowShell: Bool
    var bound: Bool
    var lastSeenAt: Double?
  }

  var bindLabel: String { bind ?? "全部网卡" }

  static var home: URL {
    if let override = ProcessInfo.processInfo.environment["PROSPERO_HOME"] {
      return URL(fileURLWithPath: override)
    }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".prospero")
  }

  /// 读 config.json + devices.json。文件不存在是正常状态(还没跑过 daemon),不是错误。
  static func load() -> DaemonStatus {
    var status = DaemonStatus()

    if let data = try? Data(contentsOf: home.appendingPathComponent("config.json")),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      status.port = obj["port"] as? Int ?? 7423
      status.bind = obj["bind"] as? String
      if let notify = obj["notify"] as? [String: Any] {
        status.notifyURL = notify["url"] as? String
      }
    }

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
          bound: d["clientPubKey"] != nil,
          lastSeenAt: d["lastSeenAt"] as? Double
        )
      }
    }

    return status
  }
}
