type SessionState = { status: string; pendingPermissions?: number; pendingQuestions?: number };
export type SessionIndicator = { state: "completed" | "terminated" | "running" | "approval" | "input" | "waiting" | "unknown"; motion: "none" | "breathe" | "bounce" | "blink"; unread: boolean };

export function sessionIndicator(session: SessionState, unread = false): SessionIndicator {
  const status = session.status.toLowerCase();
  // Terminal states take precedence over counters retained from an interrupted turn.
  if (["died", "failed", "error", "cancelled", "canceled", "killed", "terminated", "interrupted", "exited", "stopped", "abandoned"].includes(status)) return { state: "terminated", motion: "none", unread };
  if (status === "waiting_approval" || (session.pendingPermissions ?? 0) > 0) return { state: "approval", motion: "blink", unread };
  if (status === "waiting_input" || (session.pendingQuestions ?? 0) > 0) return { state: "input", motion: "blink", unread };
  if (["running", "starting", "active", "busy", "dispatched"].includes(status)) return { state: "running", motion: "breathe", unread };
  // Structured sessions return to idle when the current answer is complete.
  if (["idle", "completed", "done", "succeeded", "success"].includes(status)) return { state: "completed", motion: unread ? "bounce" : "none", unread };
  if (["pending", "ready", "paused", "blocked", "queued"].includes(status)) return { state: "waiting", motion: "none", unread };
  return { state: "unknown", motion: "none", unread };
}

export function unreadCompletions(previous: ReadonlyMap<string, SessionIndicator["state"]>, sessions: ReadonlyArray<SessionState & { id: string }>, readableId: string | undefined): string[] {
  return sessions.filter(session => session.id !== readableId && ["running", "approval", "input"].includes(previous.get(session.id) ?? "") && sessionIndicator(session).state === "completed").map(session => session.id);
}
