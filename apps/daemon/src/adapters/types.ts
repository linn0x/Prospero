/**
 * 结构化 agent 适配器接口。
 *
 * 每个后端(opencode HTTP+SSE / Claude Agent SDK / Codex app-server)把自己的
 * 事件流归一化成 protocol 的 AgentEventBody,客户端只认这一套。
 * 适配器不关心网络/加密/多客户端广播 —— 那是 StructuredSession 与 ws-server 的事。
 */
import type {
  AgentEventBody,
  Attachment,
  ApprovalPolicy,
  PermissionReply,
} from "@prospero/protocol";

export interface AdapterContext {
  cwd: string;
  /** 当前审批策略;适配器据此决定是否绕过人工确认 */
  approvalPolicy?: () => ApprovalPolicy;
  /** 适配器产出一条归一化事件 */
  emit(body: AgentEventBody): void;
  /**
   * 登记某次工具调用的完整输出。
   * 事件里只带摘要(手机上没必要一次性收下 100KB 的测试日志),
   * 用户展开卡片时再按需拉全文。
   */
  recordOutput?(callId: string, output: string): void;
}

export interface AgentAdapter {
  /** 是否能直接吃图;false 时由上层落盘降级 */
  readonly acceptsImages?: boolean;
  /** 启动后端并准备接收消息;抛错表示会话创建失败 */
  start(ctx: AdapterContext): Promise<void>;
  /**
   * 发送一条用户消息。
   * 附件由适配器决定怎么用:能原生收图的(Claude)走图片块,
   * 其余的由 StructuredSession 落盘成文件、把路径并进文本。
   */
  send(text: string, attachments?: Attachment[]): Promise<void>;
  /** 回应审批请求 */
  respondPermission(reqId: string, reply: PermissionReply): Promise<void>;
  /**
   * 用量与限流。后端拿不到就返回 null —— 大多数 agent 压根不暴露这个,
   * 所以这是可选实现,不是所有适配器都要装样子。
   */
  usage?(): Promise<UsageReport | null>;
  /** 中断当前轮次 */
  interrupt(): Promise<void>;
  /** 关闭并释放资源 */
  dispose(): Promise<void>;
}

export interface UsageReport {
  subscription?: string | null;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** 套餐限流窗口;没有不代表没有用量 */
  windows: { label: string; utilization: number; resetsAt?: string }[];
}

export class AdapterError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AdapterError";
  }
}

/** 把任意值裁剪成适合手机展示的一行摘要 */
export function summarize(value: unknown, max = 300): string {
  let s: string;
  if (typeof value === "string") s = value;
  else if (value === undefined || value === null) s = "";
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}
