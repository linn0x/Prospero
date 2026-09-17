import { describe, expect, it } from "vitest";
import { sessionIndicator, unreadCompletions } from "../src/renderer/src/workspace/session-status";

describe("session status indicators", () => {
  it.each(["completed", "done", "succeeded"])("shows %s as completed and only bounces when unread", status => {
    expect(sessionIndicator({ status })).toMatchObject({ state: "completed", motion: "none" });
    expect(sessionIndicator({ status }, true)).toMatchObject({ state: "completed", motion: "bounce" });
  });
  it.each(["starting", "dispatched"])("breathes for %s even if an older answer is unread", status => {
    expect(sessionIndicator({ status }, true)).toMatchObject({ state: "running", motion: "breathe" });
  });
  it("only breathes for running sessions with an active turn", () => {
    expect(sessionIndicator({ status: "running" })).toMatchObject({ state: "running", motion: "none" });
    expect(sessionIndicator({ status: "running", busySince: 123 })).toMatchObject({ state: "running", motion: "breathe" });
  });
  it("keeps raw running statuses static for non-session uses unless activity is supplied", () => {
    expect(sessionIndicator({ status: "running" }, true)).toMatchObject({ state: "running", motion: "none" });
  });
  it.each(["active", "idle"])("keeps %s sessions static because they are alive but not currently running", status => {
    expect(sessionIndicator({ status })).toMatchObject({ state: "idle", motion: "none" });
    expect(sessionIndicator({ status }, true)).toMatchObject({ state: "idle", motion: "bounce" });
  });
  it.each(["died", "failed", "cancelled", "killed", "exited", "interrupted"])("keeps %s stopped despite stale permission counters", status => {
    expect(sessionIndicator({ status, pendingPermissions: 1 }, true)).toMatchObject({ state: "terminated", motion: "none" });
  });
  it("prioritizes pending permissions over raw running/idle status", () => {
    expect(sessionIndicator({ status: "running", pendingPermissions: 1 })).toMatchObject({ state: "approval", motion: "blink" });
    expect(sessionIndicator({ status: "waiting_approval" })).toMatchObject({ state: "approval", motion: "blink" });
    expect(sessionIndicator({ status: "idle", pendingQuestions: 1 })).toMatchObject({ state: "input", motion: "blink" });
    expect(sessionIndicator({ status: "waiting_input" })).toMatchObject({ state: "input", motion: "blink" });
  });
  it("does not imply completion or approval for queued and unknown statuses", () => {
    expect(sessionIndicator({ status: "queued" })).toMatchObject({ state: "waiting", motion: "none" });
    expect(sessionIndicator({ status: "future-state" })).toMatchObject({ state: "unknown", motion: "none" });
  });
  it("marks newly completed background answers without marking history, stopped tasks or the visible answer", () => {
    const sessions = [{ id: "background", status: "idle" }, { id: "visible", status: "completed" }, { id: "history", status: "completed" }, { id: "stopped", status: "killed" }];
    expect(unreadCompletions(new Map(), sessions, undefined)).toEqual([]);
    const previous = new Map([["background", "running"], ["visible", "running"], ["history", "completed"], ["stopped", "running"]] as const);
    expect(unreadCompletions(previous, sessions, "visible")).toEqual(["background"]);
    expect(unreadCompletions(previous, sessions, undefined)).toEqual(["background", "visible"]);
  });
});
