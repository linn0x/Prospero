import type { SessionInfo } from "@prospero/protocol";
import { describe, expect, it } from "vitest";
import {
  DispatchError,
  DispatchService,
  type WorkerSessionManager,
} from "../src/orchestration/dispatch.js";
import { OrchestrationStore } from "../src/orchestration/store.js";
import type { CreateSessionInput } from "../src/session-manager.js";

class FakeSessions implements WorkerSessionManager {
  readonly creates: CreateSessionInput[] = [];
  readonly messages: Array<{ sid: string; text: string }> = [];
  killed: string[] = [];

  async create(input: CreateSessionInput): Promise<SessionInfo> {
    this.creates.push(input);
    return {
      id: "worker-session",
      agent: input.agent,
      kind: input.kind ?? "structured",
      title: "worker",
      cwd: input.cwd ?? "/tmp",
      status: "idle",
      createdAt: Date.now(),
      cols: input.cols,
      rows: input.rows,
    };
  }

  async chatSend(sid: string, text: string): Promise<void> {
    this.messages.push({ sid, text });
  }

  requirePty(): { writeInput(text: string): void } {
    return { writeInput: () => {} };
  }

  async kill(sid: string): Promise<void> {
    this.killed.push(sid);
  }
}

describe("DispatchService", () => {
  it("只派发 ready task，并在发送前导词前先建立可交付的 dispatch", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "派发测试", coordinatorSessionId: "coord" });
    const task = store.createTask({ runId: run.id, title: "实现 M2", spec: "写代码并测试" });
    const sessions = new FakeSessions();
    const service = new DispatchService(store, sessions);

    const started = await service.startWorker({
      taskId: task.id,
      agent: "codex",
      worktree: "none",
      cwd: "/tmp/project",
    });

    expect(started.dispatch.state).toBe("running");
    expect(store.getTask(task.id).status).toBe("dispatched");
    expect(sessions.creates[0]).toMatchObject({ agent: "codex", cwd: "/tmp/project", allowShell: true });
    expect(sessions.messages[0]?.text).toContain(`prospero --session worker-session task done --id ${task.id}`);

    service.completeTask(task.id, "worker-session", "已完成并验过");
    expect(store.getTask(task.id)).toMatchObject({ status: "done", result: "已完成并验过" });
    expect(store.getDispatch(started.dispatch.id)).toMatchObject({ state: "succeeded", outcome: "已完成并验过" });
  });

  it("依赖未完成时不会创建会话；错误的 worker 也不能交付", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "依赖测试" });
    const first = store.createTask({ runId: run.id, title: "前置", spec: "" });
    const dependent = store.createTask({ runId: run.id, title: "后置", spec: "", deps: [first.id] });
    const sessions = new FakeSessions();
    const service = new DispatchService(store, sessions);

    await expect(service.startWorker({
      taskId: dependent.id, agent: "codex", worktree: "none", cwd: "/tmp/project",
    })).rejects.toMatchObject({ code: "task_not_ready" } satisfies Partial<DispatchError>);
    expect(sessions.creates).toHaveLength(0);

    const started = await service.startWorker({
      taskId: first.id, agent: "codex", worktree: "none", cwd: "/tmp/project",
    });
    expect(() => service.completeTask(first.id, "other-worker", "伪造交付"))
      .toThrow(/另一个 worker/);
    expect(store.getDispatch(started.dispatch.id).state).toBe("running");
  });

  it("停止 worker 会终止会话、放弃本次派发并让任务进入可重试的 failed", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "停止测试" });
    const task = store.createTask({ runId: run.id, title: "长任务", spec: "" });
    const sessions = new FakeSessions();
    const service = new DispatchService(store, sessions);
    const started = await service.startWorker({
      taskId: task.id,
      agent: "codex",
      worktree: "none",
      cwd: "/tmp/project",
    });

    const stopped = await service.stopWorker(task.id, "用户主动停止");
    expect(sessions.killed).toEqual([started.session.id]);
    expect(stopped.dispatch).toMatchObject({ state: "abandoned", outcome: "用户主动停止" });
    expect(stopped.task).toMatchObject({ status: "failed", result: "用户主动停止" });
    await expect(service.stopWorker(task.id)).rejects.toMatchObject({ code: "worker_not_active" });
  });

  it("worker 未交付就自然退出时会自动收尾，不再永久显示 running", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "退出收尾" });
    const task = store.createTask({ runId: run.id, title: "会退出", spec: "" });
    const sessions = new FakeSessions();
    const service = new DispatchService(store, sessions);
    const started = await service.startWorker({
      taskId: task.id,
      agent: "codex",
      worktree: "none",
      cwd: "/tmp/project",
    });

    expect(service.settleEndedSession(started.session.id, "worker 会话意外退出")).toMatchObject({
      task: { status: "failed" },
      dispatch: { state: "abandoned" },
    });
    expect(service.settleEndedSession(started.session.id, "重复事件")).toBeNull();
  });
});
