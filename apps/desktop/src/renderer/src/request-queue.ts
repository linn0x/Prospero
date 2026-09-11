type Job = { signal: AbortSignal; abort: () => void; run: () => void };

export class RequestQueue {
  private active = 0;
  private readonly waiting: Job[] = [];

  constructor(private readonly concurrency = 4, private readonly capacity = 128) {}

  run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
    if (this.waiting.length >= this.capacity) return Promise.reject(new Error("分页队列已满，请重试"));
    return new Promise((resolve, reject) => {
      const job: Job = { signal, abort: () => {
        const index = this.waiting.indexOf(job);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new DOMException("Cancelled", "AbortError"));
      }, run: () => {
        signal.removeEventListener("abort", job.abort);
        this.active++;
        void Promise.resolve().then(operation).then(resolve, reject).finally(() => { this.active--; this.drain(); });
      } };
      signal.addEventListener("abort", job.abort, { once: true });
      this.waiting.push(job);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.waiting.length) this.waiting.shift()!.run();
  }
}
