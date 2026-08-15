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

interface OpencodeEvent {
  type: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------- 共享 server

interface SharedServer {
  port: number;
  proc: ChildProcess;
  /** SSE 订阅者:sessionID → 回调 */
  subscribers: Map<string, (ev: OpencodeEvent) => void>;
  stop(): void;
}

let sharedPromise: Promise<SharedServer> | null = null;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new AdapterError(`opencode ${init?.method ?? "GET"} ${url} → HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: T };
  return (body.data ?? body) as T;
}

/** 起 opencode serve 并持续消费 SSE;整个 daemon 共用一个 */
async function startSharedServer(registerProviderProcess?: AdapterContext["registerProviderProcess"]): Promise<SharedServer> {
  const proc = crossSpawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  try {
    await registerProviderProcess?.(proc);
  } catch (error) {
    await terminateUnregisteredProviderProcess(proc);
    throw error;
  }

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AdapterError("opencode serve 启动超时")),
      SERVER_START_TIMEOUT_MS,
    );
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const m = buf.match(/listening on https?:\/\/[^:]+:(\d+)/i);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.once("error", (e) => {
      clearTimeout(timer);
      reject(new AdapterError(`无法启动 opencode serve(是否已安装?)`, e));
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new AdapterError(`opencode serve 退出,code=${String(code)}`));
    });
  });

  // 关键:必须等模型 catalog 加载完再发 prompt。
  // 服务端口先于插件/catalog 就绪(实测约 1.4s),过早发送的 prompt 会被
  // admitted 但永不调度 —— 表现为"发了消息没反应",且没有任何报错。
  await waitForCatalog(port);

  const server: SharedServer = {
    port,
    proc,
    subscribers: new Map(),
    stop: () => {
      proc.kill();
      sharedPromise = null;
    },
  };

  void consumeEvents(server);
  proc.once("exit", () => {
    sharedPromise = null;
  });
  return server;
}

/** 轮询 /api/model 直到有模型可用 —— opencode 完成 catalog 加载的就绪信号 */
async function waitForCatalog(port: number): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const models = await fetchJson<unknown>(`http://127.0.0.1:${port}/api/model`);
      const count = Array.isArray(models)
        ? models.length
        : Object.keys((models ?? {}) as object).length;
      if (count > 0) return;
    } catch {
      // 端口尚未接受请求,继续轮询
    }
    await delay(250);
  }
  throw new AdapterError("opencode 模型 catalog 加载超时");
}

/** 持续读 SSE,按 sessionID 分发;断线自动重连 */
async function consumeEvents(server: SharedServer): Promise<void> {
  while (server.proc.exitCode === null && !server.proc.killed) {
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/event`, {
        headers: { accept: "text/event-stream" },
      });
      if (!res.body) throw new Error("SSE 无响应体");
      const reader = res.body.getReader();
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

function sharedServer(registerProviderProcess?: AdapterContext["registerProviderProcess"]): Promise<SharedServer> {
  sharedPromise ??= startSharedServer(registerProviderProcess).catch((e: unknown) => {
    sharedPromise = null;
    throw e;
  });
  return sharedPromise;
}

/** 供 daemon 退出时清理 */
export function stopOpencodeServer(): void {
  void sharedPromise?.then((s) => s.stop()).catch(() => {});
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
  private ctx: AdapterContext | null = null;
  /** callId → tool 名,用于 tool.end 时回填 */
  private readonly toolNames = new Map<string, string>();

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const server = await sharedServer(ctx.registerProviderProcess);
    this.server = server;

    const resumeSessionId =
      typeof this.opts.resumeState?.["sessionId"] === "string"
        ? this.opts.resumeState["sessionId"]
        : null;
    if (resumeSessionId) {
      // opencode 把会话存在自己的数据目录；确认记录仍在后直接重新订阅 SSE。
      await fetchJson(`http://127.0.0.1:${server.port}/api/session/${resumeSessionId}`);
      this.sessionId = resumeSessionId;
      server.subscribers.set(resumeSessionId, (ev) => this.onEvent(ev));
      ctx.persistState?.({ sessionId: resumeSessionId });
      return;
    }

    const model = await this.defaultModel(server.port);
    const session = await fetchJson<{ id: string }>(
      `http://127.0.0.1:${server.port}/api/session`,
      {
        method: "POST",
        body: JSON.stringify({
          location: { directory: ctx.cwd },
          ...(model ? { model } : {}),
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
      const cfg = await fetchJson<{ model?: string }>(`http://127.0.0.1:${port}/config`);
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
    await fetchJson(`http://127.0.0.1:${port}/api/session/${sid}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: { text } }),
    });
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
    if (this.server && this.sessionId) {
      this.server.subscribers.delete(this.sessionId);
    }
    this.server = null;
    this.sessionId = null;
    this.ctx = null;
  }
}
