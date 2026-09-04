import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Worker } from "node:worker_threads";
import createProjectionWorker from "./orchestration-projection-worker?nodeWorker";
import { legacyProjectionNeedsRefresh, legacyProjectionSourceMtime } from "./orchestration-projection";

type Result = {
  written?: boolean;
  retry?: boolean;
  error?: string;
};

const REFRESH_INTERVAL_MS = 5_000;

function modifiedAt(path: string): bigint | undefined {
  try {
    return statSync(path, { bigint: true }).mtimeNs;
  } catch {
    return undefined;
  }
}

function projectedSourceModifiedAt(path: string): bigint | undefined {
  let handle: number | undefined;
  try {
    handle = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(512);
    const length = readSync(handle, buffer, 0, buffer.length, 0);
    return legacyProjectionSourceMtime(buffer.toString("utf8", 0, length));
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

export class LegacyOrchestrationProjection {
  private worker: Worker | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private nextAttemptAt = 0;
  private failures = 0;

  constructor(
    private readonly home: string,
    private readonly onProjected: () => void,
    private readonly onError: (message: string) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate();
  }

  private backoff(): void {
    this.failures += 1;
    this.nextAttemptAt = Date.now() + Math.min(30_000, 500 * 2 ** this.failures);
  }

  private refresh(): void {
    if (this.worker || Date.now() < this.nextAttemptAt) return;
    const sourcePath = resolve(this.home, "orchestration.json");
    const targetPath = resolve(this.home, "orchestration-desktop.json");
    const sourceMtimeNs = modifiedAt(sourcePath);
    if (!legacyProjectionNeedsRefresh(sourceMtimeNs, modifiedAt(targetPath), projectedSourceModifiedAt(targetPath))) {
      this.failures = 0;
      this.nextAttemptAt = 0;
      return;
    }
    let worker: Worker;
    try {
      worker = createProjectionWorker({
        workerData: { sourcePath, targetPath, sourceMtimeNs },
      });
    } catch (error) {
      this.onError(error instanceof Error ? error.message : String(error));
      this.backoff();
      return;
    }
    this.worker = worker;
    let result: Result | undefined;
    worker.once("message", (value: Result) => {
      result = value;
      if (value.error) this.onError(value.error);
      if (value.written) this.onProjected();
    });
    worker.once("error", (error) => {
      result = { written: false, retry: true, error: error.message };
      this.onError(error.message);
    });
    worker.once("exit", () => {
      if (this.worker === worker) this.worker = undefined;
      if (result?.written || result?.retry !== true) {
        this.failures = 0;
        this.nextAttemptAt = 0;
      } else {
        this.backoff();
      }
    });
  }
}
