import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import {
  mostRelevantProject,
  parseExpandedProjects,
  projectForSession,
  sortSidebarSessions,
} from "../src/renderer/src/workspace-sidebar-state";

function session(
  id: string,
  cwd: string,
  createdAt: number,
  extra: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    id,
    cwd,
    createdAt,
    agent: "codex",
    kind: "structured",
    status: "done",
    title: id,
    ...extra,
  };
}

describe("workspace sidebar state", () => {
  it("matches the most specific project path", () => {
    const nested = session("nested", "/repo/packages/app", 1);

    expect(projectForSession(["/repo", "/repo/packages"], nested)).toBe(
      "/repo/packages",
    );
  });

  it("defaults to the active, pinned, then most recent project", () => {
    const projects = ["/older", "/newer", "/pinned"];
    const sessions = [
      session("old", "/older", 1),
      session("new", "/newer", 10),
      session("active", "/older", 2),
    ];

    expect(mostRelevantProject(projects, sessions, ["/pinned"], "active")).toBe(
      "/older",
    );
    expect(mostRelevantProject(projects, sessions, ["/pinned"])).toBe(
      "/pinned",
    );
    expect(mostRelevantProject(projects, sessions, [])).toBe("/newer");
  });

  it("restores only available projects while preserving an explicit fold-all", () => {
    expect(
      parseExpandedProjects('["C:/Repo","C:/Removed"]', ["c:/repo"]),
    ).toEqual(["c:/repo"]);
    expect(parseExpandedProjects("[]", ["/repo"])).toEqual([]);
    expect(parseExpandedProjects('["/removed"]', ["/repo"])).toBeUndefined();
    expect(parseExpandedProjects("not json", ["/repo"])).toBeUndefined();
  });

  it("keeps the selected and attention sessions ahead of a long recent list", () => {
    const sessions = [
      session("recent", "/repo", 100),
      session("unread", "/repo", 1),
      session("attention", "/repo", 2, { pendingQuestions: 1 }),
      session("selected", "/repo", 0),
    ];

    expect(
      sortSidebarSessions(sessions, "selected", [], ["unread"]).map(
        (item) => item.id,
      ),
    ).toEqual(["selected", "attention", "unread", "recent"]);
  });
});
