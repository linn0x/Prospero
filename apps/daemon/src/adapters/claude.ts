/**
 * Claude Code 适配器(基于 @anthropic-ai/claude-agent-sdk 0.3.x)。
 *
 * 与 opencode 适配器的形态差异:
 * - opencode 是"外部 server + SSE 订阅",这里是 SDK 在 daemon 进程内直接跑 query()
 * - 审批不是事件,而是 canUseTool 回调:必须挂起等手机回复,再 resolve 成
 *   PermissionResult。这里把回调 promise 存进 pending 表,由 respondPermission 兑现。
 *
 * 输入用 streaming 模式(AsyncIterable):这是 interrupt()/多轮对话的前提;
 * 一问一答式的 string prompt 无法支持中断与续话。
 */
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  EffortLevel,
  ModelInfo,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEventBody,
  AgentQuestion,
  AgentQuestionAnswer,
  Attachment,
  PermissionReply,
  SubagentStatus,
} from "@prospero/protocol";
import { needsApproval } from "../approval-policy.js";
import { diffFromToolInput } from "./diff.js";
import {
  AdapterError,
  summarize,
  type AdapterContext,
  type AdapterResumeState,
  type AgentAdapter,
  type AgentModeCatalog,
  type AgentModeSelection,
  type AgentModelCatalog,
  type AgentModelSelection,
  type UsageReport,
} from "./types.js";

interface PendingPermission {
  resolve(result: PermissionResult): void;
  /** 原始入参;允许时原样回传给 SDK */
  input: Record<string, unknown>;
  /** 供 "始终允许" 使用:SDK 给出的规则建议 */
  suggestions: PermissionUpdate[];
  toolName: string;
  agentId?: string;
}

interface PendingQuestion {
  resolve(result: PermissionResult): void;
  input: Record<string, unknown>;
  questions: AgentQuestion[];
  nativeQuestionById: Map<string, string>;
  agentId?: string;
}

/** tool_result 的 content 可能是字符串或 block 数组,取其纯文本 */
function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

/** 用户消息队列:把 send() 的调用喂给 SDK 的 AsyncIterable 输入 */
class MessageQueue {
  private readonly queue: SDKUserMessage[] = [];
  private waiting: ((m: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(m: SDKUserMessage): void {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: m, done: false });
      return;
    }
    this.queue.push(m);
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiting = resolve;
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

export interface ClaudeAdapterOptions {
  /** 测试用:限制可用工具,消除模型选路的不确定性 */
  disallowedTools?: string[];
  /** Claude Code 自己落盘的 session；恢复后继续原上下文。 */
  resumeState?: AdapterResumeState | undefined;
}

export class ClaudeAdapter implements AgentAdapter {
  constructor(private readonly opts: ClaudeAdapterOptions = {}) {}

  // Claude's SDK need not expose a child PID: the host process joined the
  // KILL_ON_JOB_CLOSE Job before `query()` can create its runtime.
  readonly durableProviderJobCompatible = true;

  private ctx: AdapterContext | null = null;
  private q: Query | null = null;
  private readonly input = new MessageQueue();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly questionToolIds = new Set<string>();
  private readonly taskAgents = new Map<string, string>();
  /**
   * 已知不是子 Agent 的原生任务。后台 shell 任务(task_type=local_bash 之类)与 Task
   * 工具共用 task_started,只有后者带 subagent_type —— 早先不加区分地全登记成子 Agent,
   * 一个长会话攒出 106 个,越过协议的 100 上限后 hello.ok 整帧作废,手机直连和中继一起连不上。
   */
  private readonly nonSubagentTasks = new Set<string>();
  private readonly subagents = new Map<string, { canMessage: boolean; createdAt: number }>();
  private readonly currentMessageByAgent = new Map<string, string>();
  /** 正在流式输出的消息 id(按 agent);增量事件的归并键只能来自流本身 */
  private readonly streamMessageByAgent = new Map<string, string>();
  private currentMsgId = "";
  private pumping: Promise<void> | null = null;
  private sessionId: string | null = null;
  private selectedModel: string | null = null;
  private selectedEffort: string | null = null;
  private selectedMode: "default" | "plan" = "default";
  private modelCache: ModelInfo[] | null = null;
  private compactWaiter: {
    msgId: string;
    resolve(): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  } | null = null;

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.sessionId =
      typeof this.opts.resumeState?.["sessionId"] === "string"
        ? this.opts.resumeState["sessionId"]
        : null;
    this.selectedModel =
      typeof this.opts.resumeState?.["model"] === "string"
        ? this.opts.resumeState["model"]
        : null;
    this.selectedEffort =
      typeof this.opts.resumeState?.["effort"] === "string"
        ? this.opts.resumeState["effort"]
        : null;
    this.selectedMode = this.opts.resumeState?.["mode"] === "plan" ? "plan" : "default";
    try {
      this.q = query({
        prompt: this.input,
        options: {
          cwd: ctx.cwd,
          env: { ...process.env, ...ctx.env },
          // 全部工具调用都过 canUseTool → 手机审批
          permissionMode: this.selectedMode,
          canUseTool: this.canUseTool,
          includePartialMessages: true,
          forwardSubagentText: true,
          agentProgressSummaries: true,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          ...(this.selectedModel ? { model: this.selectedModel } : {}),
          ...(this.selectedEffort ? { effort: this.selectedEffort as EffortLevel } : {}),
          ...(this.opts.disallowedTools
            ? { disallowedTools: this.opts.disallowedTools }
            : {}),
        },
      });
    } catch (e) {
      throw new AdapterError("无法启动 Claude Code(是否已安装并登录?)", e);
    }
    this.pumping = this.pump();
  }

  private persistNativeState(): void {
    const state: AdapterResumeState = {};
    if (this.sessionId) state["sessionId"] = this.sessionId;
    if (this.selectedModel) state["model"] = this.selectedModel;
    if (this.selectedEffort) state["effort"] = this.selectedEffort;
    state["mode"] = this.selectedMode;
    this.ctx?.persistState?.(state);
  }

  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const agentId = this.resolveAgentId((options as { agentID?: unknown }).agentID);
    if (toolName === "AskUserQuestion") {
      return this.requestUserQuestion(input, options, agentId);
    }
    return new Promise<PermissionResult>((resolve) => {
      const reqId = randomUUID();
      const policy = this.ctx?.approvalPolicy?.() ?? "strict";

      // 策略放行:不等人,但把"这一步被自动批准了"照常发出去。
      // 不打断 ≠ 不告知 —— 聊天里仍要出现这次调用,事后能翻。
      if (!needsApproval(policy, toolName)) {
        this.emit({
          kind: "permission.auto",
          reqId,
          action: options.displayName ?? toolName,
          policy,
          summary: options.title ?? toolName,
          ...(agentId ? { agentId } : {}),
        });
        resolve({ behavior: "allow", updatedInput: input });
        return;
      }
      this.pending.set(reqId, {
        resolve,
        input,
        suggestions: options.suggestions ?? [],
        toolName,
        ...(agentId ? { agentId } : {}),
      });
      // 会话被中止时不能悬着,直接拒绝
      options.signal.addEventListener("abort", () => {
        if (this.pending.delete(reqId)) {
          resolve({ behavior: "deny", message: "会话已中止" });
        }
      });
      const resources: string[] = [];
      const cmd = input["command"] ?? input["file_path"] ?? input["path"];
      if (cmd !== undefined) resources.push(summarize(cmd, 400));
      else resources.push(summarize(input, 400));

      // 改文件类审批必须能看到改动本身,否则手机上只能盲批
      const diff = diffFromToolInput(toolName, input);

      this.emit({
        kind: "permission.request",
        reqId,
        action: options.displayName ?? toolName,
        resources,
        summary: options.title ?? `${toolName}: ${resources[0] ?? ""}`,
        ...(diff ? { diff } : {}),
        ...(agentId ? { agentId } : {}),
      });
    });
  };

  private requestUserQuestion(
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
    agentId?: string,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const reqId = randomUUID();
      const native = Array.isArray(input["questions"]) ? input["questions"] : [];
      const nativeQuestionById = new Map<string, string>();
      const questions = native.flatMap((value, index): AgentQuestion[] => {
        if (!value || typeof value !== "object") return [];
        const row = value as Record<string, unknown>;
        const question = typeof row["question"] === "string" ? row["question"] : "请选择";
        const id = `q${String(index + 1)}`;
        nativeQuestionById.set(id, question);
        const choices = Array.isArray(row["options"])
          ? row["options"].flatMap((value) => {
              if (!value || typeof value !== "object") return [];
              const choice = value as Record<string, unknown>;
              return typeof choice["label"] === "string"
                ? [{
                    label: choice["label"],
                    ...(typeof choice["description"] === "string"
                      ? { description: choice["description"] }
                      : {}),
                    ...(typeof choice["preview"] === "string"
                      ? { preview: choice["preview"] }
                      : {}),
                  }]
                : [];
            })
          : [];
        return [{
          id,
          header: typeof row["header"] === "string" ? row["header"] : "Agent 提问",
          question,
          options: choices,
          multiSelect: row["multiSelect"] === true,
          allowOther: true,
        }];
      });
      if (questions.length === 0) {
        resolve({ behavior: "allow", updatedInput: { ...input, answers: {} } });
        return;
      }
      const toolUseId = (options as { toolUseID?: unknown }).toolUseID;
      if (typeof toolUseId === "string") this.questionToolIds.add(toolUseId);
      this.questions.set(reqId, {
        resolve,
        input,
        questions,
        nativeQuestionById,
        ...(agentId ? { agentId } : {}),
      });
      options.signal.addEventListener("abort", () => {
        if (!this.questions.delete(reqId)) return;
        resolve({ behavior: "deny", message: "会话已中止" });
        this.emit({
          kind: "question.resolved",
          reqId,
          answers: [],
          cancelled: true,
          ...(agentId ? { agentId } : {}),
        });
      });
      this.emit({
        kind: "question.request",
        reqId,
        questions,
        ...(agentId ? { agentId } : {}),
      });
    });
  }

  /**
   * 流式增量的归并键。
   *
   * 只能取自流本身:完整的 assistant 消息要等整条消息结束才到,拿它当键
   * 会把本步的 thinking 挂到上一步的气泡上;而一轮开头连上一步都没有,
   * 就退化成每个 stream_event 各自的 uuid —— 一个 token 一个气泡。
   * DeepSeek V4 这类每步都先思考的模型必现:手机上一轮能刷出几百张
   * 只有几个字的"思考过程"卡片。
   */
  private streamMessageId(agentKey: string): string {
    const streaming = this.streamMessageByAgent.get(agentKey);
    if (streaming) return streaming;
    // provider 没给 message_start 时也要有稳定键,补一个并沿用到本条消息结束
    const generated = randomUUID();
    this.streamMessageByAgent.set(agentKey, generated);
    return generated;
  }

  private emit(body: AgentEventBody): void {
    this.ctx?.emit(body);
  }

  private messageAgent(msg: SDKMessage): string | undefined {
    return this.resolveAgentId((msg as { parent_tool_use_id?: unknown }).parent_tool_use_id);
  }

  /**
   * 原生 id 归一成子 Agent id;不是子 Agent 的任务返回 undefined ——
   * 它的输出与审批要留在主对话里,而不是挂到一个不存在的子 Agent 上。
   */
  private resolveAgentId(raw: unknown): string | undefined {
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    const id = this.taskAgents.get(raw) ?? raw;
    return this.nonSubagentTasks.has(id) ? undefined : id;
  }

  private registerSubagent(
    id: string,
    details: { name?: string; role?: string; task?: string; preview?: string } = {},
  ): void {
    if (!id || this.subagents.has(id)) return;
    const createdAt = Date.now();
    this.subagents.set(id, { canMessage: true, createdAt });
    this.emit({
      kind: "subagent.started",
      subagent: {
        id,
        name: details.name || `Claude 子 Agent ${String(this.subagents.size)}`,
        ...(details.role ? { role: details.role } : {}),
        ...(details.task ? { task: details.task } : {}),
        status: "starting",
        canMessage: true,
        createdAt,
        updatedAt: createdAt,
        ...(details.preview ? { preview: details.preview } : {}),
      },
    });
  }

  private updateSubagent(
    id: string,
    status: SubagentStatus,
    canMessage: boolean,
    summary?: string,
  ): void {
    this.registerSubagent(id);
    const known = this.subagents.get(id);
    if (known) known.canMessage = canMessage;
    this.emit({
      kind: "subagent.updated",
      subagentId: id,
      status,
      canMessage,
      ...(summary ? { summary } : {}),
    });
  }

  /** 消费 SDK 消息流,归一化成 Prospero 事件 */
  private async pump(): Promise<void> {
    const q = this.q;
    if (!q) return;
    try {
      for await (const msg of q) {
        this.onMessage(msg);
      }
    } catch (e) {
      this.emit({
        kind: "agent.error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private onMessage(msg: SDKMessage): void {
    const nativeSessionId = (msg as { session_id?: unknown }).session_id;
    if (typeof nativeSessionId === "string" && nativeSessionId.length > 0) {
      if (nativeSessionId !== this.sessionId) {
        this.sessionId = nativeSessionId;
        this.persistNativeState();
      }
    }
    const agentId = this.messageAgent(msg);
    const agentField = agentId ? { agentId } : {};
    if (agentId) {
      this.registerSubagent(agentId);
      this.updateSubagent(agentId, "running", true);
    }
    switch (msg.type) {
      case "stream_event": {
        // 增量文本:content_block_delta 里的 text_delta
        const ev = msg.event as {
          type?: string;
          message?: { id?: unknown };
          delta?: { type?: string; text?: string; thinking?: string };
        };
        const streamKey = agentId ?? "";
        // 归并键来自 message_start,而不是等整条消息结束才到的 assistant 消息
        if (ev.type === "message_start") {
          const id = ev.message?.id;
          this.streamMessageByAgent.set(
            streamKey,
            typeof id === "string" && id.length > 0 ? id : randomUUID(),
          );
          return;
        }
        if (ev.type === "message_stop") {
          this.streamMessageByAgent.delete(streamKey);
          return;
        }
        if (ev.type !== "content_block_delta") return;
        const msgId = this.streamMessageId(streamKey);
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          this.emit({
            kind: "text.delta",
            msgId,
            textId: msgId,
            delta: ev.delta.text,
            ...agentField,
          });
        } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
          this.emit({
            kind: "reasoning.delta",
            msgId,
            delta: ev.delta.thinking,
            ...agentField,
          });
        }
        return;
      }
      case "assistant": {
        this.currentMessageByAgent.set(agentId ?? "", msg.message.id);
        if (!agentId) this.currentMsgId = msg.message.id;
        // 工具调用在完整消息里出现(增量流只给文本)
        for (const block of msg.message.content) {
          if (typeof block === "object" && block.type === "tool_use") {
            if (block.name === "AskUserQuestion") {
              this.questionToolIds.add(block.id);
              continue;
            }
            const diff = diffFromToolInput(
              block.name,
              (block.input ?? {}) as Record<string, unknown>,
            );
            this.emit({
              kind: "tool.start",
              msgId: msg.message.id,
              callId: block.id,
              tool: block.name,
              summary: summarize(block.input),
              ...(diff ? { diff } : {}),
              ...agentField,
            });
          }
        }
        return;
      }
      case "user": {
        // 工具结果回流(用户角色承载 tool_result)
        const content = msg.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (typeof block === "object" && block.type === "tool_result") {
            if (this.questionToolIds.delete(block.tool_use_id)) continue;
            const full = plainText(block.content);
            // 全文留在 daemon,事件只带摘要;用户展开卡片时再拉
            if (full.length > 0) this.ctx?.recordOutput?.(block.tool_use_id, full);
            const summary = summarize(block.content ?? "完成");
            this.emit({
              kind: "tool.end",
              callId: block.tool_use_id,
              state: block.is_error === true ? "failed" : "success",
              summary,
              ...(full.length > summary.length ? { hasMore: true } : {}),
              ...agentField,
            });
          }
        }
        return;
      }
      case "result": {
        const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        this.emit({
          kind: "turn.end",
          msgId: this.currentMessageByAgent.get(agentId ?? "") || this.currentMsgId || msg.uuid,
          finish: msg.subtype,
          ...(typeof msg.total_cost_usd === "number" ? { costUsd: msg.total_cost_usd } : {}),
          ...(typeof usage?.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
          ...(typeof usage?.output_tokens === "number"
            ? { outputTokens: usage.output_tokens }
            : {}),
          ...agentField,
        });
        this.currentMessageByAgent.delete(agentId ?? "");
        this.streamMessageByAgent.delete(agentId ?? "");
        if (agentId) this.updateSubagent(agentId, "idle", true);
        else this.currentMsgId = "";
        return;
      }
      case "system": {
        const system = msg as SDKMessage & {
          subtype?: string;
          model?: string;
          status?: string | null;
          compact_result?: "success" | "failed";
          compact_error?: string;
          task_id?: string;
          tool_use_id?: string;
          description?: string;
          subagent_type?: string;
          task_type?: string;
          prompt?: string;
          summary?: string;
        };
        if (system.subtype === "task_started" && system.task_id) {
          const publicId = system.tool_use_id || system.task_id;
          this.taskAgents.set(system.task_id, publicId);
          if (system.tool_use_id) this.taskAgents.set(system.tool_use_id, publicId);
          // 只有 Task 工具派生的任务带 subagent_type;后台 shell 任务不是子 Agent,
          // 记下来让后续的 progress/通知/子消息一并让开。
          if (!system.subagent_type) {
            this.nonSubagentTasks.add(publicId);
          } else {
            this.registerSubagent(publicId, {
              name: system.subagent_type,
              ...(system.task_type ? { role: system.task_type } : {}),
              ...(system.prompt || system.description
                ? { task: system.prompt || system.description }
                : {}),
            });
            this.updateSubagent(publicId, "running", true, system.description);
          }
        } else if (system.subtype === "task_progress" && system.task_id) {
          const publicId = this.taskAgents.get(system.task_id) ?? system.tool_use_id ?? system.task_id;
          this.taskAgents.set(system.task_id, publicId);
          if (!this.nonSubagentTasks.has(publicId)) {
            this.updateSubagent(publicId, "running", true, system.summary || system.description);
          }
        } else if (system.subtype === "task_notification" && system.task_id) {
          const publicId = this.taskAgents.get(system.task_id) ?? system.tool_use_id ?? system.task_id;
          if (!this.nonSubagentTasks.has(publicId)) {
            const rawStatus = String(system.status ?? "completed");
            const status: SubagentStatus =
              rawStatus === "failed"
                ? "failed"
                : rawStatus === "stopped"
                  ? "stopped"
                  : "completed";
            this.updateSubagent(publicId, status, false, system.summary || system.description);
          }
        }
        if (system.subtype === "init" && !this.selectedModel && system.model) {
          this.selectedModel = system.model;
          this.persistNativeState();
        }
        if (system.subtype === "status" && system.compact_result) {
          this.settleCompact(
            system.compact_result === "success",
            system.compact_error ?? "Claude 上下文压缩失败",
          );
        }
        return;
      }
      default:
        return; // system/init 等与手机 UI 无关
    }
  }

  /** SDK 原生收图,不必落盘再让模型去读 */
  readonly acceptsImages = true;

  async listModels(): Promise<AgentModelCatalog> {
    if (!this.q) throw new AdapterError("Claude 会话尚未就绪");
    const native = await this.q.supportedModels();
    this.modelCache = native;
    const selectedRow = native.find(
      (model) =>
        model.value === this.selectedModel || model.resolvedModel === this.selectedModel,
    );
    const currentModel = selectedRow?.value ?? this.selectedModel ?? native[0]?.value;
    if (currentModel && currentModel !== this.selectedModel) {
      this.selectedModel = currentModel;
      this.persistNativeState();
    }
    return {
      models: native.map((model, index) => ({
        id: model.value,
        label: model.displayName || model.value,
        ...(model.description ? { description: model.description } : {}),
        supportedEfforts: model.supportedEffortLevels ?? [],
        ...(index === 0 ? { isDefault: true } : {}),
      })),
      ...(currentModel ? { currentModel } : {}),
      ...(this.selectedEffort ? { currentEffort: this.selectedEffort } : {}),
    };
  }

  async setModel(model: string, effort?: string): Promise<AgentModelSelection> {
    if (!this.q) throw new AdapterError("Claude 会话尚未就绪");
    const native = this.modelCache ?? (await this.q.supportedModels());
    this.modelCache = native;
    const selected = native.find((entry) => entry.value === model);
    if (!selected) throw new AdapterError(`Claude 模型不可用:${model}`);
    if (effort && !(selected.supportedEffortLevels ?? []).includes(effort as EffortLevel)) {
      throw new AdapterError(`${model} 不支持推理强度 ${effort}`);
    }
    await this.q.setModel(model);
    if (effort) await this.q.applyFlagSettings({ effortLevel: effort as EffortLevel });
    this.selectedModel = model;
    this.selectedEffort = effort ?? null;
    this.persistNativeState();
    return {
      currentModel: model,
      ...(effort ? { currentEffort: effort } : {}),
    };
  }

  async listModes(): Promise<AgentModeCatalog> {
    return {
      modes: [
        {
          id: "default",
          label: "执行",
          description: "允许 Claude 使用工具、修改文件并完成任务。",
        },
        {
          id: "plan",
          label: "Plan",
          description: "只调查与规划；需要决策时显示结构化问题卡片。",
        },
      ],
      currentMode: this.selectedMode,
    };
  }

  async setMode(mode: string): Promise<AgentModeSelection> {
    if (mode !== "default" && mode !== "plan") throw new AdapterError(`Claude 模式不可用:${mode}`);
    if (!this.q) throw new AdapterError("Claude 会话尚未就绪");
    await this.q.setPermissionMode(mode);
    this.selectedMode = mode;
    this.persistNativeState();
    return { currentMode: mode };
  }

  async compact(): Promise<void> {
    if (!this.q) throw new AdapterError("Claude 会话尚未就绪");
    if (this.compactWaiter) throw new AdapterError("Claude 正在压缩上下文");
    const msgId = `compact-${randomUUID()}`;
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.compactWaiter?.msgId !== msgId) return;
        this.compactWaiter = null;
        reject(new AdapterError("Claude /compact 超时"));
      }, 180_000);
      timer.unref?.();
      this.compactWaiter = { msgId, resolve, reject, timer };
    });
    // Claude SDK 没有单独的 compact 控制方法；streaming input 会在 CLI 本地
    // 解析 slash command，并通过 system/status 回 compact_result，不会交给模型。
    this.pushTextMessage("/compact", msgId);
    return completion;
  }

  private settleCompact(ok: boolean, message: string): void {
    const waiter = this.compactWaiter;
    if (!waiter) return; // 自动 compact 或已经结算
    this.compactWaiter = null;
    clearTimeout(waiter.timer);
    if (ok) {
      this.emit({ kind: "turn.end", msgId: waiter.msgId, finish: "compact" });
      waiter.resolve();
    } else {
      const error = new AdapterError(message);
      this.emit({ kind: "agent.error", message });
      waiter.reject(error);
    }
  }

  private pushTextMessage(text: string, messageId = ""): void {
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
      ...(messageId ? { uuid: messageId } : {}),
    } as SDKUserMessage);
  }

  async send(text: string, attachments?: Attachment[]): Promise<void> {
    if (!this.q) throw new AdapterError("Claude 会话尚未就绪");
    // 无附件时保持纯字符串 content —— 不必为了统一而把简单情况复杂化
    const content =
      attachments && attachments.length > 0
        ? [
            ...attachments.map((a) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: a.mimeType,
                data: a.dataB64,
              },
            })),
            // 图在前、字在后:模型先看到图,再读围绕它的问题
            ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
          ]
        : text;
    if (typeof content === "string") {
      this.pushTextMessage(content);
    } else {
      this.input.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: this.sessionId ?? "",
      } as SDKUserMessage);
    }
  }

  /** Claude streaming input 原生允许在一轮运行中继续追加用户引导。 */
  async steer(text: string, attachments?: Attachment[]): Promise<boolean> {
    await this.send(text, attachments);
    return true;
  }

  async respondPermission(reqId: string, reply: PermissionReply): Promise<void> {
    const p = this.pending.get(reqId);
    if (!p) return; // 已被中止或重复回应
    this.pending.delete(reqId);
    if (reply === "reject") {
      p.resolve({ behavior: "deny", message: "用户在手机上拒绝了此操作" });
    } else if (reply === "always") {
      // 把 SDK 给的规则建议一并回传,后续同类操作不再询问
      p.resolve({
        behavior: "allow",
        updatedInput: p.input,
        updatedPermissions: p.suggestions,
      });
    } else {
      // updatedInput 类型上可选,但要显式把原始入参回传 —— 省略它时工具拿不到参数,
      // 表现为工具"执行了"却什么也没做,模型反复重试直到 turn 永远不结束。
      p.resolve({ behavior: "allow", updatedInput: p.input });
    }
    this.emit({
      kind: "permission.resolved",
      reqId,
      reply,
      ...(p.agentId ? { agentId: p.agentId } : {}),
    });
  }

  async respondQuestion(
    reqId: string,
    answers: AgentQuestionAnswer[],
    cancelled = false,
  ): Promise<void> {
    const pending = this.questions.get(reqId);
    if (!pending) return;
    this.questions.delete(reqId);
    const nativeAnswers: Record<string, string> = {};
    for (const answer of answers) {
      const nativeQuestion = pending.nativeQuestionById.get(answer.questionId);
      if (nativeQuestion) nativeAnswers[nativeQuestion] = answer.values.join(", ");
    }
    pending.resolve({
      behavior: "allow",
      updatedInput: { ...pending.input, answers: cancelled ? {} : nativeAnswers },
    });
    this.emit({
      kind: "question.resolved",
      reqId,
      answers,
      ...(cancelled ? { cancelled: true } : {}),
      ...(pending.agentId ? { agentId: pending.agentId } : {}),
    });
  }

  async sendToSubagent(subagentId: string, text: string): Promise<void> {
    const known = this.subagents.get(subagentId);
    if (!known || !known.canMessage) throw new AdapterError("Claude 子 Agent 当前不可寻址");
    this.updateSubagent(subagentId, "running", true);
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: subagentId,
      session_id: this.sessionId ?? "",
    } as SDKUserMessage);
  }

  /**
   * 用量与限流。
   *
   * SDK 上这个方法叫 usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET ——
   * 名字本身就是警告,任何一次发版都可能改名或消失。数据确实有用(知道自己
   * 用掉了 5 小时窗口的 95%,能解释 agent 为什么突然变慢),所以接,
   * 但一切失败都当成"没有数据",绝不让它影响会话本身。
   */
  async usage(): Promise<UsageReport | null> {
    const q = this.q as unknown as {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
    } | null;
    const fn = q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== "function") return null;

    let raw: unknown;
    try {
      raw = await fn.call(q);
    } catch {
      return null; // SDK 换了实现或后端不通,都不是会话的问题
    }
    const r = raw as {
      session?: { total_cost_usd?: number };
      subscription_type?: string | null;
      rate_limits_available?: boolean;
      rate_limits?: Record<string, { utilization?: number | null; resets_at?: string | null } | null>;
    } | null;
    if (!r) return null;

    const labels: Record<string, string> = {
      five_hour: "5 小时",
      seven_day: "7 天",
      seven_day_oauth_apps: "7 天(应用)",
    };
    const windows: UsageReport["windows"] = [];
    for (const [key, win] of Object.entries(r.rate_limits ?? {})) {
      if (!win || typeof win.utilization !== "number") continue;
      windows.push({
        label: labels[key] ?? key,
        utilization: Math.max(0, Math.min(100, win.utilization)),
        ...(win.resets_at ? { resetsAt: win.resets_at } : {}),
      });
    }
    return {
      subscription: r.subscription_type ?? null,
      ...(typeof r.session?.total_cost_usd === "number"
        ? { costUsd: r.session.total_cost_usd }
        : {}),
      windows,
    };
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt();
  }

  async dispose(): Promise<void> {
    // 悬着的审批先拒掉,避免 SDK 永久等待
    for (const [reqId, p] of this.pending) {
      p.resolve({ behavior: "deny", message: "会话已关闭" });
      this.pending.delete(reqId);
    }
    for (const [reqId, pending] of this.questions) {
      pending.resolve({ behavior: "deny", message: "会话已关闭" });
      this.questions.delete(reqId);
    }
    if (this.compactWaiter) {
      const waiter = this.compactWaiter;
      this.compactWaiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new AdapterError("会话已关闭"));
    }
    this.input.close();
    try {
      await this.q?.interrupt();
    } catch {
      // 已结束
    }
    this.q = null;
    this.ctx = null;
    this.subagents.clear();
    this.taskAgents.clear();
    this.nonSubagentTasks.clear();
    this.currentMessageByAgent.clear();
    this.streamMessageByAgent.clear();
    await this.pumping?.catch(() => {});
  }
}
