import { describe, expect, it } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";
import {
  applyEvent,
  applyEvents,
  pendingPermissions,
  type AssistantItem,
  type ChatItem,
  type PermissionItem,
  type ToolItem,
} from "../src/lib/chat-model";

const ev = (b: AgentEventBody): AgentEventBody => b;

describe("chat-model 事件折叠", () => {
  it("同一 msgId 的文本增量合并进一个助手条目", () => {
    const items = applyEvents([], [
      ev({ kind: "text.delta", msgId: "m1", textId: "t1", delta: "PO" }),
      ev({ kind: "text.delta", msgId: "m1", textId: "t1", delta: "NG" }),
    ]);
    expect(items).toHaveLength(1);
    expect((items[0] as AssistantItem).text).toBe("PONG");
    expect((items[0] as AssistantItem).done).toBe(false);
  });

  it("推理与正文分开累积,互不污染", () => {
    const items = applyEvents([], [
      ev({ kind: "reasoning.delta", msgId: "m1", delta: "想想…" }),
      ev({ kind: "text.delta", msgId: "m1", textId: "t1", delta: "答案" }),
      ev({ kind: "reasoning.delta", msgId: "m1", delta: "再想想" }),
    ]);
    expect(items).toHaveLength(1);
    const a = items[0] as AssistantItem;
    expect(a.text).toBe("答案");
    expect(a.reasoning).toBe("想想…再想想");
  });

  it("turn.end 标记完成并记录用量", () => {
    const items = applyEvents([], [
      ev({ kind: "text.delta", msgId: "m1", textId: "t1", delta: "hi" }),
      ev({ kind: "turn.end", msgId: "m1", finish: "stop", costUsd: 0.002, outputTokens: 7 }),
    ]);
    const a = items[0] as AssistantItem;
    expect(a.done).toBe(true);
    expect(a.finish).toEqual({ costUsd: 0.002, outputTokens: 7 });
  });

  it("tool.end 回填到对应的 tool.start,不新增条目", () => {
    const items = applyEvents([], [
      ev({ kind: "tool.start", msgId: "m1", callId: "c1", tool: "bash", summary: "ls" }),
      ev({ kind: "tool.end", callId: "c1", state: "success", summary: "3 files" }),
    ]);
    expect(items).toHaveLength(1);
    const t = items[0] as ToolItem;
    expect(t.state).toBe("success");
    expect(t.result).toBe("3 files");
    expect(t.input).toBe("ls");
  });

  it("孤儿 tool.end(历史被截断)也能显示", () => {
    const items = applyEvent([], ev({ kind: "tool.end", callId: "cX", state: "failed", summary: "boom" }));
    expect(items).toHaveLength(1);
    expect((items[0] as ToolItem).state).toBe("failed");
  });

  it("多个工具并发时各自回填,不串台", () => {
    const items = applyEvents([], [
      ev({ kind: "tool.start", msgId: "m1", callId: "c1", tool: "read", summary: "a.ts" }),
      ev({ kind: "tool.start", msgId: "m1", callId: "c2", tool: "bash", summary: "pwd" }),
      ev({ kind: "tool.end", callId: "c2", state: "success", summary: "/tmp" }),
    ]);
    const tools = items.filter((i): i is ToolItem => i.type === "tool");
    expect(tools.map((t) => t.state)).toEqual(["running", "success"]);
    expect(tools[1]!.result).toBe("/tmp");
  });

  it("审批解决后卡片转只读并退出待办", () => {
    let items: ChatItem[] = applyEvent([], ev({
      kind: "permission.request",
      reqId: "p1",
      action: "bash",
      resources: ["rm -rf build"],
      summary: "运行命令",
    }));
    expect(pendingPermissions(items)).toHaveLength(1);
    items = applyEvent(items, ev({ kind: "permission.resolved", reqId: "p1", reply: "reject" }));
    expect(pendingPermissions(items)).toHaveLength(0);
    expect((items[0] as PermissionItem).resolved).toBe("reject");
    expect(items).toHaveLength(1);
  });

  it("未知 reqId 的 resolved 被忽略,不产生幽灵条目", () => {
    const items = applyEvent([], ev({ kind: "permission.resolved", reqId: "nope", reply: "once" }));
    expect(items).toEqual([]);
  });

  it("完整一轮对话的条目顺序符合预期", () => {
    const items = applyEvents([], [
      ev({ kind: "user.message", msgId: "u1", text: "跑测试" }),
      ev({ kind: "reasoning.delta", msgId: "m1", delta: "先看看" }),
      ev({ kind: "tool.start", msgId: "m1", callId: "c1", tool: "bash", summary: "npm test" }),
      ev({ kind: "permission.request", reqId: "p1", action: "bash", resources: ["npm test"], summary: "运行" }),
      ev({ kind: "permission.resolved", reqId: "p1", reply: "once" }),
      ev({ kind: "tool.end", callId: "c1", state: "success", summary: "24 passed" }),
      ev({ kind: "text.delta", msgId: "m1", textId: "t1", delta: "全部通过" }),
      ev({ kind: "turn.end", msgId: "m1", finish: "stop" }),
    ]);
    expect(items.map((i) => i.type)).toEqual([
      "user",
      "assistant",
      "tool",
      "permission",
    ]);
    const a = items[1] as AssistantItem;
    expect(a.text).toBe("全部通过");
    expect(a.done).toBe(true);
    expect((items[2] as ToolItem).result).toBe("24 passed");
  });

  it("快照重放与逐条应用结果一致(重连一致性)", () => {
    const events: AgentEventBody[] = [
      ev({ kind: "user.message", msgId: "u1", text: "hi" }),
      ev({ kind: "text.delta", msgId: "m1", textId: "t1", delta: "he" }),
      ev({ kind: "text.delta", msgId: "m1", textId: "t1", delta: "llo" }),
      ev({ kind: "turn.end", msgId: "m1" }),
    ];
    const streamed = events.reduce<ChatItem[]>((acc, e) => applyEvent(acc, e), []);
    const replayed = applyEvents([], events);
    expect(replayed).toEqual(streamed);
  });

  it("agent.error 作为独立条目追加", () => {
    const items = applyEvents([], [
      ev({ kind: "text.delta", msgId: "m1", textId: "t1", delta: "x" }),
      ev({ kind: "agent.error", message: "provider auth failed" }),
    ]);
    expect(items.map((i) => i.type)).toEqual(["assistant", "error"]);
  });
});
