import type { OperationView } from "@prospero/protocol/rust-daemon";

export async function waitForOperation(
  operationId: string,
  read: (operationId: string) => Promise<OperationView>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ operationId: string; operation: OperationView | null; waitTimedOut: boolean }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid operation wait timeout");
  const deadline = Date.now() + timeoutMs;
  let operation: OperationView | null = null;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const expired = Symbol("wait expired");
    const response = await new Promise<OperationView | typeof expired>((resolve, reject) => {
      const aborted = (): void => { clearTimeout(timer); reject(signal?.reason ?? new Error("等待已取消")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(expired); }, Math.max(0, deadline - Date.now()));
      signal?.addEventListener("abort", aborted, { once: true });
      read(operationId).then(value => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); resolve(value); }, error => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(new Error(`Operation ${operationId} remains queryable; waiting failed`, { cause: error })); });
    });
    if (response === expired) break;
    operation = response;
    if (["SUCCEEDED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(operation.state)) {
      return { operationId, operation, waitTimedOut: false };
    }
    const delay = Math.min(Math.max(50, operation.retryAfterMs ?? 500), 2_000, Math.max(0, deadline - Date.now()));
    await new Promise<void>((resolve, reject) => {
      const aborted = (): void => { clearTimeout(timer); reject(signal?.reason ?? new Error("等待已取消")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, delay);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
  return { operationId, operation, waitTimedOut: true };
}
