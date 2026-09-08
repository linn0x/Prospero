import { describe, expect, it } from "vitest";
import { ChatEventAccumulator, getChatTimelineItemWindow } from "../src/renderer/src/chat-events";
import { chatDisplayItems, conversationFontSize, historyEndForItem } from "../src/renderer/src/chat/display";
import { normalizeMathDelimiters, externalMarkdownUrl } from "../src/renderer/src/chat/markdown";

describe("conversation display", () => {
  it("separates DeepSeek trajectory updates from answers without hiding requests or failures", () => {
    const timeline = new ChatEventAccumulator().reset([
      { kind: "user.message", text: "question" },
      { kind: "trajectory.record", recordId: "r", title: "read", phase: "running" },
      { kind: "trajectory.record", recordId: "r", title: "read", phase: "completed" },
      { kind: "reasoning.delta", msgId: "m", delta: "thinking" },
      { kind: "text.delta", msgId: "m", textId: "answer", delta: "actual answer" },
      { kind: "permission.request", reqId: "p" },
      { kind: "question.request", reqId: "q" },
      { kind: "agent.error", message: "failed" },
    ]);
    const conversation = chatDisplayItems(timeline.items, "conversation", true);
    const trajectory = chatDisplayItems(timeline.items, "trajectory");
    expect(conversation.some((item) => item.event.kind === "trajectory.record")).toBe(false);
    expect(conversation.some((item) => item.event.kind === "reasoning")).toBe(false);
    expect(chatDisplayItems(timeline.items, "conversation").some((item) => item.event.kind === "reasoning")).toBe(true);
    expect(conversation.find((item) => item.event.kind === "assistant.text")?.event.text).toBe("actual answer");
    expect(trajectory.filter((item) => item.event.kind === "trajectory.record")).toHaveLength(1);
    expect(trajectory.find((item) => item.event.kind === "trajectory.record")?.event.phase).toBe("completed");
    expect(trajectory.some((item) => item.event.kind === "assistant.text")).toBe(false);
    for (const list of [conversation, trajectory]) for (const kind of ["permission.request", "question.request", "agent.error"]) expect(list.some((item) => item.event.kind === kind)).toBe(true);
  });

  it("folds completed tools but leaves failed and running tools visible", () => {
    const items = new ChatEventAccumulator().reset([
      ...[1, 2, 3].map((id) => ({ kind: "tool.end", callId: String(id), state: "success" })),
      { kind: "tool.end", callId: "4", state: "error" },
      { kind: "tool.start", callId: "5" },
    ]).items;
    const display = chatDisplayItems(items, "conversation");
    expect(display.map((item) => item.event.kind)).toEqual(["activity.group", "tool.end", "tool.start"]);
    expect(display[0]!.event.events).toHaveLength(3);
  });

  it("jumps to retained records outside the mounted page with gaps in event ordinals", () => {
    const items = Array.from({ length: 200 }, (_, index) => ({ key: String(index), ordinal: 400 + index * 3, event: { kind: "user.message" } }));
    const end = historyEndForItem(items, "2", 1000, 120);
    const window = getChatTimelineItemWindow(items, 1000, end);
    expect(items.slice(window.start, window.end).some((item) => item.key === "2")).toBe(true);
    expect(window.end - window.start).toBeLessThanOrEqual(120);
  });

  it("bounds and recovers persisted font sizes", () => {
    expect([null, undefined, "", "oops", Infinity].map(conversationFontSize)).toEqual([16, 16, 16, 16, 16]);
    expect(["18", 99, -1, 17.7].map(conversationFontSize)).toEqual([18, 24, 13, 18]);
  });

  it("supports slash TeX delimiters while preserving code and incomplete streams", () => {
    expect(normalizeMathDelimiters(String.raw`inline \(x^2\) and \[a=b\]`)).toBe("inline $x^2$ and \n\n$$\na=b\n$$\n\n");
    for (const value of ["```tex\n\\(x\\)\n```", "~~~tex\n\\[x\\]\n~~~", "`\\(x\\)`", "```tex\n\\(x\\)", "unfinished \\(x"]) expect(normalizeMathDelimiters(value)).toBe(value);
  });

  it("only opens links supported by the native external-link bridge", () => {
    expect(externalMarkdownUrl("https://example.com/a")).toBe("https://example.com/a");
    for (const value of ["javascript:alert(1)", "data:text/html,hello", "file:///C:/secret", "mailto:a@example.com", "/local", ""]) expect(externalMarkdownUrl(value)).toBeUndefined();
  });
});
