import type { SessionInfo } from "@prospero/protocol";

interface SessionCreationAttempt {
  completion: Promise<SessionInfo>;
  /** Stop observing the result; the remote create may already have completed. */
  cancel(): void;
}

/** Keep late create results from navigating after cancellation, blur or a newer attempt. */
export class PendingSessionCreation {
  private current: SessionCreationAttempt | null = null;

  get pending(): boolean { return this.current !== null; }

  track(
    attempt: SessionCreationAttempt,
    onCreated: (session: SessionInfo) => void,
    onError: (error: unknown) => void,
  ): void {
    this.cancel();
    this.current = attempt;
    void attempt.completion.then((session) => {
      if (this.current !== attempt) return;
      this.current = null;
      onCreated(session);
    }, (error: unknown) => {
      if (this.current !== attempt) return;
      this.current = null;
      onError(error);
    });
  }

  cancel(): boolean {
    const attempt = this.current;
    this.current = null;
    attempt?.cancel();
    return attempt !== null;
  }
}

/** A native sheet must finish dismissing before it can hand navigation to its screen. */
export class DismissedModalAction {
  private action: (() => void) | null = null;

  defer(action: () => void): void { this.action ??= action; }
  cancel(): void { this.action = null; }
  dismiss(): void {
    const action = this.action;
    this.action = null;
    action?.();
  }
}
