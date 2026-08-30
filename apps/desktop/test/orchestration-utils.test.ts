import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/shared/types";
import { prioritizeWorktrees, worktreeNeedsAttention } from "../src/renderer/src/orchestration-utils";

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
