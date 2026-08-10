import { describe, expect, it } from "vitest";
import { CollaborationService } from "../src/orchestration/collaboration.js";
import { OrchestrationStore } from "../src/orchestration/store.js";

function setup(): { store: OrchestrationStore; mail: CollaborationService; runId: string } {
  const store = new OrchestrationStore();
  const run = store.createRun({ objective: "协作测试", coordinatorSessionId: "coord" });
  return { store, mail: new CollaborationService(store), runId: run.id };
}

describe("协作邮箱", () => {
  it("check --wait 直到新消息到达，返回后一次性标记已读", async () => {
    const { store, mail, runId } = setup();
    const waiting = mail.check({ recipient: "coord", runId, wait: true });
    mail.send({
      runId,
      from: "worker-other",
      to: "someone-else",
      type: "note",
      subject: "无关消息",
      body: "不能取消 coord 的等待",
    });
    const message = mail.send({
      runId,
      from: "worker-1",
      to: "coord",
      type: "report",
      subject: "完成",
      body: "测试已过",
    });

    await expect(waiting).resolves.toEqual([expect.objectContaining({ id: message.id })]);
    expect(store.getMessage(message.id).readAt).not.toBeNull();
  });

  it("ask 通过 threadId 阻塞到 reply，并让 ask 的 answeredAt 只落一次", async () => {
    const { store, mail, runId } = setup();
    const asking = mail.ask({
      runId,
      from: "worker-1",
      to: "coord",
      subject: "选哪个方案？",
      body: "A 或 B",
    });
    const ask = store.listMessages(runId)[0]!;
    expect(ask.type).toBe("ask");
    expect(ask.threadId).not.toBeNull();

    const reply = mail.reply({
      runId,
      from: "coord",
      to: "worker-1",
      threadId: ask.threadId!,
      subject: "选择 B",
      body: "按 B 做",
    });
    await expect(asking).resolves.toMatchObject({ ask: { id: ask.id }, reply: { id: reply.id } });
    expect(store.getMessage(reply.id).readAt).not.toBeNull();
    const answeredAt = store.getMessage(ask.id).answeredAt;
    store.markAnswered(ask.id);
    expect(store.getMessage(ask.id).answeredAt).toBe(answeredAt);
  });

  it("client 断开会取消长等待，不留下无限期 waiter", async () => {
    const { mail, runId } = setup();
    const controller = new AbortController();
    const waiting = mail.check({ recipient: "coord", runId, wait: true, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "wait_aborted" });
  });

  it("reply 只能由原收件人回给原提问者", () => {
    const { mail, runId } = setup();
    const ask = mail.send({
      runId, from: "worker-1", to: "coord", type: "ask", subject: "问", body: "",
      threadId: "thread_one",
    });
    expect(() => mail.reply({
      runId, from: "coord", to: "someone-else", threadId: ask.threadId!, subject: "答", body: "",
    })).toThrow(/原提问者/);
  });
});
