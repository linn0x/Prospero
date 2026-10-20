import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleDeferredRequest } from "../src/renderer/src/deferred-request";

afterEach(() => vi.useRealTimers());
const handlers = () => ({ success: vi.fn(), error: vi.fn(), settled: vi.fn() });

describe("deferred search requests", () => {
  it("dispatches only the last query in an input burst", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue("results");
    const callbacks = handlers();
    const cancel = scheduleDeferredRequest(request, callbacks);
    await vi.advanceTimersByTimeAsync(100);
    cancel();
    scheduleDeferredRequest(request, callbacks);
    await vi.advanceTimersByTimeAsync(149);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(callbacks.success).toHaveBeenCalledWith("results");
    expect(callbacks.settled).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("ignores an obsolete in-flight response (failure=%s)", async failure => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    let reject!: (reason: Error) => void;
    const request = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const callbacks = handlers();
    const cancel = scheduleDeferredRequest(() => request, callbacks);
    await vi.advanceTimersByTimeAsync(150);
    cancel();
    if (failure) reject(new Error("offline")); else resolve("stale");
    await vi.runAllTimersAsync();
    expect(callbacks.success).not.toHaveBeenCalled();
    expect(callbacks.error).not.toHaveBeenCalled();
    expect(callbacks.settled).not.toHaveBeenCalled();
  });

  it("reports a current failure and finishes the loading state", async () => {
    vi.useFakeTimers();
    const callbacks = handlers();
    const error = new Error("offline");
    scheduleDeferredRequest(() => Promise.reject(error), callbacks);
    await vi.advanceTimersByTimeAsync(150);
    expect(callbacks.error).toHaveBeenCalledWith(error);
    expect(callbacks.settled).toHaveBeenCalledTimes(1);
  });
});
