/**
 * 推送通道:App 不在前台时,把"待审批"这类需要人的事件推到锁屏。
 *
 * 为什么需要:iOS 上 App 一旦被挂起,WebSocket 就断了(平台行为,见架构文档 §8),
 * 手机再也收不到 agent 的审批请求 —— 而审批恰恰是最高频的远程操作。
 *
 * 通道选型:Bark(iOS,bark-server 可自建)与 ntfy(Android/自建)都是
 * "HTTP POST 一条消息"的形态,这里统一成一个 URL 模板,两者都能用。
 *
 * 隐私:只推元数据(会话名 + 动作),内容不出内网。
 */
import type { SessionInfo } from "@prospero/protocol";

export interface NotifyConfig {
  /**
   * 推送端点。支持两种形态:
   * - Bark: https://api.day.app/<device-key> 或自建 https://bark.example.com/<key>
   * - ntfy: https://ntfy.sh/<topic> 或自建
   */
  url: string;
  /** 可选:点击通知跳回 App 的深链(默认 prospero://) */
  deepLink?: string;
  /** 静默期(毫秒):同一会话在此期间内不重复推送,默认 30s */
  throttleMs?: number;
}

export interface NotifyPayload {
  title: string;
  body: string;
  /** 点击后跳转的深链 */
  url?: string;
}

const DEFAULT_THROTTLE_MS = 30_000;

/** 便于测试注入 */
export type Poster = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

const defaultPoster: Poster = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { ok: res.ok, status: res.status };
};

export class Notifier {
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly config: NotifyConfig | null,
    private readonly post: Poster = defaultPoster,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.config !== null && this.config.url.length > 0;
  }

  /**
   * 推送一条待审批提醒。
   * @param key 去重键(通常是 sessionId),同键在静默期内只推一次
   * @returns 是否真的推了
   */
  async notifyPermission(
    key: string,
    session: Pick<SessionInfo, "title" | "agent">,
    action: string,
    detail: string,
  ): Promise<boolean> {
    if (!this.config) return false;
    const throttle = this.config.throttleMs ?? DEFAULT_THROTTLE_MS;
    const last = this.lastSentAt.get(key);
    const t = this.now();
    if (last !== undefined && t - last < throttle) return false;
    this.lastSentAt.set(key, t);

    return this.send({
      title: `${session.title} 需要批准`,
      // 只带动作与资源摘要,不带文件内容/命令输出
      body: detail.length > 0 ? `${action}: ${detail}` : action,
      url: this.config.deepLink ?? "prospero://",
    });
  }

  async send(payload: NotifyPayload): Promise<boolean> {
    const config = this.config;
    if (!config) return false;
    try {
      // Bark 与 ntfy 都接受 JSON body;字段名取两者的并集,各自忽略不认识的
      const res = await this.post(config.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: payload.title,
          body: payload.body,
          message: payload.body, // ntfy 用 message
          group: "Prospero",
          tags: ["warning"],
          level: "timeSensitive", // Bark:专注模式下也提醒
          ...(payload.url !== undefined ? { url: payload.url, click: payload.url } : {}),
        }),
      });
      if (!res.ok) {
        console.warn(`[prosperod] 推送失败 HTTP ${String(res.status)}`);
      }
      return res.ok;
    } catch (e) {
      console.warn(
        `[prosperod] 推送异常:${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  /** 会话结束/审批被处理后清掉节流记录,下次能立即推 */
  clear(key: string): void {
    this.lastSentAt.delete(key);
  }
}
