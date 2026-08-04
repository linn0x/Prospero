/**
 * 结构化会话:PtySession 的对位物。
 * PtySession 用 headless 终端持有画面状态,这里用事件日志持有对话状态,
 * attach 时用 chat.snapshot 一次性重放 —— 同样是"秒开",同样支持增量续传。
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import type {
  AgentEventBody,
  AgentKind,
  PermissionReply,
  SessionInfo,
  SessionStatus,
} from "@prospero/protocol";
import type { AgentAdapter } from "./adapters/types.js";

/** 事件日志上限:超出后丢弃最旧的(快照会带 truncated 标记) */
const MAX_EVENTS = 4000;

export interface StructuredSessionOptions {
  id: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  adapter: AgentAdapter;
}

export interface StructuredSessionEvents {
  event: [body: AgentEventBody, evSeq: number];
  state: [info: SessionInfo];
}

export class StructuredSession extends EventEmitter<StructuredSessionEvents> {
  readonly id: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt = Date.now();

  private readonly adapter: AgentAdapter;
  private readonly log: AgentEventBody[] = [];
  private evSeq = 0;
  private status: SessionStatus = "starting";
  private readonly pending = new Set<string>();
  private disposed = false;

  constructor(opts: StructuredSessionOptions) {
    super();
    this.id = opts.id;
    this.agent = opts.agent;
    this.title = opts.title;
    this.cwd = opts.cwd;
    this.adapter = opts.adapter;
  }

  async start(): Promise<void> {
    await this.adapter.start({
      cwd: this.cwd,
      emit: (body) => this.record(body),
    });
    this.setStatus("idle");
  }

  info(): SessionInfo {
    return {
      id: this.id,
      agent: this.agent,
      kind: "structured",
      title: this.title,
      cwd: this.cwd,
      status: this.status,
      createdAt: this.createdAt,
      cols: 80,
      rows: 24,
      pendingPermissions: this.pending.size,
    };
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

    // 审批状态直接驱动会话状态,列表里才能把"待审批"置顶
    if (body.kind === "permission.request") {
      this.pending.add(body.reqId);
      this.setStatus("waiting_approval");
    } else if (body.kind === "permission.resolved") {
      this.pending.delete(body.reqId);
      if (this.pending.size === 0 && this.status === "waiting_approval") {
        this.setStatus("running");
      }
    } else if (body.kind === "turn.end") {
      if (this.pending.size === 0) this.setStatus("idle");
    } else if (body.kind === "agent.error") {
      if (this.pending.size === 0) this.setStatus("idle");
    } else if (this.status === "idle" || this.status === "starting") {
      this.setStatus("running");
    }

    this.emit("event", body, this.evSeq);
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit("state", this.info());
  }

  async send(text: string): Promise<void> {
    // 用户消息本地登记,保证 attach 快照里能看到自己发过什么
    this.record({ kind: "user.message", msgId: `u_${String(this.evSeq + 1)}`, text });
    this.setStatus("running");
    await this.adapter.send(text);
  }

  async respondPermission(reqId: string, reply: PermissionReply): Promise<void> {
    await this.adapter.respondPermission(reqId, reply);
    // 后端通常会回 permission.v2.replied;这里不抢先记录,避免重复
  }

  async interrupt(): Promise<void> {
    await this.adapter.interrupt();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.adapter.dispose().catch(() => {});
    this.setStatus("done");
    this.removeAllListeners();
  }
}

export function titleFor(agent: AgentKind, cwd: string): string {
  return `${agent} · ${path.basename(cwd)}`;
}
