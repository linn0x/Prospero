import { describe, expect, it } from "vitest";
import { CollaborationService } from "../src/orchestration/collaboration.js";
import { orchestrationControlApi } from "../src/orchestration/control-api.js";
import { DispatchService, type WorkerSessionManager } from "../src/orchestration/dispatch.js";
import { OrchestrationStore } from "../src/orchestration/store.js";

const unusedSessions: WorkerSessionManager = {
  async create() { throw new Error("not used"); },
  async chatSend() { throw new Error("not used"); },
  requirePty() { throw new Error("not used"); },
  async kill() {},
};

describe("控制 API 的交付报告", () => {
  it("worker task.done 会唤醒协调者邮箱，而不是靠 session idle 猜完成", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "报告", coordinatorSessionId: "coord" });
    const task = store.createTask({ runId: run.id, title: "实现", spec: "" });
    store.createDispatch({ taskId: task.id, sessionId: "worker" });
    const mail = new CollaborationService(store);
    const api = orchestrationControlApi(store, new DispatchService(store, unusedSessions), mail);

    await api("task.done", {
      taskId: task.id,
      actorSessionId: "worker",
      body: "实现并验过",
    }, new AbortController().signal);
    // worker 的 CLI 可因连接重试再次上报；任务本身和协调者邮箱都应保持幂等。
    await api("task.done", {
      taskId: task.id,
      actorSessionId: "worker",
      body: "实现并验过",
    }, new AbortController().signal);

    const inbox = await mail.check({ recipient: "coord", runId: run.id });
    expect(inbox).toEqual([
      expect.objectContaining({
        type: "report",
        from: "worker",
        taskId: task.id,
        body: "实现并验过",
      }),
    ]);
  });

  it("协调者能用 gate API 暂停并重新开放任务", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "决策", coordinatorSessionId: "coord" });
    const task = store.createTask({ runId: run.id, title: "部署", spec: "" });
    const mail = new CollaborationService(store);
    const api = orchestrationControlApi(store, new DispatchService(store, unusedSessions), mail);

    const gate = await api("gate.create", {
      runId: run.id,
      taskId: task.id,
      question: "部署到哪里？",
      options: ["staging", "production"],
      actorSessionId: "coord",
    }, new AbortController().signal) as { id: string; status: string };
    expect(gate.status).toBe("pending");
    expect(store.getTask(task.id).status).toBe("blocked");

    await api("gate.resolve", {
      gateId: gate.id,
      decision: "staging",
      actorSessionId: "coord",
    }, new AbortController().signal);
    expect(store.getTask(task.id).status).toBe("pending");
  });
});
