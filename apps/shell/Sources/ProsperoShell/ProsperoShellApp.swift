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
    print("  已配对:   \(status.devices.count) 台")
    let host = status.bind ?? "127.0.0.1"
    let up = DaemonController.portInUse(host: host, port: status.port)
    print("  daemon:   \(up ? "端口上有服务在跑" : "未运行")")
    if node == nil || cli == nil {
      print("\n定位失败时,在菜单里手动指定,或设 UserDefaults:")
      print("  defaults write com.linn0x.prospero.shell nodePath /opt/homebrew/bin/node")
      print("  defaults write com.linn0x.prospero.shell prosperodCLIPath /path/to/apps/daemon/dist/cli.js")
    }
  }

  var body: some Scene {
    MenuBarExtra {
      MenuContent(daemon: daemon, pairing: pairing)
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
    switch state {
    case .running: "wand.and.stars"
    case .externallyRunning: "wand.and.stars.inverse"
    case .starting: "hourglass"
    case .failed: "exclamationmark.triangle"
    case .stopped: "wand.and.rays.inverse"
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
    Text(daemon.stateLabel)

    if case .externallyRunning = daemon.state {
      Text("端口 \(String(daemon.status.port)) 已被占用")
    } else {
      Text("端口 \(String(daemon.status.port)) · 监听 \(daemon.status.bindLabel)")
    }

    Divider()

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
    .disabled(Locator.findCLI() == nil)

    if daemon.status.devices.isEmpty {
      Text("尚未配对任何设备")
    } else {
      Menu("已配对设备(\(daemon.status.devices.count))") {
        ForEach(daemon.status.devices) { device in
          Text("\(device.name)\(device.allowShell ? "" : " · 禁 shell")\(device.bound ? "" : " · 未绑定")")
        }
      }
    }

    Divider()

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
        }
        HStack {
          Button("复制配对串") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(url, forType: .string)
          }
          Button("再配一台") { pairing.reset() }
        }

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

  var body: some View {
    ScrollView {
      Text(daemon.recentLog.isEmpty ? "(daemon 由壳启动后,输出会显示在这里)" : daemon.recentLog.joined(separator: "\n"))
        .font(.system(.caption, design: .monospaced))
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
    }
    .frame(minWidth: 560, minHeight: 320)
  }
}
