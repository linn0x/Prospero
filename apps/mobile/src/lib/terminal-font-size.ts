/**
 * 终端字号只允许使用整数档位。这样等宽字体不会停在模糊的半像素大小，
 * 同时让 Dynamic Type、A+/A− 和捏合缩放使用完全相同的边界规则。
 */
export const TERMINAL_FONT_STEPS = [8, 9, 10, 11, 12, 14, 16, 18, 20] as const;
/** 设备级 key；没有此项就表示没有覆盖系统 Dynamic Type。 */
export const TERMINAL_FONT_PREFERENCE_STORAGE_KEY = "prospero.terminal-font-size.v1";

export type TerminalFontSize = (typeof TERMINAL_FONT_STEPS)[number];

export type TerminalFontPreference =
  | { mode: "system" }
  | { mode: "custom"; size: TerminalFontSize };

export const SYSTEM_TERMINAL_FONT_PREFERENCE: TerminalFontPreference = { mode: "system" };

/** 触控命中框和 VoiceOver 焦点框共享的最小边长。 */
export const MIN_TOUCH_TARGET = 44;
/** 缩略图内的移除操作不会越出本张图，因而不会和相邻缩略图重叠。 */
export const COMPOSER_THUMBNAIL_SIZE = 58;
export const COMPOSER_THUMBNAIL_REMOVE_TARGET = MIN_TOUCH_TARGET;
export const COMPOSER_THUMBNAIL_GAP = 10;

function isTerminalFontSize(value: unknown): value is TerminalFontSize {
  return typeof value === "number" && TERMINAL_FONT_STEPS.includes(value as TerminalFontSize);
}

/** 将任意数值吸附到最近的可用字号；相同距离时取较小档位。 */
export function clampTerminalFontSize(value: number): TerminalFontSize {
  const target = Number.isFinite(value) ? value : 12;
  return TERMINAL_FONT_STEPS.reduce<TerminalFontSize>((closest, candidate) =>
    Math.abs(candidate - target) < Math.abs(closest - target) ? candidate : closest,
  TERMINAL_FONT_STEPS[0]);
}

/** 终端的系统模式基准为 12pt，并随当前窗口的 Dynamic Type 比例实时变化。 */
export function terminalFontSizeForSystem(fontScale: number): TerminalFontSize {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return clampTerminalFontSize(12 * scale);
}

export function terminalFontSizeForPreference(
  preference: TerminalFontPreference,
  fontScale: number,
): TerminalFontSize {
  return preference.mode === "custom" ? preference.size : terminalFontSizeForSystem(fontScale);
}

/** A+/A− 从当前档位移动一格，不会产生不在档位表中的字号。 */
export function adjustTerminalFontSize(size: number, delta: number): TerminalFontSize {
  const current = clampTerminalFontSize(size);
  const index = TERMINAL_FONT_STEPS.indexOf(current);
  const direction = Math.sign(delta);
  if (direction === 0) return current;
  return TERMINAL_FONT_STEPS[Math.max(0, Math.min(TERMINAL_FONT_STEPS.length - 1, index + direction))];
}

/** 无存储项、损坏项及旧格式都意味着继续跟随系统。 */
export function parseTerminalFontPreference(raw: string | null): TerminalFontPreference {
  if (!raw) return SYSTEM_TERMINAL_FONT_PREFERENCE;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { mode?: unknown }).mode === "custom" &&
      isTerminalFontSize((value as { size?: unknown }).size)
    ) {
      return { mode: "custom", size: (value as { size: TerminalFontSize }).size };
    }
  } catch {
    // 用户偏好不是关键数据；读坏时回退系统字号即可。
  }
  return SYSTEM_TERMINAL_FONT_PREFERENCE;
}

export function serializeTerminalFontPreference(preference: TerminalFontPreference): string | null {
  return preference.mode === "custom" ? JSON.stringify(preference) : null;
}

/** 复位不保留 system 覆盖项，调用方应据此删除 AsyncStorage key。 */
export function resetTerminalFontPreference(): TerminalFontPreference {
  return SYSTEM_TERMINAL_FONT_PREFERENCE;
}
