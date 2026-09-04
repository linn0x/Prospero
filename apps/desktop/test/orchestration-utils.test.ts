import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/shared/types";
import { deriveTaskBoardStates, prioritizeRuns, prioritizeWorktrees, runListLabel, runTimelineItems, worktreeNeedsAttention } from "../src/renderer/src/orchestration-utils";

function asset(id: string, state: string, inspectionState?: string, updatedAt = 0): JsonObject {
  return {
    id,
    state,
    updatedAt,
    ...(inspectionState ? { lastInspection: { state: inspectionState } } : {}),
  };
}

describe("orchestration worktree presentation", () => {
  it("keeps terminal worktrees out of the attention preview", () => {
    expect(worktreeNeedsAttention(asset("missing", "missing"))).toBe(false);
    expect(worktreeNeedsAttention(asset("cleaned", "cleaned"))).toBe(false);
    expect(worktreeNeedsAttention(asset("active", "active"))).toBe(true);
  });

  it("orders conflicts before active worktrees and archived history", () => {
    const ordered = prioritizeWorktrees([
      asset("missing", "missing", "missing", 30),
      asset("active", "active", undefined, 10),
      asset("conflict", "active", "unmerged", 5),
      asset("cleaned", "cleaned", "equivalent", 40),
    ]);

    expect(ordered.map((entry) => entry["id"])).toEqual([
      "conflict",
      "active",
      "cleaned",
      "missing",
    ]);
  });
});

describe("orchestration timeline presentation", () => {
  it("merges tasks and gates into a stable newest-first timeline", () => {
    const items = runTimelineItems(
      [
        { id: "task-old", createdAt: 100, updatedAt: 200 },
        { id: "task-new", createdAt: 500 },
      ],
      [
        { id: "gate-resolved", createdAt: 150, resolvedAt: 600 },
        { id: "gate-middle", createdAt: 300 },
      ],
    );

    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "gate:gate-resolved",
      "task:task-new",
      "gate:gate-middle",
      "task:task-old",
    ]);
  });

  it("uses the meaningful service name for repeated crawler run prefixes", () => {
    expect(runListLabel("Crawler POC batch x: supervise PSM gs.pop.product_growth_api with 3 APIs")).toBe("gs.pop.product_growth_api");
    expect(runListLabel("Ship the desktop experience")).toBe("Ship the desktop experience");
  });

  it("puts active and recently updated runs first", () => {
    expect(prioritizeRuns([
      { id: "old-active", status: "active", updatedAt: 10 },
      { id: "new-complete", status: "completed", updatedAt: 100 },
      { id: "new-active", status: "active", updatedAt: 20 },
    ]).map((run) => run["id"])).toEqual(["new-active", "old-active", "new-complete"]);
  });
});

describe("orchestration task board presentation", () => {
  it("derives ready only after every dependency is done", () => {
    const states = deriveTaskBoardStates([
      { id: "done", status: "done", deps: [] },
      { id: "ready", status: "pending", deps: ["done"] },
      { id: "queued", status: "pending", deps: ["ready"] },
      { id: "missing", status: "pending", deps: ["unknown"] },
    ]);

    expect(Object.fromEntries(states)).toEqual({
      done: "done",
      ready: "ready",
      queued: "queued",
      missing: "queued",
    });
  });

  it("keeps blocked tasks in review instead of making them launchable", () => {
    const states = deriveTaskBoardStates([
      { id: "blocked", status: "blocked", deps: [] },
      { id: "failed", status: "failed", deps: [] },
    ]);

    expect(states.get("blocked")).toBe("review");
    expect(states.get("failed")).toBe("review");
  });
});
