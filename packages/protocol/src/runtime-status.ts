import type { ExecutionRecord, OperationView } from "./rust-daemon.js";

export function executionPending(execution: ExecutionRecord | null | undefined): boolean {
  return execution !== undefined && execution !== null && execution.state !== "FINALIZED";
}

export function runtimeStatus(execution: ExecutionRecord | null | undefined, operation?: OperationView | null): { zh: string; en: string; pending: boolean } | null {
  const state = execution?.state;
  if (state && ["START_UNKNOWN", "STOP_UNKNOWN", "OWNER_UNREACHABLE", "MANUAL_REQUIRED"].includes(state)) {
    return { zh: "执行状态未知，等待对账", en: "Execution unknown; reconciliation pending", pending: true };
  }
  if (state === "STOP_REQUESTED" || state === "STOPPING") {
    return { zh: "停止确认中", en: "Confirming stop", pending: true };
  }
  if (execution?.resultState === "ACCEPTED" && executionPending(execution)) {
    return { zh: "已交付，等待执行收尾", en: "Delivered; executor cleanup pending", pending: true };
  }
  if (operation?.state === "OUTCOME_UNKNOWN") {
    return { zh: "操作结果未知，保留原操作 ID", en: "Operation outcome unknown; keep its ID", pending: true };
  }
  if (operation?.state === "WAITING") {
    return { zh: operation.waitReason === "WAITING_INPUT" ? "等待输入" : "等待资源或恢复", en: operation.waitReason === "WAITING_INPUT" ? "Waiting for input" : "Waiting for resources or recovery", pending: true };
  }
  if (state === "WAITING_INPUT") return { zh: "等待输入", en: "Waiting for input", pending: true };
  if (state === "QUIESCED" || state === "EXIT_CONFIRMED") return { zh: "执行已退出，等待结算", en: "Executor exited; finalizing", pending: true };
  if (state === "FINALIZED") return { zh: "执行已收尾", en: "Execution finalized", pending: false };
  if (state) return { zh: state === "PLANNED" || state === "STARTING" ? "执行启动中" : "执行中", en: state === "PLANNED" || state === "STARTING" ? "Executor starting" : "Executor running", pending: true };
  return null;
}

export function latestExecution(executions: readonly ExecutionRecord[] | undefined, taskId: string): ExecutionRecord | undefined {
  return executions?.filter((execution) => execution.identity.taskId === taskId)
    .sort((left, right) => right.identity.executionEpoch - left.identity.executionEpoch || right.updatedAt - left.updatedAt)[0];
}

export function latestOperation(operations: readonly OperationView[] | undefined, taskId: string): OperationView | undefined {
  return operations?.filter((operation) => operation.taskId === taskId)
    .sort((left, right) => (right.executionEpoch ?? 0) - (left.executionEpoch ?? 0) ||
      Number(!["SUCCEEDED", "FAILED", "CANCELLED"].includes(right.state)) - Number(!["SUCCEEDED", "FAILED", "CANCELLED"].includes(left.state)))[0];
}
