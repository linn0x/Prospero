export interface QuickReplySettings {
  idle: string[];
  busy: string[];
}

export const MAX_QUICK_REPLIES = 24;
export const MAX_QUICK_REPLY_LENGTH = 500;
export const DEFAULT_QUICK_REPLIES: QuickReplySettings = {
  idle: ["继续", "go ahead", "看起来不错", "跑一下测试", "解释一下", "总结一下", "提交这些改动"],
  busy: ["等一下", "换个思路", "先别改文件"],
};

export function parseQuickReplyLines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))];
}

export function quickReplyValidationError(items: string[]): string | null {
  if (items.length > MAX_QUICK_REPLIES) return `每组最多保存 ${MAX_QUICK_REPLIES} 条快捷指令。`;
  if (items.some((item) => item.length > MAX_QUICK_REPLY_LENGTH)) return `每条快捷指令最多 ${MAX_QUICK_REPLY_LENGTH} 个字符。`;
  return null;
}

export function normalizeQuickReplies(value: unknown): QuickReplySettings {
  const settings = value && typeof value === "object" ? value as Partial<QuickReplySettings> : {};
  const normalize = (items: unknown, fallback: string[]): string[] => Array.isArray(items)
    ? [...new Set(items.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= MAX_QUICK_REPLY_LENGTH))].slice(0, MAX_QUICK_REPLIES)
    : [...fallback];
  return { idle: normalize(settings.idle, DEFAULT_QUICK_REPLIES.idle), busy: normalize(settings.busy, DEFAULT_QUICK_REPLIES.busy) };
}
