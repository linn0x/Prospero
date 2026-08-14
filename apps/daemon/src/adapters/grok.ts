/**
 * Grok Build 适配器(grok 0.2.x)。
 *
 * 形态与前三个都不同:Grok 没有常驻 server/协议通道,只有 headless 单轮
 *   grok -p "<prompt>" --output-format streaming-json [--session-id|--resume]
 * 每轮 spawn 一个进程,靠 --resume 保持上下文连续。
 *
 * ⚠️ 关键限制:headless 模式只有粗粒度审批(--always-approve / --allow / --deny),
 * 没有逐条回调,**无法把审批请求送到手机**。因此:
 * - Grok 会话默认仍走 PTY 轨(TUI 里能看到并回答审批);
 * - 选择结构化模式即等于自动批准,适配器会在会话开头明确告知。
 *
 * 事件解析是防御性的:未登录时无法核对真实字段名,因此对几种可能的形态
 * (ACP 风格 session/update、扁平 type 字段)都做兼容,认不出的整体忽略。
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentEventBody, PermissionReply } from "@prospero/protocol";
import crossSpawn from "cross-spawn";
import {
  AdapterError,
  summarize,
  type AdapterContext,
  type AdapterResumeState,
  type AgentAdapter,
} from "./types.js";

export interface GrokAdapterOptions {
  /** 结构化模式必须自动批准(headless 无逐条审批);默认 true */
  alwaysApprove?: boolean;
  resumeState?: AdapterResumeState | undefined;
}

export class GrokAdapter implements AgentAdapter {
  private readonly sessionId: string;
  private started: boolean;

  constructor(private readonly opts: GrokAdapterOptions = {}) {
    this.sessionId =
      typeof opts.resumeState?.["sessionId"] === "string"
        ? opts.resumeState["sessionId"]
        : randomUUID();
    this.started = opts.resumeState?.["started"] === true;
  }

  private ctx: AdapterContext | null = null;
  private turn: ChildProcess | null = null;
  private buf = "";
  private msgId = "";
  private turnStarted = false;

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    ctx.persistState?.({ sessionId: this.sessionId, started: this.started });
    // 会话建立时就把限制讲清楚,避免用户以为审批会弹到手机上
    ctx.emit({
      kind: "agent.error",
      message:
        "注意:Grok headless 不支持逐条审批,此对话会话中的工具调用将自动批准。" +
        "需要逐条确认时请新建 Grok 的终端会话。",
    });
  }

  private emit(body: AgentEventBody): void {
    this.ctx?.emit(body);
  }

  async send(text: string): Promise<void> {
    if (!this.ctx) throw new AdapterError("grok 会话尚未就绪");
    if (this.turn) throw new AdapterError("上一轮尚未结束");

    const args = [
      "-p",
      text,
      "--output-format",
      "streaming-json",
      "--cwd",
      this.ctx.cwd,
      // 首轮用固定 session-id,之后 --resume 续上下文
      ...(this.started ? ["--resume", this.sessionId] : ["--session-id", this.sessionId]),
      ...((this.opts.alwaysApprove ?? true) ? ["--always-approve"] : []),
    ];
    this.started = true;
    this.ctx.persistState?.({ sessionId: this.sessionId, started: true });
    this.msgId = `grok_${String(Date.now())}`;
    this.turnStarted = true;
    this.buf = "";

    const proc = crossSpawn("grok", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: this.ctx.cwd,
      env: { ...process.env, ...this.ctx.env },
    });
    this.turn = proc;
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    let stderr = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    proc.once("error", (e) => {
      this.turn = null;
      this.emit({ kind: "agent.error", message: `无法启动 grok:${e.message}` });
      this.endTurn();
    });
    proc.once("exit", (code) => {
      this.turn = null;
      this.flushLine(this.buf.trim());
      if (code !== 0 && stderr.trim().length > 0) {
        this.emit({ kind: "agent.error", message: summarize(stderr, 300) });
      }
      this.endTurn();
    });
  }

  private lastUsage: { inputTokens: number; outputTokens: number } | null = null;
  private lastCostUsd: number | null = null;

  private endTurn(): void {
    if (!this.turnStarted) return;
    this.turnStarted = false;
    this.emit({
      kind: "turn.end",
      msgId: this.msgId,
      ...(this.lastUsage ?? {}),
      ...(this.lastCostUsd !== null ? { costUsd: this.lastCostUsd } : {}),
    });
    this.lastUsage = null;
    this.lastCostUsd = null;
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      this.flushLine(line);
    }
  }

  private flushLine(line: string): void {
    if (line.length === 0) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // 非 JSON 行(plain 模式的兜底输出)当作文本
      this.emit({ kind: "text.delta", msgId: this.msgId, textId: this.msgId, delta: line });
      return;
    }
    this.handleEvent(ev);
  }

  /** 兼容 ACP 风格(update.sessionUpdate)与扁平 type 两种形态 */
  private handleEvent(ev: Record<string, unknown>): void {
    const update = (ev["update"] ?? ev) as Record<string, unknown>;
    const kind = String(update["sessionUpdate"] ?? ev["type"] ?? "");

    switch (kind) {
      case "agent_message_chunk":
      case "assistant_message_chunk":
      case "message_delta":
      case "text": {
        const delta = extractText(
          update["data"] ?? update["content"] ?? update["text"] ?? update["delta"],
        );
        if (delta) {
          this.emit({ kind: "text.delta", msgId: this.msgId, textId: this.msgId, delta });
        }
        return;
      }
      case "agent_thought_chunk":
      case "reasoning":
      case "thought": {
        const delta = extractText(
          update["data"] ?? update["content"] ?? update["text"] ?? update["delta"],
        );
        if (delta) this.emit({ kind: "reasoning.delta", msgId: this.msgId, delta });
        return;
      }
      case "tool_call":
      case "tool_use": {
        const callId = String(update["toolCallId"] ?? update["id"] ?? randomUUID());
        this.emit({
          kind: "tool.start",
          msgId: this.msgId,
          callId,
          tool: String(update["title"] ?? update["name"] ?? update["tool"] ?? "tool"),
          summary: summarize(update["rawInput"] ?? update["input"] ?? update["arguments"] ?? ""),
        });
        return;
      }
      case "tool_call_update":
      case "tool_result": {
        const callId = String(update["toolCallId"] ?? update["id"] ?? "");
        const status = String(update["status"] ?? "completed");
        if (status === "in_progress" || status === "pending") return;
        this.emit({
          kind: "tool.end",
          callId,
          state: status === "failed" || status === "error" ? "failed" : "success",
          summary: summarize(update["content"] ?? update["output"] ?? status),
        });
        return;
      }
      case "error": {
        this.emit({
          kind: "agent.error",
          message: summarize(ev["message"] ?? update["message"] ?? ev),
        });
        return;
      }
      case "end":
      case "result":
      case "turn_complete": {
        // 真实字段:{"type":"end","stopReason":...,"usage":{...},"total_cost_usd":...}
        // 用量只在这一帧里出现,进程退出时拿不到,所以在这里记下来给 turn.end 用。
        const usage = update["usage"] as Record<string, unknown> | undefined;
        if (usage) {
          this.lastUsage = {
            inputTokens: Number(usage["input_tokens"] ?? 0),
            outputTokens: Number(usage["output_tokens"] ?? 0),
          };
        }
        const cost = update["total_cost_usd"];
        if (typeof cost === "number") this.lastCostUsd = cost;
        return; // 仍由进程退出统一收尾,避免重复 turn.end
      }
      default:
        return;
    }
  }

  async respondPermission(_reqId: string, _reply: PermissionReply): Promise<void> {
    // headless 无逐条审批;此方法不会被触发(适配器从不发 permission.request)
  }

  async interrupt(): Promise<void> {
    this.turn?.kill("SIGINT");
  }

  async dispose(): Promise<void> {
    this.turn?.kill();
    this.turn = null;
    this.ctx = null;
  }
}

/** Grok 的文本可能是字符串或 {type:"text",text} 结构 */
function extractText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["text"] === "string") return o["text"];
    if (Array.isArray(v)) {
      return v.map((x) => extractText(x)).join("");
    }
  }
  return "";
}
