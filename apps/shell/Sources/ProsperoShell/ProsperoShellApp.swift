import SwiftUI

@MainActor
final class ProsperoAppDelegate: NSObject, NSApplicationDelegate {
  var onTerminate: (() -> Void)?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
  }

  func applicationWillTerminate(_ notification: Notification) {
    onTerminate?()
  }
}

@main
struct ProsperoShellApp: App {
  @NSApplicationDelegateAdaptor(ProsperoAppDelegate.self) private var appDelegate
  @State private var daemon = DaemonController()
  @State private var pairing = PairingModel()

  init() {
    // GUI 起不来时仍可从终端直接核对 Node、daemon 和数据目录定位结果。
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
    if let pending = DaemonController.storedPendingBind {
      let label = pending == DaemonController.allInterfacesSpec ? "全部网卡" : pending
      print("  待生效:   \(label)(下次启动)")
    }
    if let bind = status.bind,
       bind != DaemonController.allInterfacesSpec,
       !NetworkInterfaces.resolves(bind) {
      print("  ⚠︎ 绑定地址 \(bind) 已不在本机 —— daemon 会启动失败,可在设置里改回全部网卡")
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
      print("\n定位失败时,可在设置中检查,或设 UserDefaults:")
      print("  defaults write com.linn0x.prospero.shell nodePath /opt/homebrew/bin/node")
      print("  defaults write com.linn0x.prospero.shell prosperodCLIPath /path/to/apps/daemon/dist/cli.js")
    }
  }

  var body: some Scene {
    Window("Prospero", id: "main") {
      ProsperoDashboard(daemon: daemon, pairing: pairing)
        .task {
          // 配对成功的唯一可观察信号:daemon 握手时把客户端公钥写进 devices.json
          daemon.onDeviceBound = { name in pairing.deviceDidPair(name) }
          appDelegate.onTerminate = { daemon.stop() }
          daemon.startIfNeeded()
        }
    }
    .defaultSize(width: 1320, height: 760)
    .windowStyle(.titleBar)

    Window("配对新设备", id: "pairing") {
      PairingView(pairing: pairing)
    }
    .windowResizability(.contentSize)

  }
}

extension DaemonController {
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

struct PairingView: View {
  @Bindable var pairing: PairingModel

  var body: some View {
    VStack(spacing: 16) {
      switch pairing.phase {
      case .idle:
        Form {
          TextField("设备名", text: $pairing.deviceName)
          Toggle("允许 shell 会话(完整用户权限)", isOn: $pairing.allowShell)
          Toggle("允许手工编排与派发 worker", isOn: $pairing.allowOrchestration)
            .disabled(!pairing.allowShell)
            .onChange(of: pairing.allowShell) { _, allowed in
              if !allowed { pairing.allowOrchestration = false }
            }
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
