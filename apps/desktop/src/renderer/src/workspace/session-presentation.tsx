import type { SessionInfo } from "../../../shared/types";
import { AgentLogo } from "../AgentLogo";
import { cn } from "../lib/utils";
import { useLocale } from "../locale";
import { sessionIndicator } from "./session-status";

const AGENT_SHORT_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  agy: "Antigravity",
  opencode: "OpenCode",
  pi: "Pi",
  deepseek: "DeepSeek",
  shell: "Terminal",
};

export function sessionLabel(session: SessionInfo): string {
  return session.displayTitle || session.title || session.preview || session.agent;
}

export function sidebarSessionLabel(session: SessionInfo): string {
  if (session.displayTitle?.trim()) return session.displayTitle.trim();
  const workspaceName = session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const raw = (session.title || session.preview || "").trim();
  const fallbackAgent = AGENT_SHORT_LABELS[session.agent.toLowerCase()] ?? session.agent;
  if (!raw) return fallbackAgent;
  if (workspaceName) {
    const escapedWorkspace = workspaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = raw
      .replace(new RegExp(`^${escapedWorkspace}$`, "i"), "")
      .replace(new RegExp(`\\s*[·:—-]\\s*${escapedWorkspace}(\\s+副本|\\s+Copy)?$`, "i"), "$1")
      .trim();
    if (!stripped) return fallbackAgent;
    const copyMatch = stripped.match(/^([a-z0-9_-]+)(\s+副本|\s+Copy)?$/i);
    if (copyMatch && copyMatch[1]?.toLowerCase() === session.agent.toLowerCase()) {
      return `${fallbackAgent}${copyMatch[2] ?? ""}`;
    }
    const escapedAgent = session.agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const withoutAgentPrefix = stripped.replace(new RegExp(`^${escapedAgent}(?:\\s+Code)?\\s*[·:—-]\\s*`, "i"), "").trim();
    return withoutAgentPrefix || stripped;
  }
  return raw;
}

export function StatusMark({ status, unread = false, pendingPermissions, pendingQuestions, busySince }: { status: string; unread?: boolean; pendingPermissions?: number | undefined; pendingQuestions?: number | undefined; busySince?: number | undefined }) {
  const { t } = useLocale();
  const indicator = sessionIndicator({ status, ...(pendingPermissions !== undefined ? { pendingPermissions } : {}), ...(pendingQuestions !== undefined ? { pendingQuestions } : {}), ...(busySince !== undefined ? { busySince } : {}) }, unread);
  const label = sessionStatusLabel({ status, pendingPermissions, pendingQuestions, busySince }, unread, t);
  return <span className="status-mark" data-state={indicator.state} data-motion={indicator.motion} data-unread={unread || undefined} role="img" aria-label={label} title={label} />;
}

export function sessionStatusLabel(session: { status: string; pendingPermissions?: number | undefined; pendingQuestions?: number | undefined; busySince?: number | undefined }, unread: boolean, t: (zh: string, en: string) => string): string {
  const indicator = sessionIndicator({ status: session.status, ...(session.pendingPermissions !== undefined ? { pendingPermissions: session.pendingPermissions } : {}), ...(session.pendingQuestions !== undefined ? { pendingQuestions: session.pendingQuestions } : {}), ...(session.busySince !== undefined ? { busySince: session.busySince } : {}) }, unread);
  const labels = { completed: t("已完成", "Completed"), idle: t("空闲", "Idle"), terminated: t("已终止", "Stopped"), running: t("运行中", "Running"), approval: t("需要授权", "Needs approval"), input: t("需要输入", "Needs input"), waiting: t("等待中", "Waiting"), unknown: t("状态未知", "Unknown status") };
  return labels[indicator.state] + (unread ? t("，未读", ", unread") : "");
}

export function SessionAgentIcon({ agent, unread = false }: { agent: string; unread?: boolean }) {
  return <span className={cn("session-agent-icon", unread && "is-unread")} aria-hidden="true"><AgentLogo agent={agent} size={15} decorative /></span>;
}

export const PROSPERO_BOT_SESSION_STORAGE_KEY = "prospero.botSessionId";
export const PROSPERO_BOT_TITLE = "Prospero Bot";

export function isProsperoBotSession(session: SessionInfo | undefined): boolean {
  if (!session) return false;
  const title = (session.displayTitle ?? session.title ?? "").trim();
  if (title === PROSPERO_BOT_TITLE || title.startsWith(`${PROSPERO_BOT_TITLE} ·`) || title.startsWith(`${PROSPERO_BOT_TITLE} `)) {
    return true;
  }
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(PROSPERO_BOT_SESSION_STORAGE_KEY) === session.id;
  } catch {
    return false;
  }
}
