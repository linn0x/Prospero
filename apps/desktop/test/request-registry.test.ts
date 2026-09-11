import { describe, expect, it, vi } from "vitest";
import { RequestRegistry } from "../src/main/request-registry";

describe("main-process page cancellation", () => {
  it("keeps cancellation scoped, rejects overload and releases requests after shutdown", async () => {
    const registry = new RequestRegistry();
    const waits = Array.from({ length: 32 }, (_, index) => registry.run(`owner:${index}`, signal => new Promise<boolean>(done => signal.addEventListener("abort", () => done(true), { once: true }))));
    await expect(registry.run("other", async () => true)).rejects.toThrow("繁忙");
    await expect(registry.run("owner:0", async () => true)).rejects.toThrow("重复");
    registry.cancel("different:0");
    registry.cancel("owner:0");
    expect(await waits[0]).toBe(true);
    expect(await registry.run("other", async () => "available")).toBe("available");
    registry.cancelAll();
    expect((await Promise.all(waits)).every(Boolean)).toBe(true);
    expect(await registry.run("owner:0", async () => true)).toBe(true);
  });

  it("times out abandoned renderer requests", async () => {
    vi.useFakeTimers();
    try {
      const registry = new RequestRegistry();
      const pending = registry.run("request", signal => new Promise<boolean>(done => signal.addEventListener("abort", () => done(true), { once: true })));
      await vi.advanceTimersByTimeAsync(8000);
      expect(await pending).toBe(true);
      expect(await registry.run("request", async () => 1)).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});
