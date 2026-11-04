import type { SessionInfo } from "@prospero/protocol";

export function sessionBranchUnavailable(session: SessionInfo | undefined): string | undefined {
  if (!session || !["claude", "codex", "pi"].includes(session.agent)) return "仅 Claude Code、Codex 和 Pi 支持会话分支";
  if (!session.cwd) return "会话缺少工作目录";
  if (session.kind === "structured" && !["idle", "done", "completed"].includes(session.status)) return "请等待当前轮次结束后创建分支";
  return undefined;
}
