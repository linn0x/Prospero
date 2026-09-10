import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@prospero/protocol";
import { TerminalCloseTracker } from "../src/lib/terminal-close";
import { supportsMacTerminal } from "../src/lib/terminal-session";

const session = (id: string, status: SessionInfo["status"]): SessionInfo => ({
  id, status, kind: "pty", agent: "shell", cwd: "/Users/test", title: "test", createdAt: 1, cols: 80, rows: 24,
});
afterEach(() => vi.useRealTimers());

describe("remote Mac terminal support", () => {
  it.each(["macOS", "darwin", " MACOS "])("allows the remote host platform %s", (platform) => {
    expect(supportsMacTerminal({ platform })).toBe(true);
  });
  it.each(["Windows", "win32", "Linux", "linux", "android", "ios", "MacBook", undefined])("rejects unsupported or unconfirmed remote platform %s", (platform) => {
    expect(supportsMacTerminal({ platform })).toBe(false);
  });
  it("does not infer a Mac from a missing handshake", () => {
    expect(supportsMacTerminal(null)).toBe(false);
  });
});

describe("terminal close acknowledgement", () => {
  it("recognizes the existing daemon's unscoped missing-session reply only for the exact deletion target", async () => {
    const tracker = new TerminalCloseTracker();
    const completion = tracker.begin("shell-123", () => ({ accepted: true, disposition: "sent" }), { allowMissing: true });
    const pending = expect(completion).resolves.toBeUndefined();
    try {
      expect(tracker.error({ type: "error", code: "session_not_found", message: "no such session: shell-1234" })).toBe(false);
      expect(tracker.error({ type: "error", code: "forbidden", message: "no such session: shell-123" })).toBe(false);
      expect(tracker.error({ type: "error", code: "session_not_found", sid: "another", message: "no such session: shell-123" })).toBe(false);
      expect(tracker.error({ type: "error", code: "session_not_found", message: "no such session: shell-123" })).toBe(true);
      await pending;
    } finally {
      tracker.state(session("shell-123", "done"));
      await pending;
    }
  });

  it("deduplicates repeated closes and waits for the matching terminal to actually end", async () => {
    const tracker = new TerminalCloseTracker();
    const send = vi.fn(() => ({ accepted: true, disposition: "sent" } as const));
    const closed = vi.fn();
    const completion = tracker.begin("shell", send);
    void completion.then(closed);
    expect(tracker.begin("shell", send)).toBe(completion);
    tracker.state(session("other", "done"));
    tracker.state(session("shell", "running"));
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    tracker.state(session("shell", "done"));
    await completion;
    expect(closed).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("handles an acknowledgement arriving during send", async () => {
    const tracker = new TerminalCloseTracker();
    await expect(tracker.begin("shell", () => {
      tracker.state(session("shell", "died"));
      return { accepted: true, disposition: "sent" };
    })).resolves.toBeUndefined();
  });
  it("reports rejected delivery without pretending the terminal closed", async () => {
    const tracker = new TerminalCloseTracker();
    await expect(tracker.begin("shell", () => ({ accepted: false, reason: "offline" }))).rejects.toThrow("主机未连接");
  });
  it("reports a scoped server rejection and allows a later retry", async () => {
    const tracker = new TerminalCloseTracker();
    const send = () => ({ accepted: true, disposition: "sent" } as const);
    const completion = tracker.begin("shell", send);
    tracker.error({ type: "error", sid: "shell", code: "forbidden", message: "无法结束进程" });
    await expect(completion).rejects.toThrow("无法结束进程");
    const retry = tracker.begin("shell", send);
    tracker.state(session("shell", "done"));
    await expect(retry).resolves.toBeUndefined();
  });
  it("stops waiting on disconnect instead of replaying the close", async () => {
    const tracker = new TerminalCloseTracker();
    const send = vi.fn(() => ({ accepted: true, disposition: "sent" } as const));
    const completion = tracker.begin("shell", send);
    tracker.disconnect();
    await expect(completion).rejects.toThrow("未能确认");
    tracker.state(session("shell", "done"));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("times out with a recoverable error instead of spinning forever", async () => {
    vi.useFakeTimers();
    const tracker = new TerminalCloseTracker();
    const completion = tracker.begin("shell", () => ({ accepted: true, disposition: "sent" }));
    const expectation = expect(completion).rejects.toThrow("尚未收到终端结束确认");
    await vi.advanceTimersByTimeAsync(10_000);
    await expectation;
    expect(vi.getTimerCount()).toBe(0);
  });
});
