export type NativeTerminalOperation =
  | { kind: "input"; bytes: Uint8Array }
  | { kind: "resize"; columns: number; rows: number };

type Waiter = { resolve: () => void; reject: (error: Error) => void };
type Entry = { operation: NativeTerminalOperation; waiters: Waiter[]; settled: boolean };

const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_QUEUED_OPERATIONS = 128;
const DEFAULT_MAX_QUEUED_WAITERS = 1024;
const MAX_INPUT_FRAME_BYTES = 8192;

/** Serializes native-stream input and resize requests to the daemon. */
export class NativeTerminalOperationQueue {
  private readonly pending: Entry[] = [];
  private inputBytes = 0;
  private waiterCount = 0;
  private running = false;
  private closedError: Error | undefined;
  private activeEntry: Entry | undefined;

  constructor(
    private readonly execute: (operation: NativeTerminalOperation) => Promise<void>,
    private readonly maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
    private readonly maxQueuedOperations = DEFAULT_MAX_QUEUED_OPERATIONS,
    private readonly maxQueuedWaiters = DEFAULT_MAX_QUEUED_WAITERS,
  ) {}

  enqueueInput(value: Uint8Array): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (value.byteLength < 1 || value.byteLength > MAX_INPUT_FRAME_BYTES) return Promise.reject(new Error("Invalid native terminal input size"));
    if (this.inputBytes + value.byteLength > this.maxInputBytes) {
      return Promise.reject(new Error("Native terminal operation queue is full"));
    }

    const last = this.pending.at(-1);
    if (last?.operation.kind === "input" && last.operation.bytes.byteLength + value.byteLength <= MAX_INPUT_FRAME_BYTES) {
      if (this.waiterCount >= this.maxQueuedWaiters) return Promise.reject(new Error("Native terminal operation queue is full"));
      const merged = new Uint8Array(last.operation.bytes.byteLength + value.byteLength);
      merged.set(last.operation.bytes);
      merged.set(value, last.operation.bytes.byteLength);
      last.operation.bytes = merged;
      this.inputBytes += value.byteLength;
      return this.addWaiter(last);
    }
    if (this.pending.length >= this.maxQueuedOperations || this.waiterCount >= this.maxQueuedWaiters) {
      return Promise.reject(new Error("Native terminal operation queue is full"));
    }
    this.inputBytes += value.byteLength;
    return this.enqueue({ kind: "input", bytes: value.slice() });
  }

  enqueueResize(columns: number, rows: number): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (!Number.isInteger(columns) || columns < 20 || columns > 500 || !Number.isInteger(rows) || rows < 5 || rows > 300) {
      return Promise.reject(new Error("Invalid native terminal resize"));
    }
    const last = this.pending.at(-1);
    if (last?.operation.kind === "resize") {
      if (this.waiterCount >= this.maxQueuedWaiters) return Promise.reject(new Error("Native terminal operation queue is full"));
      last.operation.columns = columns;
      last.operation.rows = rows;
      return this.addWaiter(last);
    }
    if (this.pending.length >= this.maxQueuedOperations || this.waiterCount >= this.maxQueuedWaiters) return Promise.reject(new Error("Native terminal operation queue is full"));
    return this.enqueue({ kind: "resize", columns, rows });
  }

  /** A daemon Resize frame makes queued resize requests obsolete. */
  cancelPendingResizes(): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const entry = this.pending[index]!;
      if (entry.operation.kind !== "resize") continue;
      this.pending.splice(index, 1);
      this.settle(entry);
    }
  }

  close(reason = new Error("Native terminal operation queue is closed")): void {
    if (this.closedError) return;
    this.closedError = reason;
    for (const entry of this.pending.splice(0)) this.settle(entry, reason);
    if (this.activeEntry) this.settle(this.activeEntry, reason);
  }

  private enqueue(operation: NativeTerminalOperation): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiterCount += 1;
      this.pending.push({ operation, waiters: [{ resolve, reject }], settled: false });
      this.drain();
    });
  }

  private addWaiter(entry: Entry): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiterCount += 1;
      entry.waiters.push({ resolve, reject });
    });
  }

  private drain(): void {
    if (this.running || this.closedError) return;
    const entry = this.pending.shift();
    if (!entry) return;
    this.running = true;
    this.activeEntry = entry;
    let result: Promise<void>;
    try { result = Promise.resolve(this.execute(entry.operation)); }
    catch (cause) { result = Promise.reject(cause); }
    void result.then(
      () => this.settle(entry),
      (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.settle(entry, error);
      },
    ).finally(() => {
      if (this.activeEntry === entry) this.activeEntry = undefined;
      this.running = false;
      this.drain();
    });
  }

  private settle(entry: Entry, error?: Error): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.operation.kind === "input") this.inputBytes = Math.max(0, this.inputBytes - entry.operation.bytes.byteLength);
    this.waiterCount = Math.max(0, this.waiterCount - entry.waiters.length);
    const waiters = entry.waiters.splice(0);
    for (const waiter of waiters) error ? waiter.reject(error) : waiter.resolve();
  }
}
