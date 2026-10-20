/** Coalesce input bursts and ignore responses after the query is superseded.
 * The underlying IPC request cannot be aborted once dispatched. */
export function scheduleDeferredRequest<T>(
  request: () => Promise<T>,
  callbacks: { success: (value: T) => void; error: (reason: unknown) => void; settled: () => void },
  delay = 150,
): () => void {
  let cancelled = false;
  const timer = setTimeout(() => {
    void Promise.resolve().then(request).then(
      value => { if (!cancelled) callbacks.success(value); },
      reason => { if (!cancelled) callbacks.error(reason); },
    ).finally(() => { if (!cancelled) callbacks.settled(); });
  }, delay);
  return () => { cancelled = true; clearTimeout(timer); };
}
