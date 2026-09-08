import type { ChatTimelineItem } from "../chat-events";

export type ChatViewMode = "conversation" | "trajectory";
export const DEFAULT_CONVERSATION_FONT_SIZE = 16;
export const CONVERSATION_FONT_KEY = "prospero.conversationFontSize";
export function conversationFontSize(value: unknown): number {
  const size = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(size) ? Math.min(24, Math.max(13, Math.round(size))) : DEFAULT_CONVERSATION_FONT_SIZE;
}

export function chatDisplayItems(items: readonly ChatTimelineItem[], mode: ChatViewMode, separateTrajectory = false): ChatTimelineItem[] {
  if (mode === "trajectory") return items.filter(({ event }) => !["user.message", "assistant.text", "turn.end"].includes(String(event.kind)));
  const result: ChatTimelineItem[] = [];
  let completed: ChatTimelineItem[] = [];
  const flush = (): void => {
    if (completed.length >= 3) result.push({ ...completed[0]!, key: `activity:${completed[0]!.key}`, event: { kind: "activity.group", events: completed.map((item) => item.event) } });
    else result.push(...completed);
    completed = [];
  };
  for (const item of items) {
    if (item.event.kind === "trajectory.record") continue;
    if (separateTrajectory && ["reasoning", "tool.start", "tool.end", "permission.auto", "subagent.started", "subagent.updated"].includes(String(item.event.kind))) continue;
    if (item.event.kind === "permission.auto" || item.event.kind === "tool.end" && (item.event.state ?? "success") === "success") completed.push(item);
    else { flush(); result.push(item); }
  }
  flush();
  return result;
}

/** Include the destination and some following context, even outside the mounted window. */
export function historyEndForItem(items: readonly ChatTimelineItem[], key: string, nextOrdinal: number, windowSize: number): number {
  const index = items.findIndex((item) => item.key === key);
  if (index < 0) return nextOrdinal;
  return items[Math.min(items.length - 1, index + Math.floor(windowSize / 2))]!.ordinal + 1;
}
