import type { SessionInfo } from "../../shared/types";

export const EXPANDED_PROJECTS_STORAGE_KEY =
  "prospero.workspace.expandedProjects";
export const SIDEBAR_SESSION_PREVIEW_LIMIT = 6;
export const SIDEBAR_SESSION_PAGE_SIZE = 24;
export const SIDEBAR_COLLAPSE_WIDTH = 1_080;
export const SIDEBAR_EXPAND_WIDTH = 1_320;

export function sessionRestoreRetryDelay(attempt: number): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= 5) return undefined;
  return 500 * 2 ** attempt;
}

type DesktopShortcutEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "ctrlKey"
  | "defaultPrevented"
  | "key"
  | "metaKey"
  | "repeat"
  | "shiftKey"
  | "target"
>;

export function matchesDesktopShortcut(
  event: DesktopShortcutEvent,
  key: string,
  platform: string,
  macShift = false,
): boolean {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.altKey ||
    event.key.toLocaleLowerCase() !== key.toLocaleLowerCase()
  )
    return false;
  const target = event.target as
    | (EventTarget & { closest?: (selector: string) => Element | null })
    | null;
  if (
    target?.closest?.(
      ".xterm,input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='dialog']",
    )
  )
    return false;
  if (
    typeof document !== "undefined" &&
    document.querySelector("[role='dialog']")
  )
    return false;
  return platform === "darwin"
    ? event.metaKey && !event.ctrlKey && event.shiftKey === macShift
    : event.ctrlKey && !event.metaKey && event.shiftKey;
}

export function adaptiveSidebarOpen(width: number, current: boolean): boolean {
  if (!Number.isFinite(width)) return current;
  if (width <= SIDEBAR_COLLAPSE_WIDTH) return false;
  if (width >= SIDEBAR_EXPAND_WIDTH) return true;
  return current;
}

/**
 * The sidebar, quick open, and command center must agree on what a session
 * search means. Keeping the searchable fields here prevents one surface from
 * finding a session which another surface appears to have "lost".
 */
export function sessionSearchText(session: SessionInfo): string {
  return [
    session.displayTitle,
    session.title,
    session.preview,
    session.agent,
    session.status,
    session.cwd,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
}

export function filterSessionsByQuery(
  sessions: SessionInfo[],
  query: string,
  limit = Number.POSITIVE_INFINITY,
): SessionInfo[] {
  const normalized = query.trim().toLocaleLowerCase();
  const matches = normalized
    ? sessions.filter((session) => sessionSearchText(session).includes(normalized))
    : sessions;
  return matches.slice(0, Math.max(0, limit));
}

export function nextSidebarSessionLimit(
  currentLimit: number,
  total: number,
): number {
  if (total <= SIDEBAR_SESSION_PREVIEW_LIMIT)
    return total;
  if (currentLimit >= total) return SIDEBAR_SESSION_PREVIEW_LIMIT;
  return Math.min(
    total,
    Math.max(SIDEBAR_SESSION_PREVIEW_LIMIT, currentLimit) +
      SIDEBAR_SESSION_PAGE_SIZE,
  );
}

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

export function sortProjectsByRecentActivity(
  projects: string[],
  sessions: SessionInfo[],
): string[] {
  const originalIndex = new Map(
    projects.map((project, index) => [project, index]),
  );
  const latest = new Map(projects.map((project) => [project, 0]));
  for (const session of sessions) {
    const project = projectForSession(projects, session);
    if (!project) continue;
    latest.set(project, Math.max(latest.get(project) ?? 0, session.createdAt ?? 0));
  }
  return [...projects].sort(
    (left, right) =>
      (latest.get(right) ?? 0) - (latest.get(left) ?? 0) ||
      (originalIndex.get(left) ?? 0) - (originalIndex.get(right) ?? 0),
  );
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
