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
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentEventBody,
  AgentQuestionAnswer,
  Attachment,
  PermissionReply,
} from "@prospero/protocol";
import crossSpawn from "cross-spawn";
import { WebSocket, type RawData } from "ws";
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
  private unsubscribe: (() => void) | null = null;
  private currentTurn = 0;
  private lastSeq = -1;
  private historySync: Promise<void> | null = null;
  private readonly bufferedEvents: Array<Record<string, unknown>> = [];
  private readonly usageByTurn = new Map<number, { input: number; output: number }>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.lastSeq = finite(this.opts.resumeState?.["lastSeq"]) ?? -1;
    this.bufferedEvents.length = 0;
    const transport = this.opts.transport ?? await startTransport(ctx);
    this.transport = transport;
    const restored = typeof this.opts.resumeState?.["sessionId"] === "string"
      ? this.opts.resumeState["sessionId"] as string
      : undefined;
    const created = await transport.call<{ sessionId?: string }>("session.create", {
      cwd: ctx.cwd,
      ...(restored ? { sessionId: restored } : {}),
    });
    if (typeof created.sessionId !== "string" || created.sessionId.length === 0) {
      throw new AdapterError("DeepSeek Harness 未返回 sessionId");
    }
    this.sessionId = created.sessionId;
    this.unsubscribe = transport.subscribe(created.sessionId, (rpcId, frame) => this.onFrame(rpcId, frame));
    await transport.ready?.();
    await this.syncHistory().catch(() => undefined);
    ctx.persistState?.({ sessionId: created.sessionId });
  }

  private emit(body: AgentEventBody): void {
    this.ctx?.emit(body);
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
    if (type === "turn/start") {
      this.currentTurn = finite(data["turn"]) ?? this.currentTurn + 1;
      return;
    }
    if (type === "assistant/chunk") {
      const chunk = record(data["chunk"]);
      const msgId = this.messageId(data);
      if (chunk["type"] === "text-delta" && typeof chunk["text"] === "string" && chunk["text"].length > 0) {
        this.emit({ kind: "text.delta", msgId, textId: msgId, delta: chunk["text"] });
      } else if (chunk["type"] === "reasoning-delta" && typeof chunk["text"] === "string" && chunk["text"].length > 0) {
        this.emit({ kind: "reasoning.delta", msgId, delta: chunk["text"] });
      }
      return;
    }
    if (type === "assistant/message") {
      const usage = record(data["usage"]);
      const turn = finite(data["turn"]) ?? this.currentTurn;
      const previous = this.usageByTurn.get(turn) ?? { input: 0, output: 0 };
      previous.input += finite(usage["inputTokens"]) ?? 0;
      previous.output += finite(usage["outputTokens"]) ?? 0;
      this.usageByTurn.set(turn, previous);
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
      const reason = record(data["reason"]);
      const finish = typeof reason["kind"] === "string" ? reason["kind"] : "completed";
      if (finish === "error") {
        this.emit({ kind: "agent.error", message: summarize(record(reason["error"])["message"] ?? "DeepSeek Harness 运行失败") });
      }
      this.emit({
        kind: "turn.end",
        msgId: `deepseek_${String(turn)}`,
        finish,
        ...(usage ? { inputTokens: usage.input, outputTokens: usage.output } : {}),
      });
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
    await transport.call("session.prompt", {
      sessionId,
      mode: "queue",
      content: this.promptContent(text, attachments),
    });
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
    if (!pending) return;
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
    const { transport, sessionId } = this.require();
    const catalog = await transport.call<Record<string, unknown>>("session.models", { sessionId });
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
    return {
      models,
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
    this.ctx = null;
    this.approvals.clear();
    this.questions.clear();
    this.usageByTurn.clear();
    this.bufferedEvents.length = 0;
  }
}
