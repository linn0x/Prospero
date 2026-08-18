/**
 * 流式增量的归并键回归测试(不需要真实 CLI,mock 掉 SDK)。
 *
 * 真实事故:Claude Code 接 DeepSeek V4 时,一轮对话在手机上刷出上百张只有
 * 几个字的"思考过程"卡片。thinking 在整条消息的最前面流式吐出,而当时的
 * 归并键取自"已完成的 assistant 消息" —— 轮首拿不到就退化成每个
 * stream_event 各自的 uuid(一个 token 一个气泡),轮中拿到的则是上一步的
 * 消息 id(本步 thinking 被挂到上一个气泡上)。
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";

const sdk = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    [Symbol.asyncIterator]: async function* () {
      for (const message of sdk.messages) yield message;
    },
    interrupt: async () => {},
  }),
}));

const { ClaudeAdapter } = await import("../src/adapters/claude.js");

/** 一条流式消息:message_start → 各块增量 → message_stop */
function streamed(
  msgId: string,
  blocks: Array<{ thinking?: string; text?: string }>,
): unknown[] {
  const events: unknown[] = [
    { type: "stream_event", uuid: `u-start-${msgId}`, event: { type: "message_start", message: { id: msgId } } },
  ];
  for (const [index, block] of blocks.entries()) {
    // uuid 每个 stream_event 都不同 —— 正是它当年被误当成归并键
    const delta = block.thinking !== undefined
      ? { type: "thinking_delta", thinking: block.thinking }
      : { type: "text_delta", text: block.text };
    events.push({
      type: "stream_event",
      uuid: `u-${msgId}-${String(index)}`,
      event: { type: "content_block_delta", delta },
    });
  }
  events.push({ type: "stream_event", uuid: `u-stop-${msgId}`, event: { type: "message_stop" } });
  return events;
}

function assistantWithTool(msgId: string, callId: string): unknown {
  return {
    type: "assistant",
    uuid: `u-assistant-${msgId}`,
    message: {
      id: msgId,
      content: [{ type: "tool_use", id: callId, name: "Bash", input: { command: "ls" } }],
    },
  };
}

async function run(messages: unknown[]): Promise<AgentEventBody[]> {
  sdk.messages = messages;
  const events: AgentEventBody[] = [];
  const adapter = new ClaudeAdapter();
  await adapter.start({
    cwd: "/tmp/prospero-test",
    emit: (event: AgentEventBody) => events.push(event),
  } as never);
  // dispose() 会先摘掉 ctx 再等 pump 结束,提前调用就会吞掉尾部事件;
  // 按输入里的 result 条数等本次流真正走完。
  const turns = messages.filter((m) => (m as { type?: string }).type === "result").length;
  for (let i = 0; i < 200 && events.filter((e) => e.kind === "turn.end").length < turns; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await adapter.dispose();
  return events;
}

function msgIdsOf(events: AgentEventBody[], kind: "reasoning.delta" | "text.delta"): string[] {
  return events.filter((e) => e.kind === kind).map((e) => (e as { msgId: string }).msgId);
}

describe("ClaudeAdapter 流式增量归并", () => {
  it("一轮开头的 thinking 归到同一条消息,而不是一个 token 一个气泡", async () => {
    const events = await run([
      ...streamed("m1", [{ thinking: "先" }, { thinking: "看看" }, { thinking: "配置" }]),
      assistantWithTool("m1", "call-1"),
      { type: "result", uuid: "u-result", subtype: "success", usage: {} },
    ]);

    expect(msgIdsOf(events, "reasoning.delta")).toEqual(["m1", "m1", "m1"]);
    // thinking 与它自己那一步的工具卡同属一条消息
    const toolStart = events.find((e) => e.kind === "tool.start") as { msgId: string };
    expect(toolStart.msgId).toBe("m1");
  });

  it("轮内多步:每步的 thinking 归到本步,不落到上一步的气泡", async () => {
    const events = await run([
      ...streamed("m1", [{ thinking: "第一步" }]),
      assistantWithTool("m1", "call-1"),
      { type: "user", uuid: "u-tool-result", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] } },
      ...streamed("m2", [{ thinking: "第二步" }, { text: "查完了" }]),
      { type: "assistant", uuid: "u-assistant-m2", message: { id: "m2", content: [{ type: "text", text: "查完了" }] } },
      { type: "result", uuid: "u-result", subtype: "success", usage: {} },
    ]);

    expect(msgIdsOf(events, "reasoning.delta")).toEqual(["m1", "m2"]);
    expect(msgIdsOf(events, "text.delta")).toEqual(["m2"]);
  });

  it("跨轮:新一轮的 thinking 不会退化成逐事件 uuid", async () => {
    const events = await run([
      ...streamed("m1", [{ text: "第一轮" }]),
      { type: "assistant", uuid: "u-assistant-m1", message: { id: "m1", content: [{ type: "text", text: "第一轮" }] } },
      { type: "result", uuid: "u-result-1", subtype: "success", usage: {} },
      { type: "user", uuid: "u-user-2", message: { content: "再查一次" } },
      ...streamed("m2", [{ thinking: "用" }, { thinking: "户" }, { thinking: "又问" }]),
      { type: "assistant", uuid: "u-assistant-m2", message: { id: "m2", content: [{ type: "text", text: "好" }] } },
      { type: "result", uuid: "u-result-2", subtype: "success", usage: {} },
    ]);

    expect(new Set(msgIdsOf(events, "reasoning.delta"))).toEqual(new Set(["m2"]));
  });

  it("provider 不给 message_start 时,同一条消息的增量仍共用一个键", async () => {
    const deltas = (thinking: string, index: number): unknown => ({
      type: "stream_event",
      uuid: `u-nostart-${String(index)}`,
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
    });
    const events = await run([
      deltas("没有", 0),
      deltas("message_start", 1),
      { type: "stream_event", uuid: "u-nostart-stop", event: { type: "message_stop" } },
      { type: "result", uuid: "u-result", subtype: "success", usage: {} },
    ]);

    const ids = msgIdsOf(events, "reasoning.delta");
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });
});
