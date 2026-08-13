import { describe, expect, it } from "vitest";
import {
  COMPOSER_THUMBNAIL_GAP,
  COMPOSER_THUMBNAIL_REMOVE_TARGET,
  COMPOSER_THUMBNAIL_SIZE,
  MIN_TOUCH_TARGET,
  SYSTEM_TERMINAL_FONT_PREFERENCE,
  adjustTerminalFontSize,
  clampTerminalFontSize,
  parseTerminalFontPreference,
  resetTerminalFontPreference,
  serializeTerminalFontPreference,
  terminalFontSizeForPreference,
  terminalFontSizeForSystem,
} from "../src/lib/terminal-font-size";

describe("终端字号档位", () => {
  it("将 12 * fontScale 吸附到最近档位", () => {
    expect(terminalFontSizeForSystem(0.75)).toBe(9);
    expect(terminalFontSizeForSystem(1)).toBe(12);
    expect(terminalFontSizeForSystem(1.15)).toBe(14);
    expect(terminalFontSizeForSystem(1.5)).toBe(18);
    expect(terminalFontSizeForSystem(2)).toBe(20);
  });

  it("clamp 和步进始终返回可用档位", () => {
    expect(clampTerminalFontSize(2)).toBe(8);
    expect(clampTerminalFontSize(13)).toBe(12);
    expect(clampTerminalFontSize(999)).toBe(20);
    expect(adjustTerminalFontSize(12, 1)).toBe(14);
    expect(adjustTerminalFontSize(14, -1)).toBe(12);
    expect(adjustTerminalFontSize(8, -1)).toBe(8);
    expect(adjustTerminalFontSize(20, 1)).toBe(20);
  });
});

describe("终端字号偏好", () => {
  it("没有 override 或内容损坏时跟随系统", () => {
    expect(parseTerminalFontPreference(null)).toEqual(SYSTEM_TERMINAL_FONT_PREFERENCE);
    expect(parseTerminalFontPreference("not json")).toEqual(SYSTEM_TERMINAL_FONT_PREFERENCE);
    expect(parseTerminalFontPreference('{"mode":"custom","size":13}')).toEqual(
      SYSTEM_TERMINAL_FONT_PREFERENCE,
    );
  });

  it("解析自定义值，复位后删除 override 并重新使用当前系统字号", () => {
    const custom = parseTerminalFontPreference('{"mode":"custom","size":16}');
    expect(custom).toEqual({ mode: "custom", size: 16 });
    expect(terminalFontSizeForPreference(custom, 0.75)).toBe(16);
    expect(resetTerminalFontPreference()).toEqual(SYSTEM_TERMINAL_FONT_PREFERENCE);
    expect(serializeTerminalFontPreference(resetTerminalFontPreference())).toBeNull();
    expect(terminalFontSizeForPreference(resetTerminalFontPreference(), 0.75)).toBe(9);
  });
});

describe("iOS 触控布局常量", () => {
  it("保证真实命中框至少 44pt，图片移除区在缩略图内且相邻图之间留间距", () => {
    expect(MIN_TOUCH_TARGET).toBe(44);
    expect(COMPOSER_THUMBNAIL_REMOVE_TARGET).toBe(MIN_TOUCH_TARGET);
    expect(COMPOSER_THUMBNAIL_REMOVE_TARGET).toBeLessThanOrEqual(COMPOSER_THUMBNAIL_SIZE);
    expect(COMPOSER_THUMBNAIL_GAP).toBeGreaterThan(0);
  });
});
