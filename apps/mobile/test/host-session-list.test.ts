import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@prospero/protocol";
import { groupSessionsByProject } from "../src/lib/session-projects";
import { flattenHostSessionProjects } from "../src/lib/host-session-list";
const session = (id: string, cwd = "/project"): SessionInfo => ({ id, cwd, agent: "codex", kind: "structured", title: id, status: "idle", createdAt: 1, cols: 80, rows: 24 });

describe("host session list rows", () => {
  it("exposes 41 sessions in one project as independent render-window items", () => {
    const sessions = Array.from({ length: 41 }, (_, index) => session(String(index)));
    const rows = flattenHostSessionProjects(groupSessionsByProject(sessions), new Set());
    expect(rows).toHaveLength(42);
    expect(rows.slice(0, 6).filter(row => row.kind === "session")).toHaveLength(5);
    expect(rows.slice(1).map(row => row.kind === "session" && row.session)).toEqual(sessions);
    expect(rows.at(-1)).toMatchObject({ kind: "session", lastInProject: true });
    expect(rows[1]).toMatchObject({ kind: "session", lastInProject: false });
  });
  it("preserves project order and only removes the collapsed project's child rows", () => {
    const projects = groupSessionsByProject([session("a", "/a"), session("b", "/b"), session("c", "/a")]);
    const rows = flattenHostSessionProjects(projects, new Set(["/a"]));
    expect(rows.map(row => row.key)).toEqual(["project:/a", "project:/b", "session:b"]);
    expect(rows[0]).toMatchObject({ collapsed: true, project: projects[0] });
  });
  it("keeps original session identity and stable keys through collapse and state updates", () => {
    const coordinator = session("coordinator");
    const projects = groupSessionsByProject([coordinator]);
    const before = flattenHostSessionProjects(projects, new Set());
    const reopened = flattenHostSessionProjects(projects, new Set());
    expect(reopened.map(row => row.key)).toEqual(before.map(row => row.key));
    expect(reopened[1]?.kind === "session" && reopened[1].session).toBe(coordinator);
    const updated = flattenHostSessionProjects(groupSessionsByProject([{ ...coordinator, status: "running" }]), new Set());
    expect(updated.map(row => row.key)).toEqual(before.map(row => row.key));
  });
  it("handles an empty filtered list without inventing session rows", () => {
    expect(flattenHostSessionProjects([], new Set())).toEqual([]);
  });
});
