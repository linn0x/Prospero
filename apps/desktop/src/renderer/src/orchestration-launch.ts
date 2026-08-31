import type { JsonObject } from "../../shared/types";

export type OrchestrationWorkerAgent =
  | "codex"
  | "claude"
  | "deepseek"
  | "opencode";

export type OrchestrationLaunchSelection = {
  agent: OrchestrationWorkerAgent;
  cwd: string;
  accountId?: string | undefined;
};

function accountParams(selection: OrchestrationLaunchSelection): JsonObject {
  if (
    (selection.agent === "codex" || selection.agent === "claude") &&
    selection.accountId?.trim()
  ) {
    return { accountId: selection.accountId.trim() };
  }
  return {};
}

export function workerStartParams(
  selection: OrchestrationLaunchSelection,
  taskId: string,
  operationId: string,
): JsonObject {
  return {
    operationId,
    taskId,
    agent: selection.agent,
    cwd: selection.cwd,
    ...accountParams(selection),
    worktree: "new",
    kind: "structured",
    approvalPolicy: "standard",
  };
}

export function automationStartParams(
  selection: OrchestrationLaunchSelection,
  runId: string,
  operationId: string,
): JsonObject {
  return {
    operationId,
    runId,
    agent: selection.agent,
    cwd: selection.cwd,
    ...accountParams(selection),
    approvalPolicy: "standard",
    workspace: "run",
  };
}
