import type { SessionInfo } from "@prospero/protocol";

export const QUEUE_DISPLAY_TEXT_LIMIT = 1000;
export const QUEUE_DISPLAY_TRUNCATION_MARKER = "…（仅显示摘要，完整内容已保留）";

/** Display only: never pass this value back into the durable queue or adapter input. */
export function queueDisplayText(text: string): string {
  if (text.length <= QUEUE_DISPLAY_TEXT_LIMIT) return text;
  let end = QUEUE_DISPLAY_TEXT_LIMIT - QUEUE_DISPLAY_TRUNCATION_MARKER.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end) + QUEUE_DISPLAY_TRUNCATION_MARKER;
}

/** Also protects clients of active owners that still run an older, unbounded info(). */
export function projectSessionQueue(info: SessionInfo): SessionInfo {
  if (!info.messageQueue?.some((item) => item.text.length > QUEUE_DISPLAY_TEXT_LIMIT)) return info;
  return {
    ...info,
    messageQueue: info.messageQueue.map((item) => item.text.length > QUEUE_DISPLAY_TEXT_LIMIT
      ? { ...item, text: queueDisplayText(item.text) } : item),
  };
}
