/**
 * opencode 适配器(实测于 opencode 1.18.12)。
 *
 * 形态:daemon 托管一个 `opencode serve` 子进程(全局共享,多会话复用),
 * 通过 HTTP 建会话/发消息/回审批,通过 GET /api/event 的 SSE 收事件。
 *
 * 实测要点(与 OpenAPI spec 的差异,踩过的坑):
 * - SSE 事件负载在 `data` 字段,不是 spec 里写的 `properties`
 * - 响应体统一包在 `{data: ...}` 里
 * - 创建会话必须显式带 model,否则 prompt 只会 admitted 而不触发模型;
 *   默认模型从 GET /config 的 `model` 字段读("providerID/model-id",id 可含斜杠)
 */
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentEventBody, PermissionReply } from "@prospero/protocol";
import crossSpawn from "cross-spawn";
import {
  AdapterError,
  summarize,
  terminateUnregisteredProviderProcess,
  type AdapterContext,
  type AdapterResumeState,
  type AgentAdapter,
} from "./types.js";

const SERVER_START_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 30_000;
const STARTUP_OUTPUT_LIMIT = 64 * 1024;

export function opencodeLocationQuery(directory: string): string {
  const query = new URLSearchParams();
  query.set("location[directory]", directory);
  return query.toString();
}

interface OpencodeEvent {
  type: string;
  data?: Record<string, unknown>;
}

export function parseOpencodeStartupOutput(
  current: string,
  chunk: string,
): { buffer: string; port: number | null } {
  const buffer = `${current}${chunk}`.slice(-STARTUP_OUTPUT_LIMIT);
  const match = buffer.match(/listening on https?:\/\/[^:]+:(\d+)/i);
  return { buffer, port: match ? Number(match[1]) : null };
}

export function waitForOpencodePort(
  proc: ChildProcess,
  timeoutMs = SERVER_START_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let buf = "";
    let timer: NodeJS.Timeout;
    const cleanup = (drain = false): void => {
      clearTimeout(timer);
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onData);
      proc.off("error", onError);
      proc.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      if (drain) {
        proc.stdout?.resume();
        proc.stderr?.resume();
      }
    };
    const onData = (chunk: Buffer): void => {
      const parsed = parseOpencodeStartupOutput(buf, chunk.toString("utf8"));
      buf = parsed.buffer;
      if (parsed.port === null) return;
      cleanup(true);
      resolve(parsed.port);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new AdapterError(`无法启动 opencode serve(是否已安装?)`, error));
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new AdapterError(`opencode serve 退出,code=${String(code)}`));
    };
    const onAbort = (): void => {
      cleanup();
      reject(new AdapterError("opencode serve 启动已取消"));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new AdapterError("opencode serve 启动超时"));
    }, timeoutMs);
    proc.once("error", onError);
    proc.once("exit", onExit);
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function opencodeCatalogHasModel(value: unknown, expected: string): boolean {
  const slash = expected.indexOf("/");
  if (slash <= 0 || slash === expected.length - 1) return false;
  const providerID = expected.slice(0, slash);
  const modelID = expected.slice(slash + 1);
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(record?.["data"])
      ? record["data"]
      : [];
  if (entries.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const model = entry as Record<string, unknown>;
    return model["providerID"] === providerID && (model["id"] === modelID || model["modelID"] === modelID);
  })) return true;
  if (record && Object.prototype.hasOwnProperty.call(record, expected)) return true;
  const provider = record?.[providerID];
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return false;
  const models = (provider as Record<string, unknown>)["models"];
  return !!models && typeof models === "object" && !Array.isArray(models) &&
    Object.prototype.hasOwnProperty.call(models, modelID);
}

export function opencodeResolvedProvider(value: unknown, expectedProviderID: string): boolean {
  const response = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const provider = response?.["data"] && typeof response["data"] === "object" && !Array.isArray(response["data"])
    ? response["data"] as Record<string, unknown>
    : response;
  return provider?.["id"] === expectedProviderID || provider?.["providerID"] === expectedProviderID;
}

export function opencodeEventStreamReady(status: number, contentType: string | null, hasBody: boolean): boolean {
  return status >= 200 && status < 300 && hasBody && contentType?.toLowerCase().includes("text/event-stream") === true;
}

// ---------------------------------------------------------------- 共享 server

interface SharedServer {
  isolated: boolean;
  clients: number;
  port: number;
  proc: ChildProcess;
  /** SSE 订阅者:sessionID → 回调 */
  subscribers: Map<string, (ev: OpencodeEvent) => void>;
  stop(): Promise<void>;
}

interface SharedEntry {
  generation: symbol;
  promise: Promise<SharedServer>;
}

const sharedPromises = new Map<string, SharedEntry>();

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new AdapterError(`opencode ${init?.method ?? "GET"} ${url} → HTTP ${res.status}`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
  const raw = await res.text();
  if (raw.length === 0) return undefined as T;
  let body: { data?: T } | T;
  try { body = JSON.parse(raw) as { data?: T } | T; }
  catch { throw new AdapterError(`opencode ${init?.method ?? "GET"} ${url} 返回了无效 JSON`); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return body as T;
  return ((body as { data?: T }).data ?? body) as T;
}

/** 起 opencode serve 并持续消费 SSE;整个 daemon 共用一个 */
async function startSharedServer(
  key: string,
  generation: symbol,
  environment: Record<string, string>,
  directory: string,
  registerProviderProcess?: AdapterContext["registerProviderProcess"],
): Promise<SharedServer> {
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, ...environment };
  if (environment["PROSPERO_API_PROFILE_CONFIG"]) {
    delete childEnvironment["OPENCODE_CONFIG"];
    delete childEnvironment["OPENCODE_CONFIG_CONTENT"];
    delete childEnvironment["OPENCODE_CONFIG_DIR"];
  }
  const isolated = environment["PROSPERO_API_PROFILE_CONFIG"] !== undefined;
  const args = ["serve", "--hostname", "127.0.0.1", "--port", "0"];
  if (isolated) args.push("--pure");
  const proc = crossSpawn("opencode", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnvironment,
    ...(isolated ? { cwd: directory } : {}),
  });
  const startup = new AbortController();
  const portReady = waitForOpencodePort(proc, SERVER_START_TIMEOUT_MS, startup.signal);
  void portReady.catch(() => {});
  try {
    await registerProviderProcess?.(proc);

    const port = await portReady;
    proc.on("error", () => {});

  // 关键:必须等模型 catalog 加载完再发 prompt。
  // 服务端口先于插件/catalog 就绪(实测约 1.4s),过早发送的 prompt 会被
  // admitted 但永不调度 —— 表现为"发了消息没反应",且没有任何报错。
    await waitForCatalog(port, directory, environment["PROSPERO_API_PROFILE_MODEL"]);

    const server: SharedServer = {
      isolated,
      clients: 0,
      port,
      proc,
      subscribers: new Map(),
      stop: async () => {
        if (sharedPromises.get(key)?.generation === generation) sharedPromises.delete(key);
        await terminateUnregisteredProviderProcess(proc);
      },
    };

    let eventReady!: () => void;
    const ready = new Promise<void>((resolve) => { eventReady = resolve; });
    void consumeEvents(server, eventReady);
    let readyTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        readyTimer = setTimeout(() => reject(new AdapterError("opencode 事件流启动超时")), SERVER_START_TIMEOUT_MS);
        readyTimer.unref?.();
      }),
    ]).finally(() => {
      if (readyTimer) clearTimeout(readyTimer);
    });
    return server;
  } catch (error) {
    startup.abort();
    await terminateUnregisteredProviderProcess(proc);
    throw error;
  }
}

/** 轮询 /api/model 直到有模型可用 —— opencode 完成 catalog 加载的就绪信号 */
async function waitForCatalog(port: number, directory: string, expectedModel?: string): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const models = await fetchJson<unknown>(`http://127.0.0.1:${port}/api/model?${opencodeLocationQuery(directory)}`);
      const catalogReady = Array.isArray(models)
        ? models.length > 0
        : Object.keys((models ?? {}) as object).length > 0;
      if (expectedModel) {
        if (opencodeCatalogHasModel(models, expectedModel)) return;
      } else if (catalogReady) {
        return;
      }
    } catch {
      // 端口尚未接受请求,继续轮询
    }
    await delay(250);
  }
  throw new AdapterError("opencode 模型 catalog 加载超时");
}

async function waitForResolvedProvider(port: number, providerID: string, directory: string): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const provider = await fetchJson<unknown>(
        `http://127.0.0.1:${port}/api/provider/${encodeURIComponent(providerID)}?${opencodeLocationQuery(directory)}`,
      );
      if (opencodeResolvedProvider(provider, providerID)) return;
    } catch {}
    await delay(100);
  }
  throw new AdapterError("OpenCode API Profile provider 加载超时");
}

/** 持续读 SSE,按 sessionID 分发;断线自动重连 */
async function consumeEvents(server: SharedServer, onReady?: () => void): Promise<void> {
  while (server.proc.exitCode === null && !server.proc.killed) {
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/event`, {
        headers: { accept: "text/event-stream" },
      });
      if (!opencodeEventStreamReady(res.status, res.headers.get("content-type"), Boolean(res.body))) {
        await res.body?.cancel();
        throw new Error("SSE 响应无效");
      }
      onReady?.();
      onReady = undefined;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data: ")) continue;
          let ev: OpencodeEvent;
          try {
            ev = JSON.parse(line.slice(6)) as OpencodeEvent;
          } catch {
            continue;
          }
          const sessionID = ev.data?.["sessionID"];
          if (typeof sessionID !== "string") continue;
          server.subscribers.get(sessionID)?.(ev);
        }
      }
    } catch {
      // 断开则退避重连(server 仍活着时)
    }
    await delay(500);
  }
}

function sharedServer(
  environment: Record<string, string>,
  directory: string,
  registerProviderProcess?: AdapterContext["registerProviderProcess"],
): Promise<SharedServer> {
  const key = opencodeServerPoolKey(environment, directory);
  const existing = sharedPromises.get(key);
  if (existing) return existing.promise;
  const generation = Symbol(key);
  const started = startSharedServer(key, generation, environment, directory, registerProviderProcess).catch((error: unknown) => {
    if (sharedPromises.get(key)?.generation === generation) sharedPromises.delete(key);
    throw error;
  });
  sharedPromises.set(key, { generation, promise: started });
  void started.then((server) => {
    server.proc.once("exit", () => {
      if (sharedPromises.get(key)?.generation === generation) sharedPromises.delete(key);
    });
  }).catch(() => {});
  return started;
}

export function opencodeServerPoolKey(environment: Record<string, string>, _directory: string): string {
  return environment["PROSPERO_API_PROFILE_CONFIG"]
    ? `${environment["PROSPERO_API_PROFILE_CONFIG"]}\0${environment["PROSPERO_API_PROFILE_FINGERPRINT"] ?? ""}`
    : "native";
}

/** 供 daemon 退出时清理 */
export function stopOpencodeServer(): void {
  const servers = [...sharedPromises.values()].map((entry) => entry.promise);
  sharedPromises.clear();
  for (const server of servers) void server.then((value) => value.stop()).catch(() => {});
}

// ---------------------------------------------------------------- 适配器

export interface OpencodeAdapterOptions {
  resumeState?: AdapterResumeState | undefined;
}

export class OpencodeAdapter implements AgentAdapter {
  constructor(private readonly opts: OpencodeAdapterOptions = {}) {}

  /** The host-in-Job boundary protects the shared server and its descendants. */
  readonly durableProviderJobCompatible = true;

  private server: SharedServer | null = null;
  private sessionId: string | null = null;
  private model: { providerID: string; id: string } | null = null;
  private ctx: AdapterContext | null = null;
  /** callId → tool 名,用于 tool.end 时回填 */
  private readonly toolNames = new Map<string, string>();

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const server = await sharedServer(ctx.env ?? {}, ctx.cwd, ctx.registerProviderProcess);
    server.clients += 1;
    this.server = server;
    this.model = await this.defaultModel(server.port);
    if (server.isolated && !this.model) throw new AdapterError("OpenCode API Profile 没有可用模型");
    const expectedModel = ctx.env?.["PROSPERO_API_PROFILE_MODEL"];
    if (
      server.isolated && expectedModel && this.model &&
      `${this.model.providerID}/${this.model.id}` !== expectedModel
    ) throw new AdapterError("OpenCode API Profile 模型配置被其他配置覆盖");

    const resumeSessionId =
      typeof this.opts.resumeState?.["sessionId"] === "string"
        ? this.opts.resumeState["sessionId"]
        : null;
    if (resumeSessionId) {
      // opencode 把会话存在自己的数据目录；确认记录仍在后直接重新订阅 SSE。
      await fetchJson(`http://127.0.0.1:${server.port}/api/session/${resumeSessionId}?${opencodeLocationQuery(ctx.cwd)}`);
      this.sessionId = resumeSessionId;
      server.subscribers.set(resumeSessionId, (ev) => this.onEvent(ev));
      ctx.persistState?.({ sessionId: resumeSessionId });
      return;
    }

    const session = await fetchJson<{ id: string }>(
      `http://127.0.0.1:${server.port}/api/session`,
      {
        method: "POST",
        body: JSON.stringify({
          location: { directory: ctx.cwd },
          ...(this.model ? { model: this.model } : {}),
        }),
      },
    );
    this.sessionId = session.id;
    server.subscribers.set(session.id, (ev) => this.onEvent(ev));
    ctx.persistState?.({ sessionId: session.id });
  }

  /** 从 opencode 自身配置读默认模型;拿不到就不传(由 opencode 决定) */
  private async defaultModel(
    port: number,
  ): Promise<{ providerID: string; id: string } | null> {
    try {
      const query = new URLSearchParams({ directory: this.ctx?.cwd ?? process.cwd() });
      const cfg = await fetchJson<{ model?: string }>(`http://127.0.0.1:${port}/config?${query.toString()}`);
      const raw = cfg.model;
      if (typeof raw !== "string" || !raw.includes("/")) return null;
      const slash = raw.indexOf("/");
      return { providerID: raw.slice(0, slash), id: raw.slice(slash + 1) };
    } catch {
      return null;
    }
  }

  private emit(body: AgentEventBody): void {
    this.ctx?.emit(body);
  }

  private onEvent(ev: OpencodeEvent): void {
    const d = ev.data ?? {};
    const msgId = typeof d["assistantMessageID"] === "string" ? d["assistantMessageID"] : "";
    switch (ev.type) {
      case "session.next.text.delta": {
        const delta = d["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          this.emit({
            kind: "text.delta",
            msgId,
            textId: typeof d["textID"] === "string" ? d["textID"] : msgId,
            delta,
          });
        }
        return;
      }
      case "session.next.reasoning.delta": {
        const delta = d["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          this.emit({ kind: "reasoning.delta", msgId, delta });
        }
        return;
      }
      case "session.next.tool.called": {
        const callId = String(d["callID"] ?? "");
        const tool = String(d["tool"] ?? "tool");
        this.toolNames.set(callId, tool);
        this.emit({
          kind: "tool.start",
          msgId,
          callId,
          tool,
          summary: summarize(d["input"]),
        });
        return;
      }
      case "session.next.tool.success": {
        const callId = String(d["callID"] ?? "");
        this.toolNames.delete(callId);
        const raw = d["structured"] ?? d["result"] ?? d["content"] ?? "完成";
        const full = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
        if (full.length > 0) this.ctx?.recordOutput?.(callId, full);
        const summary = summarize(raw);
        this.emit({
          kind: "tool.end",
          callId,
          state: "success",
          summary,
          ...(full.length > summary.length ? { hasMore: true } : {}),
        });
        return;
      }
      case "session.next.tool.failed": {
        const callId = String(d["callID"] ?? "");
        this.toolNames.delete(callId);
        this.emit({
          kind: "tool.end",
          callId,
          state: "failed",
          summary: summarize(d["error"] ?? "失败"),
        });
        return;
      }
      case "permission.v2.asked": {
        const resources = Array.isArray(d["resources"])
          ? (d["resources"] as unknown[]).map((r) => summarize(r, 200))
          : [];
        const action = String(d["action"] ?? "操作");
        this.emit({
          kind: "permission.request",
          reqId: String(d["id"] ?? ""),
          action,
          resources,
          summary: resources.length > 0 ? `${action}: ${resources[0]!}` : action,
        });
        return;
      }
      case "permission.v2.replied": {
        const reply = d["reply"];
        this.emit({
          kind: "permission.resolved",
          reqId: String(d["id"] ?? ""),
          reply:
            reply === "always" || reply === "reject" || reply === "once" ? reply : "once",
        });
        return;
      }
      case "session.next.step.ended": {
        const tokens = (d["tokens"] ?? {}) as Record<string, unknown>;
        const num = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) ? v : undefined;
        const cost = num(d["cost"]);
        const input = num(tokens["input"]);
        const output = num(tokens["output"]);
        this.emit({
          kind: "turn.end",
          msgId,
          ...(typeof d["finish"] === "string" ? { finish: d["finish"] } : {}),
          ...(cost !== undefined ? { costUsd: cost } : {}),
          ...(input !== undefined ? { inputTokens: input } : {}),
          ...(output !== undefined ? { outputTokens: output } : {}),
        });
        return;
      }
      case "session.next.step.failed": {
        this.emit({ kind: "agent.error", message: summarize(d["error"] ?? "步骤失败") });
        return;
      }
      case "session.error": {
        this.emit({ kind: "agent.error", message: summarize(d["error"] ?? "会话错误") });
        return;
      }
      default:
        return; // 其余事件(plugin/catalog/reference…)与手机 UI 无关
    }
  }

  private require(): { port: number; sid: string } {
    if (!this.server || !this.sessionId) {
      throw new AdapterError("opencode 会话尚未就绪");
    }
    return { port: this.server.port, sid: this.sessionId };
  }

  async send(text: string): Promise<void> {
    const { port, sid } = this.require();
    const url = `http://127.0.0.1:${port}/api/session/${sid}/prompt`;
    const admitted = await fetchJson<{ sessionID?: unknown; id?: unknown; admittedSeq?: unknown }>(url, {
      method: "POST",
      body: JSON.stringify({ prompt: { text }, resume: false }),
    });
    if (
      admitted.sessionID !== sid || typeof admitted.id !== "string" || admitted.id.length === 0 ||
      !Number.isSafeInteger(admitted.admittedSeq) || Number(admitted.admittedSeq) < 1
    ) throw new AdapterError("OpenCode 未确认消息已进入执行队列");
    if (this.server?.isolated && this.model) {
      await waitForResolvedProvider(
        port,
        this.model.providerID,
        this.ctx?.cwd ?? process.cwd(),
      );
    }
    const promoted = await fetchJson<{ sessionID?: unknown; id?: unknown; admittedSeq?: unknown }>(url, {
      method: "POST",
      body: JSON.stringify({ id: admitted.id, prompt: { text }, resume: true }),
    });
    if (
      promoted.sessionID !== sid || promoted.id !== admitted.id ||
      promoted.admittedSeq !== admitted.admittedSeq
    ) throw new AdapterError("OpenCode 未确认消息已进入执行队列");
  }

  async respondPermission(reqId: string, reply: PermissionReply): Promise<void> {
    const { port, sid } = this.require();
    await fetchJson(
      `http://127.0.0.1:${port}/api/session/${sid}/permission/${reqId}/reply`,
      { method: "POST", body: JSON.stringify({ reply }) },
    );
  }

  async interrupt(): Promise<void> {
    const { port, sid } = this.require();
    await fetchJson(`http://127.0.0.1:${port}/api/session/${sid}/interrupt`, {
      method: "POST",
      body: "{}",
    });
  }

  async dispose(): Promise<void> {
    if (this.server) {
      if (this.sessionId) this.server.subscribers.delete(this.sessionId);
      this.server.clients = Math.max(0, this.server.clients - 1);
      if (this.server.isolated && this.server.clients === 0) await this.server.stop();
    }
    this.server = null;
    this.sessionId = null;
    this.model = null;
    this.ctx = null;
  }
}
