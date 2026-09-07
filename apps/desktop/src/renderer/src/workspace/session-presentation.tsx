import type { SessionInfo } from "../../../shared/types";
import { AgentLogo } from "../AgentLogo";
import { cn } from "../lib/utils";

export function sessionLabel(session: SessionInfo): string {
  return session.displayTitle || session.title || session.preview || session.agent;
}

export function StatusMark({ status }: { status: string }) {
  return <span className={cn("status-mark", `is-${status}`)} aria-hidden="true" />;
}

export function SessionAgentIcon({ agent, unread = false }: { agent: string; unread?: boolean }) {
  return <span className={cn("session-agent-icon", unread && "is-unread")} aria-hidden="true"><AgentLogo agent={agent} size={15} decorative /></span>;
}
