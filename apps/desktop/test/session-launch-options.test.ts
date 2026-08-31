import { describe, expect, it } from "vitest";
import type { DesktopSnapshot, JsonObject } from "../src/shared/types";
import {
  defaultSessionLaunchAccountId,
  isSessionLaunchWorkspace,
  sessionLaunchAccounts,
  sessionLaunchWorkspaces,
} from "../src/shared/session-launch-options";

function snapshot(worktreeAssets: JsonObject[]): DesktopSnapshot {
  return {
    daemon: {
      running: true,
      managed: true,
      fullAccess: false,
      starting: false,
      startupProgress: 100,
      startupStage: "ready",
      port: 19990,
      bind: "127.0.0.1",
      state: "running",
      persistence: { pty: true, structured: true },
      relay: {},
      sessions: [],
    },
    projects: ["/repo"],
    projectAliases: { "/repo": "Main repo" },
    pinnedProjectPaths: [],
    pinnedSessionIds: [],
    unreadSessionIds: [],
    workflowTemplates: [],
    devices: [],
    accounts: [],
    orchestration: { runs: [], tasks: [], dispatches: [], gates: [], worktreeAssets },
    logs: "",
    settings: {
      startDaemonOnLaunch: true,
      fullAccessPermission: false,
      minimizeToTray: true,
      launchAtLogin: false,
      theme: "system",
      workspaceSort: "recent",
      terminalFontFamily: "monospace",
      terminalFontSize: 13,
      daemonBind: "0.0.0.0",
    },
  };
}

describe("session launch options", () => {
  it("offers live orchestration worktrees alongside projects", () => {
    const value = snapshot([
      { path: "/repo-worktrees/feature", branch: "feature", state: "active", lastInspection: null },
      { path: "/repo-worktrees/cleaned", branch: "cleaned", state: "cleaned", lastInspection: null },
      { path: "/repo-worktrees/missing", branch: "missing", state: "active", lastInspection: { pathExists: false } },
    ]);

    expect(sessionLaunchWorkspaces(value)).toEqual([
      { path: "/repo", kind: "project", label: "Main repo", detail: "/repo" },
      { path: "/repo-worktrees/feature", kind: "worktree", label: "feature", detail: "/repo-worktrees/feature" },
    ]);
    expect(isSessionLaunchWorkspace(value, "/repo-worktrees/feature/")).toBe(true);
    expect(isSessionLaunchWorkspace(value, "/repo-worktrees/cleaned")).toBe(false);
  });

  it("selects the configured account for the chosen code agent", () => {
    const accounts = [
      { id: "native-codex", agent: "codex", name: "Local", isDefault: false, status: "signed_in" },
      { id: "work-codex", agent: "codex", name: "Work", isDefault: true, status: "signed_in", apiProfile: { baseUrl: "https://example.com", model: "custom" } },
      { id: "native-claude", agent: "claude", name: "Claude", isDefault: true, status: "signed_in" },
    ];

    expect(sessionLaunchAccounts(accounts, "codex").map((account) => account.id)).toEqual([
      "native-codex",
      "work-codex",
    ]);
    expect(defaultSessionLaunchAccountId(accounts, "codex")).toBe("work-codex");
    expect(defaultSessionLaunchAccountId(accounts, "claude")).toBe("native-claude");
    expect(defaultSessionLaunchAccountId(accounts, "shell")).toBeUndefined();
  });
});
