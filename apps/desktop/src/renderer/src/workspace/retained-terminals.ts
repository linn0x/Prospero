// Keep a bounded set of live xterm instances; the oldest inactive one is evicted.
export const RETAINED_TERMINAL_LIMIT = 4;

export function retainTerminalIds(current: string[], activeId?: string): string[] {
  if (!activeId || current.at(-1) === activeId) return current;
  return [...current.filter(id => id !== activeId), activeId].slice(-RETAINED_TERMINAL_LIMIT);
}
