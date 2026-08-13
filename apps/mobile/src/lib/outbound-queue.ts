/**
 * 一个用户操作被连接层接收后的明确结果。
 *
 * `queued` 也是已接收：它已在本机 FIFO 中保存，重连后会按原顺序发送。
 * `rejected` 则绝不代表“可能已经送达”，调用方必须保留草稿并让用户决定重试。
 */
export type DeliveryResult =
  | { accepted: true; disposition: "sent" | "queued" }
  | { accepted: false; reason: "offline" | "queue_full" | "transport_error" };

export const acceptedDelivery = (disposition: "sent" | "queued"): DeliveryResult => ({
  accepted: true,
  disposition,
});

export const rejectedDelivery = (
  reason: "offline" | "queue_full" | "transport_error",
): DeliveryResult => ({ accepted: false, reason });

export function deliveryFailureText(result: DeliveryResult): string {
  if (result.accepted) return "";
  switch (result.reason) {
    case "queue_full":
      return "本机离线队列已满；草稿和附件已保留，请恢复连接后重试。";
    case "transport_error":
      return "连接刚刚中断，内容没有自动重发；请确认后重试。";
    case "offline":
      return "主机未连接，内容没有发送；请恢复连接后重试。";
  }
}

/**
 * 小而刻意的 FIFO：断线时只保存明确允许补发的用户意图。
 *
 * 将容量和出队操作放在纯逻辑里，避免未来改连接代码时意外丢失满队列边界或 FIFO
 * 语义；连接断在 flush 中途时，`putBackFront` 会保留尚未确认写入的头部消息。
 */
export class BoundedQueue<T> {
  private values: T[] = [];

  constructor(readonly capacity: number) {}

  get length(): number {
    return this.values.length;
  }

  offer(value: T): boolean {
    if (this.values.length >= this.capacity) return false;
    this.values.push(value);
    return true;
  }

  take(): T | undefined {
    return this.values.shift();
  }

  putBackFront(value: T): void {
    this.values.unshift(value);
  }

  clear(): void {
    this.values = [];
  }
}
