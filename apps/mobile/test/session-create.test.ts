import { afterEach, describe, expect, it, vi } from "vitest";
import type { C2SSessionCreate, SessionInfo } from "@prospero/protocol";
import { SessionCreateTracker } from "../src/lib/session-create";

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, agent: "codex", kind: "structured", title: "Fixture", cwd: "/work", status: "idle", createdAt: 1, cols: 80, rows: 24, accountId: "account", ...extra,
});
const request = (requestId: string): C2SSessionCreate & { requestId: string } => ({
  type: "session.create", requestId, agent: "codex", kind: "structured", cwd: "/work", accountId: "account", cols: 80, rows: 24,
});
const sent = () => ({ accepted: true, disposition: "sent" } as const);
afterEach(() => vi.useRealTimers());

describe("bounded session creation tracking", () => {
  it("correlates concurrent creations completed out of order and ignores unrelated snapshots/errors", async () => {
    const tracker = new SessionCreateTracker();
    const first = tracker.begin(request("first"), true, [], sent);
    const second = tracker.begin(request("second"), true, [], sent);
    const firstDone = vi.fn(); void first.completion.then(firstDone);
    tracker.state(session("unrelated")); tracker.snapshot("unrelated");
    tracker.legacyError({ type: "error", code: "bad_message", message: "other request" });
    tracker.result({ type: "session.create.result", requestId: "second", ok: true, session: session("second-session") });
    await expect(second.completion).resolves.toMatchObject({ id: "second-session" });
    expect(firstDone).not.toHaveBeenCalled();
    tracker.result({ type: "session.create.result", requestId: "first", ok: true, session: session("first-session") });
    await expect(first.completion).resolves.toMatchObject({ id: "first-session" });
  });

  it("returns the actionable correlated failure instead of waiting for a snapshot", async () => {
    const tracker = new SessionCreateTracker();
    const task = tracker.begin(request("one"), true, [], sent);
    tracker.result({ type: "session.create.result", requestId: "one", ok: false, error: "in use", reason: "conversation_active_writer" });
    await expect(task.completion).rejects.toMatchObject({ message: "in use", reason: "conversation_active_writer" });
  });

  it.each(["cancel", "disconnect", "timeout"])("releases %s waits and cannot navigate on a late success", async (ending) => {
    vi.useFakeTimers();
    const tracker = new SessionCreateTracker();
    const task = tracker.begin(request("one"), true, [], sent);
    const completion = expect(task.completion).rejects.toMatchObject({ reason: ending === "cancel" ? "cancelled" : ending === "disconnect" ? "disconnected" : "timeout" });
    if (ending === "cancel") task.cancel();
    else if (ending === "disconnect") tracker.disconnect();
    else await vi.advanceTimersByTimeAsync(45_000);
    await completion;
    tracker.result({ type: "session.create.result", requestId: "one", ok: true, session: session("late") });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["offline", "transport_error"] as const)("ends a %s send immediately", async (reason) => {
    vi.useFakeTimers();
    const tracker = new SessionCreateTracker();
    const task = tracker.begin(request("one"), true, [], () => ({ accepted: false, reason }));
    await expect(task.completion).rejects.toMatchObject({ reason });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("legacy completion requires a new matching session and its snapshot, in either arrival order", async () => {
    const tracker = new SessionCreateTracker();
    const send = vi.fn(sent);
    const task = tracker.begin(request("legacy"), false, ["existing"], send);
    const done = vi.fn(); void task.completion.then(done);
    expect(send).toHaveBeenCalledWith(expect.not.objectContaining({ requestId: expect.anything() }));
    for (const info of [session("existing"), session("other-model", { agent: "claude" }), session("other-path", { cwd: "/elsewhere" }), session("other-account", { accountId: "another" })]) {
      tracker.state(info); tracker.snapshot(info.id);
    }
    await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    tracker.snapshot("created");
    tracker.state(session("created", { cwd: "/work/" }));
    await expect(task.completion).resolves.toMatchObject({ id: "created" });
    const next = tracker.begin(request("next"), false, ["existing", "created"], sent);
    tracker.state(session("created-next")); tracker.snapshot("created-next");
    await expect(next.completion).resolves.toMatchObject({ id: "created-next" });
  });

  it("a late legacy create cannot be mistaken for a retry after cancellation", async () => {
    const tracker = new SessionCreateTracker();
    const first = tracker.begin(request("first"), false, [], sent);
    first.cancel();
    await expect(first.completion).rejects.toMatchObject({ reason: "cancelled" });
    const send = vi.fn(sent);
    const second = tracker.begin(request("second"), false, [], send);
    await expect(second.completion).rejects.toMatchObject({ reason: "uncorrelated_create" });
    expect(send).toHaveBeenCalledOnce();
    expect(second.delivery).toEqual({ accepted: true, disposition: "sent" });
    tracker.state(session("late-first")); tracker.snapshot("late-first");
    // Upgrading the daemon restores exact results without relying on snapshots.
    const modern = tracker.begin(request("modern"), true, [], sent);
    tracker.result({ type: "session.create.result", requestId: "modern", ok: true, session: session("modern-session") });
    await expect(modern.completion).resolves.toMatchObject({ id: "modern-session" });
  });

  it("legacy writer conflicts fail immediately with the actionable reason", async () => {
    const tracker = new SessionCreateTracker();
    const task = tracker.begin(request("legacy"), false, [], sent);
    tracker.legacyError({ type: "error", code: "conflict", message: "in use", reason: "conversation_active_writer" });
    await expect(task.completion).rejects.toMatchObject({ reason: "conversation_active_writer" });
  });
});
