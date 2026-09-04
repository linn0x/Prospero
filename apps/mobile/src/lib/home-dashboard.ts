import type { HostInfo, SessionInfo } from "@prospero/protocol";

import { groupSessionsByProject, type SessionProject } from "./session-projects";
import { sortSessions } from "./store";

/** 地址簿刷新时保持用户选择；只有设备确实消失时才回退到第一台。 */
export function resolveHomeHostSelection(
  hosts: readonly { id: string }[],
  currentHostId: string | null,
): string | null {
  if (currentHostId && hosts.some((host) => host.id === currentHostId)) {
    return currentHostId;
  }
  return hosts[0]?.id ?? null;
}

/** 首页沿用主机页的会话优先级，并把同一 cwd 聚合成一个工作目录。 */
export function homeWorkspaceProjects(
  sessions: Record<string, SessionInfo> | undefined,
): SessionProject[] {
  return groupSessionsByProject(sortSessions(sessions ?? {}));
}

/** 最近会话严格按创建时间排列，不让运行优先级改变“最近”的含义。 */
export function homeRecentSessions(
  sessions: Record<string, SessionInfo> | undefined,
  limit: number,
): SessionInfo[] {
  return Object.values(sessions ?? {})
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    .slice(0, Math.max(0, limit));
}

const LIVE_SESSION_STATUSES = new Set<SessionInfo["status"]>([
  "starting",
  "running",
  "waiting_approval",
  "waiting_input",
  "idle",
]);

const LIVE_SUBAGENT_STATUSES = new Set([
  "starting",
  "running",
  "waiting_input",
  "idle",
]);

export interface HomeHostStats {
  sessionCount: number;
  activeAgentCount: number;
  runningCount: number;
}

/** 首页卡片只统计仍可交互的主 Agent / 子 Agent，已结束任务不冒充当前负载。 */
export function homeHostStats(
  sessions: Record<string, SessionInfo> | undefined,
): HomeHostStats {
  const values = Object.values(sessions ?? {});
  let activeAgentCount = 0;
  let runningCount = 0;

  for (const session of values) {
    if (LIVE_SESSION_STATUSES.has(session.status)) activeAgentCount += 1;
    if (
      session.status === "starting" ||
      session.status === "running" ||
      session.status === "waiting_approval" ||
      session.status === "waiting_input"
    ) {
      runningCount += 1;
    }
    activeAgentCount += (session.subagents ?? []).filter((agent) =>
      LIVE_SUBAGENT_STATUSES.has(agent.status),
    ).length;
  }

  return { sessionCount: values.length, activeAgentCount, runningCount };
}

export function homeHostOsLabel(info: HostInfo | null | undefined): string {
  if (!info?.platform) return "连接后读取系统信息";
  return [info.platform, info.osVersion, info.arch].filter(Boolean).join(" · ");
}
