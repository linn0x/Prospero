import type { SessionInfo } from "../../shared/types";

export const EXPANDED_PROJECTS_STORAGE_KEY =
  "prospero.workspace.expandedProjects";
export const SIDEBAR_SESSION_PREVIEW_LIMIT = 6;

export function projectForSession(
  projects: string[],
  session: SessionInfo,
): string | undefined {
  const cwd = session.cwd.toLocaleLowerCase();
  let match: string | undefined;
  for (const project of projects) {
    const normalized = project.toLocaleLowerCase();
    if (
      (cwd === normalized ||
        cwd.startsWith(`${normalized}\\`) ||
        cwd.startsWith(`${normalized}/`)) &&
      (!match || project.length > match.length)
    )
      match = project;
  }
  return match;
}

export function mostRelevantProject(
  projects: string[],
  sessions: SessionInfo[],
  pinnedProjectPaths: string[],
  activeId?: string,
): string | undefined {
  const activeSession = activeId
    ? sessions.find((session) => session.id === activeId)
    : undefined;
  const activeProject = activeSession
    ? projectForSession(projects, activeSession)
    : undefined;
  if (activeProject) return activeProject;

  const canonicalProjects = new Map(
    projects.map((project) => [project.toLocaleLowerCase(), project]),
  );
  for (const pinnedPath of pinnedProjectPaths) {
    const project = canonicalProjects.get(pinnedPath.toLocaleLowerCase());
    if (project) return project;
  }

  let recentProject: string | undefined;
  let recentActivity = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    const project = projectForSession(projects, session);
    const createdAt = session.createdAt ?? 0;
    if (project && createdAt > recentActivity) {
      recentProject = project;
      recentActivity = createdAt;
    }
  }
  return recentProject ?? projects[0];
}

/**
 * Returns undefined when no usable preference exists so callers can select a
 * sensible default. An explicitly stored empty array means "keep all folded".
 */
export function parseExpandedProjects(
  serialized: string | null,
  projects: string[],
): string[] | undefined {
  if (serialized === null) return undefined;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    if (parsed.length === 0) return [];
    const canonicalProjects = new Map(
      projects.map((project) => [project.toLocaleLowerCase(), project]),
    );
    const available = [
      ...new Set(
        parsed
          .filter((value): value is string => typeof value === "string")
          .map((project) =>
            canonicalProjects.get(project.toLocaleLowerCase()),
          )
          .filter((project): project is string => Boolean(project)),
      ),
    ];
    return available.length > 0 ? available : undefined;
  } catch {
    return undefined;
  }
}

const activeStatuses = new Set([
  "running",
  "starting",
  "waiting_approval",
  "waiting_input",
]);

function sessionPriority(
  session: SessionInfo,
  activeId: string | undefined,
  pinnedSessionIds: Set<string>,
  unreadSessionIds: Set<string>,
): number {
  if (session.id === activeId) return 5;
  if (
    (session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0) > 0 ||
    session.status === "waiting_approval" ||
    session.status === "waiting_input"
  )
    return 4;
  if (unreadSessionIds.has(session.id)) return 3;
  if (activeStatuses.has(session.status)) return 2;
  if (pinnedSessionIds.has(session.id)) return 1;
  return 0;
}

export function sortSidebarSessions(
  sessions: SessionInfo[],
  activeId: string | undefined,
  pinnedSessionIds: string[],
  unreadSessionIds: string[],
): SessionInfo[] {
  const pinned = new Set(pinnedSessionIds);
  const unread = new Set(unreadSessionIds);
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const priorityDifference =
        sessionPriority(right.session, activeId, pinned, unread) -
        sessionPriority(left.session, activeId, pinned, unread);
      return (
        priorityDifference ||
        (right.session.createdAt ?? 0) - (left.session.createdAt ?? 0) ||
        left.index - right.index
      );
    })
    .map(({ session }) => session);
}
