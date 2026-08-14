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
  private(set) var orchestration: OrchestrationStatus = .load()
  private(set) var recentLog: [String] = []
  /// `recentLog` 拼好的样子。日志窗口直接绑这个 —— 每次渲染都 joined() 一遍几百行
  /// 是笔看不见的开销,而日志刷新时渲染恰恰最频繁。
  private(set) var logText: String = ""
  private(set) var bonjourNote: String?

  /// 有设备完成配对(客户端公钥落库)时回调,带设备名。配对窗口据此给出成功提示。
  var onDeviceBound: ((String) -> Void)?

  private var process: Process?
  private var refreshTimer: Timer?
  /// 用户要求接管一个从终端启动的 daemon 时，等待旧 PID 真正退出再起壳托管版本。
  private var externalRestartTask: Task<Void, Never>?
  /// 重启是在旧进程真正退出后才起新的 —— 靠 terminationHandler 接力,而不是睡一段时间赌它退干净了
  private var restartRequested = false
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

  /// 便签的持久化读取。自检也要用,所以键名和读法都收在这里 ——
  /// 在别处再抄一遍字面量,改键名时那边会静默失效。
  static var storedPendingBind: String? {
    UserDefaults.standard.string(forKey: pendingBindKey)
  }
  /// 端口探测在飞。慢网络下一次探测可能比刷新间隔还长,不叠着发。
  private var probing = false

  // nonisolated:readLogTail 在主线程外读日志尾巴,要用到这个上限
  private nonisolated static let logLineCap = 200
  /// 日志文件体积上限。这是个调试日志,没人会去读几十兆的历史,
  /// 但没有上限它就会在 ~/.prospero 里一直长。
  private static let logByteCap: UInt64 = 1 << 20

  var logURL: URL { DaemonStatus.home.appendingPathComponent("shell.log") }

  init() {
    boundDeviceNames = Set(DaemonStatus.load().devices.filter(\.bound).map(\.name))
    pendingBind = Self.storedPendingBind
    setRecentLog(Self.readLogTail(from: logURL))
    refresh()
    // .common 而不是默认 mode:菜单跟踪、窗口拖动、列表滚动期间 runloop 都会切走,
    // 默认 mode 的 timer 在那些时候不触发 —— 界面正好在被操作时是僵的。
    let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refresh() }
    }
    RunLoop.main.add(timer, forMode: .common)
    refreshTimer = timer
  }

  /// 没在跑就拉起来。Dashboard 出现时调一次 —— 壳的存在意义就是让 daemon 归它管。
  func startIfNeeded() {
    refresh()
    switch state {
    case .stopped, .failed:
      start()
    default:
      break
    }
  }

  /// 刷新状态。壳没在管进程时,也要认出别处跑着的 daemon(终端里手动起的)。
  func refresh() {
    status = .load()
    running = RunningStatus.load().flatMap { $0.processAlive ? $0 : nil }
    orchestration = .load()

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
    // 已经有一个在手上就别再起一个 —— 两个 daemon 会抢同一个端口
    guard process == nil else { return }
    guard let node = Locator.findNode() else {
      state = .failed("找不到 node。在设置 → 运行环境里手动指定。")
      return
    }
    guard let cli = Locator.findCLI() else {
      state = .failed("找不到 apps/daemon/dist/cli.js。在设置 → 运行环境里手动指定。")
      return
    }

    state = .starting
    setRecentLog([])

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: node)
    // 广播交给壳自己做(TCC 归属 app bundle),daemon 让位
    // --tmux:PTY 会话托管给 tmux,daemon 重启后进程与画面都还在
    var args = [cli, "start", "--no-bonjour", "--tmux"]
    // 用户在设置里换过网卡就带上。CLI 会把它写进 config.json —— 落盘的事交给它做
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
        // 重启:等旧进程真的退了再起新的,避免两个 daemon 抢同一个端口
        if self.restartRequested {
          self.restartRequested = false
          self.reallyStart()
          return
        }
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

  /// config.json 里绑的地址已经不在本机了。
  ///
  /// 这是个能把 daemon 卡死的状态:CLI 是**先写 config.json 再解析地址**的,
  /// 所以一旦绑了个会消失的地址(WireGuard 的 utun 就是典型),
  /// 地址一没,daemon 每次启动都在同一处抛错退出,而错误只出现在日志窗口里。
  /// 认出来才能给出一键恢复。
  var bindIsStale: Bool {
    guard let bind = status.bind, bind != Self.allInterfacesSpec else { return false }
    return !NetworkInterfaces.resolves(bind)
  }

  /// 顶部那行的「监听」部分。有待生效的选择时一并说明,
  /// 免得它和子菜单标题里的「重启后生效」各说各的。
  var bindSummary: String {
    guard let pendingBind else { return status.bindLabel }
    let target = pendingBind == Self.allInterfacesSpec ? "全部网卡" : pendingBind
    return "\(status.bindLabel) → \(target)(重启后)"
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
    restartRequested = false
    externalRestartTask?.cancel()
    externalRestartTask = nil
    guard let proc = process else {
      state = .stopped
      refresh()
      return
    }
    state = .stopped
    // SIGTERM —— daemon 会先落盘结构化会话,PTY 则留在 tmux 中。
    // process 不在这里置 nil,交给 terminationHandler ——
    // 它才知道进程什么时候真的退了。
    proc.terminate()
  }

  /// 重启。等旧进程退出后由 terminationHandler 接力起新的,
  /// 而不是睡 0.6 秒赌它已经退干净 —— 端口没释放就起会直接失败。
  func restart() {
    guard let proc = process else {
      if let running, running.processAlive {
        restartExternal(running)
      } else {
        reallyStart()
      }
      return
    }
    restartRequested = true
    state = .starting
    bonjour.stop()
    proc.terminate()
  }

  /// “由终端启动”不能意味着 Mac App 永远无法升级或接管：用户明确点重启时，
  /// 先给 status.json 记录的精确 PID 发 SIGTERM，等它释放端口后再由 App 拉起。
  /// 不按进程名扫、不碰其他 node 进程，也不会在 App 启动时擅自中断正在工作的 Agent。
  private func restartExternal(_ snapshot: RunningStatus) {
    guard externalRestartTask == nil else { return }
    let pid = snapshot.pid
    guard Darwin.kill(pid, SIGTERM) == 0 else {
      state = .failed("无法停止终端启动的 daemon(pid \(pid))")
      return
    }
    state = .starting
    bonjour.stop()
    externalRestartTask = Task { @MainActor [weak self] in
      for _ in 0..<150 {
        if Task.isCancelled { return }
        if Darwin.kill(pid, 0) != 0 && errno == ESRCH {
          guard let self else { return }
          self.externalRestartTask = nil
          self.reallyStart()
          return
        }
        try? await Task.sleep(for: .milliseconds(100))
      }
      guard let self else { return }
      self.externalRestartTask = nil
      self.state = .failed("旧 daemon(pid \(pid)) 在 15 秒内没有退出")
    }
  }

  enum SessionAction: String {
    case interrupt
    case kill
  }

  /// Mac 宿主用户直接创建会话。仍走 daemon 的 loopback control token，避免壳复制
  /// SessionManager 的启动、tmux 托管和结构化适配逻辑。
  func createLocalSession(
    agent: String,
    kind: String,
    cwd: String,
    approvalPolicy: String,
    accountId: String?
  ) async -> (id: String?, error: String?) {
    guard let running, !running.controlToken.isEmpty else {
      return (nil, "daemon 尚未提供本机控制接口")
    }
    guard let url = URL(
      string: "http://127.0.0.1:\(running.port)/_prospero/control/session/create"
    ) else {
      return (nil, "无法构造控制地址")
    }
    var body: [String: Any] = [
      "agent": agent,
      "kind": kind,
      "cwd": cwd,
      "cols": 120,
      "rows": 40,
    ]
    if kind == "structured" {
      body["approvalPolicy"] = approvalPolicy
    }
    if let accountId, !accountId.isEmpty {
      body["accountId"] = accountId
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(running.controlToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        if (response as? HTTPURLResponse)?.statusCode == 404 {
          return (nil, "当前 daemon 尚不支持从 Mac 启动会话，请先重启 daemon 加载新版本")
        }
        let message = String(decoding: data, as: UTF8.self)
          .trimmingCharacters(in: .whitespacesAndNewlines)
        return (nil, message.isEmpty ? "daemon 拒绝创建会话" : message)
      }
      let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      guard let id = root?["id"] as? String, !id.isEmpty else {
        return (nil, "daemon 已创建会话，但没有返回会话 ID")
      }
      try? await Task.sleep(for: .milliseconds(250))
      refresh()
      return (id, nil)
    } catch {
      return (nil, error.localizedDescription)
    }
  }

  /// 只通过 daemon 的本机控制接口管理会话;口令每次启动更换并只存在 0600 status.json。
  func controlSession(id: String, action: SessionAction) async -> String? {
    guard let running, !running.controlToken.isEmpty else {
      return "daemon 尚未提供本机控制接口"
    }
    let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    guard let url = URL(string: "http://127.0.0.1:\(running.port)/_prospero/control/session/\(encoded)/\(action.rawValue)") else {
      return "无法构造控制地址"
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(running.controlToken)", forHTTPHeaderField: "Authorization")
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
      }
      try? await Task.sleep(for: .milliseconds(300))
      refresh()
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  /// 读取某个子 Agent 的独立事件流。接口只监听 loopback，并复用 daemon 每次启动
  /// 生成的控制口令；Mac App 不需要实现手机端的 E2E 握手，也不会读到父会话内容。
  func loadSubagentTranscript(
    sessionID: String,
    subagentID: String,
    agentName: String
  ) async throws -> SubagentTranscript {
    guard let running, !running.controlToken.isEmpty else {
      throw SubagentTranscriptFailure("daemon 尚未提供本机控制接口")
    }
    let encodedSession = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
      ?? sessionID
    let encodedSubagent = subagentID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
      ?? subagentID
    guard let url = URL(
      string: "http://127.0.0.1:\(running.port)/_prospero/control/session/\(encodedSession)/subagent/\(encodedSubagent)/events"
    ) else {
      throw SubagentTranscriptFailure("无法构造子 Agent 事件地址")
    }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("Bearer \(running.controlToken)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let message = String(decoding: data, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if (response as? HTTPURLResponse)?.statusCode == 404 {
        throw SubagentTranscriptFailure("这个子 Agent 已不在当前会话中")
      }
      throw SubagentTranscriptFailure(message.isEmpty ? "daemon 拒绝读取子 Agent 过程" : message)
    }
    return try SubagentTranscript.decode(data, agentName: agentName)
  }

  /// 人类在 Mac 上解开 Goal Gate；回环地址 + 每次启动生成的 token 与会话管理同级保护。
  func resolveGate(id: String, decision: String) async -> String? {
    guard let running, !running.controlToken.isEmpty else {
      return "daemon 尚未提供本机控制接口"
    }
    let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    guard let url = URL(
      string: "http://127.0.0.1:\(running.port)/_prospero/control/orchestration/gate/\(encoded)/resolve"
    ) else {
      return "无法构造控制地址"
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(running.controlToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["decision": decision])
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
      }
      refresh()
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  func createManualRun(objective: String) async -> String? {
    await performOrchestrationAction(
      method: "run.create",
      params: ["objective": objective, "operationId": UUID().uuidString]
    )
  }

  func createOrchestrationGraph(
    objective: String,
    nodes: [OrchestrationGraphDraftNode],
    operationId: String
  ) async -> String? {
    let payload: [[String: Any]] = nodes.map { node in
      [
        "clientId": node.id,
        "title": node.title,
        "spec": node.spec,
        "deps": Array(node.deps).sorted(),
      ]
    }
    return await performOrchestrationAction(
      method: "graph.create",
      params: [
        "operationId": operationId,
        "objective": objective,
        "nodes": payload,
      ]
    )
  }

  func applyOrchestrationGraph(
    runId: String,
    baseRevision: Int,
    nodes: [OrchestrationGraphDraftNode],
    deleteTaskIds: [String],
    operationId: String
  ) async -> String? {
    let payload: [[String: Any]] = nodes.map { node in
      [
        "clientId": node.id,
        "title": node.title,
        "spec": node.spec,
        "deps": Array(node.deps).sorted(),
      ]
    }
    return await performOrchestrationAction(
      method: "graph.apply",
      params: [
        "operationId": operationId,
        "runId": runId,
        "baseRevision": baseRevision,
        "nodes": payload,
        "deleteTaskIds": deleteTaskIds,
      ]
    )
  }

  func deleteOrchestrationRun(runId: String) async -> String? {
    await performOrchestrationAction(
      method: "run.delete",
      params: [
        "runId": runId,
        "operationId": UUID().uuidString,
      ]
    )
  }

  func completeOrchestrationRun(runId: String) async -> String? {
    await performOrchestrationAction(
      method: "run.complete",
      params: [
        "runId": runId,
        "operationId": UUID().uuidString,
      ]
    )
  }

  func abandonOrchestrationRun(runId: String) async -> String? {
    await performOrchestrationAction(
      method: "run.abandon",
      params: [
        "runId": runId,
        "operationId": UUID().uuidString,
      ]
    )
  }

  /// 只读检查会更新本地编排快照；实际 Git 判断只在 daemon 端完成。
  func inspectOrchestrationWorktree(assetId: String) async -> String? {
    await performOrchestrationAction(
      method: "worktree.inspect",
      params: ["assetId": assetId]
    )
  }

  /// 服务端会再次核验 safe_to_clean/equivalent；默认保留分支，便于恢复。
  func cleanupOrchestrationWorktree(assetId: String) async -> String? {
    await performOrchestrationAction(
      method: "worktree.cleanup",
      params: [
        "assetId": assetId,
        "confirm": true,
        "operationId": UUID().uuidString,
      ]
    )
  }

  func createOrchestrationTask(
    runId: String,
    title: String,
    spec: String,
    deps: [String]
  ) async -> String? {
    await performOrchestrationAction(
      method: "task.create",
      params: [
        "runId": runId,
        "title": title,
        "spec": spec,
        "deps": deps,
        "operationId": UUID().uuidString,
      ]
    )
  }

  func startOrchestrationWorker(
    taskId: String,
    agent: String,
    cwd: String,
    worktree: String,
    approvalPolicy: String
  ) async -> String? {
    await performOrchestrationAction(
      method: "worker.start",
      params: [
        "taskId": taskId,
        "agent": agent,
        "cwd": cwd,
        "worktree": worktree,
        "approvalPolicy": approvalPolicy,
        "operationId": UUID().uuidString,
      ]
    )
  }

  func stopOrchestrationWorker(taskId: String) async -> String? {
    await performOrchestrationAction(
      method: "worker.stop",
      params: [
        "taskId": taskId,
        "reason": "由 Mac 用户停止 worker",
        "operationId": UUID().uuidString,
      ]
    )
  }

  func cancelOrchestrationTask(taskId: String) async -> String? {
    await performOrchestrationAction(
      method: "task.cancel",
      params: [
        "taskId": taskId,
        "reason": "由 Mac 用户取消任务",
        "operationId": UUID().uuidString,
      ]
    )
  }

  func retryOrchestrationTask(taskId: String) async -> String? {
    await performOrchestrationAction(
      method: "task.retry",
      params: [
        "taskId": taskId,
        "operationId": UUID().uuidString,
      ]
    )
  }

  func startOrchestrationAutomation(
    runId: String,
    agent: String,
    cwd: String,
    workspace: String,
    approvalPolicy: String
  ) async -> String? {
    await performOrchestrationAction(
      method: "automation.start",
      params: [
        "runId": runId,
        "agent": agent,
        "cwd": cwd,
        "workspace": workspace,
        "approvalPolicy": approvalPolicy,
        "operationId": UUID().uuidString,
      ]
    )
  }

  func pauseOrchestrationAutomation(runId: String) async -> String? {
    await performOrchestrationAction(
      method: "automation.pause",
      params: [
        "runId": runId,
        "operationId": UUID().uuidString,
      ]
    )
  }

  /// Mac 壳的人工编排写操作统一走回环 HTTP + 每次启动轮换的 control token。
  private func performOrchestrationAction(
    method: String,
    params: [String: Any]
  ) async -> String? {
    guard let running, !running.controlToken.isEmpty else {
      return "daemon 尚未提供本机控制接口"
    }
    guard let url = URL(
      string: "http://127.0.0.1:\(running.port)/_prospero/control/orchestration/action"
    ) else {
      return "无法构造控制地址"
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(running.controlToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do {
      request.httpBody = try JSONSerialization.data(
        withJSONObject: ["method": method, "params": params]
      )
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        let message = String(decoding: data, as: UTF8.self)
          .trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? "daemon 拒绝了这次编排操作" : message
      }
      refresh()
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  /// recentLog 和它的拼接缓存必须一起改,不然日志窗口会显示上一份内容。
  private func setRecentLog(_ lines: [String]) {
    recentLog = lines
    logText = lines.joined(separator: "\n")
  }

  /// 壳重启后把上次的日志尾巴读回来 —— 否则「查看日志」在 daemon 还没输出前是空的。
  private nonisolated static func readLogTail(from url: URL) -> [String] {
    guard let data = try? Data(contentsOf: url),
          let text = String(data: data, encoding: .utf8)
    else { return [] }
    return Array(text.split(separator: "\n").suffix(logLineCap).map { RelayRedaction.redact(String($0)) })
  }

  private func appendLog(_ text: String) {
    // Relay 的 host secret、设备 ticket 和 route ticket 不属于 GUI 日志。daemon 本身
    // 应该已脱敏；这里再做一层防线，以免旧 daemon 或第三方 wrapper 把键值对直接写出。
    let safeText = RelayRedaction.redact(text)
    let lines = safeText
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

    guard let data = safeText.data(using: .utf8), let handle = logFileHandle() else { return }
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
    setRecentLog([])
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
