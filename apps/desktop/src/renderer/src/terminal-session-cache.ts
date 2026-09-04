export type TerminalSessionCacheEntry = {
  sessionId: string;
  cursor: number;
  cols: number;
  rows: number;
  serialized: string;
};

export type TerminalSessionCacheLimits = {
  maxEntries: number;
  maxEntryChars: number;
  maxTotalChars: number;
};

export const TERMINAL_SESSION_CACHE_SCROLLBACK = 1_000;
export const TERMINAL_SESSION_CACHE_LIMITS: TerminalSessionCacheLimits = {
  maxEntries: 6,
  maxEntryChars: 750_000,
  maxTotalChars: 2_000_000,
};

function validEntry(entry: TerminalSessionCacheEntry, limits: TerminalSessionCacheLimits): boolean {
  return entry.sessionId.length > 0
    && entry.sessionId.length <= 200
    && Number.isSafeInteger(entry.cursor)
    && entry.cursor >= 0
    && Number.isInteger(entry.cols)
    && entry.cols >= 20
    && entry.cols <= 500
    && Number.isInteger(entry.rows)
    && entry.rows >= 5
    && entry.rows <= 300
    && entry.serialized.length > 0
    && entry.serialized.length <= limits.maxEntryChars;
}

export function updateTerminalSessionCacheEntries(
  current: readonly TerminalSessionCacheEntry[],
  incoming: TerminalSessionCacheEntry,
  limits: TerminalSessionCacheLimits = TERMINAL_SESSION_CACHE_LIMITS,
): TerminalSessionCacheEntry[] {
  const maxEntries = Math.max(0, Math.floor(limits.maxEntries));
  const maxEntryChars = Math.max(0, Math.floor(limits.maxEntryChars));
  const maxTotalChars = Math.max(0, Math.floor(limits.maxTotalChars));
  const normalizedLimits = { maxEntries, maxEntryChars, maxTotalChars };
  const next = current.filter((entry) => entry.sessionId !== incoming.sessionId && validEntry(entry, normalizedLimits));
  if (maxEntries === 0 || incoming.serialized.length > maxTotalChars || !validEntry(incoming, normalizedLimits)) return next;
  next.push(incoming);
  let total = next.reduce((sum, entry) => sum + entry.serialized.length, 0);
  while (next.length > maxEntries || total > maxTotalChars) {
    total -= next.shift()?.serialized.length ?? 0;
  }
  return next;
}

let terminalSessionCache: TerminalSessionCacheEntry[] = [];

export function loadTerminalSessionCache(sessionId: string): TerminalSessionCacheEntry | undefined {
  const entry = terminalSessionCache.find((candidate) => candidate.sessionId === sessionId);
  if (!entry) return undefined;
  terminalSessionCache = updateTerminalSessionCacheEntries(terminalSessionCache, entry);
  return entry;
}

export function saveTerminalSessionCache(entry: TerminalSessionCacheEntry): boolean {
  terminalSessionCache = updateTerminalSessionCacheEntries(terminalSessionCache, entry);
  return terminalSessionCache.some((candidate) => candidate.sessionId === entry.sessionId);
}

export function deleteTerminalSessionCache(sessionId: string): void {
  terminalSessionCache = terminalSessionCache.filter((entry) => entry.sessionId !== sessionId);
}
