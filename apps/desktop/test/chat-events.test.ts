import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/shared/types";
import {
  CHAT_TIMELINE_WINDOW_SIZE,
  MAX_RETAINED_CHAT_ITEMS,
  ChatEventAccumulator,
  collapseChatEventHistory,
  getChatPollReconnectDelay,
  getChatTimelineItemWindow,
  getChatTimelineWindow,
  hasChatResolution,
  isChatViewportNearEnd,
  updateChatHistoryCursorFromScroll,
} from "../src/renderer/src/chat-events";

describe("Electron chat event accumulator", () => {
  it("folds initial history and incrementally updates only the affected render items", () => {
    const model = new ChatEventAccumulator();
    const initial: JsonObject[] = [
      { kind: "text.delta", msgId: "m1", textId: "t1", delta: "hel" },
      { kind: "tool.start", msgId: "m1", callId: "c1", tool: "bash", summary: "pwd" },
      { kind: "text.delta", msgId: "m1", textId: "t1", delta: "lo" },
      { kind: "reasoning.delta", msgId: "m1", delta: "think" },
      { kind: "tool.end", callId: "c1", state: "success", summary: "/tmp" },
      { kind: "permission.request", reqId: "p1", summary: "Run command", resources: [] },
      { kind: "permission.resolved", reqId: "p1", reply: "once" },
      { kind: "question.request", reqId: "q1", questions: [] },
      { kind: "question.resolved", reqId: "q1", answers: [] },
    ];

    const first = model.reset(initial);

    expect(first.items.map(({ event }) => event.kind)).toEqual([
      "assistant.text",
      "tool.end",
      "reasoning",
      "permission.request",
      "question.request",
    ]);
    expect(first.items[0]?.event.text).toBe("hello");
    expect(first.items[1]?.event).toMatchObject({ tool: "bash", state: "success", summary: "/tmp" });
    expect(hasChatResolution(first.resolutions, "permission.resolved", "p1")).toBe(true);
    expect(hasChatResolution(first.resolutions, "question.resolved", "q1")).toBe(true);

    const stableTextKey = first.items[0]?.key;
    const next = model.append([{ kind: "text.delta", msgId: "m1", textId: "t1", delta: "!" }]);

    expect(next?.items).toHaveLength(first.items.length);
    expect(next?.items[0]?.key).toBe(stableTextKey);
    expect(next?.items[0]?.event.text).toBe("hello!");
    expect(next?.items[1]).toBe(first.items[1]);
  });

  it("does not publish a new snapshot for empty or non-renderable deltas", () => {
    const model = new ChatEventAccumulator();
    const first = model.reset([{ kind: "user.message", msgId: "m1", text: "hello" }]);

    expect(model.append([])).toBeUndefined();
    expect(model.append([{ kind: "future.metadata", value: 1 }])).toBeUndefined();
    expect(model.snapshot().revision).toBe(first.revision);
    expect(model.snapshot().items).toEqual(first.items);
  });

  it("keeps thousands of raw text deltas as one stable timeline item", () => {
    const model = new ChatEventAccumulator();
    const deltas = Array.from({ length: 5_000 }, () => ({
      kind: "text.delta",
      msgId: "long",
      textId: "long",
      delta: "x",
    }));

    const snapshot = model.reset(deltas);

    expect(snapshot.items).toHaveLength(1);
    expect(String(snapshot.items[0]?.event.text)).toHaveLength(5_000);
  });

  it("retains resolution metadata in an on-demand subagent transcript", () => {
    expect(collapseChatEventHistory([
      { kind: "text.delta", msgId: "m1", textId: "t1", delta: "a" },
      { kind: "text.delta", msgId: "m1", textId: "t1", delta: "b" },
      { kind: "question.resolved", reqId: "q1", answers: [] },
    ])).toEqual([
      expect.objectContaining({ kind: "assistant.text", text: "ab" }),
      { kind: "question.resolved", reqId: "q1", answers: [] },
    ]);
  });

  it("bounds retained memory across tens of thousands of appended semantic events", () => {
    const model = new ChatEventAccumulator();
    model.reset([]);
    let snapshot = model.snapshot();
    for (let batch = 0; batch < 100; batch++) {
      snapshot = model.append(Array.from({ length: 250 }, (_, offset) => ({
        kind: "user.message",
        msgId: `m-${String(batch * 250 + offset)}`,
        text: "message",
      }))) ?? snapshot;
    }

    expect(snapshot.items.length).toBeLessThanOrEqual(MAX_RETAINED_CHAT_ITEMS);
    expect(snapshot.items.at(-1)?.event.msgId).toBe("m-24999");
    expect(snapshot.nextOrdinal).toBe(25_000);

    const resolutionOnly = model.append(Array.from({ length: 25_000 }, (_, index) => ({
      kind: "permission.resolved",
      reqId: `missing-${String(index)}`,
      reply: "once",
    })));
    expect(resolutionOnly).toBeUndefined();
    expect(model.snapshot().resolutions.size).toBeLessThanOrEqual(MAX_RETAINED_CHAT_ITEMS);
  });

  it("keeps live streams, tools, and unresolved interactions usable through compaction", () => {
    const model = new ChatEventAccumulator();
    model.reset([
      { kind: "text.delta", msgId: "active", textId: "active-text", delta: "a" },
      { kind: "reasoning.delta", msgId: "active", delta: "r" },
      { kind: "tool.start", msgId: "active", callId: "active-tool", tool: "bash", summary: "run" },
      { kind: "permission.request", reqId: "active-permission", summary: "approve", resources: [] },
      { kind: "question.request", reqId: "active-question", questions: [] },
    ]);
    model.append(Array.from({ length: 3_000 }, (_, index) => ({ kind: "user.message", msgId: `noise-${String(index)}`, text: "noise" })));

    const snapshot = model.append([
      { kind: "text.delta", msgId: "active", textId: "active-text", delta: "b" },
      { kind: "reasoning.delta", msgId: "active", delta: "s" },
      { kind: "tool.end", callId: "active-tool", state: "success", summary: "done" },
      { kind: "permission.resolved", reqId: "active-permission", reply: "once" },
      { kind: "question.resolved", reqId: "active-question", answers: [] },
    ]);

    expect(snapshot?.items.length).toBeLessThanOrEqual(MAX_RETAINED_CHAT_ITEMS);
    expect(snapshot?.items.find(({ event }) => event.kind === "assistant.text")?.event.text).toBe("ab");
    expect(snapshot?.items.find(({ event }) => event.kind === "reasoning")?.event.text).toBe("rs");
    expect(snapshot?.items.find(({ event }) => event.callId === "active-tool")?.event).toMatchObject({ kind: "tool.end", state: "success" });
    expect(hasChatResolution(snapshot?.resolutions ?? new Set(), "permission.resolved", "active-permission")).toBe(true);
    expect(hasChatResolution(snapshot?.resolutions ?? new Set(), "question.resolved", "active-question")).toBe(true);
  });

  it("keeps a hard bound even for an abnormal stream of unfinished tools", () => {
    const model = new ChatEventAccumulator();
    const snapshot = model.reset(Array.from({ length: 5_000 }, (_, index) => ({
      kind: "tool.start",
      msgId: "active",
      callId: `tool-${String(index)}`,
      tool: "bash",
      summary: "running",
    })));

    expect(snapshot.items.length).toBeLessThanOrEqual(MAX_RETAINED_CHAT_ITEMS);
    const completed = model.append([{ kind: "tool.end", callId: "tool-4999", state: "success", summary: "done" }]);
    expect(completed?.items.find(({ event }) => event.callId === "tool-4999")?.event.kind).toBe("tool.end");
  });
});

describe("Electron chat timeline window", () => {
  it("reconnects a completed long poll quickly without spinning against an older daemon", () => {
    expect(getChatPollReconnectDelay(false, 20_000)).toBe(25);
    expect(getChatPollReconnectDelay(true, 5)).toBe(25);
    expect(getChatPollReconnectDelay(false, 5)).toBe(650);
  });

  it("bounds the default DOM window to the newest events", () => {
    expect(getChatTimelineWindow(450, null)).toEqual({
      start: 450 - CHAT_TIMELINE_WINDOW_SIZE,
      end: 450,
      isLatest: true,
      newerCount: 0,
    });
  });

  it("supports fixed older pages while new events continue to arrive", () => {
    expect(getChatTimelineWindow(470, 290)).toEqual({
      start: 290 - CHAT_TIMELINE_WINDOW_SIZE,
      end: 290,
      isLatest: false,
      newerCount: 180,
    });
    expect(getChatTimelineWindow(470, 130)).toEqual({
      start: 130 - CHAT_TIMELINE_WINDOW_SIZE,
      end: 130,
      isLatest: false,
      newerCount: 340,
    });
  });

  it("freezes the live window while reading upward and resumes at its bottom", () => {
    const frozen = updateChatHistoryCursorFromScroll(null, false, 450);

    expect(frozen).toEqual({ end: 450, mode: "frozen" });
    expect(updateChatHistoryCursorFromScroll(frozen, false, 470)).toBe(frozen);
    expect(updateChatHistoryCursorFromScroll(frozen, true, 470)).toBeNull();
  });

  it("never exits a manually selected history page merely because it reached the page bottom", () => {
    const page = { end: 290, mode: "page" } as const;

    expect(updateChatHistoryCursorFromScroll(page, true, 470)).toBe(page);
  });

  it("uses a small end threshold to avoid freezing on sub-pixel scroll differences", () => {
    expect(isChatViewportNearEnd({ scrollTop: 1_452, scrollHeight: 2_000, clientHeight: 500 })).toBe(true);
    expect(isChatViewportNearEnd({ scrollTop: 1_400, scrollHeight: 2_000, clientHeight: 500 })).toBe(false);
  });

  it("uses stable ordinals so a frozen live window does not admit new items after compaction", () => {
    const model = new ChatEventAccumulator();
    const before = model.reset(Array.from({ length: 1_950 }, (_, index) => ({
      kind: "user.message",
      msgId: `m-${String(index)}`,
      text: "message",
    })));
    const cursorEnd = before.nextOrdinal;
    const beforeWindow = getChatTimelineItemWindow(before.items, before.nextOrdinal, cursorEnd);
    const beforeKeys = before.items.slice(beforeWindow.start, beforeWindow.end).map(({ key }) => key);
    const after = model.append(Array.from({ length: 300 }, (_, index) => ({
      kind: "user.message",
      msgId: `new-${String(index)}`,
      text: "new",
    })))!;
    const frozenWindow = getChatTimelineItemWindow(after.items, after.nextOrdinal, cursorEnd);

    expect(after.items.slice(frozenWindow.start, frozenWindow.end).map(({ key }) => key)).toEqual(beforeKeys);
    expect(frozenWindow.newerCount).toBe(300);
  });

  it("falls back to the oldest retained page when a manual cursor has been compacted away", () => {
    const model = new ChatEventAccumulator();
    const snapshot = model.reset(Array.from({ length: 5_000 }, (_, index) => ({
      kind: "user.message",
      msgId: `m-${String(index)}`,
      text: "message",
    })));
    const window = getChatTimelineItemWindow(snapshot.items, snapshot.nextOrdinal, 100);

    expect(window.start).toBe(0);
    expect(window.end).toBe(CHAT_TIMELINE_WINDOW_SIZE);
    expect(snapshot.items.slice(window.start, window.end)).toHaveLength(CHAT_TIMELINE_WINDOW_SIZE);
  });
});
