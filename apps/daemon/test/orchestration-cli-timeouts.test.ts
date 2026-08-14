import { describe, expect, it } from "vitest";
import { DEFAULT_CONTROL_REQUEST_TIMEOUT_MS } from "../src/control-socket.js";
import {
  CLI_CONTROL_REQUEST_TIMEOUTS,
  WORKER_START_CONTROL_REQUEST_TIMEOUT_MS,
  controlRequestTimeoutFor,
} from "../src/orchestration-cli-timeouts.js";

describe("编排 CLI 控制请求超时", () => {
  it("仅为 worker.start 选择覆盖 worktree 和 session 建立的有限长超时", () => {
    expect(CLI_CONTROL_REQUEST_TIMEOUTS.defaultTimeoutMs).toBe(DEFAULT_CONTROL_REQUEST_TIMEOUT_MS);
    expect(controlRequestTimeoutFor("worker.start")).toBe(WORKER_START_CONTROL_REQUEST_TIMEOUT_MS);
    expect(WORKER_START_CONTROL_REQUEST_TIMEOUT_MS).toBeGreaterThan(DEFAULT_CONTROL_REQUEST_TIMEOUT_MS);
    expect(WORKER_START_CONTROL_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("其他短 RPC 保持 15 秒默认超时", () => {
    expect(controlRequestTimeoutFor("task.done")).toBe(DEFAULT_CONTROL_REQUEST_TIMEOUT_MS);
    expect(controlRequestTimeoutFor("worktree.inspect")).toBe(DEFAULT_CONTROL_REQUEST_TIMEOUT_MS);
  });
});
