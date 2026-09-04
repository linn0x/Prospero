import { describe, expect, it } from "vitest";
import {
  LEGACY_DESKTOP_RESULT_LIMIT,
  LEGACY_DESKTOP_SPEC_LIMIT,
  createLegacyDesktopProjection,
  legacyProjectionNeedsRefresh,
  legacyProjectionSourceMtime,
} from "../src/main/orchestration-projection";

describe("legacy desktop orchestration projection", () => {
  it("refreshes only when a source exists and the projection is missing or older", () => {
    expect(legacyProjectionNeedsRefresh(undefined, undefined)).toBe(false);
    expect(legacyProjectionNeedsRefresh(10n, undefined)).toBe(true);
    expect(legacyProjectionNeedsRefresh(10n, 9n)).toBe(true);
    expect(legacyProjectionNeedsRefresh(10n, 10n)).toBe(false);
    expect(legacyProjectionNeedsRefresh(10n, 11n)).toBe(false);
    expect(legacyProjectionNeedsRefresh(10n, 20n, 9n)).toBe(true);
    expect(legacyProjectionNeedsRefresh(10n, 9n, 10n)).toBe(false);
    expect(legacyProjectionNeedsRefresh(10n, 20n, 11n)).toBe(true);
    expect(legacyProjectionSourceMtime('{"version":1,"sourceMtimeNs":"123","revision":4}')).toBe(123n);
    expect(legacyProjectionSourceMtime('{"version":1}')).toBeUndefined();
  });

  it("matches the daemon projection fields and text limits", () => {
    const projection = createLegacyDesktopProjection({
      eventSeq: 42,
      runs: {
        run_1: {
          id: "run_1",
          objective: "ship",
          status: "active",
          coordinatorSessionId: null,
          graphRevision: 3,
          automation: { state: "running" },
          coordinatorPrompt: { state: "pending" },
          createdAt: 1,
          updatedAt: 2,
        },
      },
      tasks: {
        task_1: {
          id: "task_1",
          runId: "run_1",
          title: "large",
          spec: "x".repeat(1_000),
          result: "y".repeat(1_000),
          skills: ["ui"],
          deps: [],
          parentId: null,
          status: "failed",
          createdAt: 3,
          updatedAt: 4,
          secret: "omit",
        },
      },
      dispatches: {
        dispatch_1: {
          id: "dispatch_1",
          runId: "run_1",
          taskId: "task_1",
          sessionId: "session_1",
          state: "failed",
          startedAt: 5,
          settledAt: 6,
          worktreePath: "/repo/worktree",
          outcome: "omit",
        },
      },
      gates: {
        gate_1: {
          id: "gate_1",
          runId: "run_1",
          taskId: "task_1",
          question: "continue?",
          options: ["yes"],
          status: "pending",
          decision: null,
          createdAt: 7,
          resolvedAt: null,
        },
      },
      worktreeAssets: {
        asset_1: { id: "asset_1", runId: "run_1", path: "/repo/worktree" },
      },
      events: [{ body: "omit" }],
    }, 123n);
    const task = (projection["tasks"] as Array<Record<string, unknown>>)[0]!;
    const run = (projection["runs"] as Array<Record<string, unknown>>)[0]!;
    const dispatch = (projection["dispatches"] as Array<Record<string, unknown>>)[0]!;

    expect(projection["version"]).toBe(1);
    expect(projection["sourceMtimeNs"]).toBe("123");
    expect(projection["revision"]).toBe(42);
    expect(projection).not.toHaveProperty("events");
    expect(run).not.toHaveProperty("coordinatorPrompt");
    expect(dispatch).not.toHaveProperty("outcome");
    expect(task).not.toHaveProperty("secret");
    expect(String(task["spec"])).toHaveLength(LEGACY_DESKTOP_SPEC_LIMIT);
    expect(String(task["result"])).toHaveLength(LEGACY_DESKTOP_RESULT_LIMIT);
    expect(task["specTruncated"]).toBe(true);
    expect(task["resultTruncated"]).toBe(true);
    expect(projection["worktreeAssets"]).toEqual([
      { id: "asset_1", runId: "run_1", path: "/repo/worktree" },
    ]);
  });
});
