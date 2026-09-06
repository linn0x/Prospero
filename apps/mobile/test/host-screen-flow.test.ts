import type { SessionInfo } from "@prospero/protocol";
import { describe, expect, it, vi } from "vitest";
import { DismissedModalAction, PendingSessionCreation } from "../src/lib/host-screen-flow";

const session = { id: "created-session" } as SessionInfo;
function attempt() {
  let resolve!: (session: SessionInfo) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<SessionInfo>((yes, no) => { resolve = yes; reject = no; });
  return { completion, resolve, reject, cancel: vi.fn() };
}

describe("host creation and navigation lifecycle", () => {
  it("enters the returned session once and releases the busy state", async () => {
    const pending = new PendingSessionCreation();
    const task = attempt();
    const enter = vi.fn();
    pending.track(task, enter, vi.fn());
    expect(pending.pending).toBe(true);
    task.resolve(session);
    await task.completion;
    expect(pending.pending).toBe(false);
    expect(enter).toHaveBeenCalledExactlyOnceWith(session);
  });

  it("cancelling local waiting prevents late successful results from navigating", async () => {
    const pending = new PendingSessionCreation();
    const task = attempt();
    const enter = vi.fn();
    pending.track(task, enter, vi.fn());
    expect(pending.cancel()).toBe(true);
    expect(pending.pending).toBe(false);
    expect(task.cancel).toHaveBeenCalledOnce();
    task.resolve(session);
    await task.completion;
    expect(enter).not.toHaveBeenCalled();
  });

  it("a settled result queued before cancellation cannot navigate on the next microtask", async () => {
    const pending = new PendingSessionCreation();
    const task = attempt();
    const enter = vi.fn();
    pending.track(task, enter, vi.fn());
    task.resolve(session);
    pending.cancel();
    await task.completion;
    expect(enter).not.toHaveBeenCalled();
  });

  it("an old failure cannot clear or report over a newer attempt", async () => {
    const pending = new PendingSessionCreation();
    const old = attempt();
    const next = attempt();
    const oldError = vi.fn();
    const enter = vi.fn();
    pending.track(old, vi.fn(), oldError);
    pending.track(next, enter, vi.fn());
    old.reject(new Error("old timeout"));
    await old.completion.catch(() => {});
    expect(oldError).not.toHaveBeenCalled();
    expect(pending.pending).toBe(true);
    next.resolve(session);
    await next.completion;
    expect(enter).toHaveBeenCalledExactlyOnceWith(session);
  });

  it("request failure releases waiting and preserves the structured reason for the UI", async () => {
    const pending = new PendingSessionCreation();
    const task = attempt();
    const fail = vi.fn();
    const error = Object.assign(new Error("desktop owns the conversation"), { reason: "conversation_active_writer" });
    pending.track(task, vi.fn(), fail);
    task.reject(error);
    await task.completion.catch(() => {});
    expect(pending.pending).toBe(false);
    expect(fail).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("navigation waits for native dismissal and ignores duplicate dismissal callbacks", () => {
    const modal = new DismissedModalAction();
    const navigate = vi.fn();
    modal.defer(navigate);
    modal.defer(vi.fn());
    expect(navigate).not.toHaveBeenCalled();
    modal.dismiss();
    modal.dismiss();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("cancelling a presentation discards the old route while allowing the next presentation", () => {
    const modal = new DismissedModalAction();
    const navigate = vi.fn();
    modal.defer(navigate);
    modal.cancel();
    modal.dismiss();
    expect(navigate).not.toHaveBeenCalled();
    const next = vi.fn();
    modal.defer(next);
    modal.dismiss();
    expect(next).toHaveBeenCalledOnce();
  });
});
