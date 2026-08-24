import SwiftUI

/// apps/daemon/term.html 里 xterm 那套 Tokyo Night 主题在 Swift 侧的复刻。
///
/// 终端画面由 WebView 画,它周围的头部、状态条、空态由 SwiftUI 画。两边各写一套
/// 颜色,窗口上迟早会露出一条色缝 —— 这里是 Swift 侧的唯一出处,改主题时
/// 和 term.html 的 theme 一起改。
enum TerminalPalette {
  /// 与 xterm 的 background 严格同色,终端周围的留白才不会显形。
  static let background = Color(terminalHex: 0x1a1b26)
  /// 头部与状态条:比画面亮一档,靠明度而不是靠分割线把层次做出来。
  static let surface = Color(terminalHex: 0x1f2130)
  /// 悬浮元素(按钮底、徽章底)。
  static let raised = Color(terminalHex: 0x292e42)
  static let border = Color(terminalHex: 0x2f3450)

  static let foreground = Color(terminalHex: 0xc0caf5)
  static let secondary = Color(terminalHex: 0x9aa5ce)
  /// 注释色。路径、次要说明用它,不参与信息竞争。
  static let dim = Color(terminalHex: 0x565f89)

  static let blue = Color(terminalHex: 0x7aa2f7)
  static let purple = Color(terminalHex: 0xbb9af7)
  static let cyan = Color(terminalHex: 0x7dcfff)
  static let green = Color(terminalHex: 0x9ece6a)
  static let yellow = Color(terminalHex: 0xe0af68)
  static let red = Color(terminalHex: 0xf7768e)
}

extension Color {
  /// 只服务于上面那张表 —— 主题色写成 0xRRGGBB 才能和 term.html 逐字对照。
  init(terminalHex hex: UInt32) {
    self.init(
      red: Double((hex >> 16) & 0xff) / 255,
      green: Double((hex >> 8) & 0xff) / 255,
      blue: Double(hex & 0xff) / 255
    )
  }
}

/// 深色头部上的小圆角按钮。
///
/// 系统的 `.bordered` 在 #1a1b26 上会画出一块浅灰色板 —— 那是给浅色窗口设计的。
/// 终端头部要的是"底色里长出来"的控件:平时几乎隐形,指过去才浮起来。
struct TerminalChipButtonStyle: ButtonStyle {
  var tint: Color = TerminalPalette.foreground
  /// 主操作(如"完成")填实底,其余只在悬停时给一层浮起。
  var filled = false

  func makeBody(configuration: Configuration) -> some View {
    Chip(configuration: configuration, tint: tint, filled: filled)
  }

  /// 悬停态要 @State,而 ButtonStyle 自身是每次求值都会重建的 struct,存不住状态。
  private struct Chip: View {
    let configuration: Configuration
    let tint: Color
    let filled: Bool
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled

    private var background: Color {
      if filled { return tint.opacity(configuration.isPressed ? 0.34 : 0.22) }
      if configuration.isPressed { return TerminalPalette.raised.opacity(0.95) }
      return hovering ? TerminalPalette.raised.opacity(0.7) : .clear
    }

    var body: some View {
      configuration.label
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(tint.opacity(enabled ? 1 : 0.35))
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(background, in: RoundedRectangle(cornerRadius: 7))
        .overlay {
          RoundedRectangle(cornerRadius: 7)
            .stroke(filled ? tint.opacity(0.45) : .clear, lineWidth: 1)
        }
        .contentShape(RoundedRectangle(cornerRadius: 7))
        .onHover { hovering = $0 && enabled }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
  }
}

/// 终端里的等宽小标签(tmux / 状态 / 路径)。
struct TerminalBadge: View {
  let text: String
  var tint: Color = TerminalPalette.dim

  var body: some View {
    Text(text)
      .font(.system(size: 10, weight: .semibold, design: .monospaced))
      .foregroundStyle(tint)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
  }
}
