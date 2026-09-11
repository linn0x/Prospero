import type { ChangeEvent, SessionHead } from "@prospero/protocol/rust-daemon";

export function applySessionChanges(items: readonly SessionHead[], events: readonly ChangeEvent[]): SessionHead[] {
  const replacements = new Map<string, SessionHead>();
  for (const event of events) {
    if (event.scope !== "sessions" || event.kind !== "session.updated" || !event.data || typeof event.data !== "object") continue;
    const head = event.data as SessionHead;
    if (head.id !== event.entityId || !Number.isSafeInteger(head.revision)) continue;
    const previous = replacements.get(head.id);
    if (!previous || previous.revision < head.revision) replacements.set(head.id, head);
  }
  return items.map(head => {
    const replacement = replacements.get(head.id);
    return replacement && replacement.revision > head.revision ? replacement : head;
  });
}

export function visibleRows(length: number, scrollTop: number, height: number, rowHeight = 72): { start: number; end: number } {
  const start = Math.min(length, Math.max(0, Math.floor(scrollTop / rowHeight) - 3));
  return { start, end: Math.min(length, start + Math.ceil(height / rowHeight) + 6) };
}

export function previousCursors(history: readonly (string | null)[], cursor: string | null): (string | null)[] {
  return [...history, cursor].slice(-64);
}
