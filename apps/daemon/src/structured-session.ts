/**
 * 结构化会话:PtySession 的对位物。
 * PtySession 用 headless 终端持有画面状态,这里用事件日志持有对话状态,
 * attach 时用 chat.snapshot 一次性重放 —— 同样是"秒开",同样支持增量续传。
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DEFAULT_POLICY } from "./approval-policy.js";
import type { UsageReport } from "./adapters/types.js";
import { prosperoHome } from "./pairing.js";
import type {
  ApprovalPolicy,
  Attachment,
  AgentEventBody,
  AgentKind,
  PermissionReply,
  SessionInfo,
  SessionStatus,
} from "@prospero/protocol";
import type { AgentAdapter } from "./adapters/types.js";

/** 事件日志上限:超出后丢弃最旧的(快照会带 truncated 标记) */
const MAX_EVENTS = 4000;
/** 会话列表预览的截断长度 */
const PREVIEW_CHARS = 140;
/** 单次工具输出保留上限(按需拉取时) */
const MAX_TOOL_OUTPUT = 200_000;
/** 保留完整输出的工具调用条数 */
const MAX_TOOL_ENTRIES = 200;

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
  /** 会话列表预览:最后一条助手文本的开头(已剥掉 Markdown 标记) */
  private preview = "";
  private previewRaw = "";
  private previewMsgId = "";
  private busySince: number | undefined;
  /** 累计用量:每轮 turn.end 汇总 */
  private totals = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  /** callId → 完整工具输出,供 tool.output.get 按需拉取 */
  private readonly toolOutputs = new Map<string, string>();

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
      recordOutput: (callId, output) => this.recordToolOutput(callId, output),
      // 取函数而非取值:策略可在会话进行中改,适配器每次调用都要读到当下的值
      approvalPolicy: () => this.policy,
    });
    this.setStatus("idle");
  }

  /** 当前审批策略;可在会话进行中修改 */
  private policy: ApprovalPolicy = DEFAULT_POLICY;

  setApprovalPolicy(policy: ApprovalPolicy): void {
    this.policy = policy;
    this.emit("state", this.info());
  }

  get approvalPolicy(): ApprovalPolicy {
    return this.policy;
  }

  info(): SessionInfo {
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
      pendingPermissions: this.pending.size,
      ...(this.preview ? { preview: this.preview } : {}),
      ...(this.busySince !== undefined ? { busySince: this.busySince } : {}),
      ...(this.totals.outputTokens > 0 || this.totals.costUsd > 0
        ? { totals: { ...this.totals } }
        : {}),
    };
  }

  /** 完整工具输出(应答 tool.output.get) */
  toolOutput(callId: string): { output: string; truncated: boolean } | null {
    const full = this.toolOutputs.get(callId);
    if (full === undefined) return null;
    return full.length > MAX_TOOL_OUTPUT
      ? { output: full.slice(0, MAX_TOOL_OUTPUT), truncated: true }
      : { output: full, truncated: false };
  }

  /** 适配器登记完整输出;摘要仍走事件,全文按需拉取 */
  recordToolOutput(callId: string, output: string): void {
    if (this.toolOutputs.size > MAX_TOOL_ENTRIES) {
      const oldest = this.toolOutputs.keys().next().value;
      if (oldest !== undefined) this.toolOutputs.delete(oldest);
    }
    this.toolOutputs.set(callId, output);
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

    // 维护列表预览:累积当前助手消息的开头,新消息则重置
    if (body.kind === "text.delta") {
      if (body.msgId !== this.previewMsgId) {
        this.previewMsgId = body.msgId;
        this.previewRaw = "";
      }
      if (this.previewRaw.length < PREVIEW_CHARS * 2) {
        this.previewRaw += body.delta;
        this.preview = stripMarkdown(this.previewRaw).slice(0, PREVIEW_CHARS);
      }
    }

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
      this.totals.costUsd += body.costUsd ?? 0;
      this.totals.inputTokens += body.inputTokens ?? 0;
      this.totals.outputTokens += body.outputTokens ?? 0;
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
    // running/waiting_approval 期间才计时,回到 idle 就清掉
    this.busySince =
      s === "running" || s === "waiting_approval" ? (this.busySince ?? Date.now()) : undefined;
    this.emit("state", this.info());
  }

  async send(text: string, attachments?: Attachment[]): Promise<void> {
    let outgoing = text;
    let forAdapter = attachments;

    if (attachments && attachments.length > 0 && this.adapter.acceptsImages !== true) {
      // 后端吃不了图就落盘,把绝对路径并进文本 —— 有读文件能力的 agent
      // 照样能看到内容。写进 ~/.prospero 而不是仓库里:附件是会话产物,
      // 不该出现在用户的 git status 里。
      const paths = await this.persistAttachments(attachments);
      outgoing = [text, ...paths.map((p) => `[附件] ${p}`)].filter((x) => x.length > 0).join("\n");
      forAdapter = undefined;
    }

    // 用户消息本地登记,保证 attach 快照里能看到自己发过什么
    const label =
      attachments && attachments.length > 0
        ? `${text}${text.length > 0 ? " " : ""}[${String(attachments.length)} 张图]`
        : text;
    this.record({ kind: "user.message", msgId: `u_${String(this.evSeq + 1)}`, text: label });
    this.busySince = Date.now(); // 新一轮开始重新计时
    this.setStatus("running");
    await this.adapter.send(outgoing, forAdapter);
  }

  /** 把附件写进 ~/.prospero/attachments/<sid>/,返回绝对路径 */
  private async persistAttachments(attachments: Attachment[]): Promise<string[]> {
    const dir = path.join(prosperoHome(), "attachments", this.id);
    await mkdir(dir, { recursive: true });
    const out: string[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      if (!a) continue;
      const ext = a.mimeType.split("/")[1] ?? "png";
      // 先去掉一切非 [字母数字._-],再把连续的点压成一个下划线。
      // 只做前一步的话 "../../evil" 会变成 ".._.._evil" —— 逃不出目录(路径
      // 分隔符已经没了),但文件名里挂着 ".." 只会让人怀疑到底安不安全。
      const safe = (a.name ?? `image-${String(i + 1)}`)
        .replace(/[^\w.-]/g, "_")
        .replace(/\.{2,}/g, "_");
      const file = path.join(dir, `${String(Date.now())}-${safe}.${ext}`);
      await writeFile(file, Buffer.from(a.dataB64, "base64"));
      out.push(file);
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
