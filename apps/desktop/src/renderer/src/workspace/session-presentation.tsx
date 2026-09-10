import type { SessionInfo } from "../../../shared/types";
import { AgentLogo } from "../AgentLogo";
import { cn } from "../lib/utils";
import { useLocale } from "../locale";
import { sessionIndicator } from "./session-status";

export function sessionLabel(session: SessionInfo): string {
  return session.displayTitle || session.title || session.preview || session.agent;
}

export function StatusMark({ status, unread = false, pendingPermissions, pendingQuestions }: { status: string; unread?: boolean; pendingPermissions?: number | undefined; pendingQuestions?: number | undefined }) {
  const { t } = useLocale();
  const indicator = sessionIndicator({ status, ...(pendingPermissions !== undefined ? { pendingPermissions } : {}), ...(pendingQuestions !== undefined ? { pendingQuestions } : {}) }, unread);
  const labels = { completed: t("已完成", "Completed"), terminated: t("已终止", "Stopped"), running: t("运行中", "Running"), approval: t("需要授权", "Needs approval"), input: t("需要输入", "Needs input"), waiting: t("等待中", "Waiting"), unknown: t("状态未知", "Unknown status") };
  const label = labels[indicator.state] + (unread ? t("，未读", ", unread") : "");
  return <span className="status-mark" data-state={indicator.state} data-motion={indicator.motion} data-unread={unread || undefined} role="img" aria-label={label} title={label} />;
}

export function SessionAgentIcon({ agent, unread = false }: { agent: string; unread?: boolean }) {
  return <span className={cn("session-agent-icon", unread && "is-unread")} aria-hidden="true"><AgentLogo agent={agent} size={15} decorative /></span>;
}
