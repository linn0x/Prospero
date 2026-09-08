import type { SessionInfo } from "@prospero/protocol";

export interface SessionProject {
  /** 规范化后的 cwd；同一个目录就是同一个项目。 */
  path: string;
  name: string;
  sessions: SessionInfo[];
  runningCount: number;
  pendingCount: number;
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]/u.test(path);
}

/** Trim directory separators without treating a POSIX filename's backslash as a separator. */
export function normalizeProjectPath(cwd: string): string {
  const trimmed = cwd.trim();
  if (trimmed === "" || /^\/+$/u.test(trimmed)) return "/";
  if (isWindowsPath(trimmed)) {
    if (/^[A-Za-z]:[\\/]+$/u.test(trimmed)) return trimmed.slice(0, 3);
    return trimmed.replace(/[\\/]+$/u, "");
  }
  return trimmed.replace(/\/+$/u, "");
}

export function projectName(path: string): string {
  const normalized = normalizeProjectPath(path);
  if (normalized === "/" || /^[A-Za-z]:[\\/]$/u.test(normalized)) return normalized;
  const parts = normalized.split(isWindowsPath(normalized) ? /[\\/]/u : /\//u).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

/**
 * 输入沿用会话优先级排序；项目按第一条重要会话出现的次序排列，项目内也保持该顺序。
 */
export function groupSessionsByProject(sessions: SessionInfo[]): SessionProject[] {
  const groups = new Map<string, SessionProject>();
  for (const session of sessions) {
    const path = normalizeProjectPath(session.cwd);
    let project = groups.get(path);
    if (!project) {
      project = {
        path,
        name: projectName(path),
        sessions: [],
        runningCount: 0,
        pendingCount: 0,
      };
      groups.set(path, project);
    }
    project.sessions.push(session);
    if (
      session.status === "running" ||
      session.status === "starting" ||
      session.status === "waiting_approval" ||
      session.status === "waiting_input"
    ) {
      project.runningCount += 1;
    }
    project.pendingCount +=
      (session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0);
  }
  return [...groups.values()];
}
