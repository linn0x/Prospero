import { describe, expect, it } from "vitest";
import type { DesktopSnapshot, DesktopSnapshotPatch } from "../src/shared/types";
import {
  desktopSnapshotFromPatch,
  shortPath,
} from "../src/renderer/src/state";

function snapshot(): DesktopSnapshot {
  return {
    daemon: {
      running: true,
      managed: true,
      fullAccess: false,
      starting: false,
      startupProgress: 1,
      startupStage: "ready",
      port: 4173,
      bind: "127.0.0.1",
      state: "running",
      persistence: { pty: true, structured: true },
      relay: {},
      sessions: [],
    },
    projects: [],
    projectAliases: {},
    pinnedProjectPaths: [],
    pinnedSessionIds: [],
    archivedSessionIds: [],
    unreadSessionIds: [],
    workflowTemplates: [],
    devices: [],
    accounts: [],
    orchestration: {
      runs: [],
      tasks: [],
      dispatches: [],
      gates: [],
      worktreeAssets: [],
    },
    logs: "",
    settings: {
      startDaemonOnLaunch: true,
      fullAccessPermission: false,
      minimizeToTray: false,
      launchAtLogin: false,
      theme: "system",
      workspaceSort: "recent",
      terminalFontFamily: "monospace",
      terminalFontSize: 13,
      daemonBind: "127.0.0.1",
    },
  };
}

describe("renderer snapshot state", () => {
  it("accepts a full first patch as the initial snapshot", () => {
    const initial = snapshot();
    const incomplete: DesktopSnapshotPatch = { ...initial };
    delete incomplete.settings;
    expect(desktopSnapshotFromPatch(initial)).toBe(initial);
    expect(
      desktopSnapshotFromPatch({ daemon: { running: false } }),
    ).toBeUndefined();
    expect(
      desktopSnapshotFromPatch(incomplete),
    ).toBeUndefined();
  });

  it("preserves the source path separator", () => {
    expect(shortPath("/Users/name/project")).toBe("name/project");
    expect(shortPath("C:\\code\\project")).toBe("code\\project");
  });
});
