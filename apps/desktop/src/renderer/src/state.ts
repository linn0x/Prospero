import { useEffect, useState } from "react";
import type { DesktopSnapshot } from "../../shared/types";

export function useDesktopSnapshot(): DesktopSnapshot | undefined {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  useEffect(() => {
    let active = true;
    void window.prospero.getSnapshot().then((next) => { if (active) setSnapshot(next); });
    const unsubscribe = window.prospero.subscribeSnapshot((next) => { if (active) setSnapshot(next); });
    return () => { active = false; unsubscribe(); };
  }, []);
  return snapshot;
}

export function displayError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*/, "");
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("\\") || path;
}

export function statusLabel(status: string): string {
  return ({
    running: "运行中", starting: "启动中", idle: "空闲", waiting_approval: "等待审批",
    waiting_input: "等待输入", completed: "已完成", done: "已完成", died: "已终止",
    pending: "待处理", ready: "可执行", dispatched: "已派发", blocked: "受阻", failed: "失败", cancelled: "已取消",
    active: "进行中", paused: "已暂停", abandoned: "已放弃", signed_in: "已登录", signed_out: "未登录",
    unavailable: "CLI 未安装", error: "错误", connected: "已连接", connecting: "连接中", disabled: "未启用", offline: "离线",
  } as Record<string, string>)[status] ?? (status || "未知");
}
