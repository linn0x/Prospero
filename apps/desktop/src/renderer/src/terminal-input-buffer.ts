// Admission happens at the keyboard event. Once accepted, a batch belongs to
// that session even if focus changes before its short batching timer fires.
export class TerminalInputBuffer {
  private text = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly deliver: (value: string) => Promise<boolean>) {}
  append(value: string): void {
    if (!value) return;
    this.text += value;
    if (this.text.length >= 8192) { void this.flush(); return; }
    if (this.timer === undefined) this.timer = setTimeout(() => { void this.flush(); }, 4);
  }
  flush(): Promise<boolean> | undefined {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.text) return undefined;
    const text = this.text; this.text = "";
    return this.deliver(text);
  }
}

export class TerminalInputQueue {
  private tail = Promise.resolve();
  private count = 0;
  private bytes = 0;
  constructor(private readonly maxCount = 128, private readonly maxBytes = 1024 * 1024) {}
  enqueue<T>(run: () => Promise<T>, bytes = 0): Promise<T> {
    if (this.count >= this.maxCount || this.bytes + bytes > this.maxBytes) {
      return Promise.reject(new Error("终端输入队列已满，请等待当前输入发送完成"));
    }
    this.count++; this.bytes += bytes;
    const result = this.tail.then(run).finally(() => { this.count--; this.bytes -= bytes; });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
