import AppKit
import Foundation

/// Mac 终端的全局字体偏好。空 family/name 代表跟随系统等宽字体；这比把
/// `SFMono-Regular` 写死更耐系统升级，也给未安装自选字体的机器一个可靠回退。
struct TerminalFontPreference: Equatable, Sendable {
  static let defaultSize = 13.0
  static let minimumSize = 8.0
  static let maximumSize = 48.0
  static let system = TerminalFontPreference(family: "", fontName: "", size: defaultSize)

  let family: String
  let fontName: String
  let size: Double

  init(family: String, fontName: String, size: Double) {
    let cleanFamily = family.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanName = fontName.trimmingCharacters(in: .whitespacesAndNewlines)
    self.family = cleanFamily
    self.fontName = cleanFamily.isEmpty ? "" : cleanName
    let finiteSize = size.isFinite ? size : Self.defaultSize
    self.size = min(Self.maximumSize, max(Self.minimumSize, finiteSize))
  }

  @MainActor
  init(font: NSFont) {
    self.init(
      family: font.familyName ?? font.displayName ?? font.fontName,
      fontName: font.fontName,
      size: Double(font.pointSize)
    )
  }

  var displayName: String {
    family.isEmpty ? "系统等宽字体" : family
  }

  static func fromStorage(_ value: String) -> TerminalFontPreference {
    guard !value.isEmpty,
          let data = value.data(using: .utf8),
          let stored = try? JSONDecoder().decode(TerminalFontPreferenceStorage.self, from: data)
    else { return .system }
    return TerminalFontPreference(
      family: stored.family,
      fontName: stored.fontName,
      size: stored.size
    )
  }

  var storageValue: String {
    guard self != .system,
          let data = try? JSONEncoder().encode(TerminalFontPreferenceStorage(
            family: family,
            fontName: fontName,
            size: size
          )),
          let value = String(data: data, encoding: .utf8)
    else { return "" }
    return value
  }

  /// xterm 的 fontFamily 接受 CSS family 名称。只传首选 family，页面会自行
  /// 追加系统等宽回退；字体未安装时不会把终端变成空白。
  var bridgeMessage: [String: Any] {
    ["kind": "font", "size": size, "family": family]
  }

  @MainActor
  var resolvedFont: NSFont {
    if !fontName.isEmpty,
       let exact = NSFont(name: fontName, size: CGFloat(size)),
       exact.isFixedPitch {
      return exact
    }
    if !family.isEmpty,
       let members = NSFontManager.shared.availableMembers(ofFontFamily: family) {
      for member in members {
        guard let name = member.first as? String,
              let candidate = NSFont(name: name, size: CGFloat(size)),
              candidate.isFixedPitch
        else { continue }
        return candidate
      }
    }
    return NSFont.monospacedSystemFont(ofSize: CGFloat(size), weight: .regular)
  }
}

private struct TerminalFontPreferenceStorage: Codable {
  let family: String
  let fontName: String
  let size: Double
}

enum TerminalFontPreferences {
  static let key = "terminalFontPreference"

  static func load(from defaults: UserDefaults = .standard) -> TerminalFontPreference {
    TerminalFontPreference.fromStorage(defaults.string(forKey: key) ?? "")
  }

  static func save(
    _ preference: TerminalFontPreference,
    to defaults: UserDefaults = .standard
  ) {
    let value = preference.storageValue
    if value.isEmpty {
      defaults.removeObject(forKey: key)
    } else {
      defaults.set(value, forKey: key)
    }
  }
}

/// iTerm2 风格的系统字体面板：修改会即时预览，不需要先点“应用”。终端网格
/// 必须使用等宽字体，因此比例字体会被拒绝，同时保留上一个有效选择。
@MainActor
final class TerminalFontPanelController: NSObject, NSFontChanging {
  static let shared = TerminalFontPanelController()

  private var selectedFont = TerminalFontPreference.system.resolvedFont
  private let hint = NSTextField(labelWithString: "仅支持等宽字体；图标字体请选择 Nerd Font Mono 变体。")

  private override init() {
    super.init()
    hint.font = .systemFont(ofSize: 11)
    hint.textColor = .secondaryLabelColor
    hint.alignment = .center
    hint.maximumNumberOfLines = 2
    hint.frame = NSRect(x: 0, y: 0, width: 360, height: 34)
  }

  func present(preference: TerminalFontPreference) {
    selectedFont = preference.resolvedFont
    hint.stringValue = "仅支持等宽字体；图标字体请选择 Nerd Font Mono 变体。"
    hint.textColor = .secondaryLabelColor

    let manager = NSFontManager.shared
    manager.target = self
    manager.setSelectedFont(selectedFont, isMultiple: false)

    let panel = NSFontPanel.shared
    panel.accessoryView = hint
    panel.setPanelFont(selectedFont, isMultiple: false)
    manager.orderFrontFontPanel(nil)
  }

  func changeFont(_ sender: NSFontManager?) {
    guard let sender else { return }
    let candidate = sender.convert(selectedFont)
    guard candidate.isFixedPitch else {
      NSSound.beep()
      hint.stringValue = "这个字体不是等宽字体，无法用于终端网格。请选择 Mono / Fixed 字体。"
      hint.textColor = .systemOrange
      sender.setSelectedFont(selectedFont, isMultiple: false)
      NSFontPanel.shared.setPanelFont(selectedFont, isMultiple: false)
      return
    }

    let preference = TerminalFontPreference(font: candidate)
    selectedFont = preference.resolvedFont
    hint.stringValue = "已即时应用到所有终端。"
    hint.textColor = .systemGreen
    TerminalFontPreferences.save(preference)
  }
}
