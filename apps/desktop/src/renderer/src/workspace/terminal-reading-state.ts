/**
 * Reading state is deliberately separate from terminal bytes. A terminal can
 * lose its replay cache while the user's viewport and find intent remain
 * useful. The bounded in-memory store also avoids putting transient queries in
 * localStorage or growing with the number of historical sessions.
 */
export type TerminalReadingState = {
  viewport: number;
  followBottom: boolean;
  find: string;
};

const MAX_SESSIONS = 64;
const states = new Map<string, TerminalReadingState>();
const DEFAULT_STATE: TerminalReadingState = { viewport: 0, followBottom: true, find: "" };

function clean(value: Partial<TerminalReadingState> | undefined): TerminalReadingState {
  return {
    viewport: Number.isFinite(value?.viewport) ? Math.max(0, Math.floor(value!.viewport!)) : DEFAULT_STATE.viewport,
    followBottom: value?.followBottom !== false,
    find: typeof value?.find === "string" ? value.find.slice(0, 256) : DEFAULT_STATE.find,
  };
}

export function readTerminalReadingState(sessionId: string): TerminalReadingState {
  const current = states.get(sessionId);
  if (current) { states.delete(sessionId); states.set(sessionId, current); return { ...current }; }
  return { ...DEFAULT_STATE };
}

export function saveTerminalReadingState(sessionId: string, value: Partial<TerminalReadingState>): TerminalReadingState {
  if (!sessionId) return { ...DEFAULT_STATE };
  const next = clean({ ...readTerminalReadingState(sessionId), ...value });
  states.delete(sessionId); states.set(sessionId, next);
  while (states.size > MAX_SESSIONS) states.delete(states.keys().next().value!);
  return { ...next };
}

export function clearTerminalReadingState(sessionId?: string): void {
  if (sessionId) states.delete(sessionId); else states.clear();
}
