import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionInfo } from "@prospero/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  DispatchError,
  DispatchService,
  WORKER_TERMINATION_TIMEOUT_MS,
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
  killNever = false;
  createBarrier: Promise<void> | null = null;
  chatHook: ((sid: string, text: string) => Promise<void>) | null = null;

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
    await this.chatHook?.(sid, text);
  }

  requirePty(): { writeInput(text: string): void } {
    return { writeInput: () => {} };
  }

  async kill(sid: string, options?: { preserveHistory?: boolean }): Promise<void> {
    this.killed.push(sid);
    this.killOptions.push(options);
    if (this.killNever) return new Promise<void>(() => {});
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

  it("在发送前导词前持久化 starting，并在返回 worker.start 前持久化 running", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "prospero-dispatch-start-persist-"));
    try {
      const store = new OrchestrationStore(home);
      const run = store.createRun({ objective: "派发持久化边界" });
      const task = store.createTask({ runId: run.id, title: "快速 worker", spec: "" });
      const sessions = new FakeSessions();
      sessions.chatHook = async () => {
        const persisted = JSON.parse(readFileSync(path.join(home, "orchestration.json"), "utf8")) as {
          tasks: Record<string, { status: string }>;
          dispatches: Record<string, { state: string }>;
        };
        expect(persisted.tasks[task.id]?.status).toBe("dispatched");
        expect(Object.values(persisted.dispatches)).toEqual([
          expect.objectContaining({ state: "starting" }),
        ]);
      };
      const service = new DispatchService(store, sessions);

      const started = await service.startWorker({
        taskId: task.id,
        agent: "codex",
        worktree: "none",
        cwd: "/tmp/project",
      });
      const persisted = JSON.parse(readFileSync(path.join(home, "orchestration.json"), "utf8")) as {
        tasks: Record<string, { status: string }>;
        dispatches: Record<string, { state: string }>;
      };
      expect(persisted.tasks[task.id]?.status).toBe("dispatched");
      expect(persisted.dispatches[started.dispatch.id]?.state).toBe("running");
      store.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("不让迟到的 running 覆盖前导词期间已经显式交付的终态", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "极速交付" });
    const task = store.createTask({ runId: run.id, title: "立即完成", spec: "" });
    const sessions = new FakeSessions();
    const service = new DispatchService(store, sessions);
    sessions.chatHook = async (sid) => {
      await service.completeTask(task.id, sid, "前导词期间已完成");
    };

    const started = await service.startWorker({
      taskId: task.id,
      agent: "codex",
      worktree: "none",
      cwd: "/tmp/project",
    });
    expect(started.task).toMatchObject({ status: "done", result: "前导词期间已完成" });
    expect(started.dispatch).toMatchObject({ state: "succeeded", outcome: "前导词期间已完成" });
    expect(store.getDispatch(started.dispatch.id).state).toBe("succeeded");
  });

  it("显式交付结束传输时，让 worker.start 返回已落盘终态而不是回滚", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "交付时关闭 supervisor" });
    const task = store.createTask({ runId: run.id, title: "立即交付", spec: "" });
    const sessions = new FakeSessions();
    const service = new DispatchService(store, sessions);
    sessions.chatHook = async (sid) => {
      await service.completeTask(task.id, sid, "已在连接关闭前持久化");
      throw new Error("supervisor socket closed");
    };

    const started = await service.startWorker({
      taskId: task.id,
      agent: "codex",
      worktree: "none",
      cwd: "/tmp/project",
    });
    expect(started.task).toMatchObject({ status: "done", result: "已在连接关闭前持久化" });
    expect(started.dispatch).toMatchObject({ state: "succeeded", outcome: "已在连接关闭前持久化" });
    expect(sessions.killed).toEqual([started.session.id]);
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

  it("worker 在真正终止前未交付时会自动收尾，不再永久显示 running", async () => {
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

    expect(service.settleTerminatedSession(started.session.id, "worker 会话意外退出")).toMatchObject({
      task: { status: "failed" },
      dispatch: { state: "abandoned" },
    });
    expect(service.settleTerminatedSession(started.session.id, "重复事件")).toBeNull();
  });

  it("结构化 worker 的首轮 completed 仍保留派发、工作树 writer 租约并可在第二轮显式交付", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "首轮完成后继续" });
    const task = store.createTask({ runId: run.id, title: "首轮 completed", spec: "继续等待交付" });
    const competing = store.createTask({ runId: run.id, title: "不得抢占 writer", spec: "" });
    store.registerWorktreeAsset({
      kind: "worker",
      runId: run.id,
      taskId: task.id,
      repo: "/tmp/repo",
      path: "/tmp/completed-worker",
      branch: null,
    });
    const sessions = new FakeSessions();
    const service = new DispatchService(store, sessions);
    const started = await service.startWorker({
      taskId: task.id,
      agent: "codex",
      worktree: "none",
      cwd: "/tmp/completed-worker",
    });

    sessions.live.set(started.session.id, {
      ...sessions.infoOf(started.session.id),
      status: "completed",
    });
    expect(store.getTask(task.id)).toMatchObject({ status: "dispatched" });
    expect(store.getDispatch(started.dispatch.id)).toMatchObject({ state: "running" });
    await expect(service.startWorker({
      taskId: competing.id,
      agent: "codex",
      worktree: "none",
      cwd: "/tmp/completed-worker",
    })).rejects.toMatchObject({ code: "worktree_busy" } satisfies Partial<DispatchError>);

    await sessions.chatSend(started.session.id, "第二轮：请现在交付");
    await service.completeTask(task.id, started.session.id, "第二轮已完成并验过");
    expect(sessions.messages.at(-1)).toEqual({ sid: started.session.id, text: "第二轮：请现在交付" });
    expect(store.getTask(task.id)).toMatchObject({ status: "done", result: "第二轮已完成并验过" });
    expect(store.getDispatch(started.dispatch.id)).toMatchObject({
      state: "succeeded",
      outcome: "第二轮已完成并验过",
    });
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

  it("终态写盘失败时重试仍先写盘；只有成功恢复持久化后才 kill", async () => {
    vi.useFakeTimers();
    const homes: string[] = [];
    try {
      for (const terminal of ["done", "failed"] as const) {
        const home = mkdtempSync(path.join(os.tmpdir(), "prospero-delivery-persist-"));
        homes.push(home);
        const store = new OrchestrationStore(home);
        const run = store.createRun({ objective: `${terminal} 持久化失败` });
        const task = store.createTask({ runId: run.id, title: terminal, spec: "" });
        const sessions = new FakeSessions();
        const service = new DispatchService(store, sessions);
        const started = await service.startWorker({
          taskId: task.id, agent: "codex", worktree: "none", cwd: `/tmp/${terminal}-persist`,
        });
        const persist = vi.spyOn(store, "persistNow").mockImplementation(() => {
          throw new Error("磁盘暂不可写");
        });
        const deliver = () => terminal === "done"
          ? service.completeTask(task.id, started.session.id, "交付")
          : service.failTask(task.id, started.session.id, "交付失败");

        await expect(deliver()).rejects.toThrow("磁盘暂不可写");
        expect(store.getTask(task.id).status).toBe(terminal);
        expect(sessions.killed).toEqual([]);
        // 幂等重放不能因为内存已终态就跳过失败的持久化，更不能提前 kill。
        await expect(deliver()).rejects.toThrow("磁盘暂不可写");
        expect(sessions.killed).toEqual([]);

        persist.mockRestore();
        await expect(deliver()).resolves.toMatchObject({ status: terminal });
        expect(sessions.killed).toEqual([started.session.id]);
        const reloaded = new OrchestrationStore(home);
        expect(reloaded.getTask(task.id)).toMatchObject({ status: terminal });
        reloaded.close();
        store.close();
      }
    } finally {
      vi.useRealTimers();
      for (const home of homes) rmSync(home, { recursive: true, force: true });
    }
  });

  it("自杀式 kill 卡住时在超时后返回已持久交付，而非无限阻塞", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new OrchestrationStore();
      const run = store.createRun({ objective: "kill 超时" });
      const task = store.createTask({ runId: run.id, title: "实现", spec: "" });
      const sessions = new FakeSessions();
      const service = new DispatchService(store, sessions);
      const started = await service.startWorker({
        taskId: task.id, agent: "codex", worktree: "none", cwd: "/tmp/kill-timeout",
      });
      sessions.killNever = true;

      const delivered = service.completeTask(task.id, started.session.id, "已落盘");
      await vi.advanceTimersByTimeAsync(WORKER_TERMINATION_TIMEOUT_MS);
      await expect(delivered).resolves.toMatchObject({ status: "done" });
      expect(store.getDispatch(started.dispatch.id).state).toBe("succeeded");
      expect(sessions.killed).toEqual([started.session.id]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("终止超过"));
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it("worktree:none 拒绝同路径 live writer（包括 completed），但真正终态/缺失会话和不同路径仍可派发", async () => {
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
    const doneTerminal = store.createTask({ runId: targetRun.id, title: "done 终态允许", spec: "" });
    const diedTerminal = store.createTask({ runId: targetRun.id, title: "died 终态允许", spec: "" });
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
      ...sessions.infoOf("old-live"), status: "completed",
    });
    await expect(service.startWorker({
      taskId: doneTerminal.id, agent: "codex", worktree: "none", cwd: "/tmp/registered-worktree",
    })).rejects.toMatchObject({ code: "worktree_busy" } satisfies Partial<DispatchError>);
    expect(sessions.creates).toHaveLength(0);

    sessions.live.set("old-live", {
      ...sessions.infoOf("old-live"), status: "done",
    });
    await service.startWorker({
      taskId: doneTerminal.id, agent: "codex", worktree: "none", cwd: "/tmp/registered-worktree",
    });

    // 上一步实际新建了一个 writer；模拟它也已从 SessionManager 消失后，才能
    // 分别验证 died 和缺失的旧 session 都不会永久占用租约。
    sessions.live.delete("worker-session");
    sessions.live.set("old-live", {
      ...sessions.infoOf("old-live"), status: "died",
    });
    await service.startWorker({
      taskId: diedTerminal.id, agent: "codex", worktree: "none", cwd: "/tmp/registered-worktree",
    });
    sessions.live.delete("worker-session");
    sessions.live.delete("old-live");
    await service.startWorker({
      taskId: missing.id, agent: "codex", worktree: "none", cwd: "/tmp/registered-worktree",
    });
    sessions.live.delete("worker-session");
    await service.startWorker({
      taskId: elsewhere.id, agent: "codex", worktree: "none", cwd: "/tmp/another-worktree",
    });
    expect(sessions.creates).toHaveLength(4);
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
