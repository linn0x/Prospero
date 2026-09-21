import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleTerminalCache } from "../src/renderer/src/terminal-cache-scheduler";

function fixture() {
  const root = new EventTarget();
  const view = new EventTarget();
  const idle = new Map<number, () => void>();
  let id = 0;
  Object.assign(view, {
    setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    requestIdleCallback: (fn: () => void) => { idle.set(++id, fn); return id; },
    cancelIdleCallback: (handle: number) => idle.delete(handle),
  });
  Object.assign(root, { defaultView: view });
  const send = (type: string, pointerId = 1) => root.dispatchEvent(Object.assign(new Event(type), { pointerId }));
  const flush = () => { const callbacks = [...idle.values()]; idle.clear(); callbacks.forEach(fn => fn()); };
  return { root: root as unknown as Document, send, flush, idle, view };
}
afterEach(() => vi.useRealTimers());
describe("terminal recovery cache scheduling", () => {
  it("defers even a long stationary drag, then saves the latest pending state once", () => {
    vi.useFakeTimers(); const f = fixture(); const save = vi.fn(() => true);
    const cache = scheduleTerminalCache(f.root, save);
    cache.schedule(); f.send("pointerdown"); cache.schedule();
    vi.advanceTimersByTime(12_000); f.flush(); expect(save).not.toHaveBeenCalled();
    f.send("pointerup"); vi.advanceTimersByTime(2_000); f.flush();
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6_000); f.flush(); expect(save).toHaveBeenCalledTimes(1); cache.dispose();
  });
  it("rechecks gestures that start after an idle callback was queued", () => {
    vi.useFakeTimers(); const f = fixture(); const save = vi.fn(() => true);
    const cache = scheduleTerminalCache(f.root, save);
    cache.schedule(); vi.advanceTimersByTime(2_000); expect(f.idle.size).toBe(1);
    f.send("pointerdown"); f.flush(); expect(save).not.toHaveBeenCalled();
    f.send("pointercancel"); vi.advanceTimersByTime(2_000); f.flush(); expect(save).toHaveBeenCalledTimes(1); cache.dispose();
  });
  it.each(["wheel", "keydown"])("waits for a quiet period after %s", type => {
    vi.useFakeTimers(); const f = fixture(); const save = vi.fn(() => true);
    const cache = scheduleTerminalCache(f.root, save);
    cache.schedule(); vi.advanceTimersByTime(1_500); f.send(type);
    vi.advanceTimersByTime(500); f.flush(); expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000); f.flush(); expect(save).toHaveBeenCalledTimes(1); cache.dispose();
  });
  it("retries an unstable buffer and cancels pending callbacks on disposal", () => {
    vi.useFakeTimers(); const f = fixture(); const save = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const cache = scheduleTerminalCache(f.root, save); cache.schedule();
    vi.advanceTimersByTime(2_000); f.flush(); vi.advanceTimersByTime(2_000); f.flush();
    expect(save).toHaveBeenCalledTimes(2);
    cache.schedule(); vi.advanceTimersByTime(2_000); cache.dispose(); f.flush();
    vi.advanceTimersByTime(10_000); f.flush(); expect(save).toHaveBeenCalledTimes(2);
  });
});
