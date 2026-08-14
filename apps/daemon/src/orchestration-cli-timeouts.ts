/** `prospero` 编排 CLI 的命令级控制 socket 超时策略。 */
import { DEFAULT_CONTROL_REQUEST_TIMEOUT_MS } from "./control-socket.js";

/**
 * `worker.start --worktree new` 会在响应前创建 worktree、复制 ignored 依赖并建立
 * agent session。五分钟仍是有限等待，同时给 CoW 不可用时的实际复制留出余量。
 */
export const WORKER_START_CONTROL_REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface ControlRequestTimeouts {
  defaultTimeoutMs: number;
  workerStartTimeoutMs: number;
}

export const CLI_CONTROL_REQUEST_TIMEOUTS: Readonly<ControlRequestTimeouts> = {
  defaultTimeoutMs: DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
  workerStartTimeoutMs: WORKER_START_CONTROL_REQUEST_TIMEOUT_MS,
};

/**
 * 只放宽会同步创建资产/会话的 worker.start；其余短 RPC 一律保持 control socket
 * 的 15 秒默认值。参数让边界测试可缩短时钟，不需要实际等待数分钟。
 */
export function controlRequestTimeoutFor(
  method: string,
  timeouts: ControlRequestTimeouts = CLI_CONTROL_REQUEST_TIMEOUTS,
): number {
  return method === "worker.start" ? timeouts.workerStartTimeoutMs : timeouts.defaultTimeoutMs;
}
