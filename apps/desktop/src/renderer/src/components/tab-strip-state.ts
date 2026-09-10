/** Retain the user's order, drop closed tabs, and append newly opened tabs. */
export function orderedTabIds(order: readonly string[], available: readonly string[]): string[] {
  const allowed = new Set(available);
  return [...new Set([...order.filter(id => allowed.has(id)), ...available])];
}

export function moveTabBefore(ids: readonly string[], id: string, before: string | null): string[] {
  if (!ids.includes(id) || before === id || before !== null && !ids.includes(before)) return [...ids];
  const next = ids.filter(value => value !== id);
  next.splice(before === null ? next.length : next.indexOf(before), 0, id);
  return next;
}

export function tabReorderKey(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, platform: string): boolean {
  return event.shiftKey && !event.altKey && (platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && ["ArrowLeft", "ArrowRight"].includes(event.key);
}
