import type { S2CError, SessionInfo } from "@prospero/protocol";
import { deliveryFailureText, type DeliveryResult } from "./outbound-queue";
import { isTerminalEnded } from "./terminal-session";

interface PendingClose {
  completion: Promise<void>;
  allowMissing: boolean;
  finish(error?: Error): void;
}

/** Closing means the remote PTY exited; writing Ctrl+C or sending a request is not an acknowledgement. */
export class TerminalCloseTracker {
  private pending = new Map<string, PendingClose>();

  begin(sid: string, send: () => DeliveryResult, { timeoutMs = 10_000, allowMissing = false }: { timeoutMs?: number; allowMissing?: boolean } = {}): Promise<void> {
    const existing = this.pending.get(sid);
    if (existing) return existing.completion;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    const pending: PendingClose = {
      completion,
      allowMissing,
      finish: (error) => {
        if (this.pending.get(sid) !== pending) return;
        this.pending.delete(sid);
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      },
    };
    const timer = setTimeout(() => pending.finish(new Error("尚未收到终端结束确认，请检查连接和终端状态后重试。")), timeoutMs);
    // Register first: a synchronous acknowledgement must not be lost.
    this.pending.set(sid, pending);
    try {
      const delivery = send();
      if (!delivery.accepted) pending.finish(new Error(deliveryFailureText(delivery)));
      else if (delivery.disposition !== "sent") pending.finish(new Error("关闭终端不能离线排队，请恢复连接后重试。"));
    } catch (error) {
      pending.finish(error instanceof Error ? error : new Error(String(error)));
    }
    return completion;
  }

  state(session: SessionInfo): void {
    if (isTerminalEnded(session)) this.pending.get(session.id)?.finish();
  }

  error(message: S2CError): boolean {
    let pending = message.sid ? this.pending.get(message.sid) : undefined;
    // Existing daemons omit sid when SessionManager throws. An already closed
    // PTY produces this exact message; match the full ID, never just the only
    // pending request or a substring that could refer to another session.
    if (message.sid === undefined && message.code === "session_not_found") {
      for (const [sid, candidate] of this.pending) {
        if (candidate.allowMissing && message.message === `no such session: ${sid}`) {
          pending = candidate;
          break;
        }
      }
    }
    if (!pending) return false;
    pending.finish(pending.allowMissing && message.code === "session_not_found" ? undefined : new Error(message.message));
    return true;
  }

  disconnect(): void {
    for (const pending of this.pending.values()) {
      pending.finish(new Error("连接已断开，未能确认终端是否关闭；重连后请查看终端状态。"));
    }
  }
}
