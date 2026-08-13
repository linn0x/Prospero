import type { ConnStatus } from "./store";

export interface SessionLoadState {
  title: string;
  detail: string;
  retryLabel: string;
  showSpinner: boolean;
}

/** 冷启动深链的早期状态，不能把“尚未取到会话”误报成连接失败。 */
export function sessionLoadState(
  status: ConnStatus,
  lastError: string | null,
): SessionLoadState {
  if (status === "failed") {
    return {
      title: "无法连接到主机",
      detail: lastError ?? "连接失败，请检查 Mac 是否在线后重试。",
      retryLabel: "重试连接",
      showSpinner: false,
    };
  }
  if (status === "connected") {
    return {
      title: "会话尚未取得",
      detail: "已连接到主机，正在取得此会话。此链接会保留并在会话可用后继续打开。",
      retryLabel: "重新读取",
      showSpinner: true,
    };
  }
  return {
    title: "正在连接到主机",
    detail: status === "reconnecting" ? "连接已中断，正在恢复…" : "正在建立安全连接…",
    retryLabel: "重新尝试",
    showSpinner: true,
  };
}
