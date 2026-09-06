import type { HostInfo, SessionInfo } from "@prospero/protocol";

import { groupSessionsByProject, type SessionProject } from "./session-projects";
import { sortSessions } from "./store";
import { recentSessionSummary, recentSessionTime, type RecentSession } from "./recent-sessions";

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

interface WorkspacePath {
  root: string;
  parts: string[];
  absolute: boolean;
  windows: boolean;
}

/** Lexical display/matching only: never resolve .. or assume a symlink's target. */
function workspacePath(value: string): WorkspacePath {
  const input = value.trim();
  const drive = /^([A-Za-z]):[\\/]/u.exec(input);
  if (drive) return { root: `${drive[1]!.toUpperCase()}:/`, parts: input.slice(3).split(/[\\/]+/u).filter(Boolean), absolute: true, windows: true };
  if (/^(?:\\\\|\/\/)[^\\/]/u.test(input)) {
    const parts = input.slice(2).split(/[\\/]+/u).filter(Boolean);
    // Preserve the server/share identity rather than displaying a local root.
    if (parts.length >= 2) return { root: `//${parts[0]}/${parts[1]}`, parts: parts.slice(2), absolute: true, windows: true };
    return { root: "//", parts, absolute: false, windows: true };
  }
  const absolute = input.startsWith("/");
  return { root: absolute ? "/" : "", parts: input.split(/\/+/u).filter(Boolean), absolute, windows: false };
}

function joinWorkspacePath(root: string, parts: readonly string[]): string {
  return parts.length === 0 ? root : `${root}${root && !root.endsWith("/") ? "/" : ""}${parts.join("/")}`;
}

function workspacePathIdentity(value: string): string | null {
  if (!value.trim()) return null;
  const parsed = workspacePath(value);
  return parsed.absolute ? joinWorkspacePath(parsed.root, parsed.parts) : null;
}

/** A task workspace is identified only by the selected host's authoritative asset paths. */
export function partitionHomeProjects(
  projects: readonly SessionProject[],
  managedWorkspacePaths: readonly string[],
): { projects: SessionProject[]; taskProjects: SessionProject[] } {
  const managed = new Set(managedWorkspacePaths.map(workspacePathIdentity).filter((value): value is string => value !== null));
  const result: { projects: SessionProject[]; taskProjects: SessionProject[] } = { projects: [], taskProjects: [] };
  for (const project of projects) {
    const identity = workspacePathIdentity(project.path);
    (identity !== null && managed.has(identity) ? result.taskProjects : result.projects).push(project);
  }
  return result;
}

/** Display label only. Callers must keep the original path for every operation. */
export function compactWorkspacePath(value: string): string {
  const parsed = workspacePath(value);
  let root = parsed.root;
  let parts = parsed.parts;
  const knownHomeUser = parts.length >= 2 && parts[1] !== "." && !parts.includes("..");
  const standardPosixHome = root === "/" && (parts[0] === "Users" || parts[0] === "home") &&
    knownHomeUser && parts[1] !== "Shared";
  const standardWindowsHome = parsed.windows && /^[A-Z]:\/$/u.test(root) && parts[0]?.toLowerCase() === "users" &&
    knownHomeUser && !["public", "default", "default user", "all users"].includes(parts[1]!.toLowerCase());
  if (standardPosixHome || standardWindowsHome) { root = "~"; parts = parts.slice(2); }
  else if (root === "" && parts[0] === "~") { root = "~"; parts = parts.slice(1); }
  if (parts.length > 2) parts = ["…", ...parts.slice(-2)];
  return joinWorkspacePath(root, parts);
}

/** 最近打开/实际活动优先；没有使用记录的旧客户端才回退到创建时间。 */
export function homeRecentSessions(
  sessions: Record<string, SessionInfo> | undefined,
  limit: number,
  recent: Readonly<Record<string, RecentSession>> = {},
): SessionInfo[] {
  return Object.values(sessions ?? {})
    .sort((a, b) => recentSessionTime(b, recent[b.id]) - recentSessionTime(a, recent[a.id])
      || b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    .slice(0, Math.max(0, limit));
}

/** 待授权入口只收操作审批，不把普通等待输入误报为权限请求。 */
export function homeApprovalSessions(
  sessions: Record<string, SessionInfo> | undefined,
): SessionInfo[] {
  return Object.values(sessions ?? {})
    .filter((session) =>
      session.status === "waiting_approval" || (session.pendingPermissions ?? 0) > 0
    )
    .sort((left, right) =>
      (right.pendingPermissions ?? 0) - (left.pendingPermissions ?? 0)
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id)
    );
}

export function homeRecentSummary(session: SessionInfo, recent?: RecentSession): string {
  return recentSessionSummary(session.preview) || recent?.summary || "尚无内容摘要";
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
