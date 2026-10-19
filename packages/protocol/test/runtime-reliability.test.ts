import { describe, expect, it } from "vitest";
import { parseC2S, parseS2C, executionPending, runtimeStatus, latestExecution } from "../src/index.js";
import type { ExecutionRecord, ExecutionState } from "../src/rust-daemon.js";

const execution = (state: ExecutionState, epoch = 1): ExecutionRecord => ({
  identity: { taskId: "task", dispatchId: null, attemptId: `attempt-${epoch}`, executionEpoch: epoch, host: null, configDigest: "digest" },
  state, resultState: "ACCEPTED", stopGeneration: 0, exitProofId: null, createdAt: 1, updatedAt: 2,
});

describe("runtime control and presentation", () => {
  it("keeps delivery and physical cleanup independent", () => {
    expect(runtimeStatus(execution("RUNNING"))?.zh).toContain("等待执行收尾");
    expect(runtimeStatus(execution("STOPPING"))?.zh).toBe("停止确认中");
    expect(runtimeStatus(execution("STOP_UNKNOWN"))?.zh).toContain("未知");
    expect(executionPending(execution("EXIT_CONFIRMED"))).toBe(true);
    expect(executionPending(execution("FINALIZED"))).toBe(false);
  });

  it("uses the execution epoch before timestamps and rejects malformed receipts", () => {
    expect(latestExecution([execution("FINALIZED", 1), execution("RUNNING", 2)], "task")?.identity.executionEpoch).toBe(2);
    expect(() => parseS2C({ type: "orchestration.execution.result", requestId: "read", execution: { state: "RUNNING" } })).toThrow();
    expect(() => parseS2C({ type: "orchestration.operation.result", requestId: "read", operation: { operationId: "op", state: "RUNNING", effectState: "RECEIVED", revision: "bad" } })).toThrow();
  });

  it("accepts generated runtime payloads and old snapshots without runtime fields", () => {
    expect(parseC2S({ type: "orchestration.execution.get", requestId: "read", attemptId: "attempt-1" })).toMatchObject({ attemptId: "attempt-1" });
    expect(parseS2C({ type: "orchestration.execution.result", requestId: "read", execution: execution("STOP_UNKNOWN") })).toMatchObject({ execution: { state: "STOP_UNKNOWN" } });
    expect(parseS2C({ type: "orchestration.snapshot", snapshot: { runs: [], tasks: [], gates: [], dispatches: [] } })).toMatchObject({ snapshot: { tasks: [] } });
  });
});
