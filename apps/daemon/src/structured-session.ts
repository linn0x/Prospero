/**
 * 结构化会话:PtySession 的对位物。
 * PtySession 用 headless 终端持有画面状态,这里用事件日志持有对话状态,
 * attach 时用 chat.snapshot 一次性重放 —— 同样是"秒开",同样支持增量续传。
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { DEFAULT_POLICY } from "./approval-policy.js";
import { readChunk } from "./fs-ops.js";
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
import { MAX_SUBAGENT_SUMMARY_CHARS, MAX_SUBAGENTS_PER_SESSION } from "@prospero/protocol";
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
/** Parent chat only renders two lines; full child history remains available on demand. */
const SNAPSHOT_SUBAGENT_PREVIEW_CHARS = 220;

/**
 * Adapter events are trusted TypeScript values, not parsed protocol input. Native SDKs can still
 * return strings beyond the schema limit, so enforce the wire invariant before persist/broadcast.
 */
export function normalizeAgentEvent(body: AgentEventBody): AgentEventBody {
  if (
    body.kind !== "subagent.updated" ||
    body.summary === undefined ||
    body.summary.length <= MAX_SUBAGENT_SUMMARY_CHARS
  ) {
    return body;
  }
  return {
    ...body,
    // Completion conclusions tend to be at the end; make truncation explicit and keep that tail.
    summary: `…${body.summary.slice(-(MAX_SUBAGENT_SUMMARY_CHARS - 1))}`,
  };
}

function sameOptionalAgent(
  a: { agentId?: string | undefined },
  b: { agentId?: string | undefined },
): boolean {
  return a.agentId === b.agentId;
}

/**
 * Builds an equivalent parent-chat replay without token-sized delta/event overhead.
 * The durable log and incremental sequence remain untouched; evSeq therefore stays authoritative.
 */
export function compactAgentSnapshotEvents(events: readonly AgentEventBody[]): AgentEventBody[] {
  const compact: AgentEventBody[] = [];
  const subagentUpdateIndex = new Map<string, number>();

  for (const source of events) {
    let body = normalizeAgentEvent(source);
    if (body.kind === "subagent.updated" && body.summary) {
      body = {
        ...body,
        summary: latestReplyPreview(body.summary, SNAPSHOT_SUBAGENT_PREVIEW_CHARS),
      };
    }

    const previous = compact.at(-1);
    if (
      body.kind === "text.delta" &&
      previous?.kind === "text.delta" &&
      body.msgId === previous.msgId &&
      body.textId === previous.textId &&
      sameOptionalAgent(body, previous)
    ) {
      compact[compact.length - 1] = { ...previous, delta: previous.delta + body.delta };
      continue;
    }
    if (
      body.kind === "reasoning.delta" &&
      previous?.kind === "reasoning.delta" &&
      body.msgId === previous.msgId &&
      sameOptionalAgent(body, previous)
    ) {
      compact[compact.length - 1] = { ...previous, delta: previous.delta + body.delta };
      continue;
    }
    if (body.kind === "subagent.started") {
      // A repeated identity event starts a new folding segment for this child.
      subagentUpdateIndex.delete(body.subagent.id);
      compact.push(body);
      continue;
    }
    if (body.kind === "subagent.updated") {
      const index = subagentUpdateIndex.get(body.subagentId);
      if (index === undefined) {
        subagentUpdateIndex.set(body.subagentId, compact.length);
        compact.push(body);
        continue;
      }
      const prior = compact[index];
      if (prior?.kind !== "subagent.updated") {
        subagentUpdateIndex.set(body.subagentId, compact.length);
        compact.push(body);
        continue;
      }
      // Missing fields mean "retain the previous value" in the mobile reducer.
      compact[index] = {
        ...body,
        ...(body.canMessage === undefined && prior.canMessage !== undefined
          ? { canMessage: prior.canMessage }
          : {}),
        ...(!body.summary && prior.summary
          ? { summary: prior.summary }
          : {}),
      };
      continue;
    }
    compact.push(body);
  }
  return compact;
}

interface QueuedAttachmentRef {
  /** 仅在本会话附件目录中有意义的文件名；不会暴露绝对路径。 */
  id: string;
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
  /** 给本机会话子进程的环境；用于会话内 prospero CLI 身份。 */
  environment?: Record<string, string>;
  /** 隔离 API Profile 的 Codex app-server 受控配置。 */
  codexAppServerArgs?: string[];
  accountId?: string;
  accountName?: string;
  approvalPolicy?: ApprovalPolicy;
  restored?: StructuredSessionPersistentState;
  /** 新建 Prospero 会话时接入已有原生会话/初始模式。 */
  initialAdapterState?: AdapterResumeState;
  /**
   * Supervisor sessions keep immutable attachment copies under their private
   * per-session directory.  Legacy in-process sessions retain the historical
   * Prospero-home location for backwards-compatible restoration.
   */
  attachmentRoot?: string;
  /** Native Session Host-only provider Job registration callback. */
  registerProviderProcess?: ((process: { pid?: number | undefined }) => Promise<void>) | undefined;
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
  /** version=1 的旧状态没有账号；省略表示沿用当时的本机默认环境。 */
  accountId?: string;
  accountName?: string;
  createdAt: number;
  approvalPolicy: ApprovalPolicy;
  events: AgentEventBody[];
  evSeq: number;
  preview: string;
  previewRaw: string;
  previewMsgId: string;
  totals: { costUsd: number; inputTokens: number; outputTokens: number };
  toolOutputs: [string, string][];
  /** 登记时已截断到 MAX_TOOL_OUTPUT 的 callId;恢复时据此还原应答里的 truncated 标志。 */
  truncatedToolOutputs?: string[];
  adapterState: AdapterResumeState;
  /** 兼容早期 version=1 状态；新写入总会带这个字段。 */
  messageQueue?: QueuedChatPersistent[];
  /** 已终止 worker 的本地审计历史；恢复时不可重启或接受新 chat。 */
  terminal?: true;
}

export class StructuredSession extends EventEmitter<StructuredSessionEvents> {
  /** Legacy/in-process structured state is intentionally not durable. */
  readonly hosting = "in_process" as const;
  readonly id: string;
  readonly agent: AgentKind;
  title: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly accountId: string | undefined;
  readonly accountName: string | undefined;

  private readonly adapter: AgentAdapter;
  private readonly environment: Record<string, string>;
  private readonly codexAppServerArgs: string[] | undefined;
  private readonly attachmentRoot: string;
  private readonly registerProviderProcess: ((process: { pid?: number | undefined }) => Promise<void>) | undefined;
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
  /** callId → 工具输出(登记时已截断到 MAX_TOOL_OUTPUT),供 tool.output.get 按需拉取 */
  private readonly toolOutputs = new Map<string, string>();
  /** 登记时被截断过的 callId;应答时据此还原 truncated 标志(截断后长度不可再反推)。 */
  private readonly truncatedToolOutputs = new Set<string>();
  private adapterState: AdapterResumeState = {};
  private readonly messageQueue: QueuedChatPersistent[] = [];
  private drainingQueue = false;
  private previewStateTimer: NodeJS.Timeout | null = null;
  private lastPreviewStateAt = 0;
  /** Generic new-session labels are replaced once, by the first real user prompt. */
  private deriveTitleFromFirstUserMessage: boolean;

  constructor(opts: StructuredSessionOptions) {
    super();
    this.id = opts.id;
    this.agent = opts.agent;
    this.title = opts.title;
    this.cwd = opts.cwd;
    this.deriveTitleFromFirstUserMessage = opts.title === titleFor(opts.agent, opts.cwd);
    this.accountId = opts.accountId ?? opts.restored?.accountId;
    this.accountName = opts.accountName ?? opts.restored?.accountName;
    this.adapter = opts.adapter;
    this.environment = opts.environment ?? {};
    this.codexAppServerArgs = opts.codexAppServerArgs;
    this.attachmentRoot = opts.attachmentRoot ?? path.join(prosperoHome(), "attachments", this.id);
    this.registerProviderProcess = opts.registerProviderProcess;
    const restored = opts.restored;
    if (restored?.terminal) {
      this.status = "done";
      this.disposed = true;
      this.backendAvailable = false;
    }
    this.createdAt = restored?.createdAt ?? Date.now();
    this.policy = restored?.approvalPolicy ?? opts.approvalPolicy ?? DEFAULT_POLICY;
    this.adapterState = { ...(opts.initialAdapterState ?? {}) };
    if (restored) {
      const nativeThreadId =
        typeof restored.adapterState["threadId"] === "string"
          ? restored.adapterState["threadId"]
          : "";
      const restoredEvents = restored.events.map(normalizeAgentEvent).filter((body) => {
        // 0.0.10 曾给 thread/list 发送本机 app-server 不认识的 ancestorThreadId。
        // Codex 静默忽略后返回父线程自己，旧 daemon 随即把它持久化成了伪子 Agent。
        // 真子线程绝不可能与父 threadId 相等，因此恢复时可无歧义地清掉这两类事件。
        if (!nativeThreadId) return true;
        if (body.kind === "subagent.started") return body.subagent.id !== nativeThreadId;
        if (body.kind === "subagent.updated") return body.subagentId !== nativeThreadId;
        return true;
      });
      this.log.push(...restoredEvents.slice(-MAX_EVENTS));
      if (this.deriveTitleFromFirstUserMessage) {
        const firstUserMessage = this.log.find(
          (body) => body.kind === "user.message" && body.agentId === undefined && body.text.trim(),
        );
        if (firstUserMessage?.kind === "user.message") {
          const restoredTitle = titleFromUserPrompt(firstUserMessage.text);
          if (restoredTitle) {
            this.title = restoredTitle;
            this.deriveTitleFromFirstUserMessage = false;
          }
        }
      }
      // 清理过历史时主动重建事件序号。仍持有旧游标的客户端会因 afterSeq 过大
      // 自动回退全量快照，不会按已经不连续的旧序号错误增量续传。
      this.evSeq = restoredEvents.length === restored.events.length
        ? Math.max(restored.evSeq, this.log.length)
        : this.log.length;
      this.previewRaw = restored.previewRaw;
      this.preview = this.previewRaw
        ? latestReplyPreview(this.previewRaw, PREVIEW_CHARS)
        : restored.preview.replace(/^…+/, "").trimStart();
      this.previewMsgId = restored.previewMsgId;
      this.totals = { ...restored.totals };
      this.adapterState = { ...restored.adapterState };
      this.messageQueue.push(...(restored.messageQueue ?? []).slice(0, MAX_MESSAGE_QUEUE));
      for (const [callId, output] of restored.toolOutputs.slice(-MAX_TOOL_ENTRIES)) {
        this.toolOutputs.set(callId, output);
      }
      for (const callId of restored.truncatedToolOutputs ?? []) {
        if (this.toolOutputs.has(callId)) this.truncatedToolOutputs.add(callId);
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

  /**
   * `beforeDrain` 给恢复路径在 adapter 已接回、但队列尚未发送前再做一次
   * 编排归属检查的机会。回调可同步 dispose 本会话，随后不再触碰旧队列。
   */
  async start(beforeDrain?: () => void | Promise<void>): Promise<void> {
    await this.adapter.start({
      cwd: this.cwd,
      env: this.environment,
      ...(this.codexAppServerArgs ? { codexAppServerArgs: this.codexAppServerArgs } : {}),
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
      ...(this.registerProviderProcess ? { registerProviderProcess: this.registerProviderProcess } : {}),
    });
    await beforeDrain?.();
    if (this.disposed) return;
    this.setStatus(this.readyStatusFromLog());
    await this.drainQueue();
  }

  /** 第一次启动是“空闲就绪”；已有一轮落幕的恢复会话是“运行完毕”。 */
  private readyStatusFromLog(): "idle" | "completed" {
    for (let index = this.log.length - 1; index >= 0; index--) {
      const body = this.log[index];
      if (!body) continue;
      if (body.kind === "turn.end" || body.kind === "agent.error") {
        if (body.agentId === undefined) return "completed";
      } else if (body.kind === "user.message" && body.agentId === undefined) {
        return "idle";
      }
    }
    return "idle";
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
    if (this.disposed) throw new Error("会话已经结束，历史只读");
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
      ...(this.accountId ? { accountId: this.accountId } : {}),
      ...(this.accountName ? { accountName: this.accountName } : {}),
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
      // 超过协议上限就整帧作废,客户端连一次被自己的解析器踢一次 —— 宁可少报几个
      // 早期子 Agent,也不能让一个会话把整台主机的连接拖死。留最近的。
      ...(this.subagents.size > 0
        ? { subagents: [...this.subagents.values()].slice(-MAX_SUBAGENTS_PER_SESSION) }
        : {}),
      ...(this.preview ? { preview: this.preview } : {}),
      ...(this.busySince !== undefined ? { busySince: this.busySince } : {}),
      ...(this.totals.outputTokens > 0 || this.totals.costUsd > 0
        ? { totals: { ...this.totals } }
        : {}),
    };
  }

  /** 工具输出(应答 tool.output.get);登记时已截断,truncated 标志单独记录 */
  toolOutput(callId: string): { output: string; truncated: boolean } | null {
    const output = this.toolOutputs.get(callId);
    if (output === undefined) return null;
    return { output, truncated: this.truncatedToolOutputs.has(callId) };
  }

  /** 已发图片按需分块读取；先以 user.message 中的索引授权，再落到会话专属目录。 */
  async attachmentChunk(
    msgId: string,
    attachmentId: string,
    offset: number,
    length: number,
  ): Promise<{ data: Buffer; total: number; eof: boolean; mimeType: Attachment["mimeType"] } | null> {
    const message = [...this.log]
      .reverse()
      .find((body) => body.kind === "user.message" && body.msgId === msgId);
    const attachment = message?.kind === "user.message"
      ? message.attachments?.find((candidate) => candidate.id === attachmentId)
      : undefined;
    if (!attachment) return null;
    const chunk = await readChunk(this.attachmentRoot, attachment.id, offset, length);
    return { ...chunk, mimeType: attachment.mimeType };
  }

  /** 适配器登记工具输出;摘要仍走事件,全文按需拉取 */
  recordToolOutput(callId: string, output: string): void {
    if (this.toolOutputs.size > MAX_TOOL_ENTRIES) {
      const oldest = this.toolOutputs.keys().next().value;
      if (oldest !== undefined) {
        this.toolOutputs.delete(oldest);
        this.truncatedToolOutputs.delete(oldest);
      }
    }
    // 登记时即截断到既有上限:全文不再占内存与持久化体积(UI 本来也只能
    // 拿到这 200K)。截断事实单独记,保证 tool.output 应答的 truncated 标志不变。
    if (output.length > MAX_TOOL_OUTPUT) {
      this.truncatedToolOutputs.add(callId);
      this.toolOutputs.set(callId, output.slice(0, MAX_TOOL_OUTPUT));
    } else {
      this.toolOutputs.set(callId, output);
    }
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
      ...(this.accountId ? { accountId: this.accountId } : {}),
      ...(this.accountName ? { accountName: this.accountName } : {}),
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
      ...(this.truncatedToolOutputs.size > 0
        ? { truncatedToolOutputs: [...this.truncatedToolOutputs] }
        : {}),
      adapterState: { ...this.adapterState },
      messageQueue: this.messageQueue.map((item) => ({
        ...item,
        attachments: item.attachments.map((attachment) => ({ ...attachment })),
      })),
      ...(this.disposed ? { terminal: true as const } : {}),
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
    if (this.status !== "idle" && this.status !== "completed") {
      throw new Error("当前任务仍在运行，请结束后再压缩");
    }
    const readyStatus = this.status;
    this.busySince = Date.now();
    this.setStatus("running");
    try {
      await this.adapter.compact();
      // 成功路径由原生 compact 的 turn/status 事件发出 turn.end，再统一进入完成态。
    } catch (error) {
      this.setStatus(readyStatus);
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

  /** attach 传输用：保持最终聊天状态等价，同时压掉高频增量与进度摘要。 */
  transportSnapshot(): { events: AgentEventBody[]; evSeq: number } {
    return { events: compactAgentSnapshotEvents(this.log), evSeq: this.evSeq };
  }

  /**
   * 子 Agent 详情的权威快照。优先采用适配器原生历史，因其不受 Prospero
   * MAX_EVENTS 和 daemon 重启时点限制；人工审批/提问只存在于 Prospero 层，
   * 因此附加到原生历史尾部保留当前可交互状态。
   */
  async subagentSnapshot(
    subagentId: string,
  ): Promise<{ subagent: SubagentInfo; events: AgentEventBody[]; evSeq: number }> {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) throw new Error("子 Agent 已不存在");
    const stored = this.log.filter(
      (body) => (body as { agentId?: string }).agentId === subagentId,
    );
    let native: AgentEventBody[] | null = null;
    if (this.backendAvailable && this.adapter.readSubagentHistory) {
      try {
        native = await this.adapter.readSubagentHistory(subagentId);
      } catch {
        // app-server 短暂繁忙/正在落盘时，详情页仍应显示实时日志，而不是整页报错。
        native = null;
      }
    }
    if (!native || native.length === 0) {
      return {
        subagent: { ...subagent },
        events: compactAgentSnapshotEvents(stored),
        evSeq: this.evSeq,
      };
    }
    const interactions = stored.filter(
      (body) =>
        body.kind === "permission.request" ||
        body.kind === "permission.resolved" ||
        body.kind === "permission.auto" ||
        body.kind === "question.request" ||
        body.kind === "question.resolved",
    );
    return {
      subagent: { ...subagent },
      events: compactAgentSnapshotEvents([...native, ...interactions]),
      evSeq: this.evSeq,
    };
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
    body = normalizeAgentEvent(body);
    let titleChanged = false;
    if (
      this.deriveTitleFromFirstUserMessage &&
      body.kind === "user.message" &&
      body.agentId === undefined
    ) {
      const nextTitle = titleFromUserPrompt(body.text);
      if (nextTitle) {
        this.title = nextTitle;
        this.deriveTitleFromFirstUserMessage = false;
        titleChanged = true;
      }
    }
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
      this.previewRaw = (this.previewRaw + body.delta).slice(0, PREVIEW_RAW_CHARS);
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
      if (this.pending.size === 0 && this.pendingQuestions.size === 0) this.setStatus("completed");
    } else if (body.kind === "agent.error" && body.agentId === undefined) {
      if (this.pending.size === 0 && this.pendingQuestions.size === 0) this.setStatus("completed");
    } else if (
      // 有些原生后端会先报 turn.end，再补最后一批 tool.end（例如长轮询
      // `check --wait` 被消息唤醒）。turn.end 已经是该轮的完成事实，迟到的
      // 工具收尾不能把卡片重新标成 running，否则没有下一条 turn.end 将它收回。
      body.kind !== "tool.end" &&
      body.kind !== "trajectory.record" &&
      body.kind !== "subagent.started" &&
      body.kind !== "subagent.updated" &&
      body.agentId === undefined &&
      (this.status === "idle" || this.status === "completed" || this.status === "starting")
    ) {
      this.setStatus("running");
    }

    if (titleChanged) {
      this.emit("state", this.info());
      this.emit("persist");
    }
    if (body.kind === "text.delta" || body.kind === "subagent.updated") this.schedulePreviewState();
    this.emit("event", body, this.evSeq);
    if (body.kind === "turn.end" || body.kind === "agent.error") void this.drainQueue();
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === s) return;
    this.status = s;
    // running/等待交互期间才计时,回到就绪/完成态就清掉
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
    if (this.disposed) throw new Error("会话已经结束，历史只读");
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
            this.recordUserMessage(queued.displayText, queued.attachments);
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
    if (this.disposed) return false;
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
    if (this.disposed) throw new Error("会话已经结束，历史只读");
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
        if (steered) this.recordUserMessage(initial.displayText, initial.attachments);
        return steered;
      }
      const [item] = this.messageQueue.splice(index, 1);
      if (!item) return steered;
      if (steered) {
        this.recordUserMessage(item.displayText, item.attachments);
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
    const refs = attachments?.length ? await this.persistAttachments(attachments) : [];
    if (refs.length > 0 && this.adapter.acceptsImages !== true) {
      // 后端吃不了图就落盘,把绝对路径并进文本 —— 有读文件能力的 agent
      // 照样能看到内容。写进 ~/.prospero 而不是仓库里:附件是会话产物,
      // 不该出现在用户的 git status 里。
      outgoing = [text, ...refs.map((ref) => `[附件] ${ref.path}`)]
        .filter((x) => x.length > 0)
        .join("\n");
      forAdapter = undefined;
    }
    // 用户消息本地登记,保证 attach 快照里能看到自己发过什么。
    this.recordUserMessage(text, refs);
    this.busySince = Date.now(); // 新一轮开始重新计时
    this.setStatus("running");
    const prepared = await this.prepareForAdapter(outgoing);
    try {
      await this.adapter.send(prepared.text, forAdapter, prepared.skills);
    } catch (error) {
      this.record({
        kind: "agent.error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private recordUserMessage(text: string, attachments: QueuedAttachmentRef[] = []): void {
    this.record({
      kind: "user.message",
      msgId: `u_${String(this.evSeq + 1)}`,
      text,
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((attachment) => ({
              id: attachment.id,
              mimeType: attachment.mimeType,
              ...(attachment.name ? { name: attachment.name } : {}),
            })),
          }
        : {}),
    });
  }

  private async prepareQueuedMessage(
    text: string,
    attachments: Attachment[] | undefined,
    kind: QueuedChatPersistent["kind"],
  ): Promise<QueuedChatPersistent> {
    const refs = attachments?.length ? await this.persistAttachments(attachments) : [];
    const attachmentCount = attachments?.length ?? 0;
    return {
      id: randomUUID(),
      displayText: text,
      outgoingText:
        attachmentCount > 0 && this.adapter.acceptsImages !== true
          ? [text, ...refs.map((ref) => `[附件] ${ref.path}`)]
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
    const root = path.resolve(this.attachmentRoot);
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
    if (this.disposed || !this.backendAvailable) return;
    this.recordUserMessage(item.displayText, item.attachments);
    this.busySince = Date.now();
    this.setStatus("running");
    const prepared = await this.prepareForAdapter(item.outgoingText);
    // prepare/附件读取中可能有外部 control RPC 同步封存 session。不能在那个
    // await 间隙之后继续把旧 worktree 的队列消息交给原生 adapter。
    if (this.disposed || !this.backendAvailable) return;
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
      (this.status !== "idle" && this.status !== "completed")
    ) {
      return;
    }
    this.drainingQueue = true;
    try {
      while (
        (this.status === "idle" || this.status === "completed") &&
        this.messageQueue.length > 0
      ) {
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

  /** 把附件写进会话专属目录；事件里只保存文件名索引。 */
  private async persistAttachments(attachments: Attachment[]): Promise<QueuedAttachmentRef[]> {
    const dir = this.attachmentRoot;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const out: QueuedAttachmentRef[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      if (!a) continue;
      const ext = a.mimeType.split("/")[1] ?? "png";
      // 文件名由 UUID 生成，既不能越出会话目录，也避免把原始文件名暴露为路径。
      const id = `${randomUUID()}.${ext}`;
      const file = path.join(dir, id);
      await writeFile(file, Buffer.from(a.dataB64, "base64"), { mode: 0o600 });
      await chmod(file, 0o600).catch(() => {});
      out.push({
        id,
        mimeType: a.mimeType,
        path: file,
        ...(a.name ? { name: a.name } : {}),
      });
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
    // 先把会话封存为 done，再等待原生 adapter 释放。worker 的 control RPC 可能
    // 正由 adapter 自己承载；若此处等待形成自杀式死锁，SessionManager 仍能立即
    // 落盘只读终态，避免重启后消费旧 worktree 的排队消息。
    this.setStatus("done");
    // Callers that own an external containment boundary (the Windows Session
    // Host Job) need the real adapter failure so they can preserve it while
    // still running their finally cleanup.  The session is terminal either
    // way, and listeners must not leak if disposal rejects.
    try { await this.adapter.dispose(); }
    finally { this.removeAllListeners(); }
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

/** New conversations use the user's first prompt as their stable list title. */
export function titleFromUserPrompt(src: string, max = 500): string {
  return stripMarkdown(src).slice(0, max).trimEnd();
}

/** 会话卡片展示最后一条回复的开头；内容过长时只在末尾标示省略。 */
export function latestReplyPreview(src: string, max = PREVIEW_CHARS): string {
  const plain = stripMarkdown(src);
  if (plain.length <= max) return plain;
  let head = plain.slice(0, max - 1);
  // 英文尽量不截断最后一个单词；中文没有空格时仍按字符精确保留开头。
  const boundary = head.lastIndexOf(" ");
  if (boundary > max - 24) head = head.slice(0, boundary);
  return `${head.trimEnd()}…`;
}
