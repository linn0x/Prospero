import { describe, expect, it, vi } from "vitest";
import type {
  AgentEventBody,
  Attachment,
  PermissionReply,
} from "@prospero/protocol";
import type { AdapterContext, AgentAdapter } from "../src/adapters/types.js";
import { StructuredSession } from "../src/structured-session.js";

class QueueAdapter implements AgentAdapter {
  private ctx: AdapterContext | null = null;
  readonly sends: string[] = [];
  readonly steers: string[] = [];
  steerResult = true;
  interrupts = 0;

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
  }

  async send(text: string, _attachments?: Attachment[]): Promise<void> {
    this.sends.push(text);
  }

  async steer(text: string): Promise<boolean> {
    this.steers.push(text);
    return this.steerResult;
  }

  finish(id: string): void {
    this.ctx?.emit({ kind: "turn.end", msgId: id, finish: "done" });
  }

  async respondPermission(_reqId: string, _reply: PermissionReply): Promise<void> {}
  async interrupt(): Promise<void> {
    this.interrupts++;
  }
  async dispose(): Promise<void> {}
}

function makeSession(adapter: QueueAdapter, restored?: ReturnType<StructuredSession["persistentState"]>) {
  return new StructuredSession({
    id: "queue-test",
    agent: "codex",
    title: "codex · queue",
    cwd: "/tmp",
    adapter,
    ...(restored ? { restored } : {}),
  });
}

describe("结构化会话消息队列", () => {
  it("明确区分首次就绪、运行中与一轮运行完毕，完成态仍可继续发送", async () => {
    const adapter = new QueueAdapter();
    const session = makeSession(adapter);
    await session.start();
    expect(session.info().status).toBe("idle");

    await session.send("第一轮");
    expect(session.info().status).toBe("running");
    adapter.finish("turn-1");
    await vi.waitFor(() => expect(session.info().status).toBe("completed"));

    await session.send("第二轮");
    expect(adapter.sends).toEqual(["第一轮", "第二轮"]);
    expect(session.info().status).toBe("running");
    await session.dispose();
  });

  it("忙碌时按 FIFO 排队，并在每轮结束后只发送下一条", async () => {
    const adapter = new QueueAdapter();
    const session = makeSession(adapter);
    await session.start();

    await session.send("第一条");
    await session.send("第二条");
    await session.send("第三条", undefined, "queue");

    expect(adapter.sends).toEqual(["第一条"]);
    expect(session.info().messageQueue?.map((item) => item.text)).toEqual(["第二条", "第三条"]);

    adapter.finish("turn-1");
    await vi.waitFor(() => expect(adapter.sends).toEqual(["第一条", "第二条"]));
    expect(session.info().messageQueue?.map((item) => item.text)).toEqual(["第三条"]);

    adapter.finish("turn-2");
    await vi.waitFor(() => expect(adapter.sends).toEqual(["第一条", "第二条", "第三条"]));
    expect(session.info().messageQueue).toEqual([]);
    await session.dispose();
  });

  it("引导优先同轮 steer；不支持时安全降级到队首", async () => {
    const adapter = new QueueAdapter();
    const events: AgentEventBody[] = [];
    const session = makeSession(adapter);
    session.on("event", (event) => events.push(event));
    await session.start();
    await session.send("开始");

    await session.send("先检查数据库", undefined, "steer");
    expect(adapter.steers).toEqual(["先检查数据库"]);
    expect(session.info().messageQueue).toEqual([]);
    expect(events.filter((event) => event.kind === "user.message")).toHaveLength(2);

    await session.send("普通排队");
    adapter.steerResult = false;
    await session.send("无法 steer 的引导", undefined, "steer");
    expect(session.info().messageQueue?.map((item) => [item.kind, item.text])).toEqual([
      ["guide", "无法 steer 的引导"],
      ["queue", "普通排队"],
    ]);
    await session.dispose();
  });

  it("可取消队列项，且队列随会话状态持久化恢复", async () => {
    const adapter = new QueueAdapter();
    const first = makeSession(adapter);
    await first.start();
    await first.send("运行中");
    await first.send("保留");
    await first.send("删除");

    const removeId = first.info().messageQueue?.[1]?.id;
    expect(removeId).toBeTruthy();
    expect(first.removeQueued(removeId!)).toBe(true);
    expect(first.info().messageQueue?.map((item) => item.text)).toEqual(["保留"]);
    const persisted = first.persistentState();
    await first.dispose();

    const restoredAdapter = new QueueAdapter();
    const restored = makeSession(restoredAdapter, persisted);
    await restored.start();
    expect(restoredAdapter.sends).toEqual(["保留"]);
    expect(restored.info().messageQueue).toEqual([]);
    await restored.dispose();
  });

  it("已排队消息可升级为引导；失败时移到队首且不丢失", async () => {
    const adapter = new QueueAdapter();
    const session = makeSession(adapter);
    await session.start();
    await session.send("运行中");
    await session.send("普通排队");
    await session.send("改成引导");

    const guideId = session.info().messageQueue?.[1]?.id;
    expect(await session.guideQueued(guideId!)).toBe(true);
    expect(adapter.steers).toEqual(["改成引导"]);
    expect(session.info().messageQueue?.map((item) => item.text)).toEqual(["普通排队"]);

    await session.send("第二条普通排队");
    adapter.steerResult = false;
    const fallbackId = session.info().messageQueue?.[1]?.id;
    expect(await session.guideQueued(fallbackId!)).toBe(false);
    expect(session.info().messageQueue?.map((item) => [item.kind, item.text])).toEqual([
      ["guide", "第二条普通排队"],
      ["queue", "普通排队"],
    ]);
    await session.dispose();
  });

  it("中断会话委托给对应 agent adapter", async () => {
    const adapter = new QueueAdapter();
    const session = makeSession(adapter);
    await session.start();
    await session.send("长任务");
    await session.interrupt();
    expect(adapter.interrupts).toBe(1);
    await session.dispose();
  });
});
