import Foundation
import ServiceManagement

/// 开机自启。SMAppService 取代了已废弃的 SMLoginItemSetEnabled,
/// 用户可以在「系统设置 → 通用 → 登录项」里看到并关掉 —— 这是好事,不该偷偷常驻。
enum LoginItem {
  static var isEnabled: Bool {
    SMAppService.mainApp.status == .enabled
  }

  /// 从构建目录直接跑时注册常会失败(系统要求 app 在稳定位置,通常是 /Applications)。
  /// 把失败原因返回给 UI,而不是静默无反应。
  static func setEnabled(_ enabled: Bool) -> String? {
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
      return nil
    } catch {
      return describe(error, enabling: enabled)
    }
  }

  static var statusLabel: String {
    switch SMAppService.mainApp.status {
    case .enabled: "已开启"
    case .requiresApproval: "待你在系统设置里批准"
    case .notFound: "不可用(app 不在稳定位置?)"
    case .notRegistered: "未开启"
    @unknown default: "未知"
    }
  }

  private static func describe(_ error: Error, enabling: Bool) -> String {
    let ns = error as NSError
    // Operation not permitted:多半是 app 还在 build 目录里,拖到 /Applications 再试
    if ns.domain == NSPOSIXErrorDomain && ns.code == 1 {
      return "注册失败:把 Prospero.app 拖到 /Applications 再试(系统不允许注册临时位置的 app)"
    }
    return "\(enabling ? "开启" : "关闭")失败:\(ns.localizedDescription)"
  }
}
