@testable import ProsperoShell
import AppKit
import XCTest

final class TerminalFontPreferencesTests: XCTestCase {
  func testStorageRoundTripIsAtomicAndFallsBackFromInvalidData() {
    let selected = TerminalFontPreference(
      family: "JetBrainsMono Nerd Font Mono",
      fontName: "JetBrainsMonoNFM-Regular",
      size: 15.5
    )

    XCTAssertEqual(TerminalFontPreference.fromStorage(selected.storageValue), selected)
    XCTAssertEqual(TerminalFontPreference.fromStorage(""), .system)
    XCTAssertEqual(TerminalFontPreference.fromStorage("not-json"), .system)
    XCTAssertEqual(TerminalFontPreference.system.storageValue, "")
  }

  func testPreferenceStorePersistsAndRemovesTheSingleDefaultsValue() throws {
    let suite = "TerminalFontPreferencesTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let selected = TerminalFontPreference(
      family: "JetBrainsMono Nerd Font Mono",
      fontName: "JetBrainsMonoNFM-Regular",
      size: 16
    )

    TerminalFontPreferences.save(selected, to: defaults)
    XCTAssertEqual(TerminalFontPreferences.load(from: defaults), selected)

    TerminalFontPreferences.save(.system, to: defaults)
    XCTAssertNil(defaults.object(forKey: TerminalFontPreferences.key))
    XCTAssertEqual(TerminalFontPreferences.load(from: defaults), .system)
  }

  func testPreferenceSanitizesNamesAndClampsFontSize() {
    XCTAssertEqual(
      TerminalFontPreference(family: "  Menlo  ", fontName: " Menlo-Regular ", size: 2),
      TerminalFontPreference(family: "Menlo", fontName: "Menlo-Regular", size: 8)
    )
    XCTAssertEqual(
      TerminalFontPreference(family: "Menlo", fontName: "Menlo-Regular", size: 100).size,
      48
    )
    XCTAssertEqual(
      TerminalFontPreference(family: "Menlo", fontName: "Menlo-Regular", size: .nan).size,
      TerminalFontPreference.defaultSize
    )
    XCTAssertEqual(
      TerminalFontPreference(family: "", fontName: "stale-name", size: 13).fontName,
      ""
    )
  }

  func testBridgeMessageKeepsFamilySeparateFromCSSSyntax() {
    let preference = TerminalFontPreference(
      family: "Font \"Quoted\", Mono",
      fontName: "QuotedMono-Regular",
      size: 14
    )

    XCTAssertEqual(preference.bridgeMessage["kind"] as? String, "font")
    XCTAssertEqual(preference.bridgeMessage["family"] as? String, "Font \"Quoted\", Mono")
    XCTAssertEqual(preference.bridgeMessage["size"] as? Double, 14)
  }

  @MainActor
  func testSystemDefaultResolvesToFixedPitchFont() {
    XCTAssertTrue(TerminalFontPreference.system.resolvedFont.isFixedPitch)
  }
}
