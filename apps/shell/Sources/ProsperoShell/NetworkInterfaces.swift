import Foundation

/// 本机可以拿来监听的网卡地址。
///
/// **权威在 daemon 那边**:真正决定绑哪个地址的是 `apps/daemon/src/discovery.ts` 的
/// `resolveBindAddr()`,它接受网卡名或 IP,失败时会给出带可用列表的错误。
/// 这里枚举只是为了把选项摆到菜单上,过滤规则照抄同文件的 `candidateAddrs()`/`unusable()` ——
/// 改那边的规则时记得同步这里,否则菜单会列出 daemon 其实不认的地址。
struct NetworkInterface: Identifiable, Hashable, Sendable {
  /// 网卡名,如 en0 / utun8
  var name: String
  /// IPv4 地址
  var address: String

  var id: String { "\(name)|\(address)" }

  /// 菜单里一行的样子:`en0 · 192.168.31.101`
  var label: String { "\(name) · \(address)" }

  /// WireGuard 重连后 utun 编号会变,所以存地址比存网卡名稳 ——
  /// discovery.ts 里那条注释说的就是这个。
  var bindSpec: String { address }
}

enum NetworkInterfaces {
  /// 手机连不上的地址,列出来只会让人选错。判断依据同 discovery.ts 的 `unusable()`。
  private static func unusable(_ addr: String) -> Bool {
    // 198.18/15 是 RFC2544 基准测试段,Surge/Clash 这类工具拿它做 TUN
    if addr.hasPrefix("198.18.") || addr.hasPrefix("198.19.") { return true }
    // 169.254/16 link-local:没拿到 DHCP 时的自赋地址,不可路由
    if addr.hasPrefix("169.254.") { return true }
    // 以 .0 结尾的通常是网段地址而非主机地址(/24 下必然如此)
    if addr.hasSuffix(".0") { return true }
    return false
  }

  /// 本机全部在用的 IPv4 网卡,**不做可用性过滤**。顺序同 daemon:en* → utun* → 其它。
  ///
  /// 判断"配置里绑的那个地址还在不在"必须用这份,不能用 `candidates()` ——
  /// daemon 的 `resolveBindAddr()` 同样不过滤,拿过滤后的表去判断,
  /// 会把用户在终端里手动绑的 198.18 之类误判成已失效。
  static func all() -> [NetworkInterface] {
    var en: [NetworkInterface] = []
    var utun: [NetworkInterface] = []
    var other: [NetworkInterface] = []

    var ifaddr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddr) == 0 else { return [] }
    defer { freeifaddrs(ifaddr) }

    var cursor = ifaddr
    while let cur = cursor {
      defer { cursor = cur.pointee.ifa_next }

      let flags = cur.pointee.ifa_flags
      guard flags & UInt32(IFF_UP) != 0, flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
      guard let sa = cur.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }

      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let ok = getnameinfo(
        sa, socklen_t(sa.pointee.sa_len),
        &host, socklen_t(host.count),
        nil, 0, NI_NUMERICHOST
      )
      guard ok == 0 else { continue }

      // 走指针重载:接收 [CChar] 的那个 String(cString:) 已废弃
      let address = host.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
      let name = String(cString: cur.pointee.ifa_name)
      let iface = NetworkInterface(name: name, address: address)

      if name.hasPrefix("en") {
        en.append(iface)
      } else if name.hasPrefix("utun") {
        utun.append(iface)
      } else {
        other.append(iface)
      }
    }

    return en + utun + other
  }

  /// 菜单里给人挑的候选,过滤掉手机连不上的那些。
  static func candidates() -> [NetworkInterface] {
    all().filter { !unusable($0.address) }
  }

  /// 这个 `--bind` 值现在还解析得出地址吗?
  ///
  /// 对齐 daemon 的 `resolveBindAddr()`:接受网卡名,也接受地址本身。
  /// WireGuard 断开后,之前绑的 utun 地址就会在这里返回 false ——
  /// 那正是 daemon 会启动失败的情形。
  static func resolves(_ spec: String) -> Bool {
    if spec == "0.0.0.0" || spec == "::" { return true }
    return all().contains { $0.address == spec || $0.name == spec }
  }
}
