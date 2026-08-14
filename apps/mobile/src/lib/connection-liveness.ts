/** Pure heartbeat policy so it can be tested without a native WebSocket. */
export const HEARTBEAT_TICK_MS = 5_000;
export const CONNECTION_PING_INTERVAL_MS = 15_000;
export const CONNECTION_SILENCE_LIMIT_MS = 35_000;

export interface LivenessState {
  protocolVersion: number;
  lastRecvAt: number;
  lastPingAt: number;
  pendingPingId: string | null;
}

export type LivenessAction = "none" | "send_ping" | "reconnect";

export function nextLivenessAction(state: LivenessState, now: number): LivenessAction {
  if (now - state.lastRecvAt >= CONNECTION_SILENCE_LIMIT_MS) return "reconnect";
  if (state.protocolVersion < 13 || state.pendingPingId !== null) return "none";
  return now - state.lastPingAt >= CONNECTION_PING_INTERVAL_MS ? "send_ping" : "none";
}
