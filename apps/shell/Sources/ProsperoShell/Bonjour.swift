import Foundation

/// `_prospero._tcp` 广播,从 daemon 挪到壳里。
///
/// 理由是 TCC:macOS 15+ 本地网络访问要弹窗授权,由 .app bundle 承担比裸 node 干净得多 ——
/// node 那边弹窗归属终端(或者干脆不弹),用户在系统设置里也找不到 Prospero 这一项。
/// daemon 侧用 `--no-bonjour` 让位。
///
/// 注意 mDNS 组播不过 WireGuard 隧道,所以广播只对同一 WiFi 广播域有效;
/// WG 场景依然靠扫码带过去的地址簿,这是设计如此,不是这里的缺陷。
final class BonjourAdvertiser: NSObject, NetServiceDelegate {
  private var service: NetService?
  private(set) var lastError: String?
  private(set) var isPublished = false

  /// NetService 在 Network.framework 之后被标记为废弃,但它是唯一能为"别的进程持有的端口"
  /// 发布服务的 API —— NWListener 必须自己持有监听 socket,而端口在 daemon 手里。
  @available(macOS, deprecated: 100000)
  func start(port: Int, name: String) {
    stop()
    let service = NetService(domain: "local.", type: "_prospero._tcp.", name: name, port: Int32(port))
    service.delegate = self
    self.service = service
    lastError = nil
    service.publish()
  }

  func stop() {
    service?.stop()
    service = nil
    isPublished = false
  }

  func netServiceDidPublish(_ sender: NetService) {
    isPublished = true
    lastError = nil
  }

  func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
    isPublished = false
    // 最常见的是本地网络权限被拒 —— 那种情况会静默超时,不会给出明确错误
    let code = errorDict[NetService.errorCode]?.intValue ?? 0
    lastError = "广播失败(code \(code));检查系统设置里的本地网络权限"
  }
}
