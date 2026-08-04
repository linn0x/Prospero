import CoreImage.CIFilterBuiltins
import Foundation
import SwiftUI

/// 生成配对二维码。
///
/// 不自己拼载荷 —— 让 CLI 去 mint 设备、写注册表、组装 payload,壳只负责把它印出来。
/// 这样配对逻辑只有一份实现,壳和终端不会漂移。
@MainActor
@Observable
final class PairingModel {
  enum Phase: Equatable {
    case idle
    case generating
    case ready(url: String, addrs: String, port: Int)
    case failed(String)
  }

  private(set) var phase: Phase = .idle
  var deviceName: String = "iphone"
  var allowShell: Bool = true

  func generate() {
    guard let node = Locator.findNode(), let cli = Locator.findCLI() else {
      phase = .failed("找不到 node 或 prosperod")
      return
    }
    phase = .generating

    var args = [cli, "pair", "--name", deviceName]
    if !allowShell { args.append("--no-shell") }

    Task.detached {
      let result = Self.run(node: node, args: args)
      await MainActor.run {
        switch result {
        case .failure(let message):
          self.phase = .failed(message)
        case .success(let output):
          guard let url = Self.extractPairingURL(from: output) else {
            self.phase = .failed("CLI 没有输出配对串:\n\(output.suffix(200))")
            return
          }
          let (addrs, port) = Self.extractAddrs(from: output)
          self.phase = .ready(url: url, addrs: addrs, port: port)
        }
      }
    }
  }

  func reset() { phase = .idle }

  // CLI 打印的是 `prospero://pair?d=<base64>`,夹在二维码字符画和说明文字之间。
  nonisolated static func extractPairingURL(from output: String) -> String? {
    for line in output.components(separatedBy: .newlines) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("prospero://pair?") { return trimmed }
    }
    return nil
  }

  /// 从 `地址: a, b  端口: 7423` 这行里取出来,纯展示用。
  nonisolated static func extractAddrs(from output: String) -> (String, Int) {
    for line in output.components(separatedBy: .newlines) where line.hasPrefix("地址: ") {
      let parts = line.dropFirst("地址: ".count).components(separatedBy: "端口: ")
      let addrs = parts.first?.trimmingCharacters(in: .whitespaces) ?? ""
      let port = Int(parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : "") ?? 7423
      return (addrs, port)
    }
    return ("", 7423)
  }

  /// Result 要求错误类型是 Error,这里只想带一段给人看的文字,自己定一个够了。
  enum RunOutcome {
    case success(String)
    case failure(String)
  }

  private nonisolated static func run(node: String, args: [String]) -> RunOutcome {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: node)
    proc.arguments = args
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = pipe
    do {
      try proc.run()
    } catch {
      return .failure("无法运行 prosperod:\(error.localizedDescription)")
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    proc.waitUntilExit()
    let output = String(decoding: data, as: UTF8.self)
    return proc.terminationStatus == 0 ? .success(output) : .failure(output)
  }
}

enum QRCode {
  /// 二维码渲染。配对串里含访问凭证,只在本机屏幕上出现,不落盘。
  static func image(from string: String, scale: CGFloat = 8) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(string.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let context = CIContext()
    guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
    return NSImage(cgImage: cg, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
  }
}
