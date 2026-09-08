export const DEFAULT_CONVERSATION_FONT_SIZE = 15;
export const MIN_CONVERSATION_FONT_SIZE = 12;
export const MAX_CONVERSATION_FONT_SIZE = 22;

export function normalizeConversationFontSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(MIN_CONVERSATION_FONT_SIZE, Math.min(MAX_CONVERSATION_FONT_SIZE, Math.round(value)))
    : DEFAULT_CONVERSATION_FONT_SIZE;
}

/** Scale explicit typography only; nested spans without a size keep native inheritance. */
export function scaleConversationTextStyle<T extends { fontSize?: number; lineHeight?: number }>(style: T, scale: number): T {
  if (scale === 1) return style;
  return {
    ...style,
    ...(typeof style.fontSize === "number" ? { fontSize: style.fontSize * scale } : {}),
    ...(typeof style.lineHeight === "number" ? { lineHeight: style.lineHeight * scale } : {}),
  };
}
