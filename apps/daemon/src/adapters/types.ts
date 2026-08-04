/**
 * 结构化 agent 适配器接口。
 *
 * 每个后端(opencode HTTP+SSE / Claude Agent SDK / Codex app-server)把自己的
 * 事件流归一化成 protocol 的 AgentEventBody,客户端只认这一套。
 * 适配器不关心网络/加密/多客户端广播 —— 那是 StructuredSession 与 ws-server 的事。
 */
import type { AgentEventBody, PermissionReply } from "@prospero/protocol";

export interface AdapterContext {
  cwd: string;
  /** 适配器产出一条归一化事件 */
  emit(body: AgentEventBody): void;
}

export interface AgentAdapter {
  /** 启动后端并准备接收消息;抛错表示会话创建失败 */
  start(ctx: AdapterContext): Promise<void>;
  /** 发送一条用户消息 */
  send(text: string): Promise<void>;
  /** 回应审批请求 */
  respondPermission(reqId: string, reply: PermissionReply): Promise<void>;
  /** 中断当前轮次 */
  interrupt(): Promise<void>;
  /** 关闭并释放资源 */
  dispose(): Promise<void>;
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
