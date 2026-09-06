import { describe, expect, it } from "vitest";
import { compactWorkspacePath, partitionHomeProjects } from "../src/lib/home-dashboard";
import type { SessionProject } from "../src/lib/session-projects";

const project = (path: string): SessionProject => ({ path, name: path.split("/").at(-1) ?? path, sessions: [], runningCount: 0, pendingCount: 0 });

describe("home workspace partition", () => {
  it("uses exact managed asset paths without guessing from worker names or path prefixes", () => {
    const projects = ["/work/worker-task", "/work/repo", "/tasks/worker-task-1", "/tasks/worker-task-1-copy", "/tasks/worker-task-1/nested", "/tasks/other"].map(project);
    const result = partitionHomeProjects(projects, ["/tasks/worker-task-1", "/tasks/other"]);
    expect(result.projects).toEqual([projects[0], projects[1], projects[3], projects[4]]);
    expect(result.taskProjects).toEqual([projects[2], projects[5]]);
    expect(new Set([...result.projects, ...result.taskProjects]).size).toBe(projects.length);
    for (const value of projects) expect([...result.projects, ...result.taskProjects].filter((entry) => entry === value)).toHaveLength(1);
  });

  it("preserves original objects and paths while normalizing matching separators and Windows drive letters", () => {
    const projects = [project("/repo//task/"), project("c:\\Repo\\Task\\"), project("\\\\server\\share\\Task\\"), project("/repo/task-two")];
    const before = projects.map((entry) => entry.path);
    const result = partitionHomeProjects(projects, ["/repo/task", "C:/Repo/Task/", "//server/share/Task", "/repo/task"]);
    expect(result.taskProjects).toEqual(projects.slice(0, 3));
    expect(result.projects).toEqual([projects[3]]);
    expect(result.taskProjects[0]).toBe(projects[0]);
    expect(projects.map((entry) => entry.path)).toEqual(before);
  });

  it("does not equate case-sensitive paths, symlink parent traversal or POSIX backslash filenames", () => {
    const projects = [project("/repo/Task"), project("/repo/link/../task"), project("/repo/task\\nested")];
    expect(partitionHomeProjects(projects, ["/repo/task", "/repo/task/nested"])).toEqual({ projects, taskProjects: [] });
  });

  it("does not classify anything from absent, blank or relative asset paths", () => {
    const projects = [project("/"), project("worker-task"), project("~/task"), project("/home/alice/task")];
    expect(partitionHomeProjects(projects, [])).toEqual({ projects, taskProjects: [] });
    expect(partitionHomeProjects(projects, ["", "  ", "worker-task", "~/task"])).toEqual({ projects, taskProjects: [] });
    expect(partitionHomeProjects([], ["/work/task"])).toEqual({ projects: [], taskProjects: [] });
  });
});

describe("compact workspace labels", () => {
  it.each([
    ["/Users/alice/Documents/Prospero", "~/Documents/Prospero"],
    ["/Users/alice/.prospero/worktrees/run/task", "~/…/run/task"],
    ["/home/alice/projects/team/repo/", "~/…/team/repo"],
    ["/Users/alice", "~"],
    ["/home/alice/repo", "~/repo"],
    ["~/one/two/three", "~/…/two/three"],
    ["C:\\Users\\Alice\\Documents\\Repo", "~/Documents/Repo"],
    ["c:/Users/Alice/work/group/repo", "~/…/group/repo"],
  ])("shortens recognized home path %s to %s", (input, expected) => {
    expect(compactWorkspacePath(input)).toBe(expected);
  });

  it.each([
    ["", ""], ["   ", ""], ["/", "/"], ["////", "/"],
    ["/Users", "/Users"], ["/var/repo", "/var/repo"],
    ["/opt/company/apps/repo", "/…/apps/repo"],
    ["/Users/Shared/Projects/Repo", "/…/Projects/Repo"],
    ["/Users/alice/../bob/repo", "/…/bob/repo"],
    ["repo", "repo"], ["workspace/apps/mobile", "…/apps/mobile"],
    ["C:\\", "C:/"], ["D:\\work\\apps\\repo", "D:/…/apps/repo"],
    ["C:\\Users\\Public\\Projects\\Repo", "C:/…/Projects/Repo"],
    ["C:\\Users\\Default\\Repo", "C:/…/Default/Repo"],
    ["\\\\server\\share", "//server/share"],
    ["\\\\server\\share\\team\\apps\\repo", "//server/share/…/apps/repo"],
    ["//server/share/Users/Alice/Repo", "//server/share/…/Alice/Repo"],
    ["//server", "//server"], [".", "."], ["..", ".."],
  ])("preserves path origin for %s as %s", (input, expected) => {
    expect(compactWorkspacePath(input)).toBe(expected);
  });
});
