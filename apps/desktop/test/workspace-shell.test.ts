import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import { shellIsLive, workspaceShell } from "../src/renderer/src/workspace/shell-session";

function shell(cwd: string, id = "shell-1"): SessionInfo {
  return { id, cwd, agent: "shell", kind: "pty", status: "running", title: "Shell" };
}

describe("workspace terminal", () => {
  it("creates one real shell with the exact cwd for overlapping requests", async () => {
    let resolve!: (session: SessionInfo) => void;
    const api = { createSession: vi.fn(() => new Promise<SessionInfo>((done) => { resolve = done; })), listSessions: vi.fn() };
    const first = workspaceShell(api, "/repo with spaces", []);
    expect(workspaceShell(api, "/repo with spaces", [])).toBe(first);
    expect(api.createSession).toHaveBeenCalledExactlyOnceWith({ cwd: "/repo with spaces", agent: "shell", kind: "pty", approvalPolicy: "standard" });
    resolve(shell("/repo with spaces"));
    await first;
    expect(await workspaceShell(api, "/repo with spaces", [shell("/repo with spaces")])).toMatchObject({ id: "shell-1" });
    expect(api.createSession).toHaveBeenCalledTimes(1);
  });

  it("allows retry after failed creation", async () => {
    const api = { createSession: vi.fn().mockRejectedValueOnce(new Error("daemon offline")).mockResolvedValueOnce(shell("/retry")), listSessions: vi.fn() };
    await expect(workspaceShell(api, "/retry", [])).rejects.toThrow("daemon offline");
    await expect(workspaceShell(api, "/retry", [])).resolves.toMatchObject({ cwd: "/retry" });
    expect(api.createSession).toHaveBeenCalledTimes(2);
  });

  it("rebuilds an ended dock shell without attaching to an unrelated primary terminal", async () => {
    const api = { createSession: vi.fn().mockResolvedValueOnce(shell("/ended", "old")).mockResolvedValueOnce(shell("/ended", "new")), listSessions: vi.fn().mockResolvedValue({ items: [{ ...shell("/ended", "old"), status: "done" }] }) };
    await workspaceShell(api, "/ended", [shell("/ended", "primary")]);
    expect((await workspaceShell(api, "/ended", [])).id).toBe("new");
    expect(api.createSession).toHaveBeenCalledTimes(2);
    expect(shellIsLive({ ...shell("/ended"), status: "completed" })).toBe(false);
  });
});
