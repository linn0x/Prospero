/** A small, transport-agnostic first-success race with deterministic cleanup. */

export interface ManagedAttempt<T> {
  promise: Promise<T>;
  /** Must detach callbacks before closing its underlying transport. */
  abort(): void;
  label: string;
}

export class AllAttemptsFailed<Failure> extends Error {
  constructor(readonly failures: Failure[]) {
    super("all connection attempts failed");
  }
}

/**
 * Every promise gets a rejection handler before any can resolve, so late loser
 * failures cannot become unhandled rejections or overwrite the winning state.
 */
export function raceFirstSuccessful<T, Failure>(
  attempts: readonly ManagedAttempt<T>[],
): Promise<T> {
  if (attempts.length === 0) return Promise.reject(new AllAttemptsFailed<Failure>([]));

  return new Promise<T>((resolve, reject) => {
    let won = false;
    let remaining = attempts.length;
    const failures: Failure[] = [];

    for (const attempt of attempts) {
      void attempt.promise.then(
        (value) => {
          if (won) {
            // A simultaneous second success is also a loser.  Its owner did
            // not get aborted by the first winner yet, so detach it here too.
            try { attempt.abort(); } catch { /* best effort */ }
            return;
          }
          won = true;
          for (const other of attempts) {
            if (other === attempt) continue;
            try { other.abort(); } catch { /* best effort */ }
          }
          resolve(value);
        },
        (failure: Failure) => {
          if (won) return;
          failures.push(failure);
          remaining -= 1;
          if (remaining === 0) reject(new AllAttemptsFailed(failures));
        },
      );
    }
  });
}
