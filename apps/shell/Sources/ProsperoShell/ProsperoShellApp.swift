import SwiftUI

@main
struct ProsperoShellApp: App {
  @State private var daemon = DaemonController()
  @State private var pairing = PairingModel()

  init() {
    // 菜单栏 app 出问题时最难查的就是"图标没出现,也没有任何输出"。
    // 这个开关把定位结果直接打到终端,不用点菜单就能看出是哪一步断了。
    if CommandLine.arguments.contains("--self-check") {
      Self.selfCheck()
      exit(0)
    }
  }

  private static func selfCheck() {
    let status = DaemonStatus.load()
    let node = Locator.findNode()
    let cli = Locator.findCLI()
    print("Prospero 壳自检")
    print("  bundle:   \(Bundle.main.bundleURL.path)")
    print("  node:     \(node ?? "❌ 找不到")")
    print("  prosperod:\(cli.map { " \($0)" } ?? " ❌ 找不到")")
    print("  home:     \(DaemonStatus.home.path)")
    print("  端口:     \(status.port)")
    print("  监听:     \(status.bindLabel)")
    let pending = UserDefaults.standard.string(forKey: "pendingBind")
    if let pending {
      print("  待生效:   \(pending == DaemonController.allInterfacesSpec ? "全部网卡" : pending)(下次启动)")
    }
    let ifaces = NetworkInterfaces.candidates()
    print("  可选网卡: \(ifaces.isEmpty ? "无" : ifaces.map(\.label).joined(separator: ", "))")
    print("  已配对:   \(status.devices.count) 台")
    let host = status.bind ?? "127.0.0.1"
    let up = DaemonController.portInUse(host: host, port: status.port)
    print("  daemon:   \(up ? "端口上有服务在跑" : "未运行")")
    print("  开机自启: \(LoginItem.statusLabel)")
    if let running = RunningStatus.load() {
      print("  status:   pid \(running.pid) \(running.processAlive ? "存活" : "❌ 已死(陈旧文件)")·端口 \(running.port)")
      print("  会话:     \(running.sessions.count) 个,待审批 \(running.pendingApprovals)")
      for session in running.sessions {
        print("    - \(session.agent) · \(session.title) — \(session.statusLabel)")
      }
    } else {
      print("  status:   无 status.json(daemon 未运行,或版本过旧)")
    }
    if node == nil || cli == nil {
      print("\n定位失败时,在菜单里手动指定,或设 UserDefaults:")
      print("  defaults write com.linn0x.prospero.shell nodePath /opt/homebrew/bin/node")
      print("  defaults write com.linn0x.prospero.shell prosperodCLIPath /path/to/apps/daemon/dist/cli.js")
    }
  }

  var body: some Scene {
    MenuBarExtra {
      MenuContent(daemon: daemon, pairing: pairing)
        .task {
          // 配对成功的唯一可观察信号:daemon 握手时把客户端公钥写进 devices.json
          daemon.onDeviceBound = { name in pairing.deviceDidPair(name) }
        }
    } label: {
      Image(systemName: daemon.symbolName)
    }
    .menuBarExtraStyle(.menu)

    Window("配对新设备", id: "pairing") {
      PairingView(pairing: pairing)
    }
    .windowResizability(.contentSize)

    Window("Prospero 日志", id: "log") {
      LogView(daemon: daemon)
    }
  }
}

extension DaemonController {
  /// 菜单栏图标直接反映状态 —— 这是壳最主要的信息输出,不用点开就能看见。
  var symbolName: String {
    // 有待审批时图标就该不一样 —— 审批是最高频的远程操作,值得占用这个位置
    if let running, running.pendingApprovals > 0 { return "hand.raised.fill" }
    switch state {
    case .running: return "wand.and.stars"
    case .externallyRunning: return "wand.and.stars.inverse"
    case .starting: return "hourglass"
    case .failed: return "exclamationmark.triangle"
    case .stopped: return "wand.and.rays.inverse"
    }
  }

  var stateLabel: String {
    switch state {
    case .running(let pid): "运行中(pid \(pid))"
    case .externallyRunning: "运行中(终端启动,壳未接管)"
    case .starting: "启动中…"
    case .failed(let message): "出错:\(message)"
    case .stopped: "已停止"
    }
  }
}

struct MenuContent: View {
  @Bindable var daemon: DaemonController
  @Bindable var pairing: PairingModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    // 一次 body 里只定位一遍,下面有两处要用
    let cliPath = Locator.findCLI()

    Text(daemon.stateLabel)

    if case .externallyRunning = daemon.state {
      Text("端口 \(String(daemon.status.port)) 已被占用")
    } else {
      Text("端口 \(String(daemon.status.port)) · 监听 \(daemon.status.bindLabel)")
    }

    Divider()

    BindPicker(daemon: daemon)

    switch daemon.state {
    case .running:
      Button("停止 daemon") { daemon.stop() }
      Button("重启 daemon") { daemon.restart() }
    case .starting:
      Button("启动中…") {}.disabled(true)
    case .externallyRunning:
      Button("daemon 已在别处运行") {}.disabled(true)
    case .stopped, .failed:
      Button("启动 daemon") { daemon.start() }
    }

    Divider()

    Button("配对新设备…") {
      pairing.reset()
      openWindow(id: "pairing")
      NSApp.activate(ignoringOtherApps: true)
    }
    .disabled(cliPath == nil)

    if daemon.status.devices.isEmpty {
      Text("尚未配对任何设备")
    } else {
      Menu("已配对设备(\(daemon.status.devices.count))") {
        ForEach(daemon.status.devices) { device in
          Menu("\(device.name)\(device.allowShell ? "" : " · 禁 shell")\(device.bound ? "" : " · 未绑定")") {
            Text(device.bound ? "已绑定客户端公钥" : "尚未连接过")
            Divider()
            Button("移除「\(device.name)」") {
              confirmRevoke(device.name)
            }
          }
        }
      }
    }

    Divider()

    if daemon.running?.isStale(cliPath: cliPath) == true {
      Text("⚠︎ daemon 比磁盘上的代码旧 —— 改过代码就重启它")
      Button("重启 daemon 以加载新代码") { daemon.restart() }
    }

    SessionsSection(running: daemon.running)

    Divider()

    LoginItemToggle()

    if let note = daemon.bonjourNote {
      Text("Bonjour:\(note)")
    }

    Divider()

    // 定位失败时的报错文案一直叫用户「在菜单里手动指定」,但菜单里从来没有这两项。
    // 补上,顺便让人能看见当前用的是哪条路径。
    Menu("可执行文件位置") {
      Text("node:\(Locator.findNode() ?? "找不到")")
      Text("prosperod:\(cliPath ?? "找不到")")
      Divider()
      Button("选择 node…") {
        chooseFile(title: "选择 node 解释器") { Locator.nodeOverride = $0 }
      }
      Button("选择 prosperod…") {
        chooseFile(title: "选择 apps/daemon/dist/cli.js") { Locator.cliOverride = $0 }
      }
      if Locator.nodeOverride != nil || Locator.cliOverride != nil {
        Divider()
        Button("清除手动指定,恢复自动查找") {
          Locator.nodeOverride = nil
          Locator.cliOverride = nil
          daemon.refresh()
        }
      }
    }

    Button("查看日志…") {
      openWindow(id: "log")
      NSApp.activate(ignoringOtherApps: true)
    }
    Button("打开 ~/.prospero") {
      NSWorkspace.shared.open(DaemonStatus.home)
    }
    Button("退出 Prospero") {
      daemon.stop()
      NSApp.terminate(nil)
    }
    .keyboardShortcut("q")
  }

  /// 挑一个可执行文件/脚本。LSUIElement 的 app 不激活就弹不到前台,面板会藏在别人后面。
  private func chooseFile(title: String, apply: (String) -> Void) {
    let panel = NSOpenPanel()
    panel.message = title
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    panel.showsHiddenFiles = true
    panel.treatsFilePackagesAsDirectories = true
    NSApp.activate(ignoringOtherApps: true)
    guard panel.runModal() == .OK, let url = panel.url else { return }
    apply(url.path)
    daemon.refresh()
  }

  /// 撤销不可逆(手机必须重新扫码),值得一次确认。
  private func confirmRevoke(_ name: String) {
    let alert = NSAlert()
    alert.messageText = "移除设备「\(name)」?"
    alert.informativeText = "该设备的凭证会被删除,当前连接立刻断开。要再用得重新扫码配对。"
    alert.alertStyle = .warning
    alert.addButton(withTitle: "移除")
    alert.addButton(withTitle: "取消")
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return }

    if let error = daemon.revokeDevice(named: name) {
      let failure = NSAlert()
      failure.messageText = "移除失败"
      failure.informativeText = error
      failure.alertStyle = .critical
      failure.runModal()
    }
  }
}

/// 选监听哪张网卡。
///
/// 绑定单张网卡的用处:Mac 同时挂着 WiFi 和 WireGuard 时,只监听隧道那张
/// 就不会把服务暴露在咖啡馆的局域网上。代价是配对二维码只会带这一个地址
/// —— 换网络就得重新配对,所以默认仍是全部网卡。
struct BindPicker: View {
  @Bindable var daemon: DaemonController

  var body: some View {
    let effective = daemon.effectiveBind
    let dirty = daemon.pendingBind != nil

    Menu(dirty ? "监听网卡 · 重启后生效" : "监听网卡") {
      Button(mark(effective == nil) + "全部网卡") {
        choose(DaemonController.allInterfacesSpec, label: "全部网卡")
      }

      let ifaces = NetworkInterfaces.candidates()
      if !ifaces.isEmpty {
        Divider()
        ForEach(ifaces) { iface in
          // config.json 里可能存的是网卡名(终端里 --bind en0 设的),两种都要能对上
          let selected = effective == iface.address || effective == iface.name
          Button(mark(selected) + iface.label) {
            choose(iface.bindSpec, label: iface.label)
          }
        }
      }

      if dirty {
        Divider()
        Button("撤销这次更改") { daemon.setPendingBind(nil) }
      }
    }
  }

  private func mark(_ on: Bool) -> String { on ? "✓ " : "  " }

  /// 改动只记在壳里,真正落盘由下次 `start` 时的 CLI 完成。
  /// 所以这里唯一要问清楚的是:现在重启,还是等下次。
  private func choose(_ spec: String, label: String) {
    daemon.setPendingBind(spec)

    // 终端里起的 daemon,壳重启不了它 —— 这时候光标一句"重启后生效"是句空话,
    // 因为壳的这个参数永远轮不到用上。直接把该敲的命令给出来。
    if case .externallyRunning = daemon.state {
      let alert = NSAlert()
      alert.messageText = "已记下「\(label)」,但当前 daemon 不是壳启动的"
      alert.informativeText = """
        壳只能在自己启动 daemon 时带上这个参数。要让它现在生效,\
        在跑着 daemon 的终端里重启:

        prosperod start --bind \(spec)
        """
      alert.addButton(withTitle: "复制命令")
      alert.addButton(withTitle: "知道了")
      NSApp.activate(ignoringOtherApps: true)
      if alert.runModal() == .alertFirstButtonReturn {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("prosperod start --bind \(spec)", forType: .string)
      }
      return
    }

    // 已停止 / 启动失败:下次点「启动 daemon」自然会带上,不用多问一句
    guard case .running = daemon.state else { return }

    let sessions = daemon.running?.sessions.count ?? 0
    let alert = NSAlert()
    alert.messageText = "监听网卡改为「\(label)」"
    alert.informativeText = sessions > 0
      ? "要立刻重启 daemon 生效吗?壳启动 daemon 时没带 --tmux,当前 \(sessions) 个会话会被杀掉。"
      : "要立刻重启 daemon 生效吗?"
    alert.alertStyle = .warning
    alert.addButton(withTitle: "下次启动生效")
    alert.addButton(withTitle: "现在重启")
    NSApp.activate(ignoringOtherApps: true)
    if alert.runModal() == .alertSecondButtonReturn {
      daemon.restart()
    }
  }
}

/// 菜单里的运行中会话。数据来自 daemon 写的 status.json —— 壳不碰 WS 协议。
struct SessionsSection: View {
  let running: RunningStatus?

  var body: some View {
    if let running, !running.sessions.isEmpty {
      let pending = running.pendingApprovals
      Text(pending > 0
        ? "会话(\(running.sessions.count))· 待审批 \(pending)"
        : "会话(\(running.sessions.count))")
      ForEach(running.sessions) { session in
        // 会话不可在壳里操作(那是手机的活),这里只做一眼可见的总览。
        // 用 Label 让状态先由图标传达 —— 扫一眼就知道哪个在等审批,不用逐行读文字。
        Label(
          "\(session.agent) · \(session.title) — \(session.statusLabel)",
          systemImage: session.symbolName
        )
      }
    } else if running != nil {
      Text("没有运行中的会话")
    } else {
      Text("会话列表需 daemon 运行")
    }
  }
}

/// 开机自启。SMAppService 的状态是系统在管,每次展开菜单重新读,别缓存。
struct LoginItemToggle: View {
  @State private var error: String?

  var body: some View {
    // status 每问一次是一次跨进程往返,一次 body 里只问一遍
    let enabled = LoginItem.isEnabled
    Button(enabled ? "✓ 开机自启" : "开机自启") {
      error = LoginItem.setEnabled(!enabled)
    }
    if let error {
      Text(error)
    }
  }
}

struct PairingView: View {
  @Bindable var pairing: PairingModel

  var body: some View {
    VStack(spacing: 16) {
      switch pairing.phase {
      case .idle:
        Form {
          TextField("设备名", text: $pairing.deviceName)
          Toggle("允许 shell 会话(完整用户权限)", isOn: $pairing.allowShell)
        }
        .formStyle(.grouped)
        Button("生成二维码") { pairing.generate() }
          .keyboardShortcut(.defaultAction)

      case .generating:
        ProgressView("正在生成…").padding(40)

      case .ready(let url, let addrs, let port):
        if let image = QRCode.image(from: url) {
          Image(nsImage: image)
            .interpolation(.none)
            .resizable()
            .frame(width: 240, height: 240)
        }
        VStack(spacing: 4) {
          Text("用 Prospero App 扫码").font(.headline)
          Text("\(addrs)  ·  端口 \(String(port))")
            .font(.caption).foregroundStyle(.secondary)
          Text("二维码含访问凭证,请勿截图外传")
            .font(.caption2).foregroundStyle(.orange)
          HStack(spacing: 6) {
            ProgressView().controlSize(.small)
            Text("等待手机扫码…").font(.caption).foregroundStyle(.secondary)
          }
          .padding(.top, 4)
        }
        HStack {
          Button("复制配对串") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(url, forType: .string)
          }
          Button("再配一台") { pairing.reset() }
        }

      case .paired(let deviceName):
        VStack(spacing: 12) {
          Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 52))
            .foregroundStyle(.green)
          Text("「\(deviceName)」配对成功").font(.headline)
          Text("手机已完成握手,可以关掉这个窗口了")
            .font(.caption).foregroundStyle(.secondary)
          Button("再配一台") { pairing.reset() }
        }
        .padding(.vertical, 20)

      case .failed(let message):
        VStack(spacing: 8) {
          Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(.orange)
          Text(message).font(.caption).textSelection(.enabled)
            .frame(maxWidth: 320).fixedSize(horizontal: false, vertical: true)
          Button("重试") { pairing.reset() }
        }
      }
    }
    .padding(24)
    .frame(minWidth: 320)
  }
}

struct LogView: View {
  @Bindable var daemon: DaemonController
  /// 日志是往下长的,默认盯着最后一行。往回翻查历史的人可以关掉。
  @State private var followTail = true

  private static let tailAnchor = "tail"

  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            Text(daemon.logText.isEmpty
              ? "(daemon 由壳启动后,输出会显示在这里)"
              : daemon.logText)
              .font(.system(.caption, design: .monospaced))
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
            Color.clear.frame(height: 1).id(Self.tailAnchor)
          }
          .padding(12)
        }
        .onChange(of: daemon.logText) {
          guard followTail else { return }
          proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
        }
        .onAppear {
          proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
        }
      }

      Divider()

      HStack(spacing: 12) {
        Toggle("跟随输出", isOn: $followTail)
          .toggleStyle(.checkbox)
        Spacer()
        Button("复制全部") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(daemon.logText, forType: .string)
        }
        .disabled(daemon.logText.isEmpty)
        Button("清空") { daemon.clearLog() }
          .disabled(daemon.logText.isEmpty)
        Button("在访达中显示") {
          NSWorkspace.shared.activateFileViewerSelecting([daemon.logURL])
        }
      }
      .padding(8)
    }
    .frame(minWidth: 560, minHeight: 320)
  }
}
