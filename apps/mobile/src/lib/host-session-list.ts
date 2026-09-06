import type { SessionInfo } from "@prospero/protocol";
import type { SessionProject } from "./session-projects";

export type HostSessionListItem =
  | { kind: "project"; key: string; project: SessionProject; collapsed: boolean }
  | { kind: "session"; key: string; session: SessionInfo; lastInProject: boolean };

/** Keep each top-level session inside FlatList's render window, even in one large project. */
export function flattenHostSessionProjects(
  projects: readonly SessionProject[],
  collapsedProjects: ReadonlySet<string>,
): HostSessionListItem[] {
  const rows: HostSessionListItem[] = [];
  for (const project of projects) {
    const collapsed = collapsedProjects.has(project.path);
    rows.push({ kind: "project", key: `project:${project.path}`, project, collapsed });
    if (collapsed) continue;
    project.sessions.forEach((session, index) => {
      rows.push({ kind: "session", key: `session:${session.id}`, session, lastInProject: index === project.sessions.length - 1 });
    });
  }
  return rows;
}
