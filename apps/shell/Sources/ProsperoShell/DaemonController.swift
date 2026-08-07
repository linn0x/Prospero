import Foundation
import Observation

/// 起停并盯着 prosperod。
///
/// 这个壳存在的理由就在这里:daemon 作为 app 的子进程运行,TCC 权限归属 app bundle,
/// 于是 `~/Documents` 之类的访问能正常弹窗授权 —— LaunchAgent 直接拉起的 node 做不到,
/// 而且无法在系统设置里补授权。
@MainActor
@Observable
final class DaemonController {
  enum State: Equatable {
    case stopped
    case starting
    case running(pid: Int32)
    /// 端口上已经有一个 daemon 了(通常是用户自己在终端里跑的),壳不去抢
    case externallyRunning
    case failed(String)
  }

  private(set) var state: State = .stopped
  private(set) var status: DaemonStatus = .load()
  private(set) var running: RunningStatus?
  private(set) var recentLog: [String] = []
  /// `recentLog` 拼好的样子。日志窗口直接绑这个 —— 每次渲染都 joined() 一遍几百行
  /// 是笔看不见的开销,而日志刷新时渲染恰恰最频繁。
  private(set) var logText: String = ""
  private(set) var bonjourNote: String?

  /// 有设备完成配对(客户端公钥落库)时回调,带设备名。配对窗口据此给出成功提示。
  var onDeviceBound: ((String) -> Void)?

  private var process: Process?
  private var refreshTimer: Timer?
  private let bonjour = BonjourAdvertiser()
  private var boundDeviceNames: Set<String> = []
  private var logHandle: FileHandle?
  /// 已写进日志文件的字节数,用来盯住体积上限
  private var logBytes: UInt64 = 0

  /// 用户挑好、但 daemon 还没读到的监听地址。
  ///
  /// 这**不是**配置的第二份权威:壳不写 config.json(那是 CLI 的活),
  /// 只在这里记一张"下次启动替我带上 --bind"的便签。daemon 一旦以它启动,
  /// CLI 就把值写进 config.json,这里立刻清掉 —— 之后读的还是 config.json。
  private(set) var pendingBind: String?

  private static let pendingBindKey = "pendingBind"
  /// 「全部网卡」在 CLI 里的写法:传 0.0.0.0 表示取消绑定
  static let allInterfacesSpec = "0.0.0.0"
  /// 端口探测在飞。慢网络下一次探测可能比刷新间隔还长,不叠着发。
  private var probing = false

  private static let logLineCap = 200
  /// 日志文件体积上限。这是个调试日志,没人会去读几十兆的历史,
  /// 但没有上限它就会在 ~/.prospero 里一直长。
  private static let logByteCap: UInt64 = 1 << 20

  var logURL: URL { DaemonStatus.home.appendingPathComponent("shell.log") }

  init() {
    boundDeviceNames = Set(DaemonStatus.load().devices.filter(\.bound).map(\.name))
    pendingBind = UserDefaults.standard.string(forKey: Self.pendingBindKey)
    refresh()
    // 菜单打开时 runloop 跑在 event tracking mode,default mode 的 timer 不触发 ——
    // 结果就是会话列表和待审批数正好在用户盯着看的时候是僵的。.common 覆盖两种 mode。
    let timer = Timer(timeInterval: 3, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refresh() }
    }
    RunLoop.main.add(timer, forMode: .common)
    refreshTimer = timer
  }

  /// 刷新状态。壳没在管进程时,也要认出别处跑着的 daemon(终端里手动起的)。
  func refresh() {
    status = .load()
    running = RunningStatus.load().flatMap { $0.processAlive ? $0 : nil }

    // 新绑定的设备 = 刚刚配对成功。这是唯一能观察到"手机那边连上了"的信号:
    // daemon 在握手时把客户端公钥写进 devices.json。
    let nowBound = Set(status.devices.filter(\.bound).map(\.name))
    for name in nowBound.subtracting(boundDeviceNames) {
      onDeviceBound?(name)
    }
    boundDeviceNames = nowBound

    syncBonjour()

    if case .running = state { return }
    if case .starting = state { return }
    probePort()
  }

  /// 探测端口上有没有别人在跑 daemon。
  ///
  /// 必须走后台:connect 到一个不可达的地址要等满超时,而这个函数每 3 秒被调一次 ——
  /// 放在主线程上就是每 3 秒把菜单栏冻一次。
  private func probePort() {
    guard !probing else { return }
    probing = true
    let host = status.bind ?? "127.0.0.1"
    let port = status.port
    Task.detached(priority: .utility) {
      let inUse = Self.portInUse(host: host, port: port)
      await MainActor.run { [weak self] in
        guard let self else { return }
        self.probing = false
        // 探测这段时间里壳自己把 daemon 起来了的话,这个结果已经过期,丢掉
        switch self.state {
        case .running, .starting: return
        default: self.state = inUse ? .externallyRunning : .stopped
        }
      }
    }
  }

  /// daemon 在跑就广播,停了就撤。端口以 status.json 里的实际值为准。
  private func syncBonjour() {
    let port = running?.port ?? status.port
    // 只在【壳自己启动】daemon 时广播 —— 那种情况我们传了 --no-bonjour,
    // daemon 不会自己播。别人在终端里起的 daemon 会自己广播,壳再播一次
    // 会让同一台 Mac 在配对页出现两次(模拟器上实测到了)。
    let shellManaged: Bool = {
      if case .running = state { return true }
      return false
    }()

    if shellManaged {
      if !bonjour.isPublished {
        bonjour.start(port: port, name: "Prospero @ \(Host.current().localizedName ?? "Mac")")
      }
    } else {
      bonjour.stop()
    }
    bonjourNote = bonjour.lastError
  }

  func start() {
    guard case .running = state else {
      reallyStart()
      return
    }
  }

  private func reallyStart() {
    guard let node = Locator.findNode() else {
      state = .failed("找不到 node。菜单里「选择 node…」手动指定。")
      return
    }
    guard let cli = Locator.findCLI() else {
      state = .failed("找不到 apps/daemon/dist/cli.js。菜单里「选择 prosperod…」手动指定。")
      return
    }

    state = .starting
    recentLog.removeAll()
    logText = ""

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: node)
    // 广播交给壳自己做(TCC 归属 app bundle),daemon 让位
    var args = [cli, "start", "--no-bonjour"]
    // 用户在菜单里换过网卡就带上。CLI 会把它写进 config.json —— 落盘的事交给它做
    if let pendingBind {
      args.append(contentsOf: ["--bind", pendingBind])
    }
    proc.arguments = args
    // 登录 shell 的 PATH 传下去,agent CLI(claude/codex/…)才找得到
    var env = ProcessInfo.processInfo.environment
    if let shellPath = Locator.loginPath() { env["PATH"] = shellPath }
    proc.environment = env

    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = pipe
    pipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      let text = String(decoding: data, as: UTF8.self)
      Task { @MainActor [weak self] in self?.appendLog(text) }
    }

    proc.terminationHandler = { p in
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.process = nil
        // 正常停止走 stop(),那里已经把 state 置成 stopped 了
        if case .stopped = self.state { return }
        self.state = p.terminationStatus == 0
          ? .stopped
          : .failed("daemon 退出(状态码 \(p.terminationStatus)),看日志")
      }
    }

    do {
      try proc.run()
    } catch {
      state = .failed("启动失败:\(error.localizedDescription)")
      return
    }
    process = proc
    state = .running(pid: proc.processIdentifier)
    // 已经交给 CLI 了,它会落进 config.json。便签的使命到此为止 ——
    // 留着它就会变成配置的第二份权威,和终端里改过的值打架。
    setPendingBind(nil)
  }

  /// 记下要换的监听地址。传 `allInterfacesSpec` 表示回到"全部网卡",传 nil 表示撤销这次更改。
  ///
  /// 只记不写:config.json 由 CLI 在 `start` 时更新,壳不碰。
  func setPendingBind(_ spec: String?) {
    pendingBind = spec
    UserDefaults.standard.set(spec, forKey: Self.pendingBindKey)
  }

  /// 当前会生效的监听地址。待生效的选择优先于 config.json 里的现值。
  /// nil / "0.0.0.0" 都表示全部网卡。
  var effectiveBind: String? {
    let value = pendingBind ?? status.bind
    return value == Self.allInterfacesSpec ? nil : value
  }

  /// 撤销设备。交给 CLI 做,壳不碰 devices.json ——
  /// 存储格式只该有一处实现,何况正在跑的 daemon 靠监视该文件来立刻踢掉连接。
  @discardableResult
  func revokeDevice(named name: String) -> String? {
    guard let node = Locator.findNode(), let cli = Locator.findCLI() else {
      return "找不到 node 或 prosperod"
    }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: node)
    proc.arguments = [cli, "revoke", name]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = pipe
    do {
      try proc.run()
    } catch {
      return error.localizedDescription
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    proc.waitUntilExit()
    refresh()
    guard proc.terminationStatus == 0 else {
      return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return nil
  }

  func stop() {
    bonjour.stop()
    guard let proc = process else {
      state = .stopped
      refresh()
      return
    }
    state = .stopped
    // SIGTERM —— daemon 自己会收尾(停广播、关会话)
    proc.terminate()
    process = nil
  }

  func restart() {
    stop()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
      self?.reallyStart()
    }
  }

  private func appendLog(_ text: String) {
    let lines = text
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map(String.init)
      .filter { !$0.isEmpty }

    if !lines.isEmpty {
      recentLog.append(contentsOf: lines)
      if recentLog.count > Self.logLineCap {
        recentLog.removeFirst(recentLog.count - Self.logLineCap)
        logText = recentLog.joined(separator: "\n")  // 裁过头了,只能重拼
      } else {
        // 常规路径:新行接到尾巴上就行,不重拼整段
        logText += (logText.isEmpty ? "" : "\n") + lines.joined(separator: "\n")
      }
    }

    guard let data = text.data(using: .utf8), let handle = logFileHandle() else { return }
    try? handle.write(contentsOf: data)
    logBytes += UInt64(data.count)
    // 超了就从头写起。句柄是常开的,所以上限必须在写入路径上盯着 ——
    // 只在开句柄时查一次的话,一次长时间运行照样能把文件撑到几十兆。
    if logBytes > Self.logByteCap { rewindLogFile() }
  }

  /// 常开的日志文件句柄。以前每来一块输出就开关一次,而 daemon 刷屏时这个频率很高。
  private func logFileHandle() -> FileHandle? {
    if let logHandle { return logHandle }
    let fm = FileManager.default
    if !fm.fileExists(atPath: logURL.path) {
      try? fm.createDirectory(at: DaemonStatus.home, withIntermediateDirectories: true)
      fm.createFile(atPath: logURL.path, contents: nil)
    }
    guard let handle = try? FileHandle(forWritingTo: logURL) else { return nil }
    logHandle = handle
    logBytes = (try? handle.seekToEnd()) ?? 0
    if logBytes > Self.logByteCap { rewindLogFile() }
    return handle
  }

  /// 截断回开头。保尾巴比保历史重要 —— 这是调试日志,出问题时看的是最近发生了什么。
  private func rewindLogFile() {
    try? logHandle?.truncate(atOffset: 0)
    try? logHandle?.seek(toOffset: 0)
    logBytes = 0
  }

  func clearLog() {
    recentLog.removeAll()
    logText = ""
    rewindLogFile()
  }

  /// 端口上有没有人在听。用来认出终端里手动起的 daemon,避免壳去抢同一个端口。
  ///
  /// 用非阻塞 connect + poll,而不是阻塞 socket 配 `SO_SNDTIMEO`:
  /// 那个 sockopt 管的是 send(),对 connect() 无效 —— 阻塞 socket 上的 connect
  /// 走的是内核自己的重传超时,地址不可达时能卡上几十秒。
  nonisolated static func portInUse(host: String, port: Int, timeout: TimeInterval = 0.3) -> Bool {
    // AF_UNSPEC 而不是 AF_INET:bind 可以是 IPv6 字面量,写死 v4 会把它判成"没人听"
    var hints = addrinfo(
      ai_flags: 0, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM,
      ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil
    )
    var info: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, String(port), &hints, &info) == 0, info != nil else { return false }
    defer { freeaddrinfo(info) }

    var candidate = info
    while let ai = candidate {
      if connectOnce(ai.pointee, timeout: timeout) { return true }
      candidate = ai.pointee.ai_next
    }
    return false
  }

  /// 对单个地址试一次连接。真超时靠 poll 控制。
  private nonisolated static func connectOnce(_ ai: addrinfo, timeout: TimeInterval) -> Bool {
    let fd = socket(ai.ai_family, ai.ai_socktype, ai.ai_protocol)
    guard fd >= 0 else { return false }
    defer { close(fd) }

    let flags = fcntl(fd, F_GETFL, 0)
    guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) >= 0 else { return false }

    if connect(fd, ai.ai_addr, ai.ai_addrlen) == 0 { return true }  // 回环通常一步到位
    guard errno == EINPROGRESS else { return false }

    var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
    guard poll(&pfd, 1, Int32((timeout * 1000).rounded())) > 0 else { return false }

    // 可写不等于连上了 —— 被拒绝的连接同样会变可写,得问 SO_ERROR 才知道结果
    var sockErr: Int32 = 0
    var len = socklen_t(MemoryLayout<Int32>.size)
    guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &sockErr, &len) == 0 else { return false }
    return sockErr == 0
  }
}
