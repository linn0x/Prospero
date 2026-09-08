import type { SessionInfo } from "@prospero/protocol";
import type { StoredHost } from "./hosts";
import type { HostRuntime } from "./store";
import type { RecentSession } from "./recent-sessions";
import { recentSessionTime } from "./recent-sessions";
import { homeApprovalSessions, homeWorkspaceProjects, partitionHomeProjects } from "./home-dashboard";
import type { SessionProject } from "./session-projects";

export interface EdgeSession {
  key: string;
  host: StoredHost;
  session: SessionInfo;
  recent?: RecentSession;
  time: number;
}

export interface EdgeProject {
  key: string;
  host: StoredHost;
  project: SessionProject;
  managed: boolean;
  time: number;
}

export const edgeItemKey = (hostId: string, itemId: string): string => JSON.stringify([hostId, itemId]);

/** External-store snapshots stay stable when only an excluded host changes. */
export function createEdgeRecentReader(
  hosts: readonly { id: string }[],
  read: (hostId: string) => Readonly<Record<string, RecentSession>>,
): () => Readonly<Record<string, RecentSession>>[] {
  let previous = hosts.map((host) => read(host.id));
  return () => {
    const next = hosts.map((host) => read(host.id));
    if (next.some((value, index) => value !== previous[index])) previous = next;
    return previous;
  };
}

/** Merge after retaining host identity: session IDs and paths are only unique on a host. */
export function buildEdgeDashboard(
  hosts: readonly StoredHost[],
  runtimes: Readonly<Record<string, HostRuntime>>,
  limit: number,
  recentForHost: (id: string) => Readonly<Record<string, RecentSession>>,
  managedPaths: Readonly<Record<string, readonly string[]>> = {},
): { recent: EdgeSession[]; approvals: EdgeSession[]; projects: EdgeProject[] } {
  const sessions: EdgeSession[] = [];
  const approvals: EdgeSession[] = [];
  const projects: EdgeProject[] = [];
  for (const host of hosts) {
    const runtime = runtimes[host.id];
    const usage = recentForHost(host.id);
    const wrap = (session: SessionInfo): EdgeSession => ({
      key: edgeItemKey(host.id, session.id), host, session, recent: usage[session.id],
      time: recentSessionTime(session, usage[session.id]),
    });
    sessions.push(...Object.values(runtime?.sessions ?? {}).map(wrap));
    approvals.push(...homeApprovalSessions(runtime?.sessions).map(wrap));
    const groups = partitionHomeProjects(homeWorkspaceProjects(runtime?.sessions), managedPaths[host.id] ?? []);
    for (const [items, managed] of [[groups.projects, false], [groups.taskProjects, true]] as const) {
      for (const project of items) {
        projects.push({
          key: edgeItemKey(host.id, project.path), host, project, managed,
          time: Math.max(...project.sessions.map((session) => recentSessionTime(session, usage[session.id]))),
        });
      }
    }
  }
  sessions.sort((a, b) => b.time - a.time || a.key.localeCompare(b.key));
  approvals.sort((a, b) => (b.session.pendingPermissions ?? 0) - (a.session.pendingPermissions ?? 0)
    || b.time - a.time || a.key.localeCompare(b.key));
  projects.sort((a, b) => b.project.pendingCount - a.project.pendingCount
    || b.project.runningCount - a.project.runningCount || b.time - a.time || a.key.localeCompare(b.key));
  return { recent: sessions.slice(0, Math.max(0, limit)), approvals, projects };
}
