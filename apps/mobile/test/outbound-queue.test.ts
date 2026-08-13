import { describe, expect, it } from "vitest";
import {
  BoundedQueue,
  acceptedDelivery,
  deliveryFailureText,
  rejectedDelivery,
} from "../src/lib/outbound-queue";

describe("离线投递 FIFO", () => {
  it("在容量边界明确拒绝第 N+1 条，不覆盖已接受的消息", () => {
    const queue = new BoundedQueue<string>(2);

    expect(queue.offer("first")).toBe(true);
    expect(queue.offer("second")).toBe(true);
    expect(queue.offer("third")).toBe(false);
    expect(queue.length).toBe(2);
    expect(queue.take()).toBe("first");
    expect(queue.take()).toBe("second");
    expect(queue.take()).toBeUndefined();
  });

  it("flush 中断时把未确认的头部放回，重连后仍按原始顺序发送", () => {
    const queue = new BoundedQueue<string>(3);
    queue.offer("first");
    queue.offer("second");
    queue.offer("third");

    const interrupted = queue.take();
    expect(interrupted).toBe("first");
    queue.putBackFront(interrupted!);

    expect([queue.take(), queue.take(), queue.take()]).toEqual(["first", "second", "third"]);
  });

  it("接受结果区分已发送、已排队和未接收", () => {
    expect(acceptedDelivery("sent")).toEqual({ accepted: true, disposition: "sent" });
    expect(acceptedDelivery("queued")).toEqual({ accepted: true, disposition: "queued" });
    const rejected = rejectedDelivery("queue_full");
    expect(rejected).toEqual({ accepted: false, reason: "queue_full" });
    expect(deliveryFailureText(rejected)).toContain("草稿和附件已保留");
  });
});
