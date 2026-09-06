import type { S2CAgentEvent, S2CChatSnapshot } from "@prospero/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ConnEvents } from "../src/lib/connection";
import { Emitter } from "../src/lib/emitter";
import {
  needsProgressApprovalSubscription,
  ProgressApprovalSubscriptions,
} from "../src/lib/progress-approval-subscriptions";

function connection(connected = true) {
  return { events: new Emitter<ConnEvents>(), isConnected: connected, attach: vi.fn() };
}

const targets = (...sids: string[]) => new Map([["host", new Set(sids)]]);
const snapshot = (sid: string) => ({ type: "chat.snapshot", sid, events: [] }) as unknown as S2CChatSnapshot;
const event = (sid: string, kind = "permission.request") => ({
  type: "agent.event", sid, body: { kind },
}) as unknown as S2CAgentEvent;
const connected: ConnEvents["connected"] = { addr: "test", path: "direct", rttMs: 1 };

describe("Android progress approval subscriptions", () => {
  it.each([
    ["ios", true, true, "background", true],
    ["web", true, true, "background", true],
    ["android", false, true, "background", true],
    ["android", true, false, "background", true],
    ["android", true, true, "active", true],
    ["android", true, true, "background", false],
  ] as const)("does not fetch approval history for %s/%s/%s/%s/%s", (platform, enabled, overlay, state, allowed) => {
    expect(needsProgressApprovalSubscription(platform, enabled, overlay, state, allowed)).toBe(false);
  });

  it("enables approval bodies only for an available Android background overlay", () => {
    expect(needsProgressApprovalSubscription("android", true, true, "background", true)).toBe(true);
  });

  it("attaches a newly pending session without replaying all existing pending histories", () => {
    const conn = connection();
    const subscriptions = new ProgressApprovalSubscriptions({ snapshot: vi.fn(), event: vi.fn() });
    const get = () => conn;
    subscriptions.update(targets("a"), get);
    subscriptions.update(targets("a", "b"), get);
    subscriptions.update(targets("b", "a"), get);
    expect(conn.attach.mock.calls).toEqual([["a"], ["b"]]);
    subscriptions.dispose();
  });

  it("reconnects once per pending target and forgets retired targets", () => {
    const conn = connection(false);
    const subscriptions = new ProgressApprovalSubscriptions({ snapshot: vi.fn(), event: vi.fn() });
    subscriptions.update(targets("a", "b"), () => conn);
    expect(conn.attach).not.toHaveBeenCalled();
    conn.isConnected = true;
    conn.events.emit("connected", connected);
    subscriptions.update(targets("b"), () => conn);
    conn.events.emit("connected", connected);
    subscriptions.update(targets("a", "b"), () => conn);
    expect(conn.attach.mock.calls).toEqual([["a"], ["b"], ["b"], ["a"]]);
    subscriptions.dispose();
  });

  it("ignores snapshots from other sessions and non-approval streaming events", () => {
    const conn = connection();
    const onSnapshot = vi.fn();
    const onEvent = vi.fn();
    const subscriptions = new ProgressApprovalSubscriptions({ snapshot: onSnapshot, event: onEvent });
    subscriptions.update(targets("pending"), () => conn);
    conn.events.emit("chatSnapshot", snapshot("reading"));
    conn.events.emit("agentEvent", event("reading"));
    conn.events.emit("agentEvent", event("pending", "text.delta"));
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    conn.events.emit("chatSnapshot", snapshot("pending"));
    conn.events.emit("agentEvent", event("pending"));
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledOnce();
    subscriptions.dispose();
  });

  it("removes listeners when disabled or when a host connection is replaced", () => {
    const old = connection();
    const next = connection();
    const onSnapshot = vi.fn();
    const subscriptions = new ProgressApprovalSubscriptions({ snapshot: onSnapshot, event: vi.fn() });
    subscriptions.update(targets("a"), () => old);
    subscriptions.update(targets("a"), () => next);
    old.events.emit("connected", connected);
    old.events.emit("chatSnapshot", snapshot("a"));
    expect(old.attach).toHaveBeenCalledOnce();
    expect(next.attach).toHaveBeenCalledOnce();
    expect(onSnapshot).not.toHaveBeenCalled();
    subscriptions.update(new Map(), () => next);
    next.events.emit("chatSnapshot", snapshot("a"));
    next.events.emit("connected", connected);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(next.attach).toHaveBeenCalledOnce();
    subscriptions.dispose();
  });

  it("does not touch connections without pending targets and can safely dispose twice", () => {
    const get = vi.fn(() => connection());
    const subscriptions = new ProgressApprovalSubscriptions({ snapshot: vi.fn(), event: vi.fn() });
    subscriptions.update(new Map(), get);
    expect(get).not.toHaveBeenCalled();
    subscriptions.dispose();
    subscriptions.dispose();
  });
});
