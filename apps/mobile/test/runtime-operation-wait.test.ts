import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationView } from "@prospero/protocol/rust-daemon";
import { waitForOperation } from "../src/lib/runtime-operation-wait";

const operation = (state: OperationView["state"]): OperationView => ({
  operationId: "original-operation", kind: "stop", state, taskId: "task", attemptId: "attempt", executionEpoch: 1,
  effectState: "RECEIVED", waitReason: null, retryAfterMs: 50, nextReconcileAt: null, revision: 1,
});
afterEach(() => vi.useRealTimers());

describe("operation waiting", () => {
  it("returns the original operation ID on timeout without replaying control", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async (_operationId: string) => operation("WAITING"));
    const pending = waitForOperation("original-operation", read, 120);
    await vi.advanceTimersByTimeAsync(120);
    await expect(pending).resolves.toMatchObject({ operationId: "original-operation", waitTimedOut: true, operation: { state: "WAITING" } });
    expect(read.mock.calls.every(([id]) => id === "original-operation")).toBe(true);
  });

  it("bounds a stalled read and keeps the operation queryable", async () => {
    vi.useFakeTimers();
    const pending = waitForOperation("original-operation", () => new Promise(() => {}), 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ operationId: "original-operation", operation: null, waitTimedOut: true });
  });

  it("cancels waiting while preserving the received stop", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = waitForOperation("original-operation", async () => operation("WAITING"), 1000, controller.signal);
    const cancelled = expect(pending).rejects.toThrow("cancel wait");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error("cancel wait"));
    await cancelled;
  });
});
