/**
 * 审批策略:决定一次工具调用要不要打断用户。
 *
 * 【为什么需要】原本每次工具调用都推到手机。实际跑起来,十次里有八九次是
 * 读文件 / 搜索 / 列目录 —— 无害、且用户几乎不会拒。后果不是"有点烦",
 * 而是把人训练成条件反射地点「允许」,等真正危险的那一次来了也照点不误。
 * 高频的无害审批实际上在【削弱】审批的安全价值。
 *
 * 【为什么不用后端的 bypass】Claude SDK 有 permissionMode: "bypassPermissions",
 * 但那样 canUseTool 完全不会被调用,聊天里也就不会出现任何工具卡片 ——
 * 用户彻底看不见 agent 做了什么。自动批准的目的是【不打断】,不是【不告知】。
 * 所以放行在我们这一层做,事件照常发,只是不等人回应。
 */
import type { ApprovalPolicy } from "@prospero/protocol";

/**
 * 明确只读的工具名。
 *
 * 跨 agent 收集(Claude / Codex / opencode / Grok 命名不同),统一小写比对。
 * 只列【确定不改变任何状态】的:读文件、搜索、列目录、看 diff。
 */
const READ_ONLY = new Set([
  // Claude Code
  "read",
  "grep",
  "glob",
  "ls",
  "notebookread",
  "todoread",
  // 通用 / 其他 agent
  "readfile",
  "read_file",
  "listdir",
  "list_dir",
  "list_directory",
  "search",
  "searchfiles",
  "codebase_search",
  "grepsearch",
  "grep_search",
  "filesearch",
  "file_search",
  "gitdiff",
  "git_diff",
  "gitstatus",
  "git_status",
]);

/**
 * 判断一次工具调用是否需要人来点头。
 *
 * 【失败时保守】不认识的工具一律按"需要审批"处理。agent 生态在变,
 * 明天出现的新工具默认应该是被拦住的 —— 反过来(默认放行)意味着
 * 任何未知工具都能悄悄跑掉,那是不能接受的失败方向。
 */
export function needsApproval(policy: ApprovalPolicy, toolName: string): boolean {
  if (policy === "yolo") return false;
  if (policy === "strict") return true;
  // standard:只有确定只读的才放行
  return !READ_ONLY.has(toolName.trim().toLowerCase());
}

/** 供 UI 显示;放宽时必须让用户一眼看见 */
export function policyLabel(policy: ApprovalPolicy): string {
  switch (policy) {
    case "strict":
      return "每次询问";
    case "standard":
      return "只读自动放行";
    case "yolo":
      return "全部自动批准";
    default:
      return policy;
  }
}

export const DEFAULT_POLICY: ApprovalPolicy = "strict";
