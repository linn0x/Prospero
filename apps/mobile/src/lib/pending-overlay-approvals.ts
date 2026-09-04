import type { AgentEventBody } from "@prospero/protocol";

export interface PendingOverlayApproval {
  hostId: string;
  sid: string;
  reqId: string;
  action: string;
  summary: string;
  resource: string;
  receivedAt: number;
}

export type PendingOverlayApprovalMap = ReadonlyMap<string, PendingOverlayApproval>;

export function overlayApprovalKey(hostId: string, sid: string, reqId: string): string {
  return `${hostId}\u0000${sid}\u0000${reqId}`;
}

function compactText(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

/**
 * 将会话事件折叠成悬浮窗可用的最小审批状态。这里只保留一行摘要和首个资源，
 * 不把 diff 或完整命令历史复制到系统级窗口。
 */
export function applyOverlayApprovalEvents(
  current: PendingOverlayApprovalMap,
  hostId: string,
  sid: string,
  events: readonly AgentEventBody[],
  resetSession = false,
  now = Date.now(),
): Map<string, PendingOverlayApproval> {
  const next = new Map(current);
  if (resetSession) {
    for (const [key, approval] of next) {
      if (approval.hostId === hostId && approval.sid === sid) next.delete(key);
    }
  }

  for (const event of events) {
    if (event.kind === "permission.request") {
      const key = overlayApprovalKey(hostId, sid, event.reqId);
      next.set(key, {
        hostId,
        sid,
        reqId: event.reqId,
        action: compactText(event.action, 80),
        summary: compactText(event.summary || event.action, 180),
        resource: compactText(event.resources[0] ?? "", 260),
        receivedAt: now,
      });
    } else if (event.kind === "permission.resolved" || event.kind === "permission.auto") {
      next.delete(overlayApprovalKey(hostId, sid, event.reqId));
    }
  }
  return next;
}

export function removeOverlayApproval(
  current: PendingOverlayApprovalMap,
  hostId: string,
  sid: string,
  reqId: string,
): Map<string, PendingOverlayApproval> {
  const next = new Map(current);
  next.delete(overlayApprovalKey(hostId, sid, reqId));
  return next;
}
