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
  readonly killOptions: Array<{ preserveHistory?: boolean } | undefined> = [];
  readonly live = new Map<string, SessionInfo>();
  killError: Error | null = null;
  createBarrier: Promise<void> | null = null;

  async create(input: CreateSessionInput): Promise<SessionInfo> {
    this.creates.push(input);
    if (this.createBarrier) await this.createBarrier;
    const session: SessionInfo = {
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
    this.live.set(session.id, session);
    return session;
  }

  async chatSend(sid: string, text: string): Promise<void> {
    this.messages.push({ sid, text });
  }

  requirePty(): { writeInput(text: string): void } {
    return { writeInput: () => {} };
  }

  async kill(sid: string, options?: { preserveHistory?: boolean }): Promise<void> {
    this.killed.push(sid);
    this.killOptions.push(options);
    if (this.killError) throw this.killError;
    this.live.delete(sid);
  }

  infoOf(sid: string): SessionInfo {
    const session = this.live.get(sid);
    if (!session) throw new Error(`no such session: ${sid}`);
    return session;
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

    await service.completeTask(task.id, "worker-session", "已完成并验过");
    expect(store.getTask(task.id)).toMatchObject({ status: "done", result: "已完成并验过" });
    expect(store.getDispatch(started.dispatch.id)).toMatchObject({ state: "succeeded", outcome: "已完成并验过" });
    expect(sessions.killed).toEqual(["worker-session"]);
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
    await expect(service.completeTask(first.id, "other-worker", "伪造交付"))
      .rejects.toThrow(/另一个 worker/);
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

  it("done/fail 先持久交付再 kill；kill 失败与重复终态事件都不回滚交付", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "终态收口" });
    const doneTask = store.createTask({ runId: run.id, title: "完成", spec: "" });
    const failedTask = store.createTask({ runId: run.id, title: "失败", spec: "" });
    const sessions = new FakeSessions();
    sessions.killError = new Error("adapter disconnect");
    const service = new DispatchService(store, sessions);

    const done = await service.startWorker({
      taskId: doneTask.id, agent: "codex", worktree: "none", cwd: "/tmp/done-worker",
    });
    await service.completeTask(doneTask.id, done.session.id, "已交付");
    await service.completeTask(doneTask.id, done.session.id, "重放不得覆盖");
    expect(store.getTask(doneTask.id)).toMatchObject({ status: "done", result: "已交付" });
    expect(store.getDispatch(done.dispatch.id)).toMatchObject({ state: "succeeded", outcome: "已交付" });

    const failed = await service.startWorker({
      taskId: failedTask.id, agent: "codex", worktree: "none", cwd: "/tmp/fail-worker",
    });
    await service.failTask(failedTask.id, failed.session.id, "测试失败");
    await service.failTask(failedTask.id, failed.session.id, "重放不得覆盖");
    expect(store.getTask(failedTask.id)).toMatchObject({ status: "failed", result: "测试失败" });
    expect(store.getDispatch(failed.dispatch.id)).toMatchObject({ state: "failed", outcome: "测试失败" });
    // 两个首次交付与各自一次重放都尽力 kill；失败只影响终止动作，绝不影响交付事实。
    expect(sessions.killed).toEqual([
      done.session.id,
      done.session.id,
      failed.session.id,
      failed.session.id,
    ]);
    expect(sessions.killOptions).toEqual([
      { preserveHistory: true },
      { preserveHistory: true },
      { preserveHistory: true },
      { preserveHistory: true },
    ]);
  });

  it("worktree:none 拒绝同路径 live writer，但终态/缺失会话和不同路径仍可派发", async () => {
    const store = new OrchestrationStore();
    const oldRun = store.createRun({ objective: "旧 worktree" });
    const oldTask = store.createTask({ runId: oldRun.id, title: "旧任务", spec: "" });
    const oldDispatch = store.createDispatch({
      taskId: oldTask.id,
      sessionId: "old-live",
      worktreePath: "/tmp/registered-worktree",
    });
    store.registerWorktreeAsset({
      kind: "worker",
      runId: oldRun.id,
      taskId: oldTask.id,
      dispatchId: oldDispatch.id,
      repo: "/tmp/repo",
      path: "/tmp/registered-worktree",
      branch: null,
    });
    const targetRun = store.createRun({ objective: "新 worktree" });
    const blocked = store.createTask({ runId: targetRun.id, title: "应拒绝", spec: "" });
    const terminal = store.createTask({ runId: targetRun.id, title: "终态允许", spec: "" });
    const missing = store.createTask({ runId: targetRun.id, title: "缺失允许", spec: "" });
    const elsewhere = store.createTask({ runId: targetRun.id, title: "不同路径允许", spec: "" });
    const sessions = new FakeSessions();
    sessions.live.set("old-live", {
      id: "old-live", agent: "codex", kind: "structured", title: "old",
      cwd: "/tmp/registered-worktree", status: "running", createdAt: 1, cols: 80, rows: 24,
    });
    const service = new DispatchService(store, sessions);

    await expect(service.startWorker({
      taskId: blocked.id, agent: "codex", worktree: "none", cwd: "/tmp/registered-worktree/packages/app",
    })).rejects.toMatchObject({ code: "worktree_busy" } satisfies Partial<DispatchError>);
    expect(sessions.creates).toHaveLength(0);

    sessions.live.set("old-live", {
      ...sessions.infoOf("old-live"), status: "done",
    });
    await service.startWorker({
      taskId: terminal.id, agent: "codex", worktree: "none", cwd: "/tmp/registered-worktree",
    });

    sessions.live.delete("old-live");
    // 上一步实际新建了一个 writer；模拟它也已从 SessionManager 消失后，才能
    // 验证“旧 session 缺失”不会永久占用租约。
    sessions.live.delete("worker-session");
    await service.startWorker({
      taskId: missing.id, agent: "codex", worktree: "none", cwd: "/tmp/registered-worktree",
    });
    sessions.live.delete("worker-session");
    await service.startWorker({
      taskId: elsewhere.id, agent: "codex", worktree: "none", cwd: "/tmp/another-worktree",
    });
    expect(sessions.creates).toHaveLength(3);
  });

  it("已登记 worktree 在 session.create 进行中也只允许一个 writer", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "并发租约" });
    const first = store.createTask({ runId: run.id, title: "第一个", spec: "" });
    const second = store.createTask({ runId: run.id, title: "第二个", spec: "" });
    store.registerWorktreeAsset({
      kind: "run",
      runId: run.id,
      repo: "/tmp/repo",
      path: "/tmp/inflight-worktree",
      branch: null,
    });
    const sessions = new FakeSessions();
    let releaseCreate: (() => void) | undefined;
    sessions.createBarrier = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const service = new DispatchService(store, sessions);

    const starting = service.startWorker({
      taskId: first.id, agent: "codex", worktree: "none", cwd: "/tmp/inflight-worktree",
    });
    await Promise.resolve();
    await expect(service.startWorker({
      taskId: second.id, agent: "codex", worktree: "none", cwd: "/tmp/inflight-worktree",
    })).rejects.toMatchObject({ code: "worktree_busy" } satisfies Partial<DispatchError>);
    releaseCreate?.();
    await starting;
    expect(sessions.creates).toHaveLength(1);
  });
});
