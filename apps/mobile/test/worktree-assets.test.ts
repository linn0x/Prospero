import { describe, expect, it } from "vitest";
import type { OrchestrationWorktreeAsset } from "@prospero/protocol";
import {
  worktreeAssetPresentation,
  worktreeCanClean,
  worktreeInspectionSummary,
} from "../src/lib/worktree-assets";

function asset(state: OrchestrationWorktreeAsset["state"]): OrchestrationWorktreeAsset {
  return {
    id: "wt-1",
    kind: "worker",
    runId: "run-1",
    taskId: "task-1",
    dispatchId: "dispatch-1",
    repo: "/repo",
    path: "/worktree",
    branch: "feature/worktree",
    state,
    createdAt: 1,
    updatedAt: 1,
    runDeletedAt: null,
    lastInspection: null,
    cleanup: null,
    legacy: false,
    lastError: null,
  };
}

describe("worktree asset presentation", () => {
  it("uses the daemon inspection for its visible safety status", () => {
    const checked = asset("active");
    checked.lastInspection = {
      state: "equivalent",
      targetRef: "main",
      checkedAt: 2,
      pathExists: true,
      registered: true,
      dirty: false,
      branch: "feature/worktree",
      aheadCommitCount: 0,
      equivalentCommitCount: 3,
      message: "已合并",
    };

    expect(worktreeAssetPresentation(checked).label).toBe("已合并");
    expect(worktreeCanClean(checked)).toBe(true);
    expect(worktreeInspectionSummary(checked)).toContain("等价提交：3");
  });

  it("never offers cleanup before a safe server inspection", () => {
    expect(worktreeCanClean(asset("safe_to_clean"))).toBe(false);
    expect(worktreeAssetPresentation(asset("dirty"))).toMatchObject({ label: "有未提交改动" });
  });
});
