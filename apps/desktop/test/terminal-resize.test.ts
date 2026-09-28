import { describe, expect, it, vi } from "vitest";
import { TerminalResizeCoordinator } from "../src/renderer/src/terminal-resize";

describe("terminal resize coordination", () => {
  it("keeps only the newest size while replay is unstable", async () => {
    const coordinator = new TerminalResizeCoordinator();
    const send = vi.fn().mockResolvedValue(undefined);
    coordinator.request({ cols: 80, rows: 24 }, false, true, send, vi.fn());
    coordinator.request({ cols: 100, rows: 30 }, false, true, send, vi.fn());
    coordinator.flush(true, send, vi.fn());
    await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ cols: 100, rows: 30 });
  });

  it("does not duplicate an in-flight or completed request", async () => {
    const coordinator = new TerminalResizeCoordinator();
    const send = vi.fn().mockResolvedValue(undefined);
    coordinator.request({ cols: 80, rows: 24 }, true, true, send, vi.fn());
    coordinator.request({ cols: 80, rows: 24 }, true, true, send, vi.fn());
    await Promise.resolve();
    coordinator.request({ cols: 80, rows: 24 }, true, true, send, vi.fn());
    expect(send).toHaveBeenCalledOnce();
  });

  it("coalesces while sending and keeps a failed request dirty", async () => {
    const coordinator = new TerminalResizeCoordinator();
    let finish!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    coordinator.request({ cols: 80, rows: 24 }, true, true, send, vi.fn());
    coordinator.request({ cols: 90, rows: 25 }, true, true, send, vi.fn());
    expect(send).toHaveBeenCalledOnce();
    finish(false);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledOnce();
    coordinator.flush(true, send, vi.fn());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fits ended terminals locally without sending a daemon resize", () => {
    const coordinator = new TerminalResizeCoordinator();
    const send = vi.fn(); const local = vi.fn();
    coordinator.request({ cols: 90, rows: 25 }, true, false, send, local);
    expect(local).toHaveBeenCalledWith({ cols: 90, rows: 25 });
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores an old in-flight completion after clear", async () => {
    const coordinator = new TerminalResizeCoordinator();
    let finishOld!: (value: boolean) => void;
    let finishNew!: (value: boolean) => void;
    const send = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishNew = resolve; }));
    coordinator.request({ cols: 80, rows: 24 }, true, true, send, vi.fn());
    coordinator.clear();
    coordinator.request({ cols: 80, rows: 24 }, true, true, send, vi.fn());
    finishOld(true);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(2);
    finishNew(true);
  });
});
