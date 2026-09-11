export class RequestRegistry {
  private readonly controllers = new Map<string, AbortController>();

  async run<T>(key: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.controllers.has(key)) throw new Error("分页请求标识重复");
    if (this.controllers.size >= 32) throw new Error("分页请求繁忙，请稍后重试");
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const timer = setTimeout(() => controller.abort(), 8000);
    try { return await operation(controller.signal); }
    finally { clearTimeout(timer); this.controllers.delete(key); }
  }

  cancel(key: string): void { this.controllers.get(key)?.abort(); }
  cancelAll(): void { for (const controller of this.controllers.values()) controller.abort(); }
}
