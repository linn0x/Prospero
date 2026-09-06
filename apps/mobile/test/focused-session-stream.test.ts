import type { AgentEventBody, S2CAgentEvent } from "@prospero/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnEvents } from "../src/lib/connection";
import { Emitter } from "../src/lib/emitter";
import {
  pollFocusedSubagent,
  subscribeFocusedChat,
  subscribeFocusedTerminal,
  subscribeWhileAppActive,
} from "../src/lib/focused-session-stream";

const body: AgentEventBody = { kind: "text.delta", msgId: "reply", textId: "text", delta: "A" };
const event = (sid: string, evSeq: number): S2CAgentEvent => ({ type: "agent.event", sid, evSeq, body });
const connected: ConnEvents["connected"] = { addr: "fixture", path: "direct", rttMs: 1 };
const makeConnection = () => ({ events: new Emitter<ConnEvents>(), isConnected: true, attach: vi.fn(), ack: vi.fn() });

describe("focused session stream lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pauses on app background and releases the AppState listener on route blur", () => {
    let change: (state: string) => void = () => {};
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const off = vi.fn();
    const blur = subscribeWhileAppActive({ currentState: "active", onChange: (listener) => { change = listener; return off; } }, start);
    change("active");
    expect(start).toHaveBeenCalledOnce();
    change("inactive");
    change("background");
    expect(stop).toHaveBeenCalledOnce();
    change("active");
    expect(start).toHaveBeenCalledTimes(2);
    blur();
    blur();
    change("active");
    expect(stop).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(off).toHaveBeenCalledOnce();
  });

  it("flushes queued chat text before blur and resumes from the displayed cursor", () => {
    const conn = makeConnection();
    const cursor = { current: 0 };
    const events = vi.fn();
    const options = { conn, sid: "a", cursor, events, snapshot: vi.fn(), toolOutput: vi.fn(), unread: vi.fn() };
    const blur = subscribeFocusedChat(options);
    conn.events.emit("agentEvent", event("a", 1));
    expect(events).not.toHaveBeenCalled();
    expect(cursor.current).toBe(0);
    blur();
    expect(events).toHaveBeenCalledWith([body]);
    expect(cursor.current).toBe(1);
    conn.events.emit("agentEvent", event("a", 2));
    vi.advanceTimersByTime(1000);
    expect(events).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const stop = subscribeFocusedChat(options);
    expect(conn.attach.mock.calls).toEqual([["a", undefined], ["a", 1]]);
    conn.events.emit("agentEvent", event("a", 1));
    conn.events.emit("agentEvent", event("a", 2));
    vi.advanceTimersByTime(32);
    expect(events).toHaveBeenCalledTimes(2);
    expect(cursor.current).toBe(2);
    stop();
  });

  it("does not apply another session or duplicate replay, and snapshot replaces its pending batch", () => {
    const conn = makeConnection();
    const events = vi.fn();
    const snapshot = vi.fn();
    const cursor = { current: 0 };
    const stop = subscribeFocusedChat({ conn, sid: "b", cursor, events, snapshot, toolOutput: vi.fn(), unread: vi.fn() });
    conn.events.emit("agentEvent", event("a", 100));
    conn.events.emit("agentEvent", event("b", 1));
    conn.events.emit("agentEvent", event("b", 1));
    conn.events.emit("chatSnapshot", { type: "chat.snapshot", sid: "b", evSeq: 3, events: [body] });
    vi.advanceTimersByTime(32);
    expect(events).not.toHaveBeenCalled();
    expect(snapshot).toHaveBeenCalledWith([body]);
    expect(cursor.current).toBe(3);
    stop();
  });

  it("flushes a tool start before filling its output", () => {
    const conn = makeConnection();
    const order: string[] = [];
    const stop = subscribeFocusedChat({ conn, sid: "a", cursor: { current: 0 }, snapshot: vi.fn(), events: () => order.push("events"), toolOutput: () => order.push("output"), unread: vi.fn() });
    conn.events.emit("agentEvent", event("a", 1));
    conn.events.emit("toolOutput", { type: "tool.output", sid: "a", callId: "tool", output: "result" });
    expect(order).toEqual(["events", "output"]);
    stop();
  });

  it("stops subagent polling and ignores a late response after blur", async () => {
    const conn = { ...makeConnection(), supportsSubagentHistory: true, subagentHistory: vi.fn() };
    let resolve!: (events: AgentEventBody[]) => void;
    conn.subagentHistory.mockReturnValue(new Promise<AgentEventBody[]>((done) => { resolve = done; }));
    const receive = vi.fn();
    const blur = pollFocusedSubagent({ conn, sid: "a", subagentId: "worker", receive });
    expect(conn.subagentHistory).toHaveBeenCalledOnce();
    blur();
    resolve([body]);
    await Promise.resolve();
    vi.advanceTimersByTime(10_000);
    conn.events.emit("connected", connected);
    expect(receive).not.toHaveBeenCalled();
    expect(conn.subagentHistory).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains terminal bytes before final ACK, ignores blurred output, and reattaches once", () => {
    const conn = makeConnection();
    const cursor = { current: 0 };
    const order: string[] = [];
    conn.ack.mockImplementation(() => order.push("ack"));
    const output = vi.fn();
    const options = { conn, sid: "a", cursor, snapshot: vi.fn(), output, flush: () => order.push("flush"), attach: () => conn.attach("a", cursor.current || undefined) };
    const blur = subscribeFocusedTerminal(options);
    conn.events.emit("output", { type: "term.output", sid: "a", seq: 3, dataB64: "QQ==" });
    blur();
    expect(order).toEqual(["flush", "ack"]);
    expect(conn.ack).toHaveBeenCalledWith("a", 3);
    conn.events.emit("output", { type: "term.output", sid: "a", seq: 4, dataB64: "Qg==" });
    conn.events.emit("connected", connected);
    vi.advanceTimersByTime(1000);
    expect(output).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const stop = subscribeFocusedTerminal(options);
    expect(conn.attach.mock.calls).toEqual([["a", undefined], ["a", 3]]);
    conn.events.emit("output", { type: "term.output", sid: "a", seq: 3, dataB64: "QQ==" });
    expect(output).toHaveBeenCalledOnce();
    stop();
  });
});
