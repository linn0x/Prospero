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
  private(set) var bonjourNote: String?

  /// 有设备完成配对(客户端公钥落库)时回调,带设备名。配对窗口据此给出成功提示。
  var onDeviceBound: ((String) -> Void)?

  private var process: Process?
  private var refreshTimer: Timer?
  private let bonjour = BonjourAdvertiser()
  private var boundDeviceNames: Set<String> = []

  var logURL: URL { DaemonStatus.home.appendingPathComponent("shell.log") }

  init() {
    boundDeviceNames = Set(DaemonStatus.load().devices.filter(\.bound).map(\.name))
    refresh()
    refreshTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refresh() }
    }
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
    let host = status.bind ?? "127.0.0.1"
    state = Self.portInUse(host: host, port: status.port) ? .externallyRunning : .stopped
  }

  /// daemon 在跑就广播,停了就撤。端口以 status.json 里的实际值为准。
  private func syncBonjour() {
    let port = running?.port ?? status.port
    let alive = running != nil || {
      if case .running = state { return true }
      if case .externallyRunning = state { return true }
      return false
    }()

    if alive {
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

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: node)
    // 广播交给壳自己做(TCC 归属 app bundle),daemon 让位
    proc.arguments = [cli, "start", "--no-bonjour"]
    // 登录 shell 的 PATH 传下去,agent CLI(claude/codex/…)才找得到
    var env = ProcessInfo.processInfo.environment
    if let shellPath = Self.loginPath() { env["PATH"] = shellPath }
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
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    recentLog.append(contentsOf: lines.filter { !$0.isEmpty })
    if recentLog.count > 200 { recentLog.removeFirst(recentLog.count - 200) }
    if let data = text.data(using: .utf8) {
      if let handle = try? FileHandle(forWritingTo: logURL) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
      } else {
        try? data.write(to: logURL)
      }
    }
  }

  /// 登录 shell 的 PATH。GUI 进程的 PATH 极简,直接传给 daemon 会让它找不到各家 agent CLI。
  private static func loginPath() -> String? {
    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: shell)
    proc.arguments = ["-lc", "echo $PATH"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    guard (try? proc.run()) != nil else { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    proc.waitUntilExit()
    let out = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return out.isEmpty ? nil : out
  }

  /// 端口上有没有人在听。用来认出终端里手动起的 daemon,避免壳去抢同一个端口。
  nonisolated static func portInUse(host: String, port: Int) -> Bool {
    var hints = addrinfo(
      ai_flags: 0, ai_family: AF_INET, ai_socktype: SOCK_STREAM,
      ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil
    )
    var info: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, String(port), &hints, &info) == 0, let first = info else { return false }
    defer { freeaddrinfo(info) }
    let fd = socket(first.pointee.ai_family, first.pointee.ai_socktype, first.pointee.ai_protocol)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var tv = timeval(tv_sec: 0, tv_usec: 300_000)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    return connect(fd, first.pointee.ai_addr, first.pointee.ai_addrlen) == 0
  }
}
