/**
 * OpenAI Codex 适配器(实测于 codex-cli 0.146.0)。
 *
 * 形态:`codex app-server` 子进程,JSON-RPC 2.0 over stdio(换行分隔)。
 * 这是 IDE 扩展用的同一条通道,协议类型可用
 * `codex app-server generate-ts --out DIR` 自举核对。
 *
 * 三方适配器里它的审批模型最"正统":审批是 server→client 的 JSON-RPC **请求**,
 * 客户端必须回 response —— 与 Claude 的 canUseTool 回调同构,和 opencode 的
 * 事件+HTTP 回复不同。
 *
 * 协议要点(取自生成的 TS 绑定):
 * - initialize → thread/start → turn/start
 * - 通知:item/started、item/agentMessage/delta、item/reasoning/textDelta、
 *   item/completed、turn/completed
 * - 审批请求:item/commandExecution/requestApproval、item/fileChange/requestApproval
 * - 决定值 ReviewDecision:"approved" | "approved_for_session" | {denied:{rejection}} | "abort"
 */
import { spawn, type ChildProcess } from "node:child_process";
import type {
  AgentEventBody,
  AgentQuestionAnswer,
  Attachment,
  FileDiff,
  PermissionReply,
  SubagentStatus,
} from "@prospero/protocol";
import { needsApproval } from "../approval-policy.js";
import type { ResolvedSkill } from "../composer-context.js";
import { fromUnifiedPatch } from "./diff.js";
import {
  AdapterError,
  summarize,
  type AdapterContext,
  type AgentAdapter,
  type AgentModeCatalog,
  type AgentModeSelection,
  type AgentModelCatalog,
  type AgentModelSelection,
  type AdapterResumeState,
  type UsageReport,
} from "./types.js";

/** 把窗口时长说成人话:300 分钟 → 「5 小时」 */
function describeWindow(mins: number): string {
  if (mins % (60 * 24) === 0) return `${String(mins / (60 * 24))} 天`;
  if (mins % 60 === 0) return `${String(mins / 60)} 小时`;
  return `${String(mins)} 分钟`;
}

const START_TIMEOUT_MS = 30_000;

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingApproval {
  /** JSON-RPC 请求 id,回 response 时用 */
  rpcId: number | string;
  itemId: string;
  agentId?: string;
}

interface PendingQuestion {
  rpcId: number | string;
  agentId?: string;
}

export interface CodexAdapterOptions {
  /** `codex app-server` 持久化在本机的 thread；有值时走 thread/resume。 */
  resumeState?: AdapterResumeState | undefined;
}

/** 从 Codex 的通知参数里找 unified patch(字段名随版本有出入,尽力而为) */
function extractDiff(p: Record<string, unknown>): FileDiff | null {
  const path =
    typeof p["path"] === "string"
      ? p["path"]
      : typeof p["file"] === "string"
        ? p["file"]
        : "";
  const patch = p["patch"] ?? p["unifiedDiff"] ?? p["diff"];
  if (typeof patch === "string" && patch.length > 0) {
    return fromUnifiedPatch(path, patch);
  }
  // changes: { "<path>": { patch | unifiedDiff } }
  const changes = p["changes"];
  if (changes && typeof changes === "object" && !Array.isArray(changes)) {
    for (const [k, v] of Object.entries(changes as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const inner = v as Record<string, unknown>;
        const ip = inner["patch"] ?? inner["unifiedDiff"] ?? inner["diff"];
        if (typeof ip === "string" && ip.length > 0) return fromUnifiedPatch(k, ip);
      }
    }
  }
  return null;
}

export class CodexAdapter implements AgentAdapter {
  constructor(private readonly opts: CodexAdapterOptions = {}) {}

  /** app-server 能保留 Skill 的结构化身份，而不是把它降级成一大段普通文本。 */
  readonly acceptsSkillInputs = true;

  private proc: ChildProcess | null = null;
  private ctx: AdapterContext | null = null;
  private threadId: string | null = null;
  /** model/effort 是逐轮原生覆盖；持久化后 daemon 重启也保持本会话选择。 */
  private selectedModel: string | null = null;
  private selectedEffort: string | null = null;
  private selectedMode: "default" | "plan" = "default";
  private modelCache: AgentModelCatalog | null = null;
  private nextId = 1;
  private buf = "";
  private readonly pendingRpc = new Map<number | string, (m: RpcMessage) => void>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly subagents = new Map<string, { createdAt: number; canMessage: boolean }>();
  private readonly currentTurns = new Map<string, string>();
  private readonly lastTextByThread = new Map<string, string>();
  /** 本轮 token(来自 thread/tokenUsage/updated,turn/completed 时随事件带出) */
  private lastTurnTokens: { input?: number | undefined; output?: number | undefined } = {};
  /** 会话累计 token */
  private totalTokens: { input?: number | undefined; output?: number | undefined } = {};
  /** 账号级限流快照 */
  private rateLimits: { windows: UsageReport["windows"]; plan: string | null } | null = null;

  /** codex 原生支持用量与限流,不必退回会话累计 */
  async usage(): Promise<UsageReport | null> {
    if (!this.rateLimits && this.totalTokens.output === undefined) return null;
    return {
      subscription: this.rateLimits?.plan ?? null,
      ...(this.totalTokens.input !== undefined ? { inputTokens: this.totalTokens.input } : {}),
      ...(this.totalTokens.output !== undefined ? { outputTokens: this.totalTokens.output } : {}),
      windows: this.rateLimits?.windows ?? [],
    };
  }

  /** itemId → 工具名,用于 item/completed 时回填 tool.end */
  private readonly toolItems = new Map<string, string>();
  private currentTurnMsgId = "";
  /** itemId → 已收到的 patch,审批与 item 完成时取用 */
  private readonly pendingDiffs = new Map<string, FileDiff>();
  /**
   * 最近一条助手文本的 itemId。turn/completed 只带 turnId,与文本 item 的 id
   * 不同;若拿 turnId 当 msgId,客户端会把用量挂到一条不存在的消息上。
   */
  private lastTextMsgId = "";
  private compactInFlight = false;

  /**
   * YOLO 不只是“不弹审批”，还必须解除 Codex sandbox。否则 Docker socket、
   * 仓库外文件和网络仍会被 workspace-write 拦住，界面看起来就像 YOLO 失效。
   */
  private executionPolicy(): {
    approvalPolicy: "untrusted" | "never";
    sandbox: "workspace-write" | "danger-full-access";
    sandboxPolicy: { type: "workspaceWrite"; writableRoots: string[] } | { type: "dangerFullAccess" };
  } {
    const yolo = this.ctx?.approvalPolicy?.() === "yolo";
    return yolo
      ? {
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          sandboxPolicy: { type: "dangerFullAccess" },
        }
      : {
          approvalPolicy: "untrusted",
          sandbox: "workspace-write",
          sandboxPolicy: { type: "workspaceWrite", writableRoots: this.ctx ? [this.ctx.cwd] : [] },
        };
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.selectedModel =
      typeof this.opts.resumeState?.["model"] === "string"
        ? this.opts.resumeState["model"]
        : null;
    this.selectedEffort =
      typeof this.opts.resumeState?.["effort"] === "string"
        ? this.opts.resumeState["effort"]
        : null;
    this.selectedMode = this.opts.resumeState?.["mode"] === "plan" ? "plan" : "default";
    const proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ctx.cwd,
      env: { ...process.env },
    });
    this.proc = proc;
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    proc.once("error", (e) => {
      this.emit({ kind: "agent.error", message: `codex app-server 启动失败:${e.message}` });
    });
    proc.once("exit", (code) => {
      if (code !== 0 && code !== null) {
        this.emit({ kind: "agent.error", message: `codex app-server 退出,code=${String(code)}` });
      }
    });

    await this.request("initialize", {
      clientInfo: { name: "prospero", title: "Prospero", version: "0.0.1" },
    });
    this.notify("initialized", {});

    const resumeThreadId =
      typeof this.opts.resumeState?.["threadId"] === "string"
        ? this.opts.resumeState["threadId"]
        : null;
    // 实测:threadId 在 result.thread.id,不是顶层 threadId(spec 类型名有误导)。
    // Codex 自己把 thread 落在 ~/.codex；Prospero 只需保存这个 ID。
    const initialPolicy = this.executionPolicy();
    const baseParams = {
      cwd: ctx.cwd,
      approvalPolicy: initialPolicy.approvalPolicy,
      sandbox: initialPolicy.sandbox,
      ...(this.selectedModel ? { model: this.selectedModel } : {}),
    };
    let started: { thread?: { id?: string }; threadId?: string };
    if (resumeThreadId) {
      try {
        started = (await this.request("thread/resume", {
          threadId: resumeThreadId,
          ...baseParams,
        })) as typeof started;
      } catch (error) {
        // Codex 会清理损坏/过期的 rollout。Prospero 的本地聊天历史仍然有价值，
        // 因此只对“原生上下文已不存在”做新 thread 降级，让同一会话还能继续用；
        // 鉴权、协议等其他错误继续上抛，不能被伪装成恢复成功。
        if (!(error instanceof Error) || !/no rollout found/i.test(error.message)) throw error;
        started = (await this.request("thread/start", baseParams)) as typeof started;
      }
    } else {
      started = (await this.request("thread/start", baseParams)) as typeof started;
    }
    const threadId = started.thread?.id ?? started.threadId;
    if (!threadId) {
      throw new AdapterError(
        `codex ${resumeThreadId ? "thread/resume" : "thread/start"} 未返回 threadId`,
      );
    }
    this.threadId = threadId;
    this.persistNativeState();
    await this.discoverSubagents();
  }

  private persistNativeState(): void {
    const state: AdapterResumeState = {};
    if (this.threadId) state["threadId"] = this.threadId;
    if (this.selectedModel) state["model"] = this.selectedModel;
    if (this.selectedEffort) state["effort"] = this.selectedEffort;
    state["mode"] = this.selectedMode;
    this.ctx?.persistState?.(state);
  }

  private emit(body: AgentEventBody): void {
    this.ctx?.emit(body);
  }

  private eventAgent(threadId: unknown): string | undefined {
    return this.threadId !== null &&
      typeof threadId === "string" &&
      threadId.length > 0 &&
      threadId !== this.threadId
      ? threadId
      : undefined;
  }

  private registerSubagent(
    id: string,
    details: {
      name?: string;
      role?: string;
      task?: string;
      preview?: string;
      createdAt?: number;
      canMessage?: boolean;
      status?: SubagentStatus;
    } = {},
  ): void {
    if (!id || id === this.threadId) return;
    const existing = this.subagents.get(id);
    if (existing) return;
    const createdAt = details.createdAt ?? Date.now();
    const canMessage = details.canMessage ?? true;
    this.subagents.set(id, { createdAt, canMessage });
    this.emit({
      kind: "subagent.started",
      subagent: {
        id,
        name: details.name || `Codex 子 Agent ${String(this.subagents.size)}`,
        ...(details.role ? { role: details.role } : {}),
        ...(details.task ? { task: details.task } : {}),
        status: details.status ?? "starting",
        canMessage,
        createdAt,
        updatedAt: Date.now(),
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
    if (!this.subagents.has(id)) this.registerSubagent(id, { status, canMessage });
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

  private async discoverSubagents(): Promise<void> {
    if (!this.threadId) return;
    try {
      const raw = (await this.request("thread/list", {
        limit: 100,
        ancestorThreadId: this.threadId,
      })) as { data?: unknown[] };
      for (const value of raw.data ?? []) {
        if (!value || typeof value !== "object") continue;
        const row = value as Record<string, unknown>;
        const id = typeof row["id"] === "string" ? row["id"] : "";
        if (!id) continue;
        const status = this.subagentStatus(row["status"]);
        this.registerSubagent(id, {
          ...(typeof row["agentNickname"] === "string"
            ? { name: row["agentNickname"] }
            : typeof row["name"] === "string"
              ? { name: row["name"] }
              : {}),
          ...(typeof row["agentRole"] === "string" ? { role: row["agentRole"] } : {}),
          ...(typeof row["preview"] === "string" ? { preview: row["preview"] } : {}),
          ...(typeof row["createdAt"] === "number"
            ? { createdAt: Math.round(row["createdAt"] * 1000) }
            : {}),
          canMessage: row["canAcceptDirectInput"] !== false,
          status,
        });
      }
    } catch {
      // 较老的 app-server 没有 ancestorThreadId；实时生命周期仍会补齐。
    }
  }

  private subagentStatus(value: unknown): SubagentStatus {
    const type =
      value && typeof value === "object"
        ? String((value as Record<string, unknown>)["type"] ?? "")
        : String(value ?? "");
    if (type === "active" || type === "running" || type === "pendingInit") return "running";
    if (type === "idle") return "idle";
    if (type === "completed") return "completed";
    if (type === "systemError" || type === "errored" || type === "notFound") return "failed";
    if (type === "interrupted" || type === "shutdown" || type === "notLoaded") return "stopped";
    return "starting";
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue; // 非 JSON 行(启动横幅等)
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: RpcMessage): void {
    // 1) 我方请求的响应
    if (msg.id !== undefined && msg.method === undefined) {
      const resolve = this.pendingRpc.get(msg.id);
      if (resolve) {
        this.pendingRpc.delete(msg.id);
        resolve(msg);
      }
      return;
    }
    // 2) server→client 请求(审批)—— 必须回 response
    if (msg.id !== undefined && msg.method !== undefined) {
      this.onServerRequest(msg);
      return;
    }
    // 3) 通知
    if (msg.method !== undefined) this.onNotification(msg);
  }

  private onServerRequest(msg: RpcMessage): void {
    const p = msg.params ?? {};
    const itemId = String(p["itemId"] ?? msg.id);
    const agentId = this.eventAgent(p["threadId"]);
    switch (msg.method) {
      case "item/tool/requestUserInput": {
        const reqId = itemId;
        const rawQuestions = Array.isArray(p["questions"]) ? p["questions"] : [];
        const questions = rawQuestions.flatMap((value, index) => {
          if (!value || typeof value !== "object") return [];
          const row = value as Record<string, unknown>;
          const id = typeof row["id"] === "string" ? row["id"] : `question-${String(index + 1)}`;
          const question = typeof row["question"] === "string" ? row["question"] : "请选择";
          const options = Array.isArray(row["options"])
            ? row["options"].flatMap((option) => {
                if (!option || typeof option !== "object") return [];
                const choice = option as Record<string, unknown>;
                return typeof choice["label"] === "string"
                  ? [{
                      label: choice["label"],
                      ...(typeof choice["description"] === "string"
                        ? { description: choice["description"] }
                        : {}),
                    }]
                  : [];
              })
            : [];
          return [{
            id,
            header: typeof row["header"] === "string" ? row["header"] : "Agent 提问",
            question,
            options,
            multiSelect: false,
            allowOther: row["isOther"] === true,
            ...(row["isSecret"] === true ? { secret: true } : {}),
          }];
        });
        if (questions.length === 0) {
          this.respond(msg.id!, { answers: {} });
          return;
        }
        this.questions.set(reqId, { rpcId: msg.id!, ...(agentId ? { agentId } : {}) });
        this.emit({
          kind: "question.request",
          reqId,
          questions,
          ...(typeof p["autoResolutionMs"] === "number" && p["autoResolutionMs"] >= 1000
            ? { autoResolutionMs: p["autoResolutionMs"] }
            : {}),
          ...(agentId ? { agentId } : {}),
        });
        return;
      }
      case "item/commandExecution/requestApproval": {
        const cmd = p["command"] ?? p["parsedCommand"] ?? p["argv"];
        this.requestApproval({
          rpcId: msg.id!,
          itemId,
          toolName: "commandExecution",
          action: "运行命令",
          resources: [summarize(cmd, 400)],
          summary: `运行命令:${summarize(cmd, 200)}`,
          ...(agentId ? { agentId } : {}),
        });
        return;
      }
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        const reason = p["reason"] ?? p["grantRoot"] ?? p["changes"] ?? "修改文件";
        // Codex 会通过 patchUpdated 先行给出 patch,这里取用
        const diff = this.pendingDiffs.get(itemId) ?? extractDiff(p);
        this.requestApproval({
          rpcId: msg.id!,
          itemId,
          toolName:
            msg.method === "item/fileChange/requestApproval" ? "fileChange" : "permissions",
          action: "修改文件",
          resources: [summarize(diff?.path ?? reason, 400)],
          summary: `修改文件:${summarize(diff?.path ?? reason, 200)}`,
          diff,
          ...(agentId ? { agentId } : {}),
        });
        return;
      }
      default:
        // 未知的 server 请求:回 error,避免 codex 永久等待
        this.respond(msg.id!, undefined, {
          code: -32601,
          message: `prospero 不支持 ${msg.method ?? "?"}`,
        });
    }
  }

  /**
   * strict/standard 以 untrusted 启动,审批在 Prospero 层处理以保留审计。
   * YOLO 通常不会再收到请求；若切换瞬间仍有旧请求在途，这里仍会立即放行。
   */
  private requestApproval(input: {
    rpcId: number | string;
    itemId: string;
    toolName: string;
    action: string;
    resources: string[];
    summary: string;
    diff?: FileDiff | null;
    agentId?: string;
  }): void {
    const policy = this.ctx?.approvalPolicy?.() ?? "strict";
    if (!needsApproval(policy, input.toolName)) {
      // 只批准这一次。若回 approved_for_session,Codex 后续不再发请求,
      // Prospero 也就无法继续留下 permission.auto 审计记录。
      this.respond(input.rpcId, { decision: "approved" });
      this.emit({
        kind: "permission.auto",
        reqId: input.itemId,
        action: input.action,
        summary: input.summary,
        policy,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
      return;
    }

    this.approvals.set(input.itemId, {
      rpcId: input.rpcId,
      itemId: input.itemId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
    this.emit({
      kind: "permission.request",
      reqId: input.itemId,
      action: input.action,
      resources: input.resources,
      summary: input.summary,
      ...(input.diff ? { diff: input.diff } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
  }

  private onNotification(msg: RpcMessage): void {
    const p = msg.params ?? {};
    const notificationThreadId =
      typeof p["threadId"] === "string" ? p["threadId"] : (this.threadId ?? "");
    const agentId = this.eventAgent(notificationThreadId);
    const agentField = agentId ? { agentId } : {};
    switch (msg.method) {
      case "thread/started": {
        const thread = (p["thread"] ?? {}) as Record<string, unknown>;
        const id = typeof thread["id"] === "string" ? thread["id"] : "";
        if (!id || typeof thread["parentThreadId"] !== "string") return;
        this.registerSubagent(id, {
          ...(typeof thread["agentNickname"] === "string"
            ? { name: thread["agentNickname"] }
            : typeof thread["name"] === "string"
              ? { name: thread["name"] }
              : {}),
          ...(typeof thread["agentRole"] === "string" ? { role: thread["agentRole"] } : {}),
          ...(typeof thread["preview"] === "string" ? { preview: thread["preview"] } : {}),
          ...(typeof thread["createdAt"] === "number"
            ? { createdAt: Math.round(thread["createdAt"] * 1000) }
            : {}),
          canMessage: thread["canAcceptDirectInput"] !== false,
          status: this.subagentStatus(thread["status"]),
        });
        return;
      }
      case "thread/status/changed": {
        const id = typeof p["threadId"] === "string" ? p["threadId"] : "";
        if (!id || id === this.threadId) return;
        const status = this.subagentStatus(p["status"]);
        this.updateSubagent(id, status, status !== "failed" && status !== "stopped");
        return;
      }
      case "thread/closed":
      case "thread/deleted": {
        const id = typeof p["threadId"] === "string" ? p["threadId"] : "";
        if (id && id !== this.threadId) this.updateSubagent(id, "stopped", false);
        return;
      }
      case "turn/started": {
        const turn = (p["turn"] ?? {}) as Record<string, unknown>;
        const turnId = String(turn["id"] ?? p["turnId"] ?? "");
        if (notificationThreadId) this.currentTurns.set(notificationThreadId, turnId);
        this.lastTextByThread.delete(notificationThreadId);
        if (agentId) this.updateSubagent(agentId, "running", true);
        else {
          this.currentTurnMsgId = turnId;
          this.lastTextMsgId = "";
        }
        return;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta": {
        const delta = p["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          const msgId = String(
            p["itemId"] ?? this.currentTurns.get(notificationThreadId) ?? this.currentTurnMsgId,
          );
          this.lastTextByThread.set(notificationThreadId, msgId);
          if (!agentId) this.lastTextMsgId = msgId;
          this.emit({ kind: "text.delta", msgId, textId: msgId, delta, ...agentField });
        }
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = p["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          this.emit({
            kind: "reasoning.delta",
            msgId: String(
              p["itemId"] ?? this.currentTurns.get(notificationThreadId) ?? this.currentTurnMsgId,
            ),
            delta,
            ...agentField,
          });
        }
        return;
      }
      case "item/started": {
        const item = (p["item"] ?? {}) as Record<string, unknown>;
        const itemType = String(item["type"] ?? item["item_type"] ?? "");
        const itemId = String(item["id"] ?? p["itemId"] ?? "");
        if (itemType === "collabAgentToolCall") {
          for (const receiverId of this.receiverThreadIds(item)) {
            this.registerSubagent(receiverId, {
              ...(typeof item["prompt"] === "string" ? { task: item["prompt"] } : {}),
              status: "running",
              canMessage: true,
            });
            this.updateSubagent(receiverId, "running", true);
          }
          return;
        }
        if (itemType === "subAgentActivity") {
          const receiverId =
            typeof item["agentThreadId"] === "string" ? item["agentThreadId"] : "";
          if (receiverId) this.registerSubagent(receiverId, { status: "running" });
          return;
        }
        if (
          itemType === "commandExecution" ||
          itemType === "fileChange" ||
          itemType === "mcpToolCall"
        ) {
          const tool =
            itemType === "commandExecution"
              ? "bash"
              : itemType === "fileChange"
                ? "edit"
                : String(item["server"] ?? "mcp");
          this.toolItems.set(itemId, tool);
          this.emit({
            kind: "tool.start",
            msgId: this.currentTurns.get(notificationThreadId) ?? this.currentTurnMsgId,
            callId: itemId,
            tool,
            summary: summarize(item["command"] ?? item["changes"] ?? item),
            ...agentField,
          });
        }
        return;
      }
      case "item/fileChange/patchUpdated": {
        const diff = extractDiff(p);
        if (diff) this.pendingDiffs.set(String(p["itemId"] ?? ""), diff);
        return;
      }
      case "item/completed": {
        const item = (p["item"] ?? {}) as Record<string, unknown>;
        const itemType = String(item["type"] ?? item["item_type"] ?? "");
        const itemId = String(item["id"] ?? p["itemId"] ?? "");
        if (itemType === "collabAgentToolCall") {
          const rawStatus = String(item["status"] ?? "completed");
          const status: SubagentStatus = rawStatus === "failed" ? "failed" : "completed";
          const states = item["agentsStates"] as Record<string, unknown> | undefined;
          for (const receiverId of this.receiverThreadIds(item)) {
            const state = states?.[receiverId] as Record<string, unknown> | undefined;
            const summary = typeof state?.["message"] === "string" ? state["message"] : undefined;
            this.updateSubagent(receiverId, status, false, summary);
          }
          return;
        }
        if (!this.toolItems.has(itemId)) return;
        this.toolItems.delete(itemId);
        const status = String(item["status"] ?? "completed");
        const raw = item["output"] ?? item["aggregatedOutput"] ?? item["result"] ?? status;
        const full = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
        if (full.length > 0) this.ctx?.recordOutput?.(itemId, full);
        const summary = summarize(raw);
        const diff = this.pendingDiffs.get(itemId);
        this.pendingDiffs.delete(itemId);
        this.emit({
          kind: "tool.end",
          callId: itemId,
          state: status === "failed" || status === "error" ? "failed" : "success",
          summary,
          ...(full.length > summary.length ? { hasMore: true } : {}),
          ...(diff ? { diff } : {}),
          ...agentField,
        });
        return;
      }
      case "thread/tokenUsage/updated": {
        if (agentId) return;
        const tu = (p["tokenUsage"] ?? {}) as Record<string, unknown>;
        const last = (tu["last"] ?? {}) as Record<string, unknown>;
        const total = (tu["total"] ?? {}) as Record<string, unknown>;
        const num = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) ? v : undefined;
        this.lastTurnTokens = { input: num(last["inputTokens"]), output: num(last["outputTokens"]) };
        this.totalTokens = { input: num(total["inputTokens"]), output: num(total["outputTokens"]) };
        return;
      }
      case "account/rateLimits/updated": {
        const rl = (p["rateLimits"] ?? {}) as Record<string, unknown>;
        const win = (v: unknown, label: string): UsageReport["windows"][number] | null => {
          const w = v as {
            usedPercent?: unknown;
            windowDurationMins?: unknown;
            resetsAt?: unknown;
          } | null;
          if (!w || typeof w.usedPercent !== "number") return null;
          const mins = typeof w.windowDurationMins === "number" ? w.windowDurationMins : null;
          return {
            label: mins ? describeWindow(mins) : label,
            utilization: w.usedPercent,
            ...(typeof w.resetsAt === "number"
              ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() }
              : {}),
          };
        };
        const windows = [win(rl["primary"], "主窗口"), win(rl["secondary"], "次窗口")].filter(
          (w): w is UsageReport["windows"][number] => w !== null,
        );
        this.rateLimits = {
          windows,
          plan: typeof rl["planType"] === "string" ? rl["planType"] : null,
        };
        return;
      }
      case "turn/completed": {
        const turn = (p["turn"] ?? {}) as Record<string, unknown>;
        const turnId = String(turn["id"] ?? p["turnId"] ?? "");
        const textMsgId = this.lastTextByThread.get(notificationThreadId);
        this.emit({
          kind: "turn.end",
          msgId: textMsgId || (!agentId ? this.lastTextMsgId : "") || turnId,
          ...(typeof turn["status"] === "string"
            ? { finish: turn["status"] }
            : typeof p["status"] === "string"
              ? { finish: p["status"] }
              : {}),
          ...(!agentId && this.lastTurnTokens.input !== undefined
            ? { inputTokens: this.lastTurnTokens.input }
            : {}),
          ...(!agentId && this.lastTurnTokens.output !== undefined
            ? { outputTokens: this.lastTurnTokens.output }
            : {}),
          ...agentField,
        });
        this.currentTurns.delete(notificationThreadId);
        this.lastTextByThread.delete(notificationThreadId);
        if (agentId) this.updateSubagent(agentId, "idle", true);
        else {
          this.lastTurnTokens = {};
          this.currentTurnMsgId = "";
          this.compactInFlight = false;
        }
        return;
      }
      case "thread/compacted": {
        if (agentId || !this.compactInFlight) return;
        this.compactInFlight = false;
        this.emit({
          kind: "turn.end",
          msgId: `compact-${Date.now().toString(36)}`,
          finish: "compact",
        });
        return;
      }
      case "error": {
        this.emit({ kind: "agent.error", message: summarize(p["message"] ?? p), ...agentField });
        return;
      }
      default:
        return;
    }
  }

  private receiverThreadIds(item: Record<string, unknown>): string[] {
    return Array.isArray(item["receiverThreadIds"])
      ? item["receiverThreadIds"].filter((id): id is string => typeof id === "string")
      : [];
  }

  private write(obj: Record<string, unknown>): void {
    this.proc?.stdin?.write(JSON.stringify(obj) + "\n");
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  private respond(id: number | string, result?: unknown, error?: RpcMessage["error"]): void {
    this.write(error ? { id, error } : { id, result: result ?? {} });
  }

  /** timeoutMs=0 表示不超时(turn/start 可能跑很久) */
  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = START_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingRpc.delete(id);
              reject(new AdapterError(`codex ${method} 超时`));
            }, timeoutMs)
          : null;
      this.pendingRpc.set(id, (m) => {
        if (timer) clearTimeout(timer);
        if (m.error) {
          reject(new AdapterError(`codex ${method} 失败:${m.error.message}`));
          return;
        }
        resolve(m.result ?? {});
      });
      this.write({ id, method, params });
    });
  }

  private userInput(text: string, skills: ResolvedSkill[] = []): Record<string, unknown>[] {
    return [
      { type: "text", text, text_elements: [] },
      ...skills.map((skill) => ({ type: "skill", name: skill.name, path: skill.path })),
    ];
  }

  async listModels(): Promise<AgentModelCatalog> {
    const models: AgentModelCatalog["models"] = [];
    let cursor: string | undefined;
    // 目录支持分页；设上限防止异常 server 返回无限 cursor。
    for (let page = 0; page < 5; page++) {
      const raw = (await this.request("model/list", {
        limit: 50,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      })) as { data?: unknown[]; nextCursor?: unknown };
      for (const item of raw.data ?? []) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const id =
          typeof row["model"] === "string"
            ? row["model"]
            : typeof row["id"] === "string"
              ? row["id"]
              : "";
        if (!id) continue;
        const efforts = Array.isArray(row["supportedReasoningEfforts"])
          ? row["supportedReasoningEfforts"]
              .map((entry) =>
                typeof entry === "string"
                  ? entry
                  : entry && typeof entry === "object" &&
                      typeof (entry as Record<string, unknown>)["reasoningEffort"] === "string"
                    ? String((entry as Record<string, unknown>)["reasoningEffort"])
                    : "",
              )
              .filter(Boolean)
          : [];
        models.push({
          id,
          label: typeof row["displayName"] === "string" ? row["displayName"] : id,
          ...(typeof row["description"] === "string"
            ? { description: row["description"] }
            : {}),
          supportedEfforts: efforts,
          ...(typeof row["defaultReasoningEffort"] === "string"
            ? { defaultEffort: row["defaultReasoningEffort"] }
            : {}),
          ...(row["isDefault"] === true ? { isDefault: true } : {}),
        });
      }
      cursor = typeof raw.nextCursor === "string" ? raw.nextCursor : undefined;
      if (!cursor) break;
    }
    const fallback = models.find((model) => model.isDefault) ?? models[0];
    const currentModel = this.selectedModel ?? fallback?.id;
    const currentRow = models.find((model) => model.id === currentModel);
    const currentEffort =
      this.selectedEffort ?? currentRow?.defaultEffort ?? currentRow?.supportedEfforts[0];
    const catalog: AgentModelCatalog = {
      models,
      ...(currentModel ? { currentModel } : {}),
      ...(currentEffort ? { currentEffort } : {}),
    };
    this.modelCache = catalog;
    if (!this.selectedModel && currentModel) {
      this.selectedModel = currentModel;
      this.selectedEffort = currentEffort ?? null;
      this.persistNativeState();
    }
    return catalog;
  }

  async setModel(model: string, effort?: string): Promise<AgentModelSelection> {
    const catalog = this.modelCache ?? (await this.listModels());
    const selected = catalog.models.find((entry) => entry.id === model);
    if (!selected) throw new AdapterError(`Codex 模型不可用:${model}`);
    const chosenEffort = effort ?? selected.defaultEffort ?? selected.supportedEfforts[0];
    if (chosenEffort && !selected.supportedEfforts.includes(chosenEffort)) {
      throw new AdapterError(`${model} 不支持推理强度 ${chosenEffort}`);
    }
    this.selectedModel = model;
    this.selectedEffort = chosenEffort ?? null;
    this.persistNativeState();
    return {
      currentModel: model,
      ...(chosenEffort ? { currentEffort: chosenEffort } : {}),
    };
  }

  async listModes(): Promise<AgentModeCatalog> {
    const modes: AgentModeCatalog["modes"] = [];
    try {
      const raw = (await this.request("collaborationMode/list", {})) as { data?: unknown[] };
      for (const value of raw.data ?? []) {
        if (!value || typeof value !== "object") continue;
        const row = value as Record<string, unknown>;
        const id = row["mode"] === "plan" ? "plan" : row["mode"] === "default" ? "default" : "";
        if (!id || modes.some((mode) => mode.id === id)) continue;
        modes.push({
          id,
          label: typeof row["name"] === "string" ? row["name"] : id === "plan" ? "Plan" : "执行",
          description:
            id === "plan"
              ? "先调查并形成计划；需要你回答的问题会显示成原生卡片。"
              : "允许 Agent 执行命令、编辑文件并完成任务。",
        });
      }
    } catch {
      // 0.146 之前没有目录 RPC，但两种稳定模式仍可通过 turn/start 使用。
    }
    if (!modes.some((mode) => mode.id === "default")) {
      modes.unshift({ id: "default", label: "执行", description: "直接执行并完成任务。" });
    }
    if (!modes.some((mode) => mode.id === "plan")) {
      modes.push({ id: "plan", label: "Plan", description: "先调查、提问并形成计划。" });
    }
    return { modes, currentMode: this.selectedMode };
  }

  async setMode(mode: string): Promise<AgentModeSelection> {
    if (mode !== "default" && mode !== "plan") throw new AdapterError(`Codex 模式不可用:${mode}`);
    if (!this.selectedModel) await this.listModels();
    this.selectedMode = mode;
    this.persistNativeState();
    if (this.threadId) {
      try {
        await this.request("thread/settings/update", {
          threadId: this.threadId,
          collaborationMode: this.collaborationMode(),
        });
      } catch {
        // 旧 app-server 在下一次 turn/start 仍会拿到同一设置。
      }
    }
    return { currentMode: mode };
  }

  private collaborationMode(): Record<string, unknown> {
    return {
      mode: this.selectedMode,
      settings: {
        model: this.selectedModel ?? "",
        reasoning_effort: this.selectedEffort,
        developer_instructions: null,
      },
    };
  }

  async compact(): Promise<void> {
    if (!this.threadId) throw new AdapterError("codex 会话尚未就绪");
    // 官方 app-server 原生方法；响应只表示已接受，完成由同一 thread 的
    // turn/item 通知驱动，最终 turn/completed 会让 StructuredSession 回 idle。
    this.compactInFlight = true;
    try {
      await this.request("thread/compact/start", { threadId: this.threadId });
    } catch (error) {
      this.compactInFlight = false;
      throw error;
    }
  }

  async send(
    text: string,
    _attachments?: Attachment[],
    skills: ResolvedSkill[] = [],
  ): Promise<void> {
    if (!this.threadId) throw new AdapterError("codex 会话尚未就绪");
    if (!this.selectedModel && this.selectedMode === "plan") await this.listModels();
    const policy = this.executionPolicy();
    // turn/start 直到本轮结束才返回,不能 await —— 否则会阻塞后续的审批回复,
    // 而审批回复正是本轮继续下去的前提,形成死锁。
    void this.request(
      "turn/start",
      {
        threadId: this.threadId,
        input: this.userInput(text, skills),
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
        ...(this.selectedModel ? { model: this.selectedModel } : {}),
        ...(this.selectedEffort ? { effort: this.selectedEffort } : {}),
        ...(this.selectedModel ? { collaborationMode: this.collaborationMode() } : {}),
      },
      0,
    ).catch((e: unknown) => {
      this.emit({
        kind: "agent.error",
        message: e instanceof Error ? e.message : String(e),
      });
    });
  }

  /** Codex app-server 0.146+ 的同轮引导；不可引导时由上层回退到队首。 */
  async steer(
    text: string,
    _attachments?: Attachment[],
    skills: ResolvedSkill[] = [],
  ): Promise<boolean> {
    if (!this.threadId || !this.currentTurnMsgId) return false;
    try {
      await this.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.currentTurnMsgId,
        input: this.userInput(text, skills),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 对已经恢复的 thread 立即写入下一轮设置；send() 仍会逐轮携带同一配置，
   * 因而旧版本不支持 settings/update 时也不会退回错误 sandbox。
   */
  async setApprovalPolicy(_policy: import("@prospero/protocol").ApprovalPolicy): Promise<void> {
    if (!this.threadId) return;
    const policy = this.executionPolicy();
    try {
      await this.request("thread/settings/update", {
        threadId: this.threadId,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
      });
    } catch {
      // 兼容较旧 app-server；下一次 turn/start 上的覆盖仍会生效。
    }
  }

  async respondPermission(reqId: string, reply: PermissionReply): Promise<void> {
    const pending = this.approvals.get(reqId);
    if (!pending) return;
    this.approvals.delete(reqId);
    const decision =
      reply === "reject"
        ? { denied: { rejection: "用户在手机上拒绝了此操作" } }
        : reply === "always"
          ? "approved_for_session"
          : "approved";
    this.respond(pending.rpcId, { decision });
    this.emit({
      kind: "permission.resolved",
      reqId,
      reply,
      ...(pending.agentId ? { agentId: pending.agentId } : {}),
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
    const nativeAnswers = Object.fromEntries(
      answers.map((answer) => [answer.questionId, { answers: cancelled ? [] : answer.values }]),
    );
    this.respond(pending.rpcId, { answers: nativeAnswers });
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
    if (!known || !known.canMessage) throw new AdapterError("Codex 子 Agent 当前不可寻址");
    const turnId = this.currentTurns.get(subagentId);
    if (turnId) {
      try {
        await this.request("turn/steer", {
          threadId: subagentId,
          expectedTurnId: turnId,
          input: this.userInput(text),
        });
        return;
      } catch {
        // 子轮恰好结束时转成新一轮，人工消息不会丢。
      }
    }
    const policy = this.executionPolicy();
    this.updateSubagent(subagentId, "running", true);
    void this.request(
      "turn/start",
      {
        threadId: subagentId,
        input: this.userInput(text),
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
        ...(this.selectedModel ? { model: this.selectedModel } : {}),
        ...(this.selectedEffort ? { effort: this.selectedEffort } : {}),
        ...(this.selectedModel ? { collaborationMode: this.collaborationMode() } : {}),
      },
      0,
    ).catch((error: unknown) => {
      this.updateSubagent(
        subagentId,
        "failed",
        false,
        error instanceof Error ? error.message : String(error),
      );
      this.emit({
        kind: "agent.error",
        agentId: subagentId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async interrupt(): Promise<void> {
    if (!this.threadId) return;
    try {
      await this.request("turn/interrupt", { threadId: this.threadId });
    } catch {
      // 无进行中的轮次
    }
  }

  async dispose(): Promise<void> {
    // 悬着的审批先拒掉,避免 codex 永久等待
    for (const [reqId, pending] of this.approvals) {
      this.respond(pending.rpcId, { decision: { denied: { rejection: "会话已关闭" } } });
      this.approvals.delete(reqId);
    }
    for (const [reqId, pending] of this.questions) {
      this.respond(pending.rpcId, { answers: {} });
      this.questions.delete(reqId);
    }
    this.proc?.kill();
    this.proc = null;
    this.ctx = null;
    this.threadId = null;
    this.modelCache = null;
    this.currentTurns.clear();
    this.lastTextByThread.clear();
    this.subagents.clear();
  }
}
