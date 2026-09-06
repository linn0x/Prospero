import { describe, expect, it } from "vitest";
import type { OrchestrationSnapshot, SessionInfo } from "../src/shared/types";
import { groupManagedWorkspaces, managedWorkspaceActivity, managedWorkspaceParent } from "../src/renderer/src/managed-workspaces";
import { filterSessionsByQuery, projectForSession, sortSidebarSessions } from "../src/renderer/src/workspace-sidebar-state";
const snapshot = (worktreeAssets: OrchestrationSnapshot["worktreeAssets"], extra: Partial<OrchestrationSnapshot> = {}): OrchestrationSnapshot => ({ runs: [], tasks: [], dispatches: [], gates: [], worktreeAssets, ...extra });
const asset = (path: string, repo = "/repo", extra: Record<string, unknown> = {}) => ({ id: path, kind: "worker", path, repo, runId: "run", taskId: "task", state: "active", cleanup: null, ...extra });
const session = (id: string, cwd: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, cwd, title: id, agent: "codex", kind: "structured", status: "done", ...extra });

describe("authoritative task workspace grouping", () => {
  it("nests assets under their repository and preserves original paths and order", () => {
    const layout = groupManagedWorkspaces(["/other", "/repo", "/temp/b/", "/temp/a"], snapshot([asset("/temp/a"), asset("/temp/b")], { tasks: [{ id: "task", runId: "run", title: "Implement parser" }] }));
    expect(layout.projects).toEqual(["/other", "/repo"]);
    expect(layout.groups).toHaveLength(1); expect(layout.groups[0]?.project).toBe("/repo");
    expect(layout.groups[0]?.workspaces.map(value => value.path)).toEqual(["/temp/b/", "/temp/a"]);
    expect(layout.byPath.get("/temp/a")?.workspace.taskTitle).toBe("Implement parser");
  });
  it("never guesses from worker-task names or prefixes", () => {
    const projects = ["/repo", "/projects/worker-task-real-project", "/temp/task-copy", "/temp/task/nested"];
    expect(groupManagedWorkspaces(projects, snapshot([asset("/temp/task")])).projects).toEqual(projects);
  });
  it("follows an authoritative run-worktree repository chain", () => {
    const layout = groupManagedWorkspaces(["/repo", "/run", "/worker"], snapshot([asset("/run", "/repo", { kind: "run", taskId: null }), asset("/worker", "/run")]));
    expect(layout.groups).toHaveLength(1); expect(layout.groups[0]?.project).toBe("/repo");
    expect(layout.groups[0]?.workspaces.map(value => value.path)).toEqual(["/run", "/worker"]);
  });
  it("retains orphaned assets after run deletion without inventing a parent", () => {
    const layout = groupManagedWorkspaces(["/worktree"], snapshot([asset("/worktree", "/missing-project", { runDeletedAt: 1 })]));
    expect(layout.groups[0]?.project).toBeUndefined(); expect(layout.groups[0]?.repo).toBe("/missing-project");
    expect(layout.groups[0]?.workspaces[0]?.path).toBe("/worktree");
  });
  it("uses a legacy run's explicit original cwd when repo equals worktree path", () => {
    const layout = groupManagedWorkspaces(["/repo", "/legacy"], snapshot([asset("/legacy", "/legacy")], { runs: [{ id: "run", automation: { cwd: "/repo" } }] }));
    expect(layout.groups[0]?.project).toBe("/repo");
  });
  it("retains cleaned workspace ownership but does not consume incomplete or conflicting claims", () => {
    const projects = ["/repo", "/cleaned", "/missing-fields", "/conflict"];
    const layout = groupManagedWorkspaces(projects, snapshot([asset("/cleaned", "/repo", { state: "cleaned" }), { path: "/missing-fields" }, asset("/conflict", "/repo"), asset("/conflict", "/different")]));
    expect(layout.projects).toEqual(["/repo", "/missing-fields", "/conflict"]);
    expect(layout.byPath.get("/cleaned")?.workspace.cleaned).toBe(true);
    expect(layout.byPath.get("/cleaned")?.group.project).toBe("/repo");
  });
  it("truncates large task labels without splitting Unicode codepoints", () => {
    const layout = groupManagedWorkspaces(["/repo", "/worker"], snapshot([asset("/worker")], { tasks: [{ id: "task", runId: "run", title: "🧪".repeat(100_000) }] }));
    expect(layout.byPath.get("/worker")?.workspace.taskTitle).toBe("🧪".repeat(120));
  });
  it("uses explicit run cwd for a registered monorepo subproject, without matching an unrelated cwd", () => {
    const projects = ["/repo/packages/app", "/unrelated", "/worker"];
    const linked = groupManagedWorkspaces(projects, snapshot([asset("/worker")], { runs: [{ id: "run", automation: { cwd: "/repo/packages/app" } }] }));
    expect(linked.groups[0]?.project).toBe("/repo/packages/app");
    const unrelated = groupManagedWorkspaces(projects, snapshot([asset("/worker")], { runs: [{ id: "run", automation: { cwd: "/unrelated" } }] }));
    expect(unrelated.groups[0]?.project).toBeUndefined();
  });
  it("normalizes Windows paths without merging distinct POSIX paths", () => {
    const layout = groupManagedWorkspaces(["C:\\Repo", "C:\\Worktree\\", "/Case", "/case"], snapshot([asset("c:/worktree", "c:/repo"), asset("/Case", "/repo")]));
    expect(layout.byPath.get("C:\\Worktree\\")?.group.project).toBe("C:\\Repo");
    expect(layout.projects).toContain("/case"); expect(layout.byPath.has("/case")).toBe(false);
  });
  it("terminates cycles while retaining every workspace", () => {
    const layout = groupManagedWorkspaces(["/a", "/b"], snapshot([asset("/a", "/b"), asset("/b", "/a")]));
    expect(layout.groups.flatMap(group => group.workspaces).map(value => value.path).sort()).toEqual(["/a", "/b"]);
    expect(layout.groups.every(group => !group.project)).toBe(true);
  });
  it("retains a parent's preview slot for its active child and preserves session priority", () => {
    const layout = groupManagedWorkspaces(["/other", "/repo", "/worker"], snapshot([asset("/worker")]));
    const active = session("active", "/worker");
    expect(managedWorkspaceParent(layout, projectForSession(["/repo", "/worker"], active)!)).toBe("/repo");
    expect(managedWorkspaceParent(layout, "/other")).toBe("/other");
    expect(sortSidebarSessions([session("old", "/worker"), active], "active", [], [])[0]?.id).toBe("active");
  });
  it("finds search children whose parent has no matching session", () => {
    const layout = groupManagedWorkspaces(["/repo", "/worker"], snapshot([asset("/worker")]));
    const matching = filterSessionsByQuery([session("needle", "/worker")], "needle");
    expect(matching).toHaveLength(1);
    expect(layout.byPath.get(projectForSession(["/repo", "/worker"], matching[0]!)!)?.group.project).toBe("/repo");
  });
  it("counts pending interactions with a legacy status fallback", () => {
    expect(managedWorkspaceActivity([session("running", "/worker", { status: "running" }), session("pending", "/worker", { status: "waiting_approval", pendingPermissions: 2, pendingQuestions: 1 }), session("legacy", "/worker", { status: "waiting_input" }), session("done", "/worker")])).toEqual({ running: 1, pending: 4 });
  });
});
