import Foundation

/// 找到运行 daemon 需要的两样东西:node 解释器,和 prosperod 的入口脚本。
///
/// 这在 GUI 里比在终端里麻烦得多 —— Finder 启动的 app 拿不到登录 shell 的 PATH,
/// 所以 `node` 不能靠 PATH 查找,得自己定位。
///
/// 定位结果带缓存,因为调用点比看起来密集得多:`findCLI()` 被写在菜单的 view body 里,
/// 每次渲染都要问一遍,而它背后是最多 8 层目录的文件遍历;`loginShell()` 更贵,
/// 要起一个跑完用户 rc 文件的登录 shell。没有缓存时这些开销全压在主线程上。
@MainActor
enum Locator {
  /// 用户手动指定的位置(菜单里「选择 prosperod…」写入),优先级最高。
  private static let cliOverrideKey = "prosperodCLIPath"
  private static let nodeOverrideKey = "nodePath"

  /// 文件系统查找的缓存有效期。菜单渲染是成簇发生的(展开一次会渲染很多遍),
  /// 几秒的窗口就足以把重复定位压掉;又足够短,用户刚 build 出 dist/cli.js 也能很快认到。
  private static let lookupTTL: TimeInterval = 5
  /// 登录 shell 探测的有效期。这个贵得多,而 PATH 在一次会话里几乎不变,可以放长。
  private static let shellTTL: TimeInterval = 60

  private static var cachedNode: String?
  private static var nodeCachedAt: Date?
  private static var cachedCLI: String?
  private static var cliCachedAt: Date?
  private static var cachedShellNode: String?
  private static var cachedShellPath: String?
  private static var shellCachedAt: Date?

  static var cliOverride: String? {
    get { UserDefaults.standard.string(forKey: cliOverrideKey) }
    set {
      UserDefaults.standard.set(newValue, forKey: cliOverrideKey)
      cliCachedAt = nil
    }
  }

  static var nodeOverride: String? {
    get { UserDefaults.standard.string(forKey: nodeOverrideKey) }
    set {
      UserDefaults.standard.set(newValue, forKey: nodeOverrideKey)
      nodeCachedAt = nil
    }
  }

  /// 丢掉全部缓存重新找。手动改过路径、或者刚重新 build 过 daemon 时用。
  static func invalidate() {
    nodeCachedAt = nil
    cliCachedAt = nil
    shellCachedAt = nil
  }

  /// node 解释器。先用登录 shell 问一次(能覆盖 nvm/fnm/volta 这些版本管理器),
  /// 问不到再退回常见安装路径。
  static func findNode() -> String? {
    if let at = nodeCachedAt, Date().timeIntervalSince(at) < lookupTTL { return cachedNode }
    cachedNode = resolveNode()
    nodeCachedAt = Date()
    return cachedNode
  }

  private static func resolveNode() -> String? {
    let fm = FileManager.default
    if let override = nodeOverride, fm.isExecutableFile(atPath: override) {
      return override
    }
    if let viaShell = loginShell().node, fm.isExecutableFile(atPath: viaShell) {
      return viaShell
    }
    let common = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ]
    return common.first { fm.isExecutableFile(atPath: $0) }
  }

  /// prosperod 入口:apps/daemon/dist/cli.js。
  /// app 装在仓库里时,从 bundle 往上走就能找到;拷到 /Applications 后就得靠 override。
  ///
  /// 注意「找不到」这个结果也要缓存 —— 那正是 `.disabled(findCLI() == nil)`
  /// 每次渲染都在走的分支,不缓存等于把最长的那条查找路径接到了渲染上。
  static func findCLI() -> String? {
    if let at = cliCachedAt, Date().timeIntervalSince(at) < lookupTTL { return cachedCLI }
    cachedCLI = resolveCLI()
    cliCachedAt = Date()
    return cachedCLI
  }

  private static func resolveCLI() -> String? {
    let fm = FileManager.default
    if let override = cliOverride, fm.isReadableFile(atPath: override) {
      return override
    }
    var dir = Bundle.main.bundleURL
    for _ in 0..<8 {
      dir = dir.deletingLastPathComponent()
      let candidate = dir.appendingPathComponent("apps/daemon/dist/cli.js")
      if fm.isReadableFile(atPath: candidate.path) { return candidate.path }
    }
    return nil
  }

  /// 登录 shell 的 PATH。GUI 进程的 PATH 极简,直接传给 daemon 会让它找不到各家 agent CLI。
  static func loginPath() -> String? { loginShell().path }

  /// 起一个登录 shell,一次问齐 node 路径和 PATH。
  ///
  /// 这两样以前是各起一个 shell 问的(findNode 一次、DaemonController.loginPath 一次)。
  /// 起登录 shell 要跑完用户的 rc 文件,几十到几百毫秒,而且都发生在主线程上 —— 问一次就够。
  ///
  /// 输出用标记行包起来,而不是按行号取:rc 文件里 echo 点什么是很常见的,
  /// 按行号取会把那些噪声当成 node 路径。
  private static func loginShell() -> (node: String?, path: String?) {
    if let at = shellCachedAt, Date().timeIntervalSince(at) < shellTTL {
      return (cachedShellNode, cachedShellPath)
    }

    let nodeMarker = "<<prospero-node>>"
    let pathMarker = "<<prospero-path>>"
    let script = """
      printf '\(nodeMarker)%s\\n' "$(command -v node)"
      printf '\(pathMarker)%s\\n' "$PATH"
      """

    var node: String?
    var path: String?
    if let out = runLoginShell(script) {
      for line in out.components(separatedBy: .newlines) {
        if line.hasPrefix(nodeMarker) {
          let value = String(line.dropFirst(nodeMarker.count)).trimmingCharacters(in: .whitespaces)
          node = value.isEmpty ? nil : value
        } else if line.hasPrefix(pathMarker) {
          let value = String(line.dropFirst(pathMarker.count)).trimmingCharacters(in: .whitespaces)
          path = value.isEmpty ? nil : value
        }
      }
    }

    cachedShellNode = node
    cachedShellPath = path
    shellCachedAt = Date()
    return (node, path)
  }

  private static func runLoginShell(_ script: String) -> String? {
    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: shell)
    proc.arguments = ["-lc", script]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    do {
      try proc.run()
    } catch {
      return nil
    }
    // 先读到 EOF 再 wait —— 反过来的话,输出撑爆管道缓冲区就死锁了
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    proc.waitUntilExit()
    let out = String(decoding: data, as: UTF8.self)
    return out.isEmpty ? nil : out
  }
}
