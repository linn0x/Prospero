import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import type { RemoteWorkspaceOpenResult } from "../src/shared/remote-workspaces";
import { RemoteWorkspaceOpenQueue, chooseRemoteShell, rememberRemoteShell, rememberedRemoteShell, remoteDirectoryKey, remoteWorkspaceShells } from "../src/renderer/src/remote-workspaces/remote-workspace-state";

const shell = (id: string, cwd: string, status = "running"): SessionInfo => ({ id, cwd, status, kind: "pty", agent: "shell", title: id, createdAt: 1, cols: 80, rows: 24 });

describe("remote workspace session selection", () => {
  it("only offers live PTYs in the selected remote directory", () => {
    const valid = shell("a", "/work/project");
    const sessions = [valid, shell("other", "/work/project-other"), shell("ended", "/work/project", "done"), { ...shell("structured", "/work/project"), kind: "structured" as const }, { ...valid, title: "Updated" }];
    expect(remoteWorkspaceShells(sessions, "/work/project/")).toEqual([{ ...valid, title: "Updated" }]);
  });

  it("normalizes remote separators while preserving case-sensitive directories and drive roots", () => {
    expect(remoteDirectoryKey("c:/Repo/")).toBe("C:\\Repo");
    expect(remoteDirectoryKey("C:\\")).toBe("C:\\");
    expect(remoteDirectoryKey("/")).toBe("/");
    expect(remoteWorkspaceShells([shell("wrong", "C:\\repo")], "C:\\Repo")).toEqual([]);
    expect(remoteWorkspaceShells([shell("wrong", "/work/Project")], "/work/project")).toEqual([]);
  });

  it("restores a known selection but never selects an unavailable remembered shell", () => {
    const sessions = [shell("a", "/work"), shell("b", "/work")];
    expect(chooseRemoteShell(sessions, "b", "a")).toBe("b");
    expect(chooseRemoteShell(sessions, "missing", "a")).toBe("a");
    expect(chooseRemoteShell([], undefined, "confirmed-created-id")).toBe("confirmed-created-id");
  });

  it("bounds versioned workspace selections and tolerates invalid storage", () => {
    let saved: string | null = null;
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    for (let index = 0; index < 100; index++) rememberRemoteShell(`w-${index}`, `s-${index}`, storage);
    expect(JSON.parse(saved!).entries).toHaveLength(64);
    expect(rememberedRemoteShell("w-99", storage)).toBe("s-99");
    expect(rememberedRemoteShell("w-0", storage)).toBeUndefined();
    saved = '{"version":2,"entries":[{"workspaceId":"w-99","sessionId":"wrong"}]}';
    expect(rememberedRemoteShell("w-99", storage)).toBeUndefined();
    saved = "invalid";
    expect(rememberedRemoteShell("w-99", storage)).toBeUndefined();
  });

  it("coalesces StrictMode or duplicate opens without mixing different workspaces", async () => {
    const queue = new RemoteWorkspaceOpenQueue();
    let finish: ((value: RemoteWorkspaceOpenResult) => void) | undefined;
    const result: RemoteWorkspaceOpenResult = { workspace: { id: "w", hostId: "host", hostName: "Remote", cwd: "/work", name: "Work", root: "home", path: "work", createdAt: 1 }, sessionId: "shell" };
    const first = vi.fn(() => new Promise<RemoteWorkspaceOpenResult>(resolve => { finish = resolve; }));
    const duplicate = vi.fn(async () => result);
    const pending = queue.run("w", first);
    expect(queue.run("w", duplicate)).toBe(pending);
    await queue.run("other", duplicate);
    expect(first).toHaveBeenCalledOnce();
    expect(duplicate).toHaveBeenCalledOnce();
    finish!(result);
    expect(await pending).toBe(result);
    await queue.run("w", duplicate);
    expect(duplicate).toHaveBeenCalledTimes(2);
  });

  it("does not retry failed creation until a new explicit request", async () => {
    const queue = new RemoteWorkspaceOpenQueue();
    const action = vi.fn(async () => { throw new Error("Uncertain creation"); });
    await expect(queue.run("w", action)).rejects.toThrow("Uncertain creation");
    await Promise.resolve();
    expect(action).toHaveBeenCalledOnce();
    await expect(queue.run("w", action)).rejects.toThrow("Uncertain creation");
    expect(action).toHaveBeenCalledTimes(2);
  });
});
