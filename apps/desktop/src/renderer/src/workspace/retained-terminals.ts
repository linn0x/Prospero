// Keep a bounded MRU set of live terminal surfaces; older background ones release GPU/relay resources.
export const RETAINED_TERMINAL_LIMIT = 6;

export function retainTerminalIds(current: string[], activeId?: string): string[] {
  if (!activeId || current.at(-1) === activeId) return current;
  return [...current.filter(id => id !== activeId), activeId].slice(-RETAINED_TERMINAL_LIMIT);
}
