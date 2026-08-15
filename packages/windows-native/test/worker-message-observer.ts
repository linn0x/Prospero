import type { Worker } from "node:worker_threads";

export type WorkerMessage = Record<string, unknown> & { type: string };

type PendingMessage = {
  readonly resolve: (message: WorkerMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

export type WorkerMessageObserver = {
  /**
   * Resolves with an already-buffered message too, so callers can install one
   * observer as soon as a Worker is created and safely await phases later.
   */
  waitFor(expected: string, timeoutMs?: number): Promise<WorkerMessage>;
};

function retainHandledRejection<T>(promise: Promise<T>): Promise<T> {
  // Startup promises are intentionally created before their prerequisite
  // handshake. Keep a worker failure from becoming an unhandled rejection in
  // the small interval before the test awaits its particular phase.
  void promise.catch(() => undefined);
  return promise;
}

function workerMessageFailure(message: WorkerMessage): Error {
  const phase = typeof message.phase === "string" ? ` at ${message.phase}` : "";
  const name = typeof message.name === "string" ? message.name : "WorkerMessageError";
  const detail = typeof message.message === "string" ? message.message : "worker reported an error";
  return new Error(`${name}: ${detail}${phase}`);
}

/**
 * Observe a Worker from construction onward, retaining messages that arrive
 * before their individual phase is awaited. Any message error, Worker error,
 * or Worker exit closes the observer exactly once and clears all listeners and
 * phase timers.
 */
export function observeWorkerMessages(worker: Worker): WorkerMessageObserver {
  const buffered = new Map<string, WorkerMessage[]>();
  const pending = new Map<string, Set<PendingMessage>>();
  let lastPhase = "worker-startup";
  let closedError: Error | undefined;
  let closed = false;

  const cleanup = () => {
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
  };

  const settlePending = (expected: string, message: WorkerMessage) => {
    const waiters = pending.get(expected);
    if (!waiters) return false;
    pending.delete(expected);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    }
    return true;
  };

  const close = (error: Error) => {
    if (closed) return;
    closed = true;
    closedError = error;
    cleanup();
    for (const waiters of pending.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }
    pending.clear();
    buffered.clear();
  };

  const onMessage = (value: unknown) => {
    if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return;
    const message = value as WorkerMessage;
    if (typeof message.phase === "string") lastPhase = message.phase;
    if (message.type === "error") {
      close(workerMessageFailure(message));
      return;
    }
    if (settlePending(message.type, message)) return;
    const messages = buffered.get(message.type);
    if (messages) messages.push(message);
    else buffered.set(message.type, [message]);
  };

  const onError = (error: Error) => close(error);
  const onExit = (code: number) => close(new Error(`Pipe worker exited before its expected phase (${code})`));

  worker.on("message", onMessage);
  worker.once("error", onError);
  worker.once("exit", onExit);

  return {
    waitFor(expected: string, timeoutMs = 10_000): Promise<WorkerMessage> {
      const messages = buffered.get(expected);
      const bufferedMessage = messages?.shift();
      if (bufferedMessage) {
        if (messages?.length === 0) buffered.delete(expected);
        return Promise.resolve(bufferedMessage);
      }
      if (closed) {
        return retainHandledRejection(Promise.reject(closedError ?? new Error("Pipe worker observer is closed")));
      }

      let resolve!: (message: WorkerMessage) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<WorkerMessage>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const waiter: PendingMessage = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const waiters = pending.get(expected);
          if (!waiters?.delete(waiter)) return;
          if (waiters.size === 0) pending.delete(expected);
          reject(new Error(`Timed out waiting for pipe worker ${expected} (last phase: ${lastPhase})`));
        }, timeoutMs),
      };
      const waiters = pending.get(expected);
      if (waiters) waiters.add(waiter);
      else pending.set(expected, new Set([waiter]));
      return retainHandledRejection(promise);
    },
  };
}
