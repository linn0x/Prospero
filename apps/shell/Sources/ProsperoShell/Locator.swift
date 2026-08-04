import Foundation

/// 找到运行 daemon 需要的两样东西:node 解释器,和 prosperod 的入口脚本。
///
/// 这在 GUI 里比在终端里麻烦得多 —— Finder 启动的 app 拿不到登录 shell 的 PATH,
/// 所以 `node` 不能靠 PATH 查找,得自己定位。
enum Locator {
  /// 用户手动指定的位置(菜单里「选择 prosperod…」写入),优先级最高。
  private static let cliOverrideKey = "prosperodCLIPath"
  private static let nodeOverrideKey = "nodePath"

  static var cliOverride: String? {
    get { UserDefaults.standard.string(forKey: cliOverrideKey) }
    set { UserDefaults.standard.set(newValue, forKey: cliOverrideKey) }
  }

  static var nodeOverride: String? {
    get { UserDefaults.standard.string(forKey: nodeOverrideKey) }
    set { UserDefaults.standard.set(newValue, forKey: nodeOverrideKey) }
  }

  /// node 解释器。先用登录 shell 问一次(能覆盖 nvm/fnm/volta 这些版本管理器),
  /// 问不到再退回常见安装路径。
  static func findNode() -> String? {
    if let override = nodeOverride, FileManager.default.isExecutableFile(atPath: override) {
      return override
    }
    if let viaShell = askLoginShell("command -v node"),
       FileManager.default.isExecutableFile(atPath: viaShell) {
      return viaShell
    }
    let common = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ]
    return common.first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  /// prosperod 入口:apps/daemon/dist/cli.js。
  /// app 装在仓库里时,从 bundle 往上走就能找到;拷到 /Applications 后就得靠 override。
  static func findCLI() -> String? {
    if let override = cliOverride, FileManager.default.isReadableFile(atPath: override) {
      return override
    }
    let fm = FileManager.default
    var dir = Bundle.main.bundleURL
    for _ in 0..<8 {
      dir = dir.deletingLastPathComponent()
      let candidate = dir.appendingPathComponent("apps/daemon/dist/cli.js")
      if fm.isReadableFile(atPath: candidate.path) { return candidate.path }
    }
    return nil
  }

  /// 起一个登录 shell 问路径。GUI 进程没有 PATH,这是拿到用户真实环境的唯一办法。
  private static func askLoginShell(_ command: String) -> String? {
    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: shell)
    proc.arguments = ["-lc", command]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    do {
      try proc.run()
    } catch {
      return nil
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    proc.waitUntilExit()
    guard proc.terminationStatus == 0 else { return nil }
    let out = String(decoding: data, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return out.isEmpty ? nil : out.components(separatedBy: "\n").first
  }
}
