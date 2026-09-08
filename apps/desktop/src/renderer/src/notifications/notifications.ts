export type DesktopNotice = { message: string; kind: "error" | "warning"; title?: string; key?: string };

/** Suppress repeated polling errors, including after the user dismisses one. */
export class NoticeGate {
  private readonly recent = new Map<string, number>();
  accept(notice: DesktopNotice, now = Date.now()): boolean {
    if (!notice.message.trim()) return false;
    const key = notice.key ?? `${notice.kind}:${notice.message}`;
    const previous = this.recent.get(key);
    if (previous !== undefined && now - previous < 30_000) return false;
    this.recent.delete(key);
    this.recent.set(key, now);
    if (this.recent.size > 100) this.recent.delete(this.recent.keys().next().value!);
    return true;
  }
}

const listeners = new Set<(notice: DesktopNotice) => void>();
const pending: DesktopNotice[] = [];
const gate = new NoticeGate();

export function notify(notice: DesktopNotice): void {
  if (!gate.accept(notice)) return;
  if (!listeners.size) {
    pending.push(notice);
    if (pending.length > 3) pending.shift();
  } else for (const listener of listeners) listener(notice);
}

export function subscribeNotices(listener: (notice: DesktopNotice) => void): () => void {
  listeners.add(listener);
  for (const notice of pending.splice(0)) listener(notice);
  return () => { listeners.delete(listener); };
}
