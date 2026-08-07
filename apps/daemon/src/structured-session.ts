/**
 * 结构化会话:PtySession 的对位物。
 * PtySession 用 headless 终端持有画面状态,这里用事件日志持有对话状态,
 * attach 时用 chat.snapshot 一次性重放 —— 同样是"秒开",同样支持增量续传。
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DEFAULT_POLICY } from "./approval-policy.js";
import type {
  AdapterResumeState,
  AgentModeCatalog,
  AgentModeSelection,
  AgentModelCatalog,
  AgentModelSelection,
  UsageReport,
} from "./adapters/types.js";
import {
  completeComposer,
  injectPortableSkills,
  prepareComposerPrompt,
  type PreparedComposerPrompt,
} from "./composer-context.js";
import { prosperoHome } from "./pairing.js";
import type {
  ApprovalPolicy,
  Attachment,
  AgentEventBody,
  AgentKind,
  AgentQuestionAnswer,
  ChatDelivery,
  ChatSuggestion,
  ChatSuggestionKind,
  PermissionReply,
  QueuedChatMessage,
  SessionInfo,
  SessionStatus,
  SubagentInfo,
} from "@prospero/protocol";
import type { AgentAdapter } from "./adapters/types.js";

/** 事件日志上限:超出后丢弃最旧的(快照会带 truncated 标记) */
const MAX_EVENTS = 4000;
/** 会话列表预览的截断长度 */
const PREVIEW_CHARS = 140;
/** 只保留当前回复尾部所需的原始窗口，避免长会话把状态 JSON 撑大。 */
const PREVIEW_RAW_CHARS = 64_000;
/** 列表预览流式刷新频率；避免把每个 token 都广播成 session.state。 */
const PREVIEW_STATE_MS = 400;
/** 单次工具输出保留上限(按需拉取时) */
const MAX_TOOL_OUTPUT = 200_000;
/** 保留完整输出的工具调用条数 */
const MAX_TOOL_ENTRIES = 200;
/** daemon 级消息队列上限；防止断线客户端无限堆积。 */
const MAX_MESSAGE_QUEUE = 50;

interface QueuedAttachmentRef {
  mimeType: Attachment["mimeType"];
  path: string;
  name?: string;
}

/** 队列落盘只保存附件文件引用，绝不把大段 base64 塞进状态 JSON。 */
export interface QueuedChatPersistent {
  id: string;
  displayText: string;
  outgoingText: string;
  kind: "queue" | "guide";
  createdAt: number;
  attachmentCount: number;
  attachments: QueuedAttachmentRef[];
}

export interface StructuredSessionOptions {
  id: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  adapter: AgentAdapter;
  approvalPolicy?: ApprovalPolicy;
  restored?: StructuredSessionPersistentState;
}

export interface StructuredSessionEvents {
  event: [body: AgentEventBody, evSeq: number];
  state: [info: SessionInfo];
  /** adapter 恢复游标或工具全文变化,没有对应的协议事件但仍需落盘 */
  persist: [];
}

/** `~/.prospero/structured-sessions.json` 中单个会话的稳定格式。 */
export interface StructuredSessionPersistentState {
  version: 1;
  id: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  createdAt: number;
  approvalPolicy: ApprovalPolicy;
  events: AgentEventBody[];
  evSeq: number;
  preview: string;
  previewRaw: string;
  previewMsgId: string;
  totals: { costUsd: number; inputTokens: number; outputTokens: number };
  toolOutputs: [string, string][];
  adapterState: AdapterResumeState;
  /** 兼容早期 version=1 状态；新写入总会带这个字段。 */
  messageQueue?: QueuedChatPersistent[];
}

export class StructuredSession extends EventEmitter<StructuredSessionEvents> {
  readonly id: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: number;

  private readonly adapter: AgentAdapter;
  private readonly log: AgentEventBody[] = [];
  private evSeq = 0;
  private status: SessionStatus = "starting";
  private readonly pending = new Set<string>();
  private readonly pendingQuestions = new Set<string>();
  private readonly subagents = new Map<string, SubagentInfo>();
  private disposed = false;
  private backendAvailable = true;
  /** 会话列表预览:最后一条助手文本的开头(已剥掉 Markdown 标记) */
  private preview = "";
  private previewRaw = "";
  private previewMsgId = "";
  private busySince: number | undefined;
  /** 累计用量:每轮 turn.end 汇总 */
  private totals = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  /** callId → 完整工具输出,供 tool.output.get 按需拉取 */
  private readonly toolOutputs = new Map<string, string>();
  private adapterState: AdapterResumeState = {};
  private readonly messageQueue: QueuedChatPersistent[] = [];
  private drainingQueue = false;
  private previewStateTimer: NodeJS.Timeout | null = null;
  private lastPreviewStateAt = 0;

  constructor(opts: StructuredSessionOptions) {
    super();
    this.id = opts.id;
    this.agent = opts.agent;
    this.title = opts.title;
    this.cwd = opts.cwd;
    this.adapter = opts.adapter;
    const restored = opts.restored;
    this.createdAt = restored?.createdAt ?? Date.now();
    this.policy = restored?.approvalPolicy ?? opts.approvalPolicy ?? DEFAULT_POLICY;
    if (restored) {
      this.log.push(...restored.events.slice(-MAX_EVENTS));
      this.evSeq = Math.max(restored.evSeq, this.log.length);
      this.preview = restored.preview;
      this.previewRaw = restored.previewRaw;
      this.previewMsgId = restored.previewMsgId;
      this.totals = { ...restored.totals };
      this.adapterState = { ...restored.adapterState };
      this.messageQueue.push(...(restored.messageQueue ?? []).slice(0, MAX_MESSAGE_QUEUE));
      for (const [callId, output] of restored.toolOutputs.slice(-MAX_TOOL_ENTRIES)) {
        this.toolOutputs.set(callId, output);
      }

      // daemon 停止时原生审批 promise/RPC 已经被拒掉,不能在恢复后继续显示成待审批。
      // 补一条 resolved 既保留审计轨迹,也让手机侧卡片回到可读的终态。
      const unresolved = new Map<string, string | undefined>();
      const unanswered = new Map<string, string | undefined>();
      for (const body of this.log) {
        if (body.kind === "permission.request") unresolved.set(body.reqId, body.agentId);
        else if (body.kind === "permission.resolved") unresolved.delete(body.reqId);
        else if (body.kind === "question.request") unanswered.set(body.reqId, body.agentId);
        else if (body.kind === "question.resolved") unanswered.delete(body.reqId);
        this.applySubagentEvent(body);
      }
      for (const [reqId, agentId] of unresolved) {
        const resolved: AgentEventBody = {
          kind: "permission.resolved",
          reqId,
          reply: "reject",
          ...(agentId ? { agentId } : {}),
        };
        this.evSeq++;
        this.log.push(resolved);
        this.applySubagentEvent(resolved);
        if (this.log.length > MAX_EVENTS) this.log.shift();
      }
      for (const [reqId, agentId] of unanswered) {
        const resolved: AgentEventBody = {
          kind: "question.resolved",
          reqId,
          answers: [],
          cancelled: true,
          ...(agentId ? { agentId } : {}),
        };
        this.evSeq++;
        this.log.push(resolved);
        this.applySubagentEvent(resolved);
        if (this.log.length > MAX_EVENTS) this.log.shift();
      }
    }
  }

  async start(): Promise<void> {
    await this.adapter.start({
      cwd: this.cwd,
      emit: (body) => this.record(body),
      recordOutput: (callId, output) => this.recordToolOutput(callId, output),
      persistState: (state) => {
        // sessionId/threadId 与模型选择可能由不同通知分别到达；浅合并避免后到的
        // 单字段更新把另一半恢复游标抹掉。
        this.adapterState = { ...this.adapterState, ...state };
        this.emit("persist");
        this.emit("state", this.info());
      },
      // 取函数而非取值:策略可在会话进行中改,适配器每次调用都要读到当下的值
      approvalPolicy: () => this.policy,
    });
    this.setStatus("idle");
    await this.drainQueue();
  }

  /** 保留可浏览的历史,但明确标记原生会话这次没有恢复成功。 */
  async markRestoreFailed(message: string): Promise<void> {
    this.backendAvailable = false;
    await this.adapter.dispose().catch(() => {});
    this.record({ kind: "agent.error", message: `会话恢复失败:${message}` });
    this.setStatus("died");
  }

  /** 当前审批策略;可在会话进行中修改 */
  private policy: ApprovalPolicy = DEFAULT_POLICY;

  async setApprovalPolicy(policy: ApprovalPolicy): Promise<void> {
    this.policy = policy;
    await this.adapter.setApprovalPolicy?.(policy);
    this.emit("state", this.info());
    this.emit("persist");

    // 用户很可能是在审批卡片已经挡住会话后切到 YOLO。只影响下一次请求会让
    // 界面显示 YOLO、当前轮次却依旧卡住,看起来就像设置没有生效。
    if (policy === "yolo") {
      for (const reqId of [...this.pending]) {
        await this.adapter.respondPermission(reqId, "once");
      }
    }
  }

  get approvalPolicy(): ApprovalPolicy {
    return this.policy;
  }

  info(): SessionInfo {
    const canCompact = typeof this.adapter.compact === "function";
    const canSelectModel =
      typeof this.adapter.listModels === "function" &&
      typeof this.adapter.setModel === "function";
    const canSelectMode =
      typeof this.adapter.listModes === "function" &&
      typeof this.adapter.setMode === "function";
    const currentModel =
      typeof this.adapterState["model"] === "string" ? this.adapterState["model"] : undefined;
    const currentEffort =
      typeof this.adapterState["effort"] === "string" ? this.adapterState["effort"] : undefined;
    const currentMode =
      typeof this.adapterState["mode"] === "string" ? this.adapterState["mode"] : undefined;
    return {
      id: this.id,
      approvalPolicy: this.policy,
      agent: this.agent,
      kind: "structured",
      title: this.title,
      cwd: this.cwd,
      status: this.status,
      createdAt: this.createdAt,
      cols: 80,
      rows: 24,
      pendingPermissions: this.pending.size,
      pendingQuestions: this.pendingQuestions.size,
      messageQueue: this.messageQueue.map(
        (item): QueuedChatMessage => ({
          id: item.id,
          text: item.displayText,
          kind: item.kind,
          createdAt: item.createdAt,
          attachmentCount: item.attachmentCount,
        }),
      ),
      ...(canCompact || canSelectModel || canSelectMode
        ? {
            agentControls: {
              compact: canCompact,
              model: canSelectModel,
              mode: canSelectMode,
              ...(currentModel ? { currentModel } : {}),
              ...(currentEffort ? { currentEffort } : {}),
              ...(currentMode ? { currentMode } : {}),
            },
          }
        : {}),
      ...(this.subagents.size > 0 ? { subagents: [...this.subagents.values()] } : {}),
      ...(this.preview ? { preview: this.preview } : {}),
      ...(this.busySince !== undefined ? { busySince: this.busySince } : {}),
      ...(this.totals.outputTokens > 0 || this.totals.costUsd > 0
        ? { totals: { ...this.totals } }
        : {}),
    };
  }

  /** 完整工具输出(应答 tool.output.get) */
  toolOutput(callId: string): { output: string; truncated: boolean } | null {
    const full = this.toolOutputs.get(callId);
    if (full === undefined) return null;
    return full.length > MAX_TOOL_OUTPUT
      ? { output: full.slice(0, MAX_TOOL_OUTPUT), truncated: true }
      : { output: full, truncated: false };
  }

  /** 适配器登记完整输出;摘要仍走事件,全文按需拉取 */
  recordToolOutput(callId: string, output: string): void {
    if (this.toolOutputs.size > MAX_TOOL_ENTRIES) {
      const oldest = this.toolOutputs.keys().next().value;
      if (oldest !== undefined) this.toolOutputs.delete(oldest);
    }
    this.toolOutputs.set(callId, output);
    this.emit("persist");
  }

  /** daemon 重启恢复所需的完整本地状态；原生模型上下文由 adapterState 指向。 */
  persistentState(): StructuredSessionPersistentState {
    return {
      version: 1,
      id: this.id,
      agent: this.agent,
      title: this.title,
      cwd: this.cwd,
      createdAt: this.createdAt,
      approvalPolicy: this.policy,
      events: [...this.log],
      evSeq: this.evSeq,
      preview: this.preview,
      previewRaw: this.previewRaw,
      previewMsgId: this.previewMsgId,
      totals: { ...this.totals },
      toolOutputs: [...this.toolOutputs.entries()].map(([callId, output]) => [
        callId,
        output.slice(0, MAX_TOOL_OUTPUT),
      ]),
      adapterState: { ...this.adapterState },
      messageQueue: this.messageQueue.map((item) => ({
        ...item,
        attachments: item.attachments.map((attachment) => ({ ...attachment })),
      })),
    };
  }

  get resumeState(): AdapterResumeState {
    return { ...this.adapterState };
  }

  /** 输入框候选统一从会话 cwd 与 daemon Skill 注册表生成，和具体 agent 无关。 */
  complete(kind: ChatSuggestionKind, query: string): Promise<ChatSuggestion[]> {
    return completeComposer(this.cwd, kind, query);
  }

  async models(): Promise<AgentModelCatalog> {
    if (!this.backendAvailable) throw new Error("会话后端未恢复;无法读取模型");
    if (!this.adapter.listModels) throw new Error(`${this.agent} 尚不支持模型选择`);
    const catalog = await this.adapter.listModels();
    if (catalog.models.length === 0) throw new Error(`${this.agent} 没有返回可选模型`);
    if (catalog.currentModel) {
      this.rememberModelSelection({
        currentModel: catalog.currentModel,
        ...(catalog.currentEffort ? { currentEffort: catalog.currentEffort } : {}),
      });
    }
    return catalog;
  }

  async setModel(model: string, effort?: string): Promise<AgentModelSelection> {
    if (!this.backendAvailable) throw new Error("会话后端未恢复;无法切换模型");
    if (!this.adapter.setModel) throw new Error(`${this.agent} 尚不支持模型选择`);
    const selection = await this.adapter.setModel(model, effort);
    this.rememberModelSelection(selection);
    return selection;
  }

  async modes(): Promise<AgentModeCatalog> {
    if (!this.backendAvailable) throw new Error("会话后端未恢复;无法读取模式");
    if (!this.adapter.listModes) throw new Error(`${this.agent} 尚不支持协作模式`);
    const catalog = await this.adapter.listModes();
    if (catalog.modes.length === 0) throw new Error(`${this.agent} 没有返回可选模式`);
    if (catalog.currentMode) {
      this.rememberModeSelection({ currentMode: catalog.currentMode });
    }
    return catalog;
  }

  async setMode(mode: string): Promise<AgentModeSelection> {
    if (!this.backendAvailable) throw new Error("会话后端未恢复;无法切换模式");
    if (!this.adapter.setMode) throw new Error(`${this.agent} 尚不支持协作模式`);
    const selection = await this.adapter.setMode(mode);
    this.rememberModeSelection(selection);
    return selection;
  }

  /** `/compact` 是控制操作，不写入 user.message，也不会作为普通 Prompt 发给模型。 */
  async compact(): Promise<void> {
    if (!this.backendAvailable) throw new Error("会话后端未恢复;无法压缩上下文");
    if (!this.adapter.compact) throw new Error(`${this.agent} 尚不支持手动压缩`);
    if (this.status !== "idle") throw new Error("当前任务仍在运行，请结束后再压缩");
    this.busySince = Date.now();
    this.setStatus("running");
    try {
      await this.adapter.compact();
      // 成功路径由原生 compact 的 turn/status 事件发出 turn.end，再统一回 idle。
    } catch (error) {
      this.setStatus("idle");
      throw error;
    }
  }

  private rememberModelSelection(selection: AgentModelSelection): void {
    this.adapterState = {
      ...this.adapterState,
      model: selection.currentModel,
      ...(selection.currentEffort ? { effort: selection.currentEffort } : {}),
    };
    if (!selection.currentEffort) delete this.adapterState["effort"];
    this.emit("state", this.info());
    this.emit("persist");
  }

  private rememberModeSelection(selection: AgentModeSelection): void {
    this.adapterState = { ...this.adapterState, mode: selection.currentMode };
    this.emit("state", this.info());
    this.emit("persist");
  }

  /** attach 用:全量事件历史 + 当前 evSeq */
  snapshot(): { events: AgentEventBody[]; evSeq: number } {
    return { events: [...this.log], evSeq: this.evSeq };
  }

  /** 增量续传:返回 afterSeq 之后的事件;历史已被截断时返回 null(需全量快照) */
  since(afterSeq: number): AgentEventBody[] | null {
    if (afterSeq > this.evSeq) return null;
    const oldest = this.evSeq - this.log.length + 1;
    if (afterSeq + 1 < oldest && afterSeq < this.evSeq) return null;
    const skip = this.log.length - (this.evSeq - afterSeq);
    return this.log.slice(Math.max(0, skip));
  }

  private record(body: AgentEventBody): void {
    if (this.disposed) return;
    this.evSeq++;
    this.log.push(body);
    if (this.log.length > MAX_EVENTS) this.log.shift();
    this.applySubagentEvent(body);

    // 维护列表预览:滚动展示当前助手消息的【最新尾部】,新消息则重置。
    // 以前到 280 字就停止更新，因此长任务在列表里永远停在开场白。
    if (body.kind === "text.delta" && body.agentId === undefined) {
      if (body.msgId !== this.previewMsgId) {
        this.previewMsgId = body.msgId;
        this.previewRaw = "";
      }
      this.previewRaw = (this.previewRaw + body.delta).slice(-PREVIEW_RAW_CHARS);
      this.preview = latestReplyPreview(this.previewRaw, PREVIEW_CHARS);
    }

    // 审批状态直接驱动会话状态,列表里才能把"待审批"置顶
    if (body.kind === "permission.request") {
      this.pending.add(body.reqId);
      this.setStatus("waiting_approval");
    } else if (body.kind === "permission.resolved") {
      this.pending.delete(body.reqId);
      if (this.pending.size === 0 && this.status === "waiting_approval") {
        this.setStatus(this.pendingQuestions.size > 0 ? "waiting_input" : "running");
      }
    } else if (body.kind === "question.request") {
      this.pendingQuestions.add(body.reqId);
      if (this.pending.size === 0) this.setStatus("waiting_input");
    } else if (body.kind === "question.resolved") {
      this.pendingQuestions.delete(body.reqId);
      if (this.pendingQuestions.size === 0 && this.status === "waiting_input") {
        this.setStatus(this.pending.size > 0 ? "waiting_approval" : "running");
      }
    } else if (body.kind === "turn.end" && body.agentId === undefined) {
      this.totals.costUsd += body.costUsd ?? 0;
      this.totals.inputTokens += body.inputTokens ?? 0;
      this.totals.outputTokens += body.outputTokens ?? 0;
      if (this.pending.size === 0 && this.pendingQuestions.size === 0) this.setStatus("idle");
    } else if (body.kind === "agent.error" && body.agentId === undefined) {
      if (this.pending.size === 0 && this.pendingQuestions.size === 0) this.setStatus("idle");
    } else if (
      body.kind !== "subagent.started" &&
      body.kind !== "subagent.updated" &&
      body.agentId === undefined &&
      (this.status === "idle" || this.status === "starting")
    ) {
      this.setStatus("running");
    }

    if (body.kind === "text.delta" || body.kind === "subagent.updated") this.schedulePreviewState();
    this.emit("event", body, this.evSeq);
    if (body.kind === "turn.end" || body.kind === "agent.error") void this.drainQueue();
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === s) return;
    this.status = s;
    // running/等待交互期间才计时,回到 idle 就清掉
    this.busySince =
      s === "running" || s === "waiting_approval" || s === "waiting_input"
        ? (this.busySince ?? Date.now())
        : undefined;
    if (this.previewStateTimer !== null) {
      clearTimeout(this.previewStateTimer);
      this.previewStateTimer = null;
    }
    this.lastPreviewStateAt = Date.now();
    this.emit("state", this.info());
  }

  /** 会话列表停留在前台时，也能看到长回复的最新尾部滚动更新。 */
  private schedulePreviewState(): void {
    if (this.previewStateTimer !== null || this.disposed) return;
    const delay = Math.max(0, PREVIEW_STATE_MS - (Date.now() - this.lastPreviewStateAt));
    this.previewStateTimer = setTimeout(() => {
      this.previewStateTimer = null;
      if (this.disposed) return;
      this.lastPreviewStateAt = Date.now();
      this.emit("state", this.info());
    }, delay);
  }

  async send(
    text: string,
    attachments?: Attachment[],
    delivery: ChatDelivery = "auto",
  ): Promise<void> {
    if (!this.backendAvailable) throw new Error("会话后端未恢复;重启 daemon 后会再次尝试");
    const busy =
      this.status === "starting" ||
      this.status === "running" ||
      this.status === "waiting_approval" ||
      this.status === "waiting_input";

    if (busy) {
      const queued = await this.prepareQueuedMessage(
        text,
        attachments,
        delivery === "steer" ? "guide" : "queue",
      );
      if (delivery === "steer") {
        try {
          const forAdapter = await this.queuedAttachmentsForAdapter(queued);
          const prepared = await this.prepareForAdapter(queued.outgoingText);
          const steered =
            (await this.adapter.steer?.(prepared.text, forAdapter, prepared.skills)) ?? false;
          if (steered) {
            this.recordUserMessage(queued.displayText);
            return;
          }
        } catch {
          // 当前轮不接受 steer 时，下面降级到队首，消息不能丢。
        }
        this.enqueue(queued, true);
        return;
      }
      this.enqueue(queued, false);
      return;
    }

    await this.dispatchNow(text, attachments);
  }

  /** 取消尚未发给 agent 的消息。已经 steer/发送的内容不能假装撤回。 */
  removeQueued(queueId: string): boolean {
    const index = this.messageQueue.findIndex((item) => item.id === queueId);
    if (index < 0) return false;
    this.messageQueue.splice(index, 1);
    this.emit("state", this.info());
    this.emit("persist");
    return true;
  }

  /**
   * 把已排队消息升级成当前轮引导。原生 steer 失败（或轮次恰好结束）时，
   * 消息改标为 guide 并移到队首；无论竞态如何都不会丢正文或附件。
   */
  async guideQueued(queueId: string): Promise<boolean> {
    if (!this.backendAvailable) throw new Error("会话后端未恢复;无法发送引导");
    if (this.drainingQueue) throw new Error("队列正在发送，请稍后再试");
    const initial = this.messageQueue.find((item) => item.id === queueId);
    if (!initial) return false;

    this.drainingQueue = true; // turn.end 在 steer RPC 期间不能并发取走同一条消息。
    let steered = false;
    try {
      const busy =
        this.status === "starting" ||
        this.status === "running" ||
        this.status === "waiting_approval" ||
        this.status === "waiting_input";
      if (busy) {
        try {
          const attachments = await this.queuedAttachmentsForAdapter(initial);
          const prepared = await this.prepareForAdapter(initial.outgoingText);
          steered =
            (await this.adapter.steer?.(prepared.text, attachments, prepared.skills)) ?? false;
        } catch {
          steered = false;
        }
      }

      const index = this.messageQueue.findIndex((item) => item.id === queueId);
      if (index < 0) {
        // 另一个客户端可能在 RPC 等待期间点了删除；已经 steer 成功的内容无法撤回，
        // 聊天审计仍必须如实记录。
        if (steered) this.recordUserMessage(initial.displayText);
        return steered;
      }
      const [item] = this.messageQueue.splice(index, 1);
      if (!item) return steered;
      if (steered) {
        this.recordUserMessage(item.displayText);
      } else {
        item.kind = "guide";
        this.messageQueue.unshift(item);
      }
      this.emit("state", this.info());
      this.emit("persist");
      return steered;
    } finally {
      this.drainingQueue = false;
      // steer 期间原轮可能已结束；失败时立即把队首消息作为下一轮发出。
      void this.drainQueue();
    }
  }

  private async dispatchNow(text: string, attachments?: Attachment[]): Promise<void> {
    let outgoing = text;
    let forAdapter = attachments;

    if (attachments && attachments.length > 0 && this.adapter.acceptsImages !== true) {
      // 后端吃不了图就落盘,把绝对路径并进文本 —— 有读文件能力的 agent
      // 照样能看到内容。写进 ~/.prospero 而不是仓库里:附件是会话产物,
      // 不该出现在用户的 git status 里。
      const paths = await this.persistAttachments(attachments);
      outgoing = [text, ...paths.map((p) => `[附件] ${p}`)].filter((x) => x.length > 0).join("\n");
      forAdapter = undefined;
    }

    // 用户消息本地登记,保证 attach 快照里能看到自己发过什么
    const label =
      attachments && attachments.length > 0
        ? `${text}${text.length > 0 ? " " : ""}[${String(attachments.length)} 张图]`
        : text;
    this.recordUserMessage(label);
    this.busySince = Date.now(); // 新一轮开始重新计时
    this.setStatus("running");
    const prepared = await this.prepareForAdapter(outgoing);
    await this.adapter.send(prepared.text, forAdapter, prepared.skills);
  }

  private recordUserMessage(text: string): void {
    this.record({ kind: "user.message", msgId: `u_${String(this.evSeq + 1)}`, text });
  }

  private async prepareQueuedMessage(
    text: string,
    attachments: Attachment[] | undefined,
    kind: QueuedChatPersistent["kind"],
  ): Promise<QueuedChatPersistent> {
    const paths = attachments?.length ? await this.persistAttachments(attachments) : [];
    const refs: QueuedAttachmentRef[] = paths.map((file, index) => {
      const attachment = attachments?.[index];
      return {
        mimeType: attachment?.mimeType ?? "image/png",
        path: file,
        ...(attachment?.name ? { name: attachment.name } : {}),
      };
    });
    const attachmentCount = attachments?.length ?? 0;
    return {
      id: randomUUID(),
      displayText:
        attachmentCount > 0
          ? `${text}${text.length > 0 ? " " : ""}[${String(attachmentCount)} 张图]`
          : text,
      outgoingText:
        attachmentCount > 0 && this.adapter.acceptsImages !== true
          ? [text, ...paths.map((file) => `[附件] ${file}`)]
              .filter((part) => part.length > 0)
              .join("\n")
          : text,
      kind,
      createdAt: Date.now(),
      attachmentCount,
      attachments: refs,
    };
  }

  private enqueue(item: QueuedChatPersistent, front: boolean): void {
    if (this.messageQueue.length >= MAX_MESSAGE_QUEUE) {
      throw new Error(`消息队列已满（最多 ${String(MAX_MESSAGE_QUEUE)} 条）`);
    }
    if (front) this.messageQueue.unshift(item);
    else this.messageQueue.push(item);
    this.emit("state", this.info());
    this.emit("persist");
  }

  private async queuedAttachmentsForAdapter(
    item: QueuedChatPersistent,
  ): Promise<Attachment[] | undefined> {
    if (this.adapter.acceptsImages !== true || item.attachments.length === 0) return undefined;
    const root = path.resolve(prosperoHome(), "attachments", this.id);
    const loaded: Attachment[] = [];
    for (const ref of item.attachments) {
      const resolved = path.resolve(ref.path);
      // 持久化文件可被手工编辑；恢复时重新约束，不能借队列读取任意路径。
      if (!resolved.startsWith(`${root}${path.sep}`)) continue;
      try {
        loaded.push({
          mimeType: ref.mimeType,
          dataB64: (await readFile(resolved)).toString("base64"),
          ...(ref.name ? { name: ref.name } : {}),
        });
      } catch {
        // 附件被手工清理时仍发送文本，不让整条队列永远卡住。
      }
    }
    return loaded.length > 0 ? loaded : undefined;
  }

  private async dispatchQueued(item: QueuedChatPersistent): Promise<void> {
    const attachments = await this.queuedAttachmentsForAdapter(item);
    this.recordUserMessage(item.displayText);
    this.busySince = Date.now();
    this.setStatus("running");
    const prepared = await this.prepareForAdapter(item.outgoingText);
    await this.adapter.send(prepared.text, attachments, prepared.skills);
  }

  /**
   * Codex 原生接收 `{type:"skill"}`；其余适配器把同一份 SKILL.md 注入本轮，
   * 因而 Claude/OpenCode/Grok 不需要各自实现一套 Skill 发现规则。
   */
  private async prepareForAdapter(text: string): Promise<PreparedComposerPrompt> {
    const prepared = await prepareComposerPrompt(this.cwd, text);
    if (this.adapter.acceptsSkillInputs === true) return prepared;
    return {
      text: injectPortableSkills(prepared.text, prepared.skills),
      skills: [],
    };
  }

  private async drainQueue(): Promise<void> {
    if (
      this.drainingQueue ||
      this.disposed ||
      !this.backendAvailable ||
      this.status !== "idle"
    ) {
      return;
    }
    this.drainingQueue = true;
    try {
      while (this.status === "idle" && this.messageQueue.length > 0) {
        const item = this.messageQueue.shift();
        if (!item) break;
        this.emit("state", this.info());
        this.emit("persist");
        try {
          await this.dispatchQueued(item);
        } catch (error) {
          this.record({
            kind: "agent.error",
            message: `队列消息发送失败:${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  /** 把附件写进 ~/.prospero/attachments/<sid>/,返回绝对路径 */
  private async persistAttachments(attachments: Attachment[]): Promise<string[]> {
    const dir = path.join(prosperoHome(), "attachments", this.id);
    await mkdir(dir, { recursive: true });
    const out: string[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      if (!a) continue;
      const ext = a.mimeType.split("/")[1] ?? "png";
      // 先去掉一切非 [字母数字._-],再把连续的点压成一个下划线。
      // 只做前一步的话 "../../evil" 会变成 ".._.._evil" —— 逃不出目录(路径
      // 分隔符已经没了),但文件名里挂着 ".." 只会让人怀疑到底安不安全。
      const safe = (a.name ?? `image-${String(i + 1)}`)
        .replace(/[^\w.-]/g, "_")
        .replace(/\.{2,}/g, "_");
      const file = path.join(dir, `${String(Date.now())}-${safe}.${ext}`);
      await writeFile(file, Buffer.from(a.dataB64, "base64"));
      out.push(file);
    }
    return out;
  }

  /**
   * 用量与限流。
   *
   * 适配器能给就用它的(带套餐窗口);给不了就用会话自己累计的 token 与花费 ——
   * 那是每个结构化后端都会在 turn.end 上报的东西。没有窗口 ≠ 没有用量。
   */
  async usage(): Promise<UsageReport | null> {
    if (this.adapter.usage) {
      try {
        const r = await this.adapter.usage();
        if (r) {
          // 适配器没报花费时用会话累计的补上
          return {
            ...r,
            costUsd: r.costUsd ?? this.totals.costUsd,
            inputTokens: r.inputTokens ?? this.totals.inputTokens,
            outputTokens: r.outputTokens ?? this.totals.outputTokens,
          };
        }
      } catch {
        // 落到下面的会话累计
      }
    }
    if (this.totals.outputTokens === 0 && this.totals.costUsd === 0) return null;
    return {
      costUsd: this.totals.costUsd,
      inputTokens: this.totals.inputTokens,
      outputTokens: this.totals.outputTokens,
      windows: [],
    };
  }

  async respondPermission(reqId: string, reply: PermissionReply): Promise<void> {
    if (!this.backendAvailable) return;
    await this.adapter.respondPermission(reqId, reply);
    // 后端通常会回 permission.v2.replied;这里不抢先记录,避免重复
  }

  async respondQuestion(
    reqId: string,
    answers: AgentQuestionAnswer[],
    cancelled = false,
  ): Promise<void> {
    if (!this.backendAvailable || !this.adapter.respondQuestion) return;
    await this.adapter.respondQuestion(reqId, answers, cancelled);
  }

  async sendToSubagent(subagentId: string, text: string): Promise<void> {
    if (!this.backendAvailable) throw new Error("会话后端未恢复;无法联系子 Agent");
    if (!this.adapter.sendToSubagent) throw new Error(`${this.agent} 不支持子 Agent 定向消息`);
    const subagent = this.subagents.get(subagentId);
    if (!subagent) throw new Error("子 Agent 已不存在");
    if (!subagent.canMessage) throw new Error("这个子 Agent 已结束，当前不能继续对话");
    this.record({
      kind: "subagent.updated",
      subagentId,
      status: "running",
      canMessage: true,
    });
    this.record({
      kind: "user.message",
      msgId: `su_${String(this.evSeq + 1)}`,
      text,
      agentId: subagentId,
    });
    await this.adapter.sendToSubagent(subagentId, text);
  }

  private applySubagentEvent(body: AgentEventBody): void {
    if (body.kind === "subagent.started") {
      this.subagents.set(body.subagent.id, { ...body.subagent });
      return;
    }
    if (body.kind === "subagent.updated") {
      const previous = this.subagents.get(body.subagentId);
      if (!previous) return;
      this.subagents.set(body.subagentId, {
        ...previous,
        status: body.status,
        updatedAt: Date.now(),
        ...(body.canMessage !== undefined ? { canMessage: body.canMessage } : {}),
        ...(body.summary ? { preview: latestReplyPreview(body.summary, 220) } : {}),
      });
      return;
    }
    if (body.kind === "text.delta" && body.agentId) {
      const previous = this.subagents.get(body.agentId);
      if (!previous) return;
      this.subagents.set(body.agentId, {
        ...previous,
        status: previous.status === "starting" ? "running" : previous.status,
        updatedAt: Date.now(),
        preview: latestReplyPreview(`${previous.preview ?? ""}${body.delta}`, 220),
      });
      return;
    }
    if (
      (body.kind === "question.request" || body.kind === "permission.request") &&
      body.agentId
    ) {
      const previous = this.subagents.get(body.agentId);
      if (!previous) return;
      this.subagents.set(body.agentId, {
        ...previous,
        status: "waiting_input",
        updatedAt: Date.now(),
      });
      return;
    }
    if (
      (body.kind === "question.resolved" || body.kind === "permission.resolved") &&
      body.agentId
    ) {
      const previous = this.subagents.get(body.agentId);
      if (!previous) return;
      this.subagents.set(body.agentId, {
        ...previous,
        status: "running",
        updatedAt: Date.now(),
      });
    }
  }

  async interrupt(): Promise<void> {
    if (!this.backendAvailable) return;
    await this.adapter.interrupt();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.previewStateTimer !== null) {
      clearTimeout(this.previewStateTimer);
      this.previewStateTimer = null;
    }
    await this.adapter.dispose().catch(() => {});
    this.setStatus("done");
    this.removeAllListeners();
  }
}

export function titleFor(agent: AgentKind, cwd: string): string {
  return `${agent} · ${path.basename(cwd)}`;
}

/** 列表预览里不该出现 Markdown 标记,剥成朴素文本 */
export function stripMarkdown(src: string): string {
  return src
    .replace(/```[\s\S]*?(?:```|$)/g, " ") // 代码块整体去掉
    .replace(/`([^`]*)`/g, "$1") // 行内代码保留内容
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // 标题标记
    .replace(/^\s*[-*+]\s+/gm, "") // 无序列表标记
    .replace(/^\s*\d+[.)]\s+/gm, "") // 有序列表标记
    .replace(/^\s*>\s?/gm, "") // 引用标记
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接留文字
    .replace(/\s+/g, " ")
    .trim();
}

/** 会话卡片展示最后一条回复的尾部；开头被截掉时用省略号明确标示。 */
export function latestReplyPreview(src: string, max = PREVIEW_CHARS): string {
  const plain = stripMarkdown(src);
  if (plain.length <= max) return plain;
  let tail = plain.slice(-(max - 1));
  // 尽量不从半个单词开始；中文没有空格时仍按字符精确保留末尾。
  const boundary = tail.indexOf(" ");
  if (boundary > 0 && boundary < 24) tail = tail.slice(boundary + 1);
  return `…${tail}`;
}
