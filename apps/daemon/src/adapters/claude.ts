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
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEventBody, PermissionReply } from "@prospero/protocol";
import { diffFromToolInput } from "./diff.js";
import { AdapterError, summarize, type AdapterContext, type AgentAdapter } from "./types.js";

interface PendingPermission {
  resolve(result: PermissionResult): void;
  /** 原始入参;允许时原样回传给 SDK */
  input: Record<string, unknown>;
  /** 供 "始终允许" 使用:SDK 给出的规则建议 */
  suggestions: PermissionUpdate[];
  toolName: string;
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
}

export class ClaudeAdapter implements AgentAdapter {
  constructor(private readonly opts: ClaudeAdapterOptions = {}) {}

  private ctx: AdapterContext | null = null;
  private q: Query | null = null;
  private readonly input = new MessageQueue();
  private readonly pending = new Map<string, PendingPermission>();
  private currentMsgId = "";
  private pumping: Promise<void> | null = null;

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    try {
      this.q = query({
        prompt: this.input,
        options: {
          cwd: ctx.cwd,
          // 全部工具调用都过 canUseTool → 手机审批
          permissionMode: "default",
          canUseTool: this.canUseTool,
          includePartialMessages: true,
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

  private readonly canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise<PermissionResult>((resolve) => {
      const reqId = randomUUID();
      this.pending.set(reqId, {
        resolve,
        input,
        suggestions: options.suggestions ?? [],
        toolName,
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
      });
    });

  private emit(body: AgentEventBody): void {
    this.ctx?.emit(body);
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
    switch (msg.type) {
      case "stream_event": {
        // 增量文本:content_block_delta 里的 text_delta
        const ev = msg.event as {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (ev.type !== "content_block_delta") return;
        const msgId = this.currentMsgId || msg.uuid;
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          this.emit({
            kind: "text.delta",
            msgId,
            textId: msgId,
            delta: ev.delta.text,
          });
        } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
          this.emit({ kind: "reasoning.delta", msgId, delta: ev.delta.thinking });
        }
        return;
      }
      case "assistant": {
        this.currentMsgId = msg.message.id;
        // 工具调用在完整消息里出现(增量流只给文本)
        for (const block of msg.message.content) {
          if (typeof block === "object" && block.type === "tool_use") {
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
            });
          }
        }
        return;
      }
      case "result": {
        const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        this.emit({
          kind: "turn.end",
          msgId: this.currentMsgId || msg.uuid,
          finish: msg.subtype,
          ...(typeof msg.total_cost_usd === "number" ? { costUsd: msg.total_cost_usd } : {}),
          ...(typeof usage?.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
          ...(typeof usage?.output_tokens === "number"
            ? { outputTokens: usage.output_tokens }
            : {}),
        });
        this.currentMsgId = "";
        return;
      }
      default:
        return; // system/init 等与手机 UI 无关
    }
  }

  async send(text: string): Promise<void> {
    if (!this.q) throw new AdapterError("Claude 会话尚未就绪");
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    } as SDKUserMessage);
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
    this.emit({ kind: "permission.resolved", reqId, reply });
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
    this.input.close();
    try {
      await this.q?.interrupt();
    } catch {
      // 已结束
    }
    this.q = null;
    this.ctx = null;
    await this.pumping?.catch(() => {});
  }
}
