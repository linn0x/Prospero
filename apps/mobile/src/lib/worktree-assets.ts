import type { OrchestrationWorktreeAsset } from "@prospero/protocol";

export interface WorktreeAssetPresentation {
  label: string;
  detail: string;
  tone: "muted" | "warning" | "success" | "danger";
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
  if (!inspection) return "尚未检查。点“检查”可让主机只读核验工作树状态。";
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
