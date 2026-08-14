import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrchestrationWorktreeAsset } from "@prospero/protocol";
import {
  WORKTREE_ACTION_MIN_HIT_TARGET,
  groupWorktreeAssets,
  worktreeAssetPresentation,
  worktreeCanClean,
  worktreeEffectiveState,
  worktreeInspectionSummary,
  worktreePathAction,
  worktreeRunDeletionNotice,
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
  it("keeps current Run assets attached and groups deleted or missing Runs as retained worktrees", () => {
    const current = asset("active");
    current.runId = "run-current";
    const deleted = asset("preserved");
    deleted.id = "wt-deleted";
    // A deletion tombstone wins even while a stale snapshot still contains its Run.
    deleted.runId = "run-current";
    deleted.runDeletedAt = 2;
    const missingCleaned = asset("cleaned");
    missingCleaned.id = "wt-missing-cleaned";
    missingCleaned.runId = "run-missing";

    const groups = groupWorktreeAssets([current, deleted, missingCleaned], [{ id: "run-current" }]);

    expect(groups.byRunId.get("run-current")).toEqual([current]);
    expect(groups.orphaned).toEqual([deleted, missingCleaned]);
    expect(groups.orphaned.find((candidate) => candidate.id === "wt-missing-cleaned"))
      .toMatchObject({ state: "cleaned" });
    expect(worktreeAssetPresentation(missingCleaned).label).toBe("已清理");
  });

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

  it("treats persisted cleanup as terminal despite an older safe inspection", () => {
    const cleaned = asset("cleaned");
    cleaned.lastInspection = {
      state: "safe_to_clean",
      targetRef: "main",
      checkedAt: 2,
      pathExists: true,
      registered: true,
      dirty: false,
      branch: "feature/worktree",
      aheadCommitCount: 0,
      equivalentCommitCount: 0,
      message: "可安全清理",
    };
    cleaned.cleanup = { removedAt: 3, branchDeleted: false, warning: null };

    expect(worktreeEffectiveState(cleaned)).toBe("cleaned");
    expect(worktreeAssetPresentation(cleaned)).toMatchObject({ label: "已清理", tone: "muted" });
    expect(worktreeCanClean(cleaned)).toBe(false);
    expect(worktreeInspectionSummary(cleaned)).toContain("状态：已清理");

    const cleanupRecordedBeforeStateUpdate = asset("active");
    cleanupRecordedBeforeStateUpdate.lastInspection = cleaned.lastInspection;
    cleanupRecordedBeforeStateUpdate.cleanup = cleaned.cleanup;
    expect(worktreeEffectiveState(cleanupRecordedBeforeStateUpdate)).toBe("cleaned");
    expect(worktreeCanClean(cleanupRecordedBeforeStateUpdate)).toBe(false);

    const shellSource = readFileSync(
      join(import.meta.dirname, "..", "..", "shell", "Sources", "ProsperoShell", "OrchestrationStatus.swift"),
      "utf8",
    );
    expect(shellSource).toMatch(
      /func orchestrationWorktreeState\([\s\S]*?asset\.state == "cleaned" \|\| asset\.cleanup != nil[\s\S]*?return "cleaned"/,
    );
    expect(shellSource).toMatch(
      /func orchestrationWorktreeCanClean\([\s\S]*?guard orchestrationWorktreeState\(asset\) != "cleaned" else \{ return false \}/,
    );
    const dashboardSource = readFileSync(
      join(import.meta.dirname, "..", "..", "shell", "Sources", "ProsperoShell", "Dashboard.swift"),
      "utf8",
    );
    expect(dashboardSource).toContain("orchestrationWorktreeState(asset)");
    expect(dashboardSource).toContain("orchestrationWorktreeCanClean(asset)");
  });

  it("retains a daemon diagnostic in an unchecked worktree summary", () => {
    const unchecked = asset("unknown");
    unchecked.lastError = "完成 worker 派发失败：会话已结束";

    expect(worktreeInspectionSummary(unchecked)).toContain("诊断：完成 worker 派发失败：会话已结束");
  });

  it("labels the path action truthfully for browseable and copy-only paths", () => {
    expect(worktreePathAction("/worker", true)).toMatchObject({
      label: "浏览路径",
      accessibilityLabel: "浏览工作树路径：/worker",
    });
    expect(worktreePathAction("/orphan", false)).toMatchObject({
      label: "复制路径",
      accessibilityLabel: "复制工作树路径：/orphan",
    });
  });

  it("warns about all registered worktrees and preserves the legacy automation fallback", () => {
    const worker = asset("active");
    worker.kind = "worker";
    worker.taskId = "task-1";
    const run = asset("active");
    run.id = "wt-run";
    run.kind = "run";
    run.taskId = null;
    run.path = "/run-worktree";

    const registered = worktreeRunDeletionNotice(
      [worker, run],
      (candidate) => candidate.kind === "run" ? "共享 Run" : "worker：实现任务",
      "/legacy-run-worktree",
    );
    expect(registered).toContain("全部 2 个关联工作树（其中 1 个 worker 工作树）");
    expect(registered).toContain("worker：实现任务\n/worktree");
    expect(registered).toContain("共享 Run\n/run-worktree");
    expect(registered).not.toContain("/legacy-run-worktree");

    expect(worktreeRunDeletionNotice([], () => "unused", "/legacy-run-worktree"))
      .toContain("自动 Run 工作树。它会保留在主机上：\n/legacy-run-worktree");
    expect(worktreeRunDeletionNotice([], () => "unused", null)).toBe("");
  });

  it("keeps the Mac legacy fallback limited to empty assets from Run workspaces", () => {
    const shellSource = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "shell",
        "Sources",
        "ProsperoShell",
        "OrchestrationStatus.swift",
      ),
      "utf8",
    );

    expect(shellSource).toContain("func orchestrationRunDeletionNotice(");
    expect(shellSource).toMatch(
      /guard assets\.isEmpty,[\s\S]*?automation\?\.workspace == "run",[\s\S]*?let workspacePath = automation\?\.workspacePath/,
    );
    expect(shellSource).toContain(
      'return "\\n\\n删除编排不会清理自动 Run 工作树。它会保留在主机上：\\n\\(workspacePath)"',
    );
  });

  it("keeps compact worktree controls at a 44pt target with explicit accessibility metadata", () => {
    const screen = readFileSync(
      join(import.meta.dirname, "..", "src", "app", "host", "[hostId]", "orchestration.tsx"),
      "utf8",
    );

    expect(WORKTREE_ACTION_MIN_HIT_TARGET).toBe(44);
    expect(screen).toContain("minWidth: WORKTREE_ACTION_MIN_HIT_TARGET");
    expect(screen).toContain("minHeight: WORKTREE_ACTION_MIN_HIT_TARGET");
    expect(screen).toMatch(
      /orphanWorktreeToggle: \{[\s\S]*?minHeight: WORKTREE_ACTION_MIN_HIT_TARGET/,
    );
    expect(screen).toContain('accessibilityRole="button"');
    expect(screen).toContain("accessibilityLabel={pathAction.accessibilityLabel}");
    expect(screen).toContain("accessibilityState={{ disabled: !canManage }}");
  });
});
