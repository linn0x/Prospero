import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import {
  adaptiveSidebarOpen,
  filterSessionsByQuery,
  matchesDesktopShortcut,
  matchesFocusShortcut,
  mostRelevantProject,
  nextSidebarSessionLimit,
  parseExpandedProjects,
  projectForSession,
  restoredSessionIds,
  sessionRestoreRetryDelay,
  sortProjectsByRecentActivity,
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
  it("backs off historical session restoration before releasing startup", () => {
    expect(sessionRestoreRetryDelay(0)).toBe(500);
    expect(sessionRestoreRetryDelay(3)).toBe(4_000);
    expect(sessionRestoreRetryDelay(5)).toBeUndefined();
  });

  it("keeps the active session inside the bounded restore set", () => {
    const stored = Array.from({ length: 100 }, (_, index) => `session-${String(index)}`);

    const restored = restoredSessionIds(stored, "active", 100);

    expect(restored).toHaveLength(100);
    expect(restored[0]).toBe("active");
    expect(restored).not.toContain("session-99");
  });

  it("keeps global shortcuts out of shell control keys", () => {
    const event = {
      altKey: false,
      ctrlKey: true,
      defaultPrevented: false,
      key: "k",
      metaKey: false,
      repeat: false,
      shiftKey: false,
      target: null,
    };

    expect(matchesDesktopShortcut(event, "k", "win32")).toBe(false);
    expect(
      matchesDesktopShortcut({ ...event, shiftKey: true }, "k", "win32"),
    ).toBe(true);
    expect(
      matchesDesktopShortcut(
        {
          ...event,
          shiftKey: true,
          target: { closest: () => ({}) } as unknown as EventTarget,
        },
        "k",
        "win32",
      ),
    ).toBe(false);
    expect(
      matchesDesktopShortcut(
        { ...event, ctrlKey: false, metaKey: true },
        "k",
        "darwin",
      ),
    ).toBe(true);
    expect(
      matchesDesktopShortcut(
        { ...event, ctrlKey: false, key: "f", metaKey: true, shiftKey: true },
        "f",
        "darwin",
        true,
      ),
    ).toBe(true);
  });

  it("keeps focus mode available from the terminal without stealing form input", () => {
    const terminal = { closest: (selector: string) => selector.includes(".xterm") || selector.includes("textarea") ? {} : null } as unknown as EventTarget;
    const input = { closest: (selector: string) => selector.includes("input") ? {} : null } as unknown as EventTarget;
    const event = {
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: "f",
      metaKey: true,
      repeat: false,
      shiftKey: true,
      target: terminal,
    };

    expect(matchesFocusShortcut(event, "darwin")).toBe(true);
    expect(matchesFocusShortcut({ ...event, target: input }, "darwin")).toBe(false);
    expect(matchesFocusShortcut({ ...event, altKey: true, ctrlKey: true, metaKey: false, shiftKey: false }, "win32")).toBe(true);
  });

  it("uses hysteresis while no explicit sidebar preference exists", () => {
    expect(adaptiveSidebarOpen(1_080, true)).toBe(false);
    expect(adaptiveSidebarOpen(1_200, false)).toBe(false);
    expect(adaptiveSidebarOpen(1_200, true)).toBe(true);
    expect(adaptiveSidebarOpen(1_320, false)).toBe(true);
    expect(adaptiveSidebarOpen(Number.NaN, true)).toBe(true);
  });

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

  it("pages large session groups instead of mounting every session", () => {
    expect(nextSidebarSessionLimit(6, 3_671)).toBe(30);
    expect(nextSidebarSessionLimit(30, 3_671)).toBe(54);
    expect(nextSidebarSessionLimit(54, 54)).toBe(6);
    expect(nextSidebarSessionLimit(6, 4)).toBe(4);
  });

  it("uses one case-insensitive search vocabulary across session surfaces", () => {
    const sessions = [
      session("build", "/repo/packages/desktop", 10, {
        displayTitle: "Desktop build",
        agent: "claude",
        status: "waiting_input",
        preview: "Please choose an account",
      }),
      session("other", "/repo/server", 20),
    ];

    expect(filterSessionsByQuery(sessions, "ACCOUNT").map((item) => item.id)).toEqual([
      "build",
    ]);
    expect(filterSessionsByQuery(sessions, "packages", 1).map((item) => item.id)).toEqual([
      "build",
    ]);
    expect(filterSessionsByQuery(sessions, "", 1).map((item) => item.id)).toEqual([
      "build",
    ]);
  });

  it("orders recent workspaces by their latest session activity", () => {
    const projects = ["/first", "/recent", "/empty"];
    const sessions = [
      session("older", "/first", 10),
      session("newer", "/recent", 30),
      session("nested", "/first/package", 20),
    ];

    expect(sortProjectsByRecentActivity(projects, sessions)).toEqual([
      "/recent",
      "/first",
      "/empty",
    ]);
  });
});
