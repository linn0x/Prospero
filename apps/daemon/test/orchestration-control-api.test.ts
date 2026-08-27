import { describe, expect, it, vi } from "vitest";
import { AutomationService } from "../src/orchestration/automation.js";
import { CollaborationService } from "../src/orchestration/collaboration.js";
import { orchestrationControlApi } from "../src/orchestration/control-api.js";
import { DispatchService, type WorkerSessionManager } from "../src/orchestration/dispatch.js";
import { OrchestrationStore } from "../src/orchestration/store.js";

const unusedSessions: WorkerSessionManager = {
  async create() { throw new Error("not used"); },
  async chatSend() { throw new Error("not used"); },
  requirePty() { throw new Error("not used"); },
  async kill() {},
  infoOf() { throw new Error("not used"); },
};

describe("控制 API 的交付报告", () => {
  it("task.create 将显式 Skill 保存为独立字段而不是只塞进 spec", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "多 Skill", coordinatorSessionId: "coord" });
    const api = orchestrationControlApi(
      store,
      new DispatchService(store, unusedSessions),
      new CollaborationService(store),
    );
    const task = await api("task.create", {
      runId: run.id,
      title: "路由探索",
      spec: "只读分析",
      skills: ["api-search", "psm-to-repo"],
      actorSessionId: "coord",
    }, new AbortController().signal) as { spec: string; skills: string[] };

    expect(task.spec).toBe("只读分析");
    expect(task.skills).toEqual(["api-search", "psm-to-repo"]);
  });

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

  it("gate.resolve 会唤醒自动执行，让已交付的 Run 在 run-level Gate 解开后收口", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "等待发布确认" });
    const task = store.createTask({ runId: run.id, title: "实现", spec: "完成实现" });
    const dispatch = store.createDispatch({ taskId: task.id, sessionId: "worker" });
    store.setTaskStatus(task.id, "done", "已验收");
    store.setDispatchState(dispatch.id, "succeeded", "已验收");
    store.setRunAutomation(run.id, {
      state: "running",
      agent: "codex",
      approvalPolicy: "standard",
      workspace: "current",
      cwd: "/tmp/project",
      workspacePath: "/tmp/project",
      branch: null,
      startedAt: 1,
      updatedAt: 1,
      lastError: null,
    });
    const gate = store.createGate({ runId: run.id, question: "是否发布？" });
    const workerDispatch = new DispatchService(store, unusedSessions);
    const automation = new AutomationService(store, workerDispatch);
    const api = orchestrationControlApi(store, workerDispatch, new CollaborationService(store), automation);

    await api("gate.resolve", {
      gateId: gate.id,
      decision: "发布",
      actorSessionId: null,
    }, new AbortController().signal);

    await vi.waitFor(() => expect(store.getRun(run.id)).toMatchObject({
      status: "completed",
      automation: { state: "completed", lastError: null },
    }));
  });

  it("只有协调者能显式完成自己的 Run", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "收口", coordinatorSessionId: "coord" });
    const api = orchestrationControlApi(
      store,
      new DispatchService(store, unusedSessions),
      new CollaborationService(store),
    );
    const signal = new AbortController().signal;

    await expect(api("run.complete", {
      runId: run.id,
      actorSessionId: "worker",
    }, signal)).rejects.toMatchObject({ code: "forbidden" });

    const completed = await api("run.complete", {
      runId: run.id,
      actorSessionId: "coord",
    }, signal) as { status: string };
    expect(completed.status).toBe("completed");
  });

  it("宿主可放弃没有活动 worker 的 Run，并保持操作幂等", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "停止目标", coordinatorSessionId: null });
    const task = store.createTask({ runId: run.id, title: "未开始", spec: "取消" });
    const api = orchestrationControlApi(
      store,
      new DispatchService(store, unusedSessions),
      new CollaborationService(store),
    );
    const params = {
      runId: run.id,
      operationId: "abandon-run",
      actorSessionId: null,
    };

    const abandoned = await api("run.abandon", params, new AbortController().signal) as {
      status: string;
    };
    expect(abandoned.status).toBe("abandoned");
    expect(store.getTask(task.id).status).toBe("cancelled");
    expect(await api("run.abandon", params, new AbortController().signal)).toEqual(abandoned);
  });
});

describe("控制 API 的幂等与任务图事务", () => {
  it("同一 operationId 的并发重试只创建一个 Run，不同参数会冲突", async () => {
    const store = new OrchestrationStore();
    const api = orchestrationControlApi(
      store,
      new DispatchService(store, unusedSessions),
      new CollaborationService(store),
    );
    const signal = new AbortController().signal;
    const [first, retry] = await Promise.all([
      api("run.create", { objective: "幂等", operationId: "op-run" }, signal),
      api("run.create", { objective: "幂等", operationId: "op-run" }, signal),
    ]) as Array<{ id: string }>;

    expect(first.id).toBe(retry.id);
    expect(store.listRuns()).toHaveLength(1);
    await expect(api(
      "run.create",
      { objective: "换了参数", operationId: "op-run" },
      signal,
    )).rejects.toMatchObject({ code: "operation_conflict" });
  });

  it("失败 Task 重试后以新的 worker.start operationId 可合法新派发", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "重新派发" });
    const task = store.createTask({ runId: run.id, title: "实现", spec: "" });
    let starts = 0;
    const sessions: WorkerSessionManager = {
      ...unusedSessions,
      async create(input) {
        starts += 1;
        return {
          id: `worker-${starts}`,
          agent: input.agent,
          kind: input.kind ?? "structured",
          title: "worker",
          cwd: input.cwd ?? "/tmp",
          status: "idle",
          createdAt: starts,
          cols: input.cols,
          rows: input.rows,
        };
      },
      async chatSend() {},
      async kill() {},
    };
    const api = orchestrationControlApi(store, new DispatchService(store, sessions), new CollaborationService(store));
    const signal = new AbortController().signal;
    const startParams = {
      taskId: task.id,
      agent: "codex",
      worktree: "none",
      cwd: "/tmp/project",
      actorSessionId: null,
    };

    const first = await api("worker.start", { ...startParams, operationId: "start-attempt-1" }, signal) as {
      session: { id: string };
    };
    await api("task.fail", {
      taskId: task.id,
      actorSessionId: first.session.id,
      body: "本次尝试失败",
    }, signal);
    await api("task.retry", {
      taskId: task.id,
      actorSessionId: null,
      operationId: "retry-task-1",
    }, signal);

    const second = await api("worker.start", { ...startParams, operationId: "start-attempt-2" }, signal) as {
      session: { id: string };
    };
    expect(second.session.id).not.toBe(first.session.id);
    expect(starts).toBe(2);
  });

  it("graph.create 一次提交整张图，重复提交返回同一组 id", async () => {
    const store = new OrchestrationStore();
    const api = orchestrationControlApi(
      store,
      new DispatchService(store, unusedSessions),
      new CollaborationService(store),
    );
    const params = {
      operationId: "op-graph",
      objective: "视觉编排",
      nodes: [
        { clientId: "a", title: "设计", spec: "定方案", deps: [] },
        { clientId: "b", title: "实现", spec: "写代码", deps: ["a"] },
      ],
    };
    const first = await api("graph.create", params, new AbortController().signal) as {
      run: { id: string };
      idMap: Record<string, string>;
    };
    const retry = await api("graph.create", params, new AbortController().signal) as typeof first;

    expect(retry).toEqual(first);
    expect(store.listRuns()).toHaveLength(1);
    expect(store.listTasks(first.run.id)).toHaveLength(2);
  });

  it("run.delete 可重试，删除后仍由 operation tombstone 返回首次结果", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "可删除" });
    store.createTask({ runId: run.id, title: "待办", spec: "待办" });
    const api = orchestrationControlApi(
      store,
      new DispatchService(store, unusedSessions),
      new CollaborationService(store),
    );
    const params = { runId: run.id, operationId: "delete-run", actorSessionId: null };

    const first = await api("run.delete", params, new AbortController().signal);
    const retry = await api("run.delete", params, new AbortController().signal);

    expect(retry).toEqual(first);
    expect(store.listRuns()).toEqual([]);
  });

  it("run.delete 拒绝仍活着的已交付 completed worker，避免随后 cleanup 失去 session 索引", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "保留 live settled worker" });
    const task = store.createTask({ runId: run.id, title: "实现", spec: "" });
    const dispatch = store.createDispatch({ taskId: task.id, sessionId: "live-worker" });
    store.setTaskStatus(task.id, "done", "已交付");
    store.setDispatchState(dispatch.id, "succeeded", "已交付");
    const sessions: WorkerSessionManager = {
      ...unusedSessions,
      infoOf() {
        return {
          id: "live-worker",
          agent: "codex",
          kind: "structured",
          title: "worker",
          cwd: "/tmp/live-worker",
          status: "completed",
          createdAt: 1,
          cols: 80,
          rows: 24,
        };
      },
    };
    const api = orchestrationControlApi(
      store,
      new DispatchService(store, sessions),
      new CollaborationService(store),
    );

    await expect(api("run.delete", {
      runId: run.id,
      operationId: "delete-live-settled",
      actorSessionId: null,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "worker_session_live" });
    expect(store.getRun(run.id).status).toBe("active");
  });

  it("普通 worker 不能删除宿主创建的手工 Run", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "宿主管理", coordinatorSessionId: null });
    const api = orchestrationControlApi(
      store,
      new DispatchService(store, unusedSessions),
      new CollaborationService(store),
    );

    await expect(api("run.delete", {
      runId: run.id,
      operationId: "worker-delete",
      actorSessionId: "worker",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "forbidden" });
    expect(store.getRun(run.id).id).toBe(run.id);
  });

  it("宿主可停止 worker、重试失败任务，再取消尚未执行的任务", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "生命周期", coordinatorSessionId: null });
    const task = store.createTask({ runId: run.id, title: "实现", spec: "" });
    store.createDispatch({ taskId: task.id, sessionId: "worker" });
    const killed: string[] = [];
    const sessions: WorkerSessionManager = {
      ...unusedSessions,
      async kill(sid) { killed.push(sid); },
    };
    const api = orchestrationControlApi(
      store,
      new DispatchService(store, sessions),
      new CollaborationService(store),
    );
    const signal = new AbortController().signal;

    const stopped = await api("worker.stop", {
      taskId: task.id,
      reason: "用户停止",
      operationId: "stop-worker",
      actorSessionId: null,
    }, signal) as { task: { status: string } };
    expect(stopped.task.status).toBe("failed");
    expect(killed).toEqual(["worker"]);
    expect(await api("worker.stop", {
      taskId: task.id,
      reason: "用户停止",
      operationId: "stop-worker",
      actorSessionId: null,
    }, signal)).toEqual(stopped);

    await api("task.retry", {
      taskId: task.id,
      operationId: "retry-task",
      actorSessionId: null,
    }, signal);
    expect(store.getTask(task.id)).toMatchObject({ status: "pending", result: null });

    await api("task.cancel", {
      taskId: task.id,
      reason: "不再需要",
      operationId: "cancel-task",
      actorSessionId: null,
    }, signal);
    expect(store.getTask(task.id)).toMatchObject({ status: "cancelled", result: "不再需要" });
  });
});
