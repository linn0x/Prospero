import type { OrchestrationRun, OrchestrationWorktreeAsset } from "@prospero/protocol";

export interface WorktreeAssetPresentation {
  label: string;
  detail: string;
  tone: "muted" | "warning" | "success" | "danger";
}

/** All compact worktree actions still need a full mobile hit target. */
export const WORKTREE_ACTION_MIN_HIT_TARGET = 44;

export interface WorktreePathAction {
  label: "浏览路径" | "复制路径";
  accessibilityLabel: string;
  accessibilityHint: string;
}

export interface WorktreeAssetGroups {
  /** Assets still owned by a Run present in the latest snapshot. */
  byRunId: ReadonlyMap<string, OrchestrationWorktreeAsset[]>;
  /**
   * Assets whose Run was explicitly deleted, or whose Run is no longer in the
   * snapshot. Deliberately includes cleaned records so their final state stays
   * visible instead of making a successful cleanup look like lost history.
   */
  orphaned: OrchestrationWorktreeAsset[];
}

/**
 * Keeps active Run ownership ahead of presentation, while making deletion
 * tombstones and snapshot gaps recoverable from one dedicated UI section.
 */
export function groupWorktreeAssets(
  assets: readonly OrchestrationWorktreeAsset[],
  runs: readonly Pick<OrchestrationRun, "id">[],
): WorktreeAssetGroups {
  const currentRunIds = new Set(runs.map((run) => run.id));
  const byRunId = new Map<string, OrchestrationWorktreeAsset[]>();
  const orphaned: OrchestrationWorktreeAsset[] = [];

  for (const asset of assets) {
    if (asset.runDeletedAt !== null || !currentRunIds.has(asset.runId)) {
      orphaned.push(asset);
      continue;
    }
    const grouped = byRunId.get(asset.runId);
    if (grouped) grouped.push(asset);
    else byRunId.set(asset.runId, [asset]);
  }

  return { byRunId, orphaned };
}

/** A path can only be browsed when it is backed by a linked worker dispatch. */
export function worktreePathAction(
  path: string,
  hasLinkedDispatch: boolean,
): WorktreePathAction {
  return hasLinkedDispatch
    ? {
      label: "浏览路径",
      accessibilityLabel: `浏览工作树路径：${path}`,
      accessibilityHint: "在关联 worker 的文件浏览器中查看此路径。",
    }
    : {
      label: "复制路径",
      accessibilityLabel: `复制工作树路径：${path}`,
      accessibilityHint: "当前没有关联 worker 会话，路径会复制到剪贴板。",
    };
}

/** The displayed result always comes from the daemon's last inspection. */
export function worktreeAssetPresentation(
  asset: OrchestrationWorktreeAsset,
): WorktreeAssetPresentation {
  const state = asset.lastInspection?.state ?? asset.state;
  switch (state) {
    case "dirty":
      return { label: "有未提交改动", detail: "请先提交、暂存或保留", tone: "warning" };
    case "unmerged":
      return { label: "未合并", detail: "分支仍有未合并提交", tone: "warning" };
    case "equivalent":
      return { label: "已合并", detail: "与目标 ref 等价，可安全清理", tone: "success" };
    case "safe_to_clean":
      return { label: "可清理", detail: "服务端已确认没有待保留改动", tone: "success" };
    case "cleaned":
      return { label: "已清理", detail: "目录已移除；分支默认保留", tone: "muted" };
    case "missing":
      return { label: "路径已丢失", detail: "服务端不会尝试删除", tone: "danger" };
    case "unknown":
      return { label: "无法确认", detail: "请查看摘要并处理检查错误", tone: "danger" };
    default:
      return { label: "待检查", detail: "尚未获得安全结论", tone: "muted" };
  }
}

/** Only a server inspection, not a cached lifecycle label, can unlock cleanup. */
export function worktreeCanClean(asset: OrchestrationWorktreeAsset): boolean {
  const state = asset.lastInspection?.state;
  return state === "safe_to_clean" || state === "equivalent";
}

export function worktreeInspectionSummary(asset: OrchestrationWorktreeAsset): string {
  const inspection = asset.lastInspection;
  if (!inspection) {
    const lines = ["尚未检查。点“检查”可让主机只读核验工作树状态。"];
    if (asset.lastError) lines.push(`诊断：${asset.lastError}`);
    return lines.join("\n");
  }
  const lines = [
    `状态：${worktreeAssetPresentation(asset).label}`,
    `目标：${inspection.targetRef}`,
    `分支：${inspection.branch ?? asset.branch ?? "detached"}`,
  ];
  if (inspection.aheadCommitCount !== null) lines.push(`待合并提交：${inspection.aheadCommitCount}`);
  if (inspection.equivalentCommitCount !== null) lines.push(`等价提交：${inspection.equivalentCommitCount}`);
  if (inspection.message) lines.push(`说明：${inspection.message}`);
  return lines.join("\n");
}

/**
 * Preserve the pre-worktree-assets warning for automation Runs served by an
 * older daemon (or before its asset record has arrived).
 */
export function worktreeRunDeletionNotice(
  assets: readonly OrchestrationWorktreeAsset[],
  ownerForAsset: (asset: OrchestrationWorktreeAsset) => string,
  fallbackRunWorkspacePath?: string | null,
): string {
  const preservedAssets = assets.filter((asset) => asset.state !== "cleaned");
  if (preservedAssets.length > 0) {
    const workerCount = preservedAssets.filter((asset) => asset.kind === "worker").length;
    const locations = preservedAssets.map((asset) => `${ownerForAsset(asset)}\n${asset.path}`).join("\n\n");
    return `\n\n删除编排不会清理全部 ${String(preservedAssets.length)} 个关联工作树（其中 ${String(workerCount)} 个 worker 工作树）。它们会保留在主机上：\n${locations}`;
  }

  if (assets.length === 0 && fallbackRunWorkspacePath) {
    return `\n\n删除编排不会清理自动 Run 工作树。它会保留在主机上：\n${fallbackRunWorkspacePath}`;
  }

  return "";
}
