import { afterEach, expect, it, vi } from "vitest";
import { TerminalInputBuffer, TerminalInputQueue } from "../src/renderer/src/terminal-input-buffer";

afterEach(() => vi.useRealTimers());
it("delivers already accepted characters to their original session after switching", async () => {
  vi.useFakeTimers();
  const a = vi.fn().mockResolvedValue(true), b = vi.fn().mockResolvedValue(true);
  const first = new TerminalInputBuffer(a), second = new TerminalInputBuffer(b);
  first.append("中文"); second.append("other");
  await vi.advanceTimersByTimeAsync(4);
  expect(a).toHaveBeenCalledExactlyOnceWith("中文");
  expect(b).toHaveBeenCalledExactlyOnceWith("other");
});
it("does not postpone the first key indefinitely during continuous input", async () => {
  vi.useFakeTimers(); const send = vi.fn().mockResolvedValue(true);
  const buffer = new TerminalInputBuffer(send);
  buffer.append("a"); await vi.advanceTimersByTimeAsync(3); buffer.append("b");
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledExactlyOnceWith("ab");
});
it("flushes once before unmount/paste and bounds the pending batch", async () => {
  vi.useFakeTimers(); const send = vi.fn().mockResolvedValue(true);
  const buffer = new TerminalInputBuffer(send);
  buffer.append("pending"); await buffer.flush(); await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledExactlyOnceWith("pending");
  buffer.append("x".repeat(8192)); expect(send).toHaveBeenCalledTimes(2);
});
it("bounds queued paste bytes, preserves ordering and frees capacity after failure", async () => {
  const queue = new TerminalInputQueue(2, 8); let release!: () => void;
  const pending = new Promise<void>(r => { release = r; }); const order: number[] = [];
  const first = queue.enqueue(async () => { await pending; order.push(1); }, 6);
  const second = queue.enqueue(async () => { order.push(2); throw new Error("fixture"); }, 2);
  const rejected = expect(second).rejects.toThrow("fixture");
  await expect(queue.enqueue(async () => {}, 1)).rejects.toThrow("队列已满");
  release(); await first; await rejected;
  expect(order).toEqual([1,2]);
  await expect(queue.enqueue(async () => true, 8)).resolves.toBe(true);
});
