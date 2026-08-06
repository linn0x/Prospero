import { describe, expect, it } from "vitest";
import type {
  AgentQuestionAnswer,
  PermissionReply,
} from "@prospero/protocol";
import type {
  AdapterContext,
  AgentAdapter,
  AgentModeCatalog,
  AgentModeSelection,
  AgentModelCatalog,
  AgentModelSelection,
} from "../src/adapters/types.js";
import { StructuredSession } from "../src/structured-session.js";

class InteractiveAdapter implements AgentAdapter {
  private ctx: AdapterContext | null = null;
  readonly childMessages: Array<{ id: string; text: string }> = [];
  mode = "default";

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    ctx.persistState?.({ model: "native-model", mode: this.mode });
  }

  async send(): Promise<void> {}
  async respondPermission(_reqId: string, _reply: PermissionReply): Promise<void> {}
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}

  async listModels(): Promise<AgentModelCatalog> {
    return {
      models: [{ id: "native-model", label: "Native", supportedEfforts: ["low", "high"] }],
      currentModel: "native-model",
      currentEffort: "low",
    };
  }

  async setModel(model: string, effort?: string): Promise<AgentModelSelection> {
    return { currentModel: model, ...(effort ? { currentEffort: effort } : {}) };
  }

  async listModes(): Promise<AgentModeCatalog> {
    return {
      modes: [{ id: "default", label: "执行" }, { id: "plan", label: "Plan" }],
      currentMode: this.mode,
    };
  }

  async setMode(mode: string): Promise<AgentModeSelection> {
    this.mode = mode;
    this.ctx?.persistState?.({ mode });
    return { currentMode: mode };
  }

  ask(): void {
    this.ctx?.emit({
      kind: "question.request",
      reqId: "question-1",
      questions: [{
        id: "scope",
        header: "范围",
        question: "先做哪一端？",
        options: [{ label: "iOS" }, { label: "Mac" }],
        multiSelect: false,
        allowOther: true,
      }],
    });
  }

  async respondQuestion(
    reqId: string,
    answers: AgentQuestionAnswer[],
    cancelled = false,
  ): Promise<void> {
    this.ctx?.emit({
      kind: "question.resolved",
      reqId,
      answers,
      ...(cancelled ? { cancelled: true } : {}),
    });
  }

  spawnChild(): void {
    this.ctx?.emit({
      kind: "subagent.started",
      subagent: {
        id: "child-1",
        name: "reviewer",
        task: "检查实现",
        status: "running",
        canMessage: true,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    this.ctx?.emit({
      kind: "text.delta",
      msgId: "child-answer",
      textId: "child-answer",
      delta: "正在检查",
      agentId: "child-1",
    });
  }

  async sendToSubagent(subagentId: string, text: string): Promise<void> {
    this.childMessages.push({ id: subagentId, text });
  }
}

describe("结构化 Agent 原生交互", () => {
  it("模型/Plan 能力写进会话状态并持久化选择", async () => {
    const adapter = new InteractiveAdapter();
    const session = new StructuredSession({
      id: "controls",
      agent: "codex",
      title: "codex · controls",
      cwd: "/tmp",
      adapter,
    });
    await session.start();
    expect(session.info().agentControls).toMatchObject({
      compact: false,
      model: true,
      mode: true,
      currentModel: "native-model",
      currentMode: "default",
    });
    expect((await session.models()).models[0]?.id).toBe("native-model");
    expect(await session.setMode("plan")).toEqual({ currentMode: "plan" });
    expect(session.info().agentControls?.currentMode).toBe("plan");
    expect(session.persistentState().adapterState).toMatchObject({ mode: "plan" });
    await session.dispose();
  });

  it("问题驱动 waiting_input，回答后恢复；子 Agent 可查看并人工发消息", async () => {
    const adapter = new InteractiveAdapter();
    const session = new StructuredSession({
      id: "interactions",
      agent: "claude",
      title: "claude · interactions",
      cwd: "/tmp",
      adapter,
    });
    await session.start();
    adapter.ask();
    expect(session.info()).toMatchObject({ status: "waiting_input", pendingQuestions: 1 });
    await session.respondQuestion("question-1", [
      { questionId: "scope", values: ["iOS"] },
    ]);
    expect(session.info().pendingQuestions).toBe(0);

    adapter.spawnChild();
    expect(session.info().subagents?.[0]).toMatchObject({
      id: "child-1",
      name: "reviewer",
      status: "running",
      preview: "正在检查",
    });
    await session.sendToSubagent("child-1", "先跑移动端测试");
    expect(adapter.childMessages).toEqual([{ id: "child-1", text: "先跑移动端测试" }]);
    expect(
      session.snapshot().events.some(
        (event) =>
          event.kind === "user.message" &&
          event.agentId === "child-1" &&
          event.text === "先跑移动端测试",
      ),
    ).toBe(true);
    await session.dispose();
  });
});
