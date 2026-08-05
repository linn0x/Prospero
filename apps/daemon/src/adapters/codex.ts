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
import type { AgentEventBody, FileDiff, PermissionReply } from "@prospero/protocol";
import { fromUnifiedPatch } from "./diff.js";
import {
  AdapterError,
  summarize,
  type AdapterContext,
  type AgentAdapter,
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
  private proc: ChildProcess | null = null;
  private ctx: AdapterContext | null = null;
  private threadId: string | null = null;
  private nextId = 1;
  private buf = "";
  private readonly pendingRpc = new Map<number | string, (m: RpcMessage) => void>();
  private readonly approvals = new Map<string, PendingApproval>();
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

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
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

    // 实测:threadId 在 result.thread.id,不是顶层 threadId(spec 类型名有误导)
    const started = (await this.request("thread/start", {
      cwd: ctx.cwd,
      // 全部走手机审批:untrusted 表示除白名单外都要问
      approvalPolicy: "untrusted",
    })) as { thread?: { id?: string }; threadId?: string };
    const threadId = started.thread?.id ?? started.threadId;
    if (!threadId) throw new AdapterError("codex thread/start 未返回 threadId");
    this.threadId = threadId;
  }

  private emit(body: AgentEventBody): void {
    this.ctx?.emit(body);
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
    switch (msg.method) {
      case "item/commandExecution/requestApproval": {
        const cmd = p["command"] ?? p["parsedCommand"] ?? p["argv"];
        this.approvals.set(itemId, { rpcId: msg.id!, itemId });
        this.emit({
          kind: "permission.request",
          reqId: itemId,
          action: "运行命令",
          resources: [summarize(cmd, 400)],
          summary: `运行命令:${summarize(cmd, 200)}`,
        });
        return;
      }
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        this.approvals.set(itemId, { rpcId: msg.id!, itemId });
        const reason = p["reason"] ?? p["grantRoot"] ?? p["changes"] ?? "修改文件";
        // Codex 会通过 patchUpdated 先行给出 patch,这里取用
        const diff = this.pendingDiffs.get(itemId) ?? extractDiff(p);
        this.emit({
          kind: "permission.request",
          reqId: itemId,
          action: "修改文件",
          resources: [summarize(diff?.path ?? reason, 400)],
          summary: `修改文件:${summarize(diff?.path ?? reason, 200)}`,
          ...(diff ? { diff } : {}),
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

  private onNotification(msg: RpcMessage): void {
    const p = msg.params ?? {};
    switch (msg.method) {
      case "turn/started":
        this.currentTurnMsgId = String(p["turnId"] ?? "");
        this.lastTextMsgId = "";
        return;
      case "item/agentMessage/delta": {
        const delta = p["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          const msgId = String(p["itemId"] ?? this.currentTurnMsgId);
          this.lastTextMsgId = msgId;
          this.emit({ kind: "text.delta", msgId, textId: msgId, delta });
        }
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = p["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          this.emit({
            kind: "reasoning.delta",
            msgId: String(p["itemId"] ?? this.currentTurnMsgId),
            delta,
          });
        }
        return;
      }
      case "item/started": {
        const item = (p["item"] ?? {}) as Record<string, unknown>;
        const itemType = String(item["type"] ?? item["item_type"] ?? "");
        const itemId = String(item["id"] ?? p["itemId"] ?? "");
        // 只有工具类 item 需要卡片;文本类由 delta 承载
        if (itemType === "commandExecution" || itemType === "fileChange" || itemType === "mcpToolCall") {
          const tool =
            itemType === "commandExecution"
              ? "bash"
              : itemType === "fileChange"
                ? "edit"
                : String(item["server"] ?? "mcp");
          this.toolItems.set(itemId, tool);
          this.emit({
            kind: "tool.start",
            msgId: this.currentTurnMsgId,
            callId: itemId,
            tool,
            summary: summarize(item["command"] ?? item["changes"] ?? item),
          });
        }
        return;
      }
      case "item/fileChange/patchUpdated": {
        // Codex 原生给出 patch,无需合成
        const diff = extractDiff(p);
        if (diff) this.pendingDiffs.set(String(p["itemId"] ?? ""), diff);
        return;
      }
      case "item/completed": {
        const item = (p["item"] ?? {}) as Record<string, unknown>;
        const itemId = String(item["id"] ?? p["itemId"] ?? "");
        if (!this.toolItems.has(itemId)) return;
        this.toolItems.delete(itemId);
        const status = String(item["status"] ?? "completed");
        const raw = item["output"] ?? item["result"] ?? status;
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
        });
        return;
      }
      /**
       * 用量在【单独的通知】里,不在 turn/completed 上。
       * TurnCompletedNotification 的形状是 { threadId, turn },压根没有 usage 字段 ——
       * 早先按 `p.usage` 读,于是 token 永远是 0,界面上 codex 看起来"没有用量"。
       * 官方 schema(codex app-server generate-ts)是唯一可靠的来源。
       */
      case "thread/tokenUsage/updated": {
        const tu = (p["tokenUsage"] ?? {}) as Record<string, unknown>;
        const last = (tu["last"] ?? {}) as Record<string, unknown>;
        const total = (tu["total"] ?? {}) as Record<string, unknown>;
        const num = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) ? v : undefined;
        this.lastTurnTokens = {
          input: num(last["inputTokens"]),
          output: num(last["outputTokens"]),
        };
        this.totalTokens = {
          input: num(total["inputTokens"]),
          output: num(total["outputTokens"]),
        };
        return;
      }

      /** 账号级限流。窗口是 usedPercent + resetsAt(秒级时间戳) */
      case "account/rateLimits/updated": {
        const rl = (p["rateLimits"] ?? {}) as Record<string, unknown>;
        const win = (v: unknown, label: string): UsageReport["windows"][number] | null => {
          const w = v as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null;
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
        this.emit({
          kind: "turn.end",
          msgId: this.lastTextMsgId || this.currentTurnMsgId || String(p["turnId"] ?? ""),
          ...(typeof p["status"] === "string" ? { finish: p["status"] } : {}),
          ...(this.lastTurnTokens.input !== undefined
            ? { inputTokens: this.lastTurnTokens.input }
            : {}),
          ...(this.lastTurnTokens.output !== undefined
            ? { outputTokens: this.lastTurnTokens.output }
            : {}),
        });
        this.lastTurnTokens = {};
        return;
      }
      case "error": {
        this.emit({ kind: "agent.error", message: summarize(p["message"] ?? p) });
        return;
      }
      default:
        return;
    }
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

  async send(text: string): Promise<void> {
    if (!this.threadId) throw new AdapterError("codex 会话尚未就绪");
    // turn/start 直到本轮结束才返回,不能 await —— 否则会阻塞后续的审批回复,
    // 而审批回复正是本轮继续下去的前提,形成死锁。
    void this.request(
      "turn/start",
      {
        threadId: this.threadId,
        input: [{ type: "text", text, text_elements: [] }],
      },
      0,
    ).catch((e: unknown) => {
      this.emit({
        kind: "agent.error",
        message: e instanceof Error ? e.message : String(e),
      });
    });
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
    this.emit({ kind: "permission.resolved", reqId, reply });
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
    this.proc?.kill();
    this.proc = null;
    this.ctx = null;
    this.threadId = null;
  }
}
