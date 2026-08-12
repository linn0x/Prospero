import { describe, expect, it } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";
import {
  applyEvent,
  applyEvents,
  applyToolOutput,
  foldChatItems,
  itemsForAgent,
  pendingInteractions,
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
    expect(a.finish).toEqual({ reason: "stop", costUsd: 0.002, outputTokens: 7 });
  });

  it("turn.end 汇总本轮文件改动，同一路径采用最终 diff", () => {
    const items = applyEvents([], [
      ev({ kind: "user.message", msgId: "u1", text: "改两个文件" }),
      ev({
        kind: "tool.start",
        msgId: "m1",
        callId: "c1",
        tool: "edit",
        summary: "预览 a.ts",
        diff: { path: "src/a.ts", patch: "+one", additions: 1, deletions: 0 },
      }),
      ev({
        kind: "tool.end",
        callId: "c1",
        state: "success",
        summary: "写入 a.ts",
        diff: { path: "src/a.ts", patch: "-old\n+new", additions: 3, deletions: 2 },
      }),
      ev({
        kind: "permission.request",
        reqId: "p1",
        action: "edit",
        resources: ["src/b.ts"],
        summary: "写入 b.ts",
        diff: { path: "src/b.ts", patch: "+four", additions: 4, deletions: 0 },
      }),
      ev({ kind: "permission.resolved", reqId: "p1", reply: "once" }),
      ev({ kind: "text.delta", msgId: "m1", textId: "t1", delta: "改好了" }),
      ev({ kind: "turn.end", msgId: "m1", finish: "stop" }),
    ]);
    expect(items.at(-1)).toEqual({
      type: "turn-diff-summary",
      key: "d:m1",
      msgId: "m1",
      files: [
        { path: "src/a.ts", additions: 3, deletions: 2 },
        { path: "src/b.ts", additions: 4, deletions: 0 },
      ],
      additions: 7,
      deletions: 2,
    });
  });

  it("用户图片只保留可按需读取的轻量索引，不进入文本内容", () => {
    const items = applyEvent([], ev({
      kind: "user.message",
      msgId: "u-image",
      text: "这个报错怎么修？",
      attachments: [{ id: "image-1.png", mimeType: "image/png", name: "crash.png" }],
    }));
    expect(items[0]).toMatchObject({
      type: "user",
      msgId: "u-image",
      text: "这个报错怎么修？",
      attachments: [{ id: "image-1.png", name: "crash.png" }],
    });
  });

  it("每轮 diff 独立汇总，重复 turn.end 不会重复添加", () => {
    let items = applyEvents([], [
      ev({ kind: "tool.start", msgId: "m1", callId: "a", tool: "edit", summary: "a", diff: {
        path: "a.ts", patch: "+a", additions: 1, deletions: 0,
      } }),
      ev({ kind: "text.delta", msgId: "m1", textId: "t1", delta: "第一轮" }),
      ev({ kind: "turn.end", msgId: "m1" }),
      ev({ kind: "user.message", msgId: "u2", text: "继续" }),
      ev({ kind: "tool.start", msgId: "m2", callId: "b", tool: "edit", summary: "b", diff: {
        path: "b.ts", patch: "+b", additions: 2, deletions: 1,
      } }),
      ev({ kind: "text.delta", msgId: "m2", textId: "t2", delta: "第二轮" }),
      ev({ kind: "turn.end", msgId: "m2" }),
    ]);
    items = applyEvent(items, ev({ kind: "turn.end", msgId: "m2" }));
    const summaries = items.filter((item) => item.type === "turn-diff-summary");
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(summaries[1]?.files.map((file) => file.path)).toEqual(["b.ts"]);
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

  it("按需工具输出会保留服务端截断标记", () => {
    const started = applyEvent([], ev({
      kind: "tool.start", msgId: "m1", callId: "c1", tool: "bash", summary: "npm test",
    }));
    const items = applyToolOutput(started, "c1", "very long output", true);
    expect(items[0]).toMatchObject({
      type: "tool",
      fullOutput: "very long output",
      outputTruncated: true,
    });
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

  it("Agent 原生问题进入待处理，回答后卡片保留但退出待办", () => {
    let items = applyEvent([], ev({
      kind: "question.request",
      reqId: "q1",
      questions: [{
        id: "scope",
        header: "范围",
        question: "先做哪一端？",
        options: [{ label: "iOS" }, { label: "Mac" }],
        multiSelect: false,
        allowOther: true,
      }],
    }));
    expect(pendingInteractions(items)).toHaveLength(1);
    items = applyEvent(items, ev({
      kind: "question.resolved",
      reqId: "q1",
      answers: [{ questionId: "scope", values: ["iOS"] }],
    }));
    expect(pendingInteractions(items)).toHaveLength(0);
    expect(items[0]).toMatchObject({ type: "question", answers: [{ values: ["iOS"] }] });
  });

  it("主会话与子 Agent 事件按 agentId 分流，生命周期卡只在主会话显示", () => {
    const items = applyEvents([], [
      ev({
        kind: "subagent.started",
        subagent: {
          id: "child-1",
          name: "reviewer",
          status: "running",
          canMessage: true,
          createdAt: 1,
          updatedAt: 1,
        },
      }),
      ev({ kind: "text.delta", msgId: "main", textId: "main", delta: "主回复" }),
      ev({
        kind: "text.delta",
        msgId: "child",
        textId: "child",
        delta: "子回复",
        agentId: "child-1",
      }),
      ev({ kind: "user.message", msgId: "u", text: "人工引导", agentId: "child-1" }),
    ]);
    expect(itemsForAgent(items).map((item) => item.type)).toEqual(["subagent", "assistant"]);
    const child = itemsForAgent(items, "child-1");
    expect(child.map((item) => item.type)).toEqual(["assistant", "user"]);
    expect((child[0] as AssistantItem).text).toBe("子回复");
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

  it("连续三个已完成活动自动折叠", () => {
    const items = applyEvents([], [
      ev({ kind: "tool.start", msgId: "m", callId: "a", tool: "read", summary: "a" }),
      ev({ kind: "tool.end", callId: "a", state: "success", summary: "ok" }),
      ev({ kind: "permission.auto", reqId: "p", action: "read", summary: "读取", policy: "standard" }),
      ev({ kind: "tool.start", msgId: "m", callId: "b", tool: "bash", summary: "test" }),
      ev({ kind: "tool.end", callId: "b", state: "success", summary: "ok" }),
    ]);
    const display = foldChatItems(items);
    expect(display).toHaveLength(1);
    expect(display[0]?.type).toBe("activity-group");
    if (display[0]?.type === "activity-group") expect(display[0].items).toHaveLength(3);
  });

  it("运行中、失败与待审批活动不折叠", () => {
    const items = applyEvents([], [
      ev({ kind: "tool.start", msgId: "m", callId: "ok", tool: "read", summary: "a" }),
      ev({ kind: "tool.end", callId: "ok", state: "success", summary: "ok" }),
      ev({ kind: "tool.start", msgId: "m", callId: "running", tool: "bash", summary: "watch" }),
      ev({ kind: "tool.start", msgId: "m", callId: "bad", tool: "bash", summary: "bad" }),
      ev({ kind: "tool.end", callId: "bad", state: "failed", summary: "boom" }),
      ev({ kind: "permission.request", reqId: "wait", action: "bash", resources: ["rm x"], summary: "删除" }),
    ]);
    expect(foldChatItems(items).map((item) => item.type)).toEqual([
      "tool",
      "tool",
      "tool",
      "permission",
    ]);
  });

  it("只有两个已完成活动时保持逐项展示", () => {
    const items = applyEvents([], [
      ev({ kind: "permission.auto", reqId: "a", action: "read", summary: "a", policy: "yolo" }),
      ev({ kind: "permission.auto", reqId: "b", action: "read", summary: "b", policy: "yolo" }),
    ]);
    expect(foldChatItems(items).map((item) => item.type)).toEqual(["permission", "permission"]);
  });
});
