import type { C2SSessionCreate, S2CError, S2CSessionCreateResult, SessionInfo } from "@prospero/protocol";
import type { DeliveryResult } from "./outbound-queue";

export class SessionCreateError extends Error {
  constructor(message: string, readonly reason?: string) { super(message); this.name = "SessionCreateError"; }
}

export interface SessionCreateTask {
  requestId: string;
  delivery: DeliveryResult;
  completion: Promise<SessionInfo>;
  /** Stops waiting only. A request already sent to the computer is never replayed. */
  cancel(): void;
}

interface PendingCreate {
  request: C2SSessionCreate;
  correlated: boolean;
  baseline: Set<string>;
  candidates: Map<string, SessionInfo>;
  snapshots: Set<string>;
  finish(session?: SessionInfo, error?: SessionCreateError): void;
}

const comparablePath = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");

/** A creation is complete only after its own acknowledgement, never an arbitrary attached snapshot. */
export class SessionCreateTracker {
  private readonly pending = new Map<string, PendingCreate>();
  private legacyUncertain = false;

  begin(request: C2SSessionCreate & { requestId: string }, correlated: boolean, baseline: Iterable<string>, send: (message: C2SSessionCreate) => DeliveryResult): SessionCreateTask {
    const requestId = request.requestId;
    const ambiguous = (): SessionCreateError => new SessionCreateError("创建请求已发送；此前有未确认的请求，请从会话列表打开，避免重复新建。", "uncorrelated_create");
    if (!correlated && [...this.pending.values()].some((pending) => !pending.correlated)) {
      this.legacyUncertain = true;
      for (const pending of this.pending.values()) if (!pending.correlated) pending.finish(undefined, ambiguous());
    }
    let finish!: PendingCreate["finish"];
    const completion = new Promise<SessionInfo>((resolve, reject) => {
      const timer = setTimeout(() => finish(undefined, new SessionCreateError("等待创建结果超时；电脑可能已经创建会话，请先查看会话列表。", "timeout")), 45_000);
      finish = (session, error) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        if (!correlated && error && ["cancelled", "disconnected", "timeout", "transport_error"].includes(error.reason ?? "")) this.legacyUncertain = true;
        if (session) resolve(session);
        else reject(error ?? new SessionCreateError("已停止等待创建结果", "cancelled"));
      };
      this.pending.set(requestId, { request, correlated, baseline: new Set(baseline), candidates: new Map(), snapshots: new Set(), finish });
    });
    // The caller may inspect synchronous delivery before installing its handler.
    void completion.catch(() => {});
    const { requestId: _requestId, ...legacyRequest } = request;
    const delivery = send(correlated ? request : legacyRequest);
    if (!delivery.accepted) finish(undefined, new SessionCreateError(delivery.reason === "offline"
      ? "主机未连接，尚未发送创建请求。"
      : "创建请求的连接中断；电脑可能已收到，请先查看会话列表。", delivery.reason));
    else if (!correlated && this.legacyUncertain) finish(undefined, ambiguous());
    return { requestId, delivery, completion, cancel: () => finish(undefined, new SessionCreateError("已停止等待创建结果", "cancelled")) };
  }

  result(message: S2CSessionCreateResult): void {
    const pending = this.pending.get(message.requestId);
    if (!pending?.correlated) return;
    if (message.ok && message.session) pending.finish(message.session);
    else pending.finish(undefined, new SessionCreateError(message.error ?? "电脑未返回有效的创建结果", message.reason ?? message.code));
  }

  state(session: SessionInfo): void {
    for (const pending of this.pending.values()) {
      if (pending.correlated || pending.baseline.has(session.id)) continue;
      const request = pending.request;
      if (session.agent !== request.agent || (request.kind && session.kind !== request.kind) ||
          (request.accountId && session.accountId !== request.accountId) ||
          (request.cwd && comparablePath(session.cwd) !== comparablePath(request.cwd))) continue;
      pending.candidates.set(session.id, session);
      if (pending.snapshots.has(session.id)) pending.finish(session);
    }
  }

  snapshot(sid: string): void {
    for (const pending of this.pending.values()) {
      if (pending.correlated || pending.baseline.has(sid)) continue;
      pending.snapshots.add(sid);
      const session = pending.candidates.get(sid);
      if (session) pending.finish(session);
    }
  }

  legacyError(message: S2CError): void {
    if (message.sid !== undefined) return;
    // Unscoped filesystem/authorization errors must not terminate a creation.
    if (!["agent_unavailable", "shell_not_allowed", "bad_message"].includes(message.code) && message.reason !== "conversation_active_writer") return;
    for (const pending of this.pending.values()) {
      if (!pending.correlated) pending.finish(undefined, new SessionCreateError(message.message, message.reason ?? message.code));
    }
  }

  disconnect(): void {
    for (const pending of this.pending.values()) pending.finish(undefined, new SessionCreateError("连接已断开；电脑可能仍在创建会话，重新连接后请先查看列表。", "disconnected"));
  }
}
