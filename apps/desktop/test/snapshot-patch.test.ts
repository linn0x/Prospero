import { describe, expect, it } from "vitest";
import { applyDesktopSnapshotPatch, diffDesktopSnapshot, isEmptyDesktopSnapshotPatch, mergeDesktopSnapshotPatches } from "../src/shared/snapshot-patch";
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
    expect(diffDesktopSnapshot(previous, next)).toEqual({ daemon: { starting: true, state: "starting" } });
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

  it("patches only changed session IDs and preserves untouched records", () => {
    const previous = snapshot();
    const first = { id: "session-1", agent: "codex", kind: "structured", title: "first", cwd: "/one", status: "completed" };
    const second = { id: "session-2", agent: "codex", kind: "structured", title: "second", cwd: "/two", status: "running" };
    const initial = { ...previous, daemon: { ...previous.daemon, sessions: [first, second] } };
    const changedSecond = { ...second, status: "waiting_input", pendingQuestions: 1 };
    const next = { ...initial, daemon: { ...initial.daemon, sessions: [first, changedSecond] } };

    const patch = diffDesktopSnapshot(initial, next);

    expect(patch.daemon).toEqual({ sessionUpserts: [changedSecond] });
    expect(patch.daemon).not.toHaveProperty("sessions");
    const applied = applyDesktopSnapshotPatch(initial, patch);
    expect(applied.daemon.sessions).toEqual(next.daemon.sessions);
    expect(applied.daemon.sessions[0]).toBe(first);
    expect(applied.daemon.sessions[1]).toBe(changedSecond);
  });

  it("applies removals and a compact order vector without replacing all sessions", () => {
    const previous = snapshot();
    const first = { id: "session-1", agent: "codex", kind: "structured", title: "first", cwd: "/one", status: "completed" };
    const second = { id: "session-2", agent: "codex", kind: "structured", title: "second", cwd: "/two", status: "completed" };
    const third = { id: "session-3", agent: "codex", kind: "structured", title: "third", cwd: "/three", status: "running" };
    const initial = { ...previous, daemon: { ...previous.daemon, sessions: [first, second, third] } };
    const next = { ...initial, daemon: { ...initial.daemon, sessions: [third, first] } };

    const patch = diffDesktopSnapshot(initial, next);

    expect(patch.daemon).toEqual({ sessionRemovedIds: ["session-2"], sessionOrder: ["session-3", "session-1"] });
    const applied = applyDesktopSnapshotPatch(initial, patch);
    expect(applied.daemon.sessions).toEqual([third, first]);
    expect(applied.daemon.sessions[0]).toBe(third);
  });

  it("retains all session deltas received before the initial snapshot resolves", () => {
    const first = { id: "session-1", agent: "codex", kind: "structured", title: "first", cwd: "/one", status: "running" };
    const second = { id: "session-2", agent: "codex", kind: "structured", title: "second", cwd: "/two", status: "waiting_input" };
    const combined = mergeDesktopSnapshotPatches(
      { daemon: { sessionUpserts: [first] } },
      { daemon: { sessionUpserts: [second], sessionOrder: ["session-2", "session-1"] } },
    );
    const current = { ...snapshot(), daemon: { ...snapshot().daemon, sessions: [] } };

    expect(applyDesktopSnapshotPatch(current, combined).daemon.sessions).toEqual([second, first]);
  });

  it("patches orchestration entities without replacing unchanged records", () => {
    const base = snapshot();
    const run = { id: "run-1", status: "active" };
    const first = { id: "task-1", runId: "run-1", status: "pending" };
    const second = { id: "task-2", runId: "run-1", status: "pending" };
    const previous = {
      ...base,
      orchestration: { ...base.orchestration, runs: [run], tasks: [first, second] },
    };
    const changedSecond = { ...second, status: "done" };
    const next = {
      ...previous,
      orchestration: { ...previous.orchestration, tasks: [first, changedSecond] },
    };

    const patch = diffDesktopSnapshot(previous, next);

    expect(patch).toEqual({ orchestrationDelta: { tasks: { upserts: [changedSecond] } } });
    const applied = applyDesktopSnapshotPatch(previous, patch);
    expect(applied.orchestration.runs).toBe(previous.orchestration.runs);
    expect(applied.orchestration.tasks[0]).toBe(first);
    expect(applied.orchestration.tasks[1]).toBe(changedSecond);
  });

  it("merges orchestration upserts and removals received before initialization", () => {
    const combined = mergeDesktopSnapshotPatches(
      { orchestrationDelta: { tasks: { upserts: [{ id: "task-1", status: "pending" }] } } },
      {
        orchestrationDelta: {
          tasks: {
            upserts: [{ id: "task-2", status: "done" }],
            removedIds: ["task-1"],
            order: ["task-2"],
          },
        },
      },
    );
    const current = snapshot();

    expect(applyDesktopSnapshotPatch(current, combined).orchestration.tasks).toEqual([
      { id: "task-2", status: "done" },
    ]);
  });
});
