import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/shared/types";
import { deriveTaskBoardStates, prioritizeWorktrees, worktreeNeedsAttention } from "../src/renderer/src/orchestration-utils";

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
