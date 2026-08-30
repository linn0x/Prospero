import { describe, expect, it } from "vitest";
import { applyDesktopSnapshotPatch, diffDesktopSnapshot, isEmptyDesktopSnapshotPatch } from "../src/shared/snapshot-patch";
import type { DesktopSnapshot } from "../src/shared/types";

function snapshot(): DesktopSnapshot {
  return {
    daemon: {
      running: false,
      managed: false,
      fullAccess: false,
      starting: false,
      startupProgress: 0,
      startupStage: "",
      port: 7423,
      bind: "0.0.0.0",
      state: "stopped",
      persistence: { pty: false, structured: false },
      relay: {},
      sessions: [],
    },
    projects: [],
    projectAliases: {},
    pinnedProjectPaths: [],
    pinnedSessionIds: [],
    unreadSessionIds: [],
    workflowTemplates: [],
    devices: [],
    accounts: [],
    orchestration: { runs: [], tasks: [], dispatches: [], gates: [], worktreeAssets: [] },
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

describe("desktop snapshot patches", () => {
  it("sends a full initial payload and only changed top-level slices afterward", () => {
    const previous = snapshot();
    const next = { ...previous, daemon: { ...previous.daemon, starting: true, state: "starting" } };

    expect(diffDesktopSnapshot(undefined, previous)).toBe(previous);
    expect(diffDesktopSnapshot(previous, next)).toEqual({ daemon: next.daemon });
  });

  it("merges a patch without replacing unchanged slice identities", () => {
    const previous = snapshot();
    const daemon = { ...previous.daemon, running: true, state: "running" };
    const merged = applyDesktopSnapshotPatch(previous, { daemon });

    expect(merged.daemon).toBe(daemon);
    expect(merged.orchestration).toBe(previous.orchestration);
    expect(merged.settings).toBe(previous.settings);
    expect(isEmptyDesktopSnapshotPatch(diffDesktopSnapshot(merged, merged))).toBe(true);
  });
});
