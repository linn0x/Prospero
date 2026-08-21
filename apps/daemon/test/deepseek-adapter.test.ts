import { describe, expect, it } from "vitest";
import type { AgentEventBody, ApprovalPolicy } from "@prospero/protocol";
import {
  DeepseekAdapter,
  type DeepseekTransport,
} from "../src/adapters/deepseek.js";

class FakeTransport implements DeepseekTransport {
  readonly calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  readonly responses: Array<{ rpcId: string; result: { ok: boolean; value?: unknown; error?: unknown } }> = [];
  historyEvents: Array<{ event: Record<string, unknown> }> = [];
  handler: ((rpcId: string, frame: Record<string, unknown> & { type: string }) => void) | null = null;

  async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, payload });
    if (method === "session.create") return {
      sessionId: payload["sessionId"] ?? "dsh-session-1",
      ...(typeof payload["agentPreset"] === "string" ? { agentPreset: payload["agentPreset"] } : {}),
    } as T;
    if (method === "session.history") return { events: this.historyEvents, hasMore: false } as T;
    if (method === "session.models" || method === "llm.models") {
      return {
        ...(method === "session.models"
          ? { current: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high" } }
          : {}),
        groups: [{
          id: "deepseek-official",
          name: "DeepSeek",
          models: [{
            id: "deepseek-v4-flash",
            name: "V4 Flash",
            reasoning: { efforts: [{ id: "low" }, { id: "high" }], defaultEffort: "high" },
          }],
        }],
      } as T;
    }
    if (method === "session.selectModel") {
      return { selected: {
        provider: payload["provider"],
        model: payload["model"],
        reasoningEffort: payload["reasoningEffort"],
      } } as T;
    }
    if (method === "agentPreset.list") {
      return {
        presets: [
          { id: "default", name: "Default", isDefault: true, trust: "builtin" },
          { id: "reviewer", name: "Reviewer", description: "Review changes", trust: "user" },
        ],
      } as T;
    }
    return { accepted: true } as T;
  }

  async respond(rpcId: string, result: { ok: boolean; value?: unknown; error?: unknown }): Promise<void> {
    this.responses.push({ rpcId, result });
  }

  subscribe(_sessionId: string, handler: (rpcId: string, frame: Record<string, unknown> & { type: string }) => void): () => void {
    this.handler = handler;
    return () => { this.handler = null; };
  }

  emit(rpcId: string, frame: Record<string, unknown> & { type: string }): void {
    this.handler?.(rpcId, frame);
  }
}

function context(
  events: AgentEventBody[],
  states: Record<string, unknown>[],
  approvalPolicy?: ApprovalPolicy,
) {
  return {
    cwd: "D:\\work\\project",
    emit: (event: AgentEventBody) => events.push(event),
    persistState: (state: Record<string, unknown>) => states.push(state),
    ...(approvalPolicy ? { approvalPolicy: () => approvalPolicy } : {}),
  };
}

describe("DeepseekAdapter", () => {
  it("creates and restores native Harness sessions", async () => {
    const transport = new FakeTransport();
    const states: Record<string, unknown>[] = [];
    const adapter = new DeepseekAdapter({
      transport,
      resumeState: { sessionId: "existing-session" },
    });
    await adapter.start(context([], states));

    expect(transport.calls[0]).toEqual({
      method: "session.create",
      payload: { cwd: "D:\\work\\project", sessionId: "existing-session" },
    });
    expect(states).toEqual([{ sessionId: "existing-session" }]);

    await adapter.send("检查项目", [{ mimeType: "image/png", dataB64: "aGVsbG8=", name: "shot.png" }]);
    expect(transport.calls.at(-1)).toEqual({
      method: "session.prompt",
      payload: {
        sessionId: "existing-session",
        mode: "queue",
        content: [
          { type: "text", text: "检查项目" },
          { type: "image", mediaType: "image/png", data: "aGVsbG8=", name: "shot.png" },
        ],
      },
    });
  });

  it("normalizes stream, tool and usage events", async () => {
    const transport = new FakeTransport();
    const events: AgentEventBody[] = [];
    const outputs: Array<[string, string]> = [];
    const adapter = new DeepseekAdapter({ transport });
    await adapter.start({
      ...context(events, []),
      recordOutput: (callId, output) => outputs.push([callId, output]),
    });

    const sessionId = "dsh-session-1";
    const sessionEvent = (type: string, data: Record<string, unknown>) =>
      transport.emit(crypto.randomUUID(), { type: "session/event", sessionId, event: { type, data } });
    sessionEvent("turn/start", { turn: 3 });
    sessionEvent("assistant/chunk", { turn: 3, step: 1, chunk: { type: "text-delta", text: "完成" } });
    sessionEvent("assistant/chunk", { turn: 3, step: 1, chunk: { type: "reasoning-delta", text: "分析" } });
    sessionEvent("tool/call", { turn: 3, step: 1, callId: "call-1", name: "bash", arguments: "{\"command\":\"pwd\"}" });
    sessionEvent("tool/result", {
      turn: 3,
      step: 1,
      message: {
        source: { callId: "call-1" },
        content: [{ type: "tool-result", content: [{ type: "text", text: "D:/work/project" }] }],
      },
    });
    sessionEvent("assistant/message", { turn: 3, step: 1, usage: { inputTokens: 20, outputTokens: 7 } });
    sessionEvent("turn/end", { turn: 3, reason: { kind: "completed" } });

    expect(events).toContainEqual({
      kind: "text.delta",
      msgId: "deepseek_3_1",
      textId: "deepseek_3_1",
      delta: "完成",
    });
    expect(events).toContainEqual({ kind: "reasoning.delta", msgId: "deepseek_3_1", delta: "分析" });
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool.start", callId: "call-1", tool: "bash" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool.end", callId: "call-1", state: "success" }));
    expect(events.at(-1)).toEqual({
      kind: "turn.end",
      msgId: "deepseek_3_1",
      finish: "completed",
      inputTokens: 20,
      outputTokens: 7,
    });
    expect(outputs).toEqual([["call-1", "D:/work/project"]]);
  });

  it("catches up missed history and deduplicates the following live replay", async () => {
    const transport = new FakeTransport();
    transport.historyEvents = [
      { event: { seq: 10, type: "turn/start", data: { turn: 2 } } },
      {
        event: {
          seq: 11,
          type: "assistant/chunk",
          data: { turn: 2, step: 1, chunk: { type: "text-delta", text: "已补回" } },
        },
      },
      { event: { seq: 12, type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } } },
    ];
    const events: AgentEventBody[] = [];
    const adapter = new DeepseekAdapter({ transport });
    await adapter.start(context(events, []));

    expect(events.filter((event) => event.kind !== "trajectory.record")).toEqual([
      { kind: "text.delta", msgId: "deepseek_2_1", textId: "deepseek_2_1", delta: "已补回" },
      { kind: "turn.end", msgId: "deepseek_2_1", finish: "completed" },
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "trajectory.record",
      recordId: "turn_2",
      phase: "completed",
    }));

    transport.emit("live-replay", {
      type: "session/event",
      sessionId: "dsh-session-1",
      event: transport.historyEvents[1]!.event,
    });
    expect(events.filter((event) => event.kind !== "trajectory.record")).toHaveLength(2);
  });

  it("resumes from the persisted Harness event cursor without replaying old answers", async () => {
    const transport = new FakeTransport();
    transport.historyEvents = [{
      event: {
        seq: 12,
        type: "assistant/chunk",
        data: { turn: 2, step: 1, chunk: { type: "text-delta", text: "旧回答" } },
      },
    }];
    const events: AgentEventBody[] = [];
    const adapter = new DeepseekAdapter({
      transport,
      resumeState: { sessionId: "dsh-session-1", lastSeq: 12 },
    });
    await adapter.start(context(events, []));
    expect(events).toEqual([]);
  });

  it("yolo 策略自动批准,不再打断用户,但保留 permission.auto 审计事件", async () => {
    const transport = new FakeTransport();
    const events: AgentEventBody[] = [];
    const adapter = new DeepseekAdapter({ transport });
    await adapter.start(context(events, [], "yolo"));

    transport.emit("approval-rpc", {
      type: "approval/requested",
      sessionId: "dsh-session-1",
      approvalId: "approval-1",
      toolName: "bash",
      reason: "运行测试",
    });
    await Promise.resolve();

    // 不能再向手机发审批请求
    expect(events.some((e) => e.kind === "permission.request")).toBe(false);
    expect(events.at(-1)).toEqual({
      kind: "permission.auto",
      reqId: "approval-1",
      action: "bash",
      policy: "yolo",
      summary: "运行测试",
    });
    // 且必须真的答复 dsh,否则 Harness 会一直卡在等待批准
    expect(transport.responses[0]).toEqual({
      rpcId: "approval-rpc",
      result: {
        ok: true,
        value: {
          sessionId: "dsh-session-1",
          approvalId: "approval-1",
          outcome: "allowed-once",
        },
      },
    });
  });

  it("回答一个不在待答表里的问题时报错,而不是把答案悄悄丢掉", async () => {
    const transport = new FakeTransport();
    const events: AgentEventBody[] = [];
    const adapter = new DeepseekAdapter({ transport });
    await adapter.start(context(events, []));

    // 手机上点了"提交回答",但这个 reqId 已经不在待答表里(已答过/会话重启)。
    // 静默 return 会让 UI 毫无反应,用户只能干等对面超时取消。
    await expect(adapter.respondQuestion("unknown-question", [
      { questionId: "choice", values: ["修复"] },
    ])).rejects.toThrow("unknown-question");
    expect(transport.responses).toHaveLength(0);
  });

  it("standard 策略只放行只读工具,写操作仍然要问", async () => {
    const transport = new FakeTransport();
    const events: AgentEventBody[] = [];
    const adapter = new DeepseekAdapter({ transport });
    await adapter.start(context(events, [], "standard"));

    transport.emit("read-rpc", {
      type: "approval/requested",
      sessionId: "dsh-session-1",
      approvalId: "approval-read",
      toolName: "read_file",
      reason: "查看配置",
    });
    await Promise.resolve();
    expect(events.at(-1)?.kind).toBe("permission.auto");

    transport.emit("write-rpc", {
      type: "approval/requested",
      sessionId: "dsh-session-1",
      approvalId: "approval-write",
      toolName: "bash",
      reason: "删除文件",
    });
    await Promise.resolve();
    expect(events.at(-1)?.kind).toBe("permission.request");
  });

  it("restores assembled DeepSeek history and its trajectory without raw chunks", async () => {
    const transport = new FakeTransport();
    transport.historyEvents = [
      {
        event: {
          seq: 1,
          time: 1_000,
          type: "user/message",
          data: { id: "user-1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "检查项目" }] },
        },
      },
      { event: { seq: 2, time: 1_100, type: "turn/start", data: { turn: 1 } } },
      { event: { seq: 3, time: 1_200, type: "step/start", data: { turn: 1, step: 0 } } },
      {
        event: {
          seq: 4,
          time: 1_900,
          type: "assistant/message",
          data: {
            turn: 1,
            step: 0,
            message: { id: "assistant-1", content: [{ type: "reasoning", text: "分析" }, { type: "text", text: "已完成" }] },
            usage: { inputTokens: 12, outputTokens: 4 },
          },
        },
      },
      { event: { seq: 5, time: 2_000, type: "step/end", data: { turn: 1, step: 0 } } },
      { event: { seq: 6, time: 2_100, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } },
    ];
    const events: AgentEventBody[] = [];
    const adapter = new DeepseekAdapter({ transport });
    await adapter.start(context(events, []));

    expect(events).toContainEqual({ kind: "user.message", msgId: "user-1", text: "检查项目" });
    expect(events).toContainEqual({ kind: "reasoning.delta", msgId: "assistant-1", delta: "分析" });
    expect(events).toContainEqual({ kind: "text.delta", msgId: "assistant-1", textId: "assistant-1", delta: "已完成" });
    expect(events).toContainEqual(expect.objectContaining({
      kind: "trajectory.record",
      recordId: "request_1_0",
      durationMs: 700,
      inputTokens: 12,
      outputTokens: 4,
    }));
    expect(events.at(-1)).toEqual({
      kind: "turn.end",
      msgId: "assistant-1",
      finish: "completed",
      inputTokens: 12,
      outputTokens: 4,
    });
  });

  it("maps model context, turn duration and compaction lifecycle into trajectory records", async () => {
    const transport = new FakeTransport();
    transport.historyEvents = [
      { event: { seq: 1, time: 100, type: "turn/start", data: { turn: 4 } } },
      {
        event: {
          seq: 2,
          time: 150,
          type: "request/context",
          data: { provider: "deepseek-official", model: "deepseek-v4-flash", contextWindow: 128_000 },
        },
      },
      { event: { seq: 3, time: 200, type: "compaction/start", data: { compactionId: "compact-1", turn: 4 } } },
      {
        event: {
          seq: 4,
          time: 500,
          type: "compaction/summary",
          data: {
            compactionId: "compact-1",
            summary: "保留关键上下文",
            usage: { inputTokens: 30, outputTokens: 8 },
          },
        },
      },
      { event: { seq: 5, time: 700, type: "compaction/end", data: { compactionId: "compact-1", turn: 4 } } },
      { event: { seq: 6, time: 900, type: "turn/end", data: { turn: 4, reason: { kind: "completed" } } } },
    ];
    const events: AgentEventBody[] = [];
    const adapter = new DeepseekAdapter({ transport });
    await adapter.start(context(events, []));

    expect(events).toContainEqual(expect.objectContaining({
      kind: "trajectory.record",
      recordId: "context_2",
      detail: "deepseek-official/deepseek-v4-flash · 128000 tokens",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "trajectory.record",
      recordId: "compaction_compact-1",
      phase: "completed",
      detail: "保留关键上下文",
      durationMs: 500,
      inputTokens: 30,
      outputTokens: 8,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "trajectory.record",
      recordId: "turn_4",
      phase: "completed",
      durationMs: 800,
    }));
  });

  it("applies the selected preset, model and reasoning effort to a new session", async () => {
    const transport = new FakeTransport();
    const states: Record<string, unknown>[] = [];
    const adapter = new DeepseekAdapter({
      transport,
      resumeState: {
        agentPreset: "reviewer",
        model: "deepseek-official/deepseek-v4-flash",
        effort: "low",
      },
    });
    await adapter.start(context([], states));

    expect(transport.calls).toContainEqual({
      method: "session.create",
      payload: { cwd: "D:\\work\\project", agentPreset: "reviewer" },
    });
    expect(transport.calls).toContainEqual({
      method: "session.selectModel",
      payload: {
        sessionId: "dsh-session-1",
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "low",
      },
    });
    expect(states.at(-1)).toEqual({
      sessionId: "dsh-session-1",
      agentPreset: "reviewer",
      model: "deepseek-official/deepseek-v4-flash",
      effort: "low",
    });
  });

  it("answers approval and question server requests through /api/respond semantics", async () => {
    const transport = new FakeTransport();
    const events: AgentEventBody[] = [];
    const adapter = new DeepseekAdapter({ transport });
    await adapter.start(context(events, []));

    transport.emit("approval-rpc", {
      type: "approval/requested",
      sessionId: "dsh-session-1",
      approvalId: "approval-1",
      toolName: "bash",
      reason: "运行测试",
    });
    await adapter.respondPermission("approval-1", "always");
    expect(transport.responses[0]).toEqual({
      rpcId: "approval-rpc",
      result: {
        ok: true,
        value: {
          sessionId: "dsh-session-1",
          approvalId: "approval-1",
          outcome: "allowed-once",
        },
      },
    });
    transport.emit("resolved-rpc", {
      type: "approval/resolved",
      sessionId: "dsh-session-1",
      approvalId: "approval-1",
      outcome: "allowed-once",
    });
    expect(events.at(-1)).toEqual({ kind: "permission.resolved", reqId: "approval-1", reply: "always" });

    transport.emit("question-rpc", {
      type: "question/requested",
      sessionId: "dsh-session-1",
      questions: [{ id: "choice", header: "方式", question: "如何继续？", options: [{ label: "修复" }] }],
    });
    await adapter.respondQuestion("question-rpc", [{ questionId: "choice", values: ["修复"] }]);
    expect(transport.responses.at(-1)).toEqual({
      rpcId: "question-rpc",
      result: {
        ok: true,
        value: {
          sessionId: "dsh-session-1",
          answer: { answers: [{ id: "choice", selected: ["修复"] }] },
        },
      },
    });
  });

  it("exposes and selects Harness model routes", async () => {
    const transport = new FakeTransport();
    const states: Record<string, unknown>[] = [];
    const adapter = new DeepseekAdapter({ transport });
    await adapter.start(context([], states));

    await expect(adapter.listModels()).resolves.toEqual({
      models: [{
        id: "deepseek-official/deepseek-v4-flash",
        label: "DeepSeek · V4 Flash",
        supportedEfforts: ["low", "high"],
        defaultEffort: "high",
        isDefault: true,
      }],
      currentModel: "deepseek-official/deepseek-v4-flash",
      currentEffort: "high",
      presets: [
        { id: "default", name: "Default", isDefault: true },
        { id: "reviewer", name: "Reviewer", description: "Review changes", custom: true },
      ],
    });
    await expect(adapter.setModel("deepseek-official/deepseek-v4-flash", "low")).resolves.toEqual({
      currentModel: "deepseek-official/deepseek-v4-flash",
      currentEffort: "low",
    });
    expect(states.at(-1)).toEqual({
      sessionId: "dsh-session-1",
      model: "deepseek-official/deepseek-v4-flash",
      effort: "low",
    });
  });

  it("reads launch catalogs without creating an empty Harness session", async () => {
    const transport = new FakeTransport();
    const adapter = new DeepseekAdapter({ transport });
    await adapter.start({ ...context([], []), catalogOnly: true });

    await expect(adapter.listModels()).resolves.toEqual({
      models: [{
        id: "deepseek-official/deepseek-v4-flash",
        label: "DeepSeek · V4 Flash",
        supportedEfforts: ["low", "high"],
        defaultEffort: "high",
      }],
      presets: [
        { id: "default", name: "Default", isDefault: true },
        { id: "reviewer", name: "Reviewer", description: "Review changes", custom: true },
      ],
    });
    expect(transport.calls.some((call) => call.method === "session.create")).toBe(false);
    expect(transport.calls).toContainEqual({ method: "llm.models", payload: {} });
    expect(transport.calls).toContainEqual({ method: "agentPreset.list", payload: {} });
  });
});
