/**
 * DeepSeek Harness adapter (developer preview rc.6).
 *
 * `dsh` does not ship a TUI profile. Its supported multi-turn integration
 * surface is the local `dsh web` host: unary RPC over HTTP and live events over
 * WebSocket. Each Prospero structured owner starts one loopback-only host so account
 * environment, process lifetime, and durable Windows Job ownership stay
 * isolated per session.
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentEventBody,
  AgentQuestionAnswer,
  Attachment,
  PermissionReply,
} from "@prospero/protocol";
import crossSpawn from "cross-spawn";
import { WebSocket, type RawData } from "ws";
import { needsApproval } from "../approval-policy.js";
import {
  AdapterError,
  summarize,
  terminateUnregisteredProviderProcess,
  type AdapterContext,
  type AdapterResumeState,
  type AgentAdapter,
  type AgentModelCatalog,
  type AgentModelSelection,
} from "./types.js";

const START_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 30_000;

interface RpcResult {
  ok: boolean;
  value?: unknown;
  error?: { code?: string; message?: string };
}

interface RpcEnvelope {
  type?: string;
  rpcId?: string;
  result?: RpcResult;
  payload?: unknown;
}

interface MuxFrame extends Record<string, unknown> {
  type: string;
  sessionId?: string;
}

type MuxHandler = (rpcId: string, frame: MuxFrame) => void;

export interface DeepseekTransport {
  call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T>;
  respond(rpcId: string, result: RpcResult): Promise<void>;
  subscribe(sessionId: string, handler: MuxHandler): () => void;
  ready?(): Promise<void>;
  close?(): Promise<void> | void;
}

interface OwnedTransport extends DeepseekTransport {
  process: ChildProcess;
}

function rpcError(method: string, result: RpcResult | undefined): AdapterError {
  const code = result?.error?.code;
  const message = result?.error?.message ?? "未知错误";
  return new AdapterError(`DeepSeek Harness ${method} 失败${code ? ` (${code})` : ""}: ${message}`);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new AdapterError(`DeepSeek Harness HTTP ${response.status}: ${url}`);
  }
  return (await response.json()) as T;
}

function createHttpTransport(
  port: number,
  process: ChildProcess,
  allowWindowsTreeFallback: boolean,
): OwnedTransport {
  const subscribers = new Map<string, MuxHandler>();
  let closed = false;
  let eventSocket: WebSocket | null = null;
  let connectPromise: Promise<void> | null = null;
  const base = `http://127.0.0.1:${String(port)}`;
  const eventsUrl = `ws://127.0.0.1:${String(port)}/api/events.mux`;

  const dispatch = (data: RawData): void => {
    try {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : data.toString("utf8");
      const envelope = JSON.parse(text) as RpcEnvelope;
      if (envelope.type !== "server-request" || typeof envelope.rpcId !== "string") return;
      if (!envelope.payload || typeof envelope.payload !== "object") return;
      const frame = envelope.payload as MuxFrame;
      if (typeof frame.type !== "string" || typeof frame.sessionId !== "string") return;
      subscribers.get(frame.sessionId)?.(envelope.rpcId, frame);
    } catch {
      // A malformed or forward-version frame must not tear down the connection.
    }
  };

  let ensureConnected: () => Promise<void>;
  const openSocket = (): Promise<void> => new Promise((resolve, reject) => {
    const socket = new WebSocket(eventsUrl);
    eventSocket = socket;
    let opened = false;
    socket.on("message", dispatch);
    socket.once("open", () => {
      opened = true;
      resolve();
    });
    socket.once("error", (error) => {
      if (!opened) reject(error);
    });
    socket.once("close", () => {
      if (eventSocket === socket) eventSocket = null;
      if (!opened) reject(new Error("DeepSeek Harness 事件连接已关闭"));
      if (!closed && process.exitCode === null && !process.killed) {
        void delay(500).then(() => ensureConnected()).catch(() => undefined);
      }
    });
  });

  ensureConnected = (): Promise<void> => {
    if (eventSocket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      while (!closed && process.exitCode === null && !process.killed) {
        try {
          await openSocket();
          return;
        } catch {
          if (!closed) await delay(500);
        }
      }
      throw new AdapterError("DeepSeek Harness 事件连接不可用");
    })().finally(() => {
      connectPromise = null;
    });
    return connectPromise;
  };

  const transport: OwnedTransport = {
    process,
    async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
      const rpcId = randomUUID();
      const envelope = await postJson<RpcEnvelope>(`${base}/api/${method}`, {
        type: "client-request",
        rpcId,
        method,
        payload,
      });
      if (envelope.type !== "server-response" || envelope.rpcId !== rpcId) {
        throw new AdapterError(`DeepSeek Harness ${method} 返回了无效 RPC 响应`);
      }
      if (!envelope.result?.ok) throw rpcError(method, envelope.result);
      return envelope.result.value as T;
    },
    async respond(rpcId: string, result: RpcResult): Promise<void> {
      const receipt = await postJson<{ accepted?: boolean; reason?: string }>(`${base}/api/respond`, {
        type: "client-response",
        rpcId,
        result,
      });
      if (receipt.accepted !== true) {
        throw new AdapterError(`DeepSeek Harness 响应已失效: ${receipt.reason ?? "unknown"}`);
      }
    },
    subscribe(sessionId: string, handler: MuxHandler): () => void {
      subscribers.set(sessionId, handler);
      void ensureConnected().catch(() => undefined);
      return () => {
        if (subscribers.get(sessionId) === handler) subscribers.delete(sessionId);
      };
    },
    async ready(): Promise<void> {
      await Promise.race([
        ensureConnected(),
        delay(START_TIMEOUT_MS).then(() => {
          throw new AdapterError("DeepSeek Harness 事件连接超时");
        }),
      ]);
    },
    async close(): Promise<void> {
      closed = true;
      eventSocket?.terminate();
      eventSocket = null;
      subscribers.clear();
      if (process.exitCode === null && !process.killed) {
        if (globalThis.process.platform === "win32" && allowWindowsTreeFallback && process.pid) {
          await new Promise<void>((resolve) => {
            const killer = crossSpawn("taskkill", ["/pid", String(process.pid), "/t", "/f"], {
              stdio: "ignore",
              windowsHide: true,
            });
            killer.once("error", () => resolve());
            killer.once("exit", () => resolve());
          });
        } else {
          process.kill();
        }
      }
      process.stdout?.destroy();
      process.stderr?.destroy();
      process.unref();
    },
  };

  return transport;
}

async function startTransport(ctx: AdapterContext): Promise<OwnedTransport> {
  const process = crossSpawn("dsh", ["web", "--host", "127.0.0.1", "--port", "0"], {
    cwd: ctx.cwd,
    env: { ...globalThis.process.env, ...(ctx.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await ctx.registerProviderProcess?.(process);
  } catch (error) {
    await terminateUnregisteredProviderProcess(process);
    throw error;
  }

  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new AdapterError("dsh web 启动超时"))), START_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-8_000);
      const match = output.match(/dsh web:\s+http:\/\/127\.0\.0\.1:(\d+)/i);
      if (match) finish(() => resolve(Number(match[1])));
    };
    process.stdout?.on("data", onData);
    process.stderr?.on("data", onData);
    process.once("error", (error) => finish(() => reject(
      new AdapterError("无法启动 dsh；请先运行 npm install -g @deepseek-ai/dsh", error),
    )));
    process.once("exit", (code) => finish(() => reject(
      new AdapterError(`dsh web 启动时退出 (code=${String(code)}): ${summarize(output, 800)}`),
    )));
  });

  const transport = createHttpTransport(port, process, ctx.registerProviderProcess === undefined);
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      await transport.call("host.describe", {});
      return transport;
    } catch (error) {
      if (Date.now() >= deadline || process.exitCode !== null) {
        await transport.close?.();
        throw new AdapterError("dsh web RPC 未就绪", error);
      }
      await delay(200);
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return summarize(value);
  const parts: string[] = [];
  for (const item of value) {
    const block = record(item);
    if ((block["type"] === "text" || block["type"] === "reasoning") && typeof block["text"] === "string") {
      parts.push(block["text"]);
    } else if (block["type"] === "tool-result") {
      parts.push(contentText(block["content"]));
    }
  }
  return parts.join("\n");
}

function assistantContent(value: unknown): { text: string; reasoning: string } {
  const text: string[] = [];
  const reasoning: string[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const block = record(item);
    if (block["type"] === "text" && typeof block["text"] === "string") text.push(block["text"]);
    if (block["type"] === "reasoning" && typeof block["text"] === "string") reasoning.push(block["text"]);
  }
  return { text: text.join("\n"), reasoning: reasoning.join("\n") };
}

interface PendingApproval {
  rpcId: string;
  approvalId: string;
  reply?: PermissionReply;
}

interface PendingQuestion {
  rpcId: string;
  answers?: AgentQuestionAnswer[];
  cancelled?: boolean;
}

export interface DeepseekAdapterOptions {
  resumeState?: AdapterResumeState | undefined;
  transport?: DeepseekTransport | undefined;
}

export class DeepseekAdapter implements AgentAdapter {
  constructor(private readonly opts: DeepseekAdapterOptions = {}) {}

  readonly durableProviderJobCompatible = true;
  readonly acceptsImages = true;

  private ctx: AdapterContext | null = null;
  private transport: DeepseekTransport | null = null;
  private sessionId: string | null = null;
  private currentPreset: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private currentTurn = 0;
  private lastSeq = -1;
  private historySync: Promise<void> | null = null;
  private readonly bufferedEvents: Array<Record<string, unknown>> = [];
  private readonly usageByTurn = new Map<number, { input: number; output: number }>();
  private readonly turnStartedAt = new Map<number, number>();
  private readonly stepStartedAt = new Map<string, number>();
  private readonly compactionStartedAt = new Map<string, number>();
  private readonly compactionDetails = new Map<string, { detail: string; inputTokens: number; outputTokens: number }>();
  private readonly messageByTurn = new Map<number, string>();
  private readonly streamedText = new Map<string, { text: string; reasoning: string }>();
  private readonly pendingUserText: string[] = [];
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.lastSeq = finite(this.opts.resumeState?.["lastSeq"]) ?? -1;
    this.bufferedEvents.length = 0;
    const transport = this.opts.transport ?? await startTransport(ctx);
    this.transport = transport;
    // 模型/预设目录都有 host 级只读 RPC。目录探测绝不能先创建空会话，
    // 否则手机每打开一次新建页，Harness 历史里就会多一条空白记录。
    if (ctx.catalogOnly) return;
    const restored = typeof this.opts.resumeState?.["sessionId"] === "string"
      ? this.opts.resumeState["sessionId"] as string
      : undefined;
    const requestedPreset = typeof this.opts.resumeState?.["agentPreset"] === "string"
      ? this.opts.resumeState["agentPreset"] as string
      : undefined;
    const created = await transport.call<{ sessionId?: string; agentPreset?: string }>("session.create", {
      cwd: ctx.cwd,
      ...(restored ? { sessionId: restored } : {}),
      ...(!restored && requestedPreset ? { agentPreset: requestedPreset } : {}),
    });
    if (typeof created.sessionId !== "string" || created.sessionId.length === 0) {
      throw new AdapterError("DeepSeek Harness 未返回 sessionId");
    }
    this.sessionId = created.sessionId;
    this.currentPreset = created.agentPreset ?? requestedPreset ?? null;
    this.unsubscribe = transport.subscribe(created.sessionId, (rpcId, frame) => this.onFrame(rpcId, frame));
    await transport.ready?.();
    await this.syncHistory().catch(() => undefined);
    const requestedModel = typeof this.opts.resumeState?.["model"] === "string"
      ? this.opts.resumeState["model"] as string
      : undefined;
    const requestedEffort = typeof this.opts.resumeState?.["effort"] === "string"
      ? this.opts.resumeState["effort"] as string
      : undefined;
    if (!restored && requestedModel) await this.setModel(requestedModel, requestedEffort);
    ctx.persistState?.({
      sessionId: created.sessionId,
      ...(this.currentPreset ? { agentPreset: this.currentPreset } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedEffort ? { effort: requestedEffort } : {}),
    });
  }

  private emit(body: AgentEventBody): void {
    this.ctx?.emit(body);
  }

  private emitTrajectory(
    recordId: string,
    recordKind: "turn" | "step" | "request" | "retry" | "compaction",
    phase: "running" | "completed" | "failed" | "info",
    title: string,
    fields: Omit<Extract<AgentEventBody, { kind: "trajectory.record" }>, "kind" | "recordId" | "recordKind" | "phase" | "title"> = {},
  ): void {
    this.emit({ kind: "trajectory.record", recordId, recordKind, phase, title, ...fields });
  }

  private messageId(data: Record<string, unknown>): string {
    const message = record(data["message"]);
    if (typeof message["id"] === "string") return message["id"];
    const turn = finite(data["turn"]) ?? this.currentTurn;
    const step = finite(data["step"]) ?? 0;
    return `deepseek_${String(turn)}_${String(step)}`;
  }

  private onFrame(rpcId: string, frame: MuxFrame): void {
    if (frame.type === "session/subscribed") {
      const remoteLastSeq = finite(frame["lastSeq"]);
      if (remoteLastSeq !== undefined && remoteLastSeq > this.lastSeq) {
        void this.syncHistory().catch(() => undefined);
      }
      return;
    }
    if (frame.type === "session/event") {
      const event = record(frame["event"]);
      if (this.historySync) this.bufferedEvents.push(event);
      else this.consumeSessionEvent(event);
      return;
    }
    if (frame.type === "approval/requested") {
      const approvalId = String(frame["approvalId"] ?? "");
      if (!approvalId) return;
      this.approvals.set(approvalId, { rpcId, approvalId });
      const tool = String(frame["toolName"] ?? "tool");
      const reason = typeof frame["reason"] === "string" ? frame["reason"] : "";
      const callId = typeof frame["callId"] === "string" ? frame["callId"] : "";

      // 策略放行:不等人,但把"这一步被自动批准了"照常发出去 —— 与 claude/codex
      // 适配器同一套语义。不打断 ≠ 不告知,聊天里仍要留下这次调用便于事后追溯。
      const policy = this.ctx?.approvalPolicy?.() ?? "strict";
      if (!needsApproval(policy, tool)) {
        this.emit({
          kind: "permission.auto",
          reqId: approvalId,
          action: tool,
          policy,
          summary: reason || `允许 ${tool} 执行此操作`,
        });
        // 复用手动批准的同一条通路:dsh 回 approval/resolved 后照常发 permission.resolved
        void this.respondPermission(approvalId, "once").catch(() => undefined);
        return;
      }

      this.emit({
        kind: "permission.request",
        reqId: approvalId,
        action: tool,
        resources: [reason, callId].filter(Boolean),
        summary: reason || `允许 ${tool} 执行此操作`,
      });
      return;
    }
    if (frame.type === "approval/resolved") {
      const approvalId = String(frame["approvalId"] ?? "");
      const pending = this.approvals.get(approvalId);
      this.approvals.delete(approvalId);
      const outcome = frame["outcome"];
      this.emit({
        kind: "permission.resolved",
        reqId: approvalId,
        reply: pending?.reply ?? (outcome === "allowed-once" ? "once" : "reject"),
      });
      return;
    }
    if (frame.type === "question/requested") {
      const reqId = rpcId;
      const questions = Array.isArray(frame["questions"])
        ? frame["questions"].map((raw, index) => {
            const question = record(raw);
            const options = Array.isArray(question["options"])
              ? question["options"].map((item) => {
                  const option = record(item);
                  return {
                    label: String(option["label"] ?? ""),
                    ...(typeof option["description"] === "string" ? { description: option["description"] } : {}),
                  };
                }).filter((item) => item.label.length > 0)
              : [];
            return {
              id: String(question["id"] ?? `question_${String(index + 1)}`),
              header: typeof question["header"] === "string" ? question["header"] : "DeepSeek",
              question: String(question["question"] ?? "请选择"),
              options,
              multiSelect: question["multiSelect"] === true,
              allowOther: true,
            };
          })
        : [];
      if (questions.length === 0) return;
      this.questions.set(reqId, { rpcId });
      this.emit({ kind: "question.request", reqId, questions: questions.slice(0, 4) });
      return;
    }
    if (frame.type === "question/resolved") {
      const reqId = String(frame["questionRpcId"] ?? "");
      const pending = this.questions.get(reqId);
      this.questions.delete(reqId);
      this.emit({
        kind: "question.resolved",
        reqId,
        answers: pending?.answers ?? [],
        ...(pending?.cancelled || frame["outcome"] === "cancelled" ? { cancelled: true } : {}),
      });
    }
  }

  private consumeSessionEvent(event: Record<string, unknown>): void {
    const seq = finite(event["seq"]);
    if (seq !== undefined) {
      if (seq <= this.lastSeq) return;
      this.lastSeq = seq;
    }
    this.onSessionEvent(event);
    if (
      seq !== undefined &&
      (event["type"] === "assistant/message" || event["type"] === "turn/end") &&
      this.sessionId
    ) {
      this.ctx?.persistState?.({ sessionId: this.sessionId, lastSeq: seq });
    }
  }

  private async syncHistory(): Promise<void> {
    if (this.historySync) return this.historySync;
    const { transport, sessionId } = this.require();
    const sync = (async () => {
      const history = await transport.call<{ events?: unknown[] }>("session.history", {
        sessionId,
        maxMessages: 50,
      });
      const events = (Array.isArray(history.events) ? history.events : [])
        .map((entry) => record(record(entry)["event"]))
        .filter((event) => typeof event["type"] === "string")
        .sort((left, right) => (finite(left["seq"]) ?? 0) - (finite(right["seq"]) ?? 0));
      for (const event of events) this.consumeSessionEvent(event);
    })();
    this.historySync = sync;
    try {
      await sync;
    } finally {
      if (this.historySync === sync) {
        while (this.bufferedEvents.length > 0) {
          const buffered = this.bufferedEvents.splice(0)
            .sort((left, right) => (finite(left["seq"]) ?? 0) - (finite(right["seq"]) ?? 0));
          for (const event of buffered) this.consumeSessionEvent(event);
        }
        this.historySync = null;
      }
    }
  }

  private onSessionEvent(event: Record<string, unknown>): void {
    const type = event["type"];
    const data = record(event["data"]);
    const eventTime = finite(event["time"]);
    const seq = finite(event["seq"]) ?? 0;
    if (type === "turn/start") {
      this.currentTurn = finite(data["turn"]) ?? this.currentTurn + 1;
      if (eventTime !== undefined) this.turnStartedAt.set(this.currentTurn, eventTime);
      this.emitTrajectory(`turn_${String(this.currentTurn)}`, "turn", "running", `第 ${String(this.currentTurn)} 轮`, {
        turn: this.currentTurn,
        ...(eventTime !== undefined ? { startedAt: eventTime } : {}),
      });
      return;
    }
    if (type === "step/start") {
      const turn = finite(data["turn"]) ?? this.currentTurn;
      const step = finite(data["step"]) ?? 0;
      const id = `step_${String(turn)}_${String(step)}`;
      if (eventTime !== undefined) this.stepStartedAt.set(id, eventTime);
      this.emitTrajectory(id, "step", "running", `步骤 ${String(step + 1)}`, {
        turn,
        step,
        ...(eventTime !== undefined ? { startedAt: eventTime } : {}),
      });
      return;
    }
    if (type === "step/end") {
      const turn = finite(data["turn"]) ?? this.currentTurn;
      const step = finite(data["step"]) ?? 0;
      const id = `step_${String(turn)}_${String(step)}`;
      const startedAt = this.stepStartedAt.get(id);
      this.emitTrajectory(id, "step", "completed", `步骤 ${String(step + 1)}`, {
        turn,
        step,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(startedAt !== undefined && eventTime !== undefined && eventTime >= startedAt
          ? { durationMs: Math.round(eventTime - startedAt) }
          : {}),
      });
      return;
    }
    if (type === "user/message") {
      const source = record(data["source"]);
      const text = contentText(data["content"]);
      const direct = source["kind"] === "user";
      this.emitTrajectory(`user_${String(seq)}`, "request", "info", direct ? "用户输入" : "上下文注入", {
        ...(text ? { detail: summarize(text, 4_000) } : {}),
        ...(eventTime !== undefined ? { startedAt: eventTime } : {}),
      });
      if (direct) {
        const pendingIndex = this.pendingUserText.indexOf(text);
        if (pendingIndex >= 0) this.pendingUserText.splice(pendingIndex, 1);
        else this.emit({ kind: "user.message", msgId: String(data["id"] ?? `deepseek_user_${String(seq)}`), text });
      }
      return;
    }
    if (type === "assistant/chunk") {
      const chunk = record(data["chunk"]);
      const msgId = this.messageId(data);
      const turn = finite(data["turn"]) ?? this.currentTurn;
      this.messageByTurn.set(turn, msgId);
      const streamed = this.streamedText.get(msgId) ?? { text: "", reasoning: "" };
      if (chunk["type"] === "text-delta" && typeof chunk["text"] === "string" && chunk["text"].length > 0) {
        streamed.text += chunk["text"];
        this.emit({ kind: "text.delta", msgId, textId: msgId, delta: chunk["text"] });
      } else if (chunk["type"] === "reasoning-delta" && typeof chunk["text"] === "string" && chunk["text"].length > 0) {
        streamed.reasoning += chunk["text"];
        this.emit({ kind: "reasoning.delta", msgId, delta: chunk["text"] });
      }
      this.streamedText.set(msgId, streamed);
      return;
    }
    if (type === "assistant/message") {
      const usage = record(data["usage"]);
      const turn = finite(data["turn"]) ?? this.currentTurn;
      const step = finite(data["step"]) ?? 0;
      const msgId = this.messageId(data);
      this.messageByTurn.set(turn, msgId);
      const assembled = assistantContent(record(data["message"])["content"]);
      const streamed = this.streamedText.get(msgId) ?? { text: "", reasoning: "" };
      if (assembled.reasoning && assembled.reasoning !== streamed.reasoning) {
        const delta = assembled.reasoning.startsWith(streamed.reasoning)
          ? assembled.reasoning.slice(streamed.reasoning.length)
          : assembled.reasoning;
        if (delta) this.emit({ kind: "reasoning.delta", msgId, delta });
      }
      if (assembled.text && assembled.text !== streamed.text) {
        const delta = assembled.text.startsWith(streamed.text)
          ? assembled.text.slice(streamed.text.length)
          : assembled.text;
        if (delta) this.emit({ kind: "text.delta", msgId, textId: msgId, delta });
      }
      this.streamedText.set(msgId, assembled);
      const previous = this.usageByTurn.get(turn) ?? { input: 0, output: 0 };
      previous.input += finite(usage["inputTokens"]) ?? 0;
      previous.output += finite(usage["outputTokens"]) ?? 0;
      this.usageByTurn.set(turn, previous);
      const requestId = `request_${String(turn)}_${String(step)}`;
      const startedAt = this.stepStartedAt.get(`step_${String(turn)}_${String(step)}`);
      this.emitTrajectory(requestId, "request", "completed", "模型回复", {
        turn,
        step,
        ...(assembled.text ? { detail: summarize(assembled.text, 2_000) } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(startedAt !== undefined && eventTime !== undefined && eventTime >= startedAt
          ? { durationMs: Math.round(eventTime - startedAt) }
          : {}),
        inputTokens: finite(usage["inputTokens"]) ?? 0,
        outputTokens: finite(usage["outputTokens"]) ?? 0,
      });
      return;
    }
    if (type === "llm/retry") {
      const turn = finite(data["turn"]) ?? this.currentTurn;
      const step = finite(data["step"]) ?? 0;
      const retry = finite(data["retry"]) ?? 0;
      const delayMs = finite(data["delayMs"]);
      this.emitTrajectory(`retry_${String(seq)}`, "retry", "failed", `模型请求重试 ${String(retry + 1)}`, {
        turn,
        step,
        detail: summarize(data["failure"] ?? "模型请求失败", 2_000),
        ...(eventTime !== undefined ? { startedAt: eventTime } : {}),
        ...(delayMs !== undefined ? { durationMs: Math.round(delayMs) } : {}),
      });
      return;
    }
    if (type === "request/context") {
      const provider = typeof data["provider"] === "string" ? data["provider"] : "";
      const model = typeof data["model"] === "string" ? data["model"] : "";
      const contextWindow = finite(data["contextWindow"]);
      this.emitTrajectory(`context_${String(seq)}`, "request", "info", "模型上下文", {
        detail: [
          provider && model ? `${provider}/${model}` : provider || model,
          contextWindow !== undefined ? `${String(Math.round(contextWindow))} tokens` : "",
        ].filter(Boolean).join(" · "),
        ...(eventTime !== undefined ? { startedAt: eventTime } : {}),
      });
      return;
    }
    if (type === "request/header") {
      this.emitTrajectory(`header_${String(seq)}`, "request", "info", "模型请求参数", {
        detail: summarize(data, 4_000),
        ...(eventTime !== undefined ? { startedAt: eventTime } : {}),
      });
      return;
    }
    if (type === "compaction/start") {
      const compactionId = String(data["compactionId"] ?? seq);
      if (eventTime !== undefined) this.compactionStartedAt.set(compactionId, eventTime);
      this.emitTrajectory(`compaction_${compactionId}`, "compaction", "running", "正在压缩上下文", {
        ...(finite(data["turn"]) !== undefined ? { turn: finite(data["turn"]) } : {}),
        ...(eventTime !== undefined ? { startedAt: eventTime } : {}),
      });
      return;
    }
    if (type === "compaction/summary") {
      const compactionId = String(data["compactionId"] ?? seq);
      const startedAt = this.compactionStartedAt.get(compactionId);
      const summaryUsage = record(data["usage"]);
      const summary = {
        detail: summarize(data["summary"] ?? data, 4_000),
        inputTokens: finite(summaryUsage["inputTokens"]) ?? 0,
        outputTokens: finite(summaryUsage["outputTokens"]) ?? 0,
      };
      this.compactionDetails.set(compactionId, summary);
      this.emitTrajectory(`compaction_${compactionId}`, "compaction", "running", "正在压缩上下文", {
        ...summary,
        ...(startedAt !== undefined ? { startedAt } : eventTime !== undefined ? { startedAt: eventTime } : {}),
      });
      return;
    }
    if (type === "compaction/end") {
      const compactionId = String(data["compactionId"] ?? seq);
      const startedAt = this.compactionStartedAt.get(compactionId);
      const summary = this.compactionDetails.get(compactionId);
      const failed = data["error"] !== undefined;
      this.emitTrajectory(`compaction_${compactionId}`, "compaction", failed ? "failed" : "completed", failed ? "上下文压缩失败" : "上下文压缩完成", {
        ...(failed ? { detail: summarize(data["error"], 2_000) } : summary ?? {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(startedAt !== undefined && eventTime !== undefined && eventTime >= startedAt
          ? { durationMs: Math.round(eventTime - startedAt) }
          : {}),
      });
      this.compactionStartedAt.delete(compactionId);
      this.compactionDetails.delete(compactionId);
      return;
    }
    if (type === "compaction/prune") {
      this.emitTrajectory(`compaction_prune_${String(seq)}`, "compaction", "info", "已裁剪工具输出", {
        detail: summarize(data, 2_000),
        ...(eventTime !== undefined ? { startedAt: eventTime } : {}),
      });
      return;
    }
    if (type === "tool/call") {
      const callId = String(data["callId"] ?? "");
      this.emit({
        kind: "tool.start",
        msgId: this.messageId(data),
        callId,
        tool: String(data["name"] ?? "tool"),
        summary: summarize(data["arguments"]),
      });
      return;
    }
    if (type === "tool/result") {
      const message = record(data["message"]);
      const callId = String(record(message["source"])["callId"] ?? "");
      const output = contentText(message["content"]);
      if (output) this.ctx?.recordOutput?.(callId, output);
      const failed = data["error"] !== undefined || record(
        Array.isArray(message["content"]) ? message["content"][0] : undefined,
      )["isError"] === true;
      const summary = summarize(output || data["error"] || (failed ? "失败" : "完成"));
      this.emit({
        kind: "tool.end",
        callId,
        state: failed ? "failed" : "success",
        summary,
        ...(output.length > summary.length ? { hasMore: true } : {}),
      });
      return;
    }
    if (type === "turn/end") {
      const turn = finite(data["turn"]) ?? this.currentTurn;
      const usage = this.usageByTurn.get(turn);
      this.usageByTurn.delete(turn);
      const startedAt = this.turnStartedAt.get(turn);
      const reason = record(data["reason"]);
      const finish = typeof reason["kind"] === "string" ? reason["kind"] : "completed";
      if (finish === "error") {
        this.emit({ kind: "agent.error", message: summarize(record(reason["error"])["message"] ?? "DeepSeek Harness 运行失败") });
      }
      this.emitTrajectory(`turn_${String(turn)}`, "turn", finish === "error" ? "failed" : "completed", `第 ${String(turn)} 轮`, {
        turn,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(startedAt !== undefined && eventTime !== undefined && eventTime >= startedAt
          ? { durationMs: Math.round(eventTime - startedAt) }
          : {}),
        ...(finish !== "completed" ? { detail: finish } : {}),
        ...(usage ? { inputTokens: usage.input, outputTokens: usage.output } : {}),
      });
      this.emit({
        kind: "turn.end",
        msgId: this.messageByTurn.get(turn) ?? `deepseek_${String(turn)}`,
        finish,
        ...(usage ? { inputTokens: usage.input, outputTokens: usage.output } : {}),
      });
      this.turnStartedAt.delete(turn);
    }
  }

  private require(): { transport: DeepseekTransport; sessionId: string } {
    if (!this.transport || !this.sessionId) throw new AdapterError("DeepSeek Harness 会话尚未就绪");
    return { transport: this.transport, sessionId: this.sessionId };
  }

  private promptContent(text: string, attachments: Attachment[] = []): Array<Record<string, unknown>> {
    return [
      ...(text.length > 0 ? [{ type: "text", text }] : []),
      ...attachments.map((attachment) => ({
        type: "image",
        mediaType: attachment.mimeType,
        data: attachment.dataB64,
        ...(attachment.name ? { name: attachment.name } : {}),
      })),
    ];
  }

  async send(text: string, attachments?: Attachment[]): Promise<void> {
    const { transport, sessionId } = this.require();
    this.pendingUserText.push(text);
    try {
      await transport.call("session.prompt", {
        sessionId,
        mode: "queue",
        content: this.promptContent(text, attachments),
      });
    } catch (error) {
      const index = this.pendingUserText.lastIndexOf(text);
      if (index >= 0) this.pendingUserText.splice(index, 1);
      throw error;
    }
  }

  async steer(text: string, attachments?: Attachment[]): Promise<boolean> {
    const { transport, sessionId } = this.require();
    try {
      await transport.call("session.prompt", {
        sessionId,
        mode: "steer",
        content: this.promptContent(text, attachments),
      });
      return true;
    } catch (error) {
      if (error instanceof Error && /steer-unavailable/i.test(error.message)) return false;
      throw error;
    }
  }

  async respondPermission(reqId: string, reply: PermissionReply): Promise<void> {
    const { transport, sessionId } = this.require();
    const pending = this.approvals.get(reqId);
    if (!pending) return;
    pending.reply = reply;
    await transport.respond(pending.rpcId, {
      ok: true,
      value: {
        sessionId,
        approvalId: pending.approvalId,
        outcome: reply === "reject" ? "rejected" : "allowed-once",
      },
    });
  }

  async respondQuestion(reqId: string, answers: AgentQuestionAnswer[], cancelled = false): Promise<void> {
    const { transport, sessionId } = this.require();
    const pending = this.questions.get(reqId);
    // 静默 return 会让手机上的"提交回答"什么都不发生:答案丢了,调用方却当成功。
    // 问题不在待答表里只有两种可能 —— 已经答过,或 adapter 重启丢了上下文 ——
    // 两种都必须让用户看见,否则只能干等 dsh 那边超时取消。
    if (!pending) {
      throw new AdapterError(`问题 ${reqId} 已不在待回答列表中(可能已回答或会话已重启)`);
    }
    pending.answers = answers;
    pending.cancelled = cancelled;
    await transport.respond(pending.rpcId, cancelled
      ? {
          ok: false,
          error: { code: "cancelled", message: "the user closed this question request", details: {} },
        } as RpcResult
      : {
          ok: true,
          value: {
            sessionId,
            answer: {
              answers: answers.map((answer) => ({
                id: answer.questionId,
                selected: answer.values,
              })),
            },
          },
        });
  }

  async listModels(): Promise<AgentModelCatalog> {
    const transport = this.transport;
    if (!transport) throw new AdapterError("DeepSeek Harness 尚未启动");
    const sessionId = this.sessionId;
    const catalog = sessionId
      ? await transport.call<Record<string, unknown>>("session.models", { sessionId })
      : await transport.call<Record<string, unknown>>("llm.models", {});
    const current = record(catalog["current"]);
    const currentId = `${String(current["provider"] ?? "")}/${String(current["model"] ?? "")}`;
    const models = (Array.isArray(catalog["groups"]) ? catalog["groups"] : []).flatMap((rawGroup) => {
      const group = record(rawGroup);
      const provider = String(group["id"] ?? "");
      const providerName = String(group["name"] ?? provider);
      return (Array.isArray(group["models"]) ? group["models"] : []).map((rawModel) => {
        const model = record(rawModel);
        const reasoning = record(model["reasoning"]);
        const efforts = (Array.isArray(reasoning["efforts"]) ? reasoning["efforts"] : [])
          .map((raw) => String(record(raw)["id"] ?? "")).filter(Boolean);
        const id = `${provider}/${String(model["id"] ?? "")}`;
        return {
          id,
          label: `${providerName} · ${String(model["name"] ?? model["id"] ?? "")}`,
          ...(typeof model["description"] === "string" ? { description: model["description"] } : {}),
          supportedEfforts: efforts,
          ...(typeof reasoning["defaultEffort"] === "string" ? { defaultEffort: reasoning["defaultEffort"] } : {}),
          ...(id === currentId ? { isDefault: true } : {}),
        };
      }).filter((model) => !model.id.endsWith("/"));
    });
    const presetCatalog = await transport.call<Record<string, unknown>>("agentPreset.list", {});
    const presets = (Array.isArray(presetCatalog["presets"]) ? presetCatalog["presets"] : [])
      .map((raw) => record(raw))
      .flatMap((preset) => {
        const id = typeof preset["id"] === "string" ? preset["id"] : "";
        if (!id || typeof preset["broken"] === "string") return [];
        return [{
          id,
          name: typeof preset["name"] === "string" ? preset["name"] : id,
          ...(typeof preset["description"] === "string" ? { description: preset["description"] } : {}),
          ...(preset["isDefault"] === true ? { isDefault: true } : {}),
          ...(preset["trust"] === "user" ? { custom: true } : {}),
        }];
      });
    return {
      models,
      presets,
      ...(this.currentPreset ? { currentPreset: this.currentPreset } : {}),
      ...(currentId !== "/" ? { currentModel: currentId } : {}),
      ...(typeof current["reasoningEffort"] === "string" ? { currentEffort: current["reasoningEffort"] } : {}),
    };
  }

  async setModel(model: string, effort?: string): Promise<AgentModelSelection> {
    const { transport, sessionId } = this.require();
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) throw new AdapterError("DeepSeek 模型 ID 格式无效");
    const result = await transport.call<{ selected?: Record<string, unknown> }>("session.selectModel", {
      sessionId,
      provider: model.slice(0, slash),
      model: model.slice(slash + 1),
      ...(effort ? { reasoningEffort: effort } : {}),
    });
    const selected = record(result.selected);
    const currentModel = `${String(selected["provider"] ?? model.slice(0, slash))}/${String(selected["model"] ?? model.slice(slash + 1))}`;
    this.ctx?.persistState?.({ sessionId, model: currentModel, ...(effort ? { effort } : {}) });
    return {
      currentModel,
      ...(typeof selected["reasoningEffort"] === "string" ? { currentEffort: selected["reasoningEffort"] } : {}),
    };
  }

  async compact(): Promise<void> {
    const { transport, sessionId } = this.require();
    await transport.call("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: "/compact" }],
    });
  }

  async interrupt(): Promise<void> {
    const { transport, sessionId } = this.require();
    await transport.call("session.cancel", { sessionId });
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.transport?.close?.();
    this.transport = null;
    this.sessionId = null;
    this.currentPreset = null;
    this.ctx = null;
    this.approvals.clear();
    this.questions.clear();
    this.usageByTurn.clear();
    this.turnStartedAt.clear();
    this.stepStartedAt.clear();
    this.compactionStartedAt.clear();
    this.compactionDetails.clear();
    this.messageByTurn.clear();
    this.streamedText.clear();
    this.pendingUserText.length = 0;
    this.bufferedEvents.length = 0;
  }

  static async searchLocalConversations(
    query: string,
    requestedLimit = 20,
  ): Promise<import("@prospero/protocol").ResumableConversation[]> {
    const transport = await startTransport({
      cwd: os.homedir(),
      approvalPolicy: () => "strict",
      emit: () => {},
    });
    try {
      const listed = await transport.call<{ items?: unknown[] }>("session.list", {});
      const items = (Array.isArray(listed.items) ? listed.items : []).map(record);
      const needle = query.trim();
      let snippets = new Map<string, string>();
      let allowed: Set<string> | null = null;
      if (needle) {
        const searched = await transport.call<{ items?: unknown[] }>("session.search", { query: needle });
        const rows = (Array.isArray(searched.items) ? searched.items : []).map(record);
        allowed = new Set(rows.map((row) => String(row["sessionId"] ?? "")).filter(Boolean));
        snippets = new Map(rows.flatMap((row) => {
          const id = typeof row["sessionId"] === "string" ? row["sessionId"] : "";
          const snippet = typeof row["snippet"] === "string" ? row["snippet"] : "";
          return id ? [[id, snippet] as const] : [];
        }));
      }
      const limit = Math.max(1, Math.min(50, requestedLimit));
      return items
        .filter((item) => item["blank"] !== true && typeof item["sessionId"] === "string")
        .filter((item) => allowed === null || allowed.has(String(item["sessionId"])))
        .sort((a, b) => Number(b["updatedAt"] ?? 0) - Number(a["updatedAt"] ?? 0))
        .slice(0, limit)
        .map((item) => {
          const id = String(item["sessionId"]);
          const cwd = typeof item["cwd"] === "string" && item["cwd"] ? item["cwd"] : os.homedir();
          const preset = typeof item["agentPreset"] === "string" ? item["agentPreset"] : undefined;
          const projectionValues = record(record(item["projections"])["values"]);
          const projectedTitle = typeof projectionValues["title"] === "string"
            ? projectionValues["title"].trim()
            : "";
          const preview = snippets.get(id)?.trim();
          return {
            id,
            agent: "deepseek" as const,
            title: (projectedTitle || preview || (preset ? `DeepSeek ${preset}` : `DeepSeek · ${path.basename(cwd)}`)).slice(0, 500),
            ...(preview ? { preview: preview.slice(0, 4000) } : {}),
            cwd,
            updatedAt: Math.max(0, Math.round(Number(item["updatedAt"] ?? Date.now()))),
          };
        });
    } finally {
      await transport.close?.();
    }
  }
}
