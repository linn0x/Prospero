import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@prospero/protocol";
import {
  groupSessionsByProject,
  normalizeProjectPath,
  projectName,
} from "../src/lib/session-projects";

function session(id: string, cwd: string, status: SessionInfo["status"] = "idle"): SessionInfo {
  return {
    id,
    agent: "codex",
    kind: "structured",
    title: id,
    cwd,
    status,
    createdAt: 1,
    cols: 80,
    rows: 24,
  };
}

describe("session projects", () => {
  it("把尾部斜杠不同的同一目录归为一个项目", () => {
    const groups = groupSessionsByProject([
      session("a", "/Users/me/repo"),
      session("b", "/Users/me/repo/", "running"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.path).toBe("/Users/me/repo");
    expect(groups[0]?.name).toBe("repo");
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(["a", "b"]);
    expect(groups[0]?.runningCount).toBe(1);
  });

  it("不同目录保持为不同项目并保留输入顺序", () => {
    const groups = groupSessionsByProject([
      session("urgent", "/work/b", "waiting_approval"),
      session("new", "/work/a"),
      session("old", "/work/b"),
    ]);
    expect(groups.map((group) => group.path)).toEqual(["/work/b", "/work/a"]);
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(["urgent", "old"]);
  });

  it("根目录与项目名有稳定展示", () => {
    expect(normalizeProjectPath("////")).toBe("/");
    expect(projectName("/Users/me/Prospero/")).toBe("Prospero");
    expect(projectName("/")).toBe("/");
  });

  it("uses only the directory name on Windows without changing POSIX backslash filenames", () => {
    expect(projectName("D:\\projects\\Prospero\\")).toBe("Prospero");
    expect(projectName("C:/Users/power/Projects/Prospero/")).toBe("Prospero");
    expect(projectName("\\\\server\\share\\Prospero\\")).toBe("Prospero");
    expect(projectName("C:\\")).toBe("C:\\");
    expect(projectName("/Users/alice/Projects/Prospero/")).toBe("Prospero");
    expect(projectName("/Users/alice/name\\with\\backslash")).toBe("name\\with\\backslash");
    expect(projectName("/Users/alice/name\\")).toBe("name\\");
    const groups = groupSessionsByProject([session("a", "D:\\work\\repo"), session("b", "D:\\work\\repo\\")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.path).toBe("D:\\work\\repo");
    expect(groups[0]!.name).toBe("repo");
  });
});
