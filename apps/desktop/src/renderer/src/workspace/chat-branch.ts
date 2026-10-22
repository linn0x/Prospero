import type { SessionInfo } from "../../../shared/types";

export function chatBranchDisabledReason(session: SessionInfo): "agent" | "kind" | "turn" | "workspace" | undefined {
  if (!["codex", "claude"].includes(session.agent)) return "agent";
  if (!["pty", "structured"].includes(session.kind)) return "kind";
  if (!session.cwd) return "workspace";
  // A PTY's "running" status describes its lifetime, not an active model turn.
  // The native picker selects and forks history in a separate terminal.
  if (session.kind === "structured" && !["idle", "done", "completed"].includes(session.status)) return "turn";
  return undefined;
}
