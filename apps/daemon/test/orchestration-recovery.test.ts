import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionInfo } from "@prospero/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationService } from "../src/orchestration/automation.js";
import {
  DispatchService,
  type WorkerSessionManager,
} from "../src/orchestration/dispatch.js";
import { GoalInitializationService } from "../src/orchestration/goal-initialization.js";
import { OrchestrationStore } from "../src/orchestration/store.js";
import type { CreateSessionInput } from "../src/session-manager.js";
import { createDaemonServer } from "../src/ws-server.js";

const homes: string[] = [];

function temporaryHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "prospero-orchestration-recovery-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function session(id: string, status: SessionInfo["status"]): SessionInfo {
  return {
    id,
    agent: "codex",
    kind: "structured",
    title: "worker",
    cwd: "/tmp/project",
    status,
    createdAt: 1,
    cols: 120,
    rows: 40,
  };
}

class RecoverySessions implements WorkerSessionManager {
  readonly live = new Map<string, SessionInfo>();
  readonly created: CreateSessionInput[] = [];
  readonly killed: string[] = [];
  readonly killOptions: Array<{ preserveHistory?: boolean } | undefined> = [];

  async create(input: CreateSessionInput): Promise<SessionInfo> {
    this.created.push(input);
    return session(`new-worker-${String(this.created.length)}`, "idle");
  }

  async chatSend(): Promise<void> {}
  requirePty(): { writeInput(text: string): void } { return { writeInput() {} }; }
  async kill(sid: string, options?: { preserveHistory?: boolean }): Promise<void> {
    this.killed.push(sid);
    this.killOptions.push(options);
    this.live.delete(sid);
  }

  infoOf(sid: string): SessionInfo {
    const found = this.live.get(sid);
    if (!found) throw new Error(`no such session: ${sid}`);
    return found;
  }
}

describe("daemon 启动时的 Dispatch 对账", () => {
  it("WS 状态监听把 completed 当作 live：只检查 coordinator Run，不失败 active Dispatch", async () => {
    const home = temporaryHome();
    const server = await createDaemonServer({ home, port: 0 });
    try {
      const coordinatorRun = server.orchestration.store.createRun({
        objective: "coordinator completed 后检查收口",
        coordinatorSessionId: "coordinator-session",
      });
      const coordinatorTask = server.orchestration.store.createTask({
        runId: coordinatorRun.id,
        title: "已显式交付",
        spec: "",
      });
      const coordinatorDispatch = server.orchestration.store.createDispatch({
        taskId: coordinatorTask.id,
        sessionId: "coordinator-worker",
      });
      server.orchestration.store.settleWorkerDelivery(
        coordinatorDispatch.id,
        "done",
        "succeeded",
        "已交付",
        "已交付",
      );
      vi.spyOn(server.manager, "list").mockReturnValue([
        session("coordinator-session", "completed"),
      ]);

      const workerRun = server.orchestration.store.createRun({ objective: "completed worker 不失联" });
      const workerTask = server.orchestration.store.createTask({
        runId: workerRun.id,
        title: "继续等待第二轮",
        spec: "",
      });
      const workerDispatch = server.orchestration.store.createDispatch({
        taskId: workerTask.id,
        sessionId: "completed-worker",
      });

      server.manager.emit("state", session("completed-worker", "completed"));

      expect(server.orchestration.store.getRun(coordinatorRun.id).status).toBe("completed");
      expect(server.orchestration.store.getDispatch(workerDispatch.id)).toMatchObject({ state: "starting" });
      expect(server.orchestration.store.getTask(workerTask.id)).toMatchObject({ status: "dispatched" });

      server.manager.emit("state", session("completed-worker", "done"));
      expect(server.orchestration.store.getDispatch(workerDispatch.id)).toMatchObject({ state: "abandoned" });
      expect(server.orchestration.store.getTask(workerTask.id)).toMatchObject({ status: "failed" });
    } finally {
      await server.close();
    }
  });

  it("真实 daemon 启动会对账持久化的缺失会话，第二次启动保持幂等", async () => {
    const home = temporaryHome();
    const seeded = new OrchestrationStore(home);
    const run = seeded.createRun({ objective: "daemon 启动恢复" });
    const task = seeded.createTask({ runId: run.id, title: "遗留 worker", spec: "" });
    const dispatch = seeded.createDispatch({ taskId: task.id, sessionId: "gone-before-restart" });
    seeded.close();

    const first = await createDaemonServer({ home, port: 0 });
    try {
      expect(first.orchestration.store.getDispatch(dispatch.id).state).toBe("abandoned");
      expect(first.orchestration.store.getTask(task.id).status).toBe("failed");
    } finally {
      await first.close();
    }

    const second = await createDaemonServer({ home, port: 0 });
    try {
      expect(second.orchestration.store.getDispatch(dispatch.id).state).toBe("abandoned");
      expect(second.orchestration.store.getTask(task.id).status).toBe("failed");
    } finally {
      await second.close();
    }
  });

  it("缺失会话会一次性收敛为 abandoned + failed，持久化后重复启动不再重复处理", async () => {
    const home = temporaryHome();
    const initial = new OrchestrationStore(home);
    const run = initial.createRun({ objective: "恢复缺失 worker" });
    const task = initial.createTask({ runId: run.id, title: "实现", spec: "" });
    const dispatch = initial.createDispatch({ taskId: task.id, sessionId: "lost-worker" });
    let changes = 0;
    initial.onChange(() => { changes += 1; });

    const first = await new DispatchService(initial, new RecoverySessions()).reconcilePersistedSessions();
    expect(first.settled).toHaveLength(1);
    expect(initial.getDispatch(dispatch.id)).toMatchObject({
      state: "abandoned",
      outcome: "worker 会话在 daemon 恢复后不存在",
    });
    expect(initial.getTask(task.id)).toMatchObject({
      status: "failed",
      result: "worker 会话在 daemon 恢复后不存在",
    });
    // Dispatch/Task 对观察者只发布一次，不能暴露半截收敛状态。
    expect(changes).toBe(1);
    initial.persistNow();
    initial.close();

    const restarted = new OrchestrationStore(home);
    const second = await new DispatchService(restarted, new RecoverySessions()).reconcilePersistedSessions();
    expect(second).toEqual({ settled: [], resumed: [] });
    expect(restarted.getTask(task.id).status).toBe("failed");
    restarted.close();
  });

  it("恢复时只有 done/died 会话失败；completed 恢复为 running，已显式 done 的事实仍优先", async () => {
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "恢复终态 worker" });
    const completedTask = store.createTask({ runId: run.id, title: "首轮完成，仍可继续", spec: "" });
    const doneTask = store.createTask({ runId: run.id, title: "done 未交付", spec: "" });
    const diedTask = store.createTask({ runId: run.id, title: "died 未交付", spec: "" });
    const explicitTask = store.createTask({ runId: run.id, title: "已交付", spec: "" });
    const completed = store.createDispatch({ taskId: completedTask.id, sessionId: "completed-worker" });
    const done = store.createDispatch({ taskId: doneTask.id, sessionId: "done-worker" });
    const died = store.createDispatch({ taskId: diedTask.id, sessionId: "died-worker" });
    const explicit = store.createDispatch({ taskId: explicitTask.id, sessionId: "reported-worker" });
    // 模拟 task.done 已落盘、dispatch 成功状态尚未来得及落盘时 daemon 崩溃。
    store.setTaskStatus(explicitTask.id, "done", "worker 已显式交付");

    const sessions = new RecoverySessions();
    sessions.live.set("completed-worker", session("completed-worker", "completed"));
    sessions.live.set("done-worker", session("done-worker", "done"));
    sessions.live.set("died-worker", session("died-worker", "died"));
    sessions.live.set("reported-worker", session("reported-worker", "done"));
    const result = await new DispatchService(store, sessions).reconcilePersistedSessions();

    expect(result.settled).toHaveLength(3);
    expect(result.resumed).toEqual([expect.objectContaining({ id: completed.id, state: "running" })]);
    expect(store.getDispatch(completed.id).state).toBe("running");
    expect(store.getTask(completedTask.id).status).toBe("dispatched");
    expect(store.getDispatch(done.id).state).toBe("abandoned");
    expect(store.getTask(doneTask.id).status).toBe("failed");
    expect(store.getDispatch(died.id).state).toBe("abandoned");
    expect(store.getTask(diedTask.id).status).toBe("failed");
    expect(store.getDispatch(explicit.id)).toMatchObject({ state: "succeeded", outcome: "worker 已显式交付" });
    expect(store.getTask(explicitTask.id)).toMatchObject({ status: "done", result: "worker 已显式交付" });
  });

  it("重启会终止已持久化交付但仍存活（含 completed）的 worker，并保留历史", async () => {
    const home = temporaryHome();
    const seeded = new OrchestrationStore(home);
    const run = seeded.createRun({ objective: "交付后 kill 前崩溃" });
    const doneTask = seeded.createTask({ runId: run.id, title: "done", spec: "" });
    const failedTask = seeded.createTask({ runId: run.id, title: "failed", spec: "" });
    const completedTask = seeded.createTask({ runId: run.id, title: "completed", spec: "" });
    const doneDispatch = seeded.createDispatch({ taskId: doneTask.id, sessionId: "done-still-live" });
    const failedDispatch = seeded.createDispatch({ taskId: failedTask.id, sessionId: "failed-still-live" });
    const completedDispatch = seeded.createDispatch({
      taskId: completedTask.id,
      sessionId: "completed-still-live",
    });
    seeded.setTaskStatus(doneTask.id, "done", "已交付");
    seeded.setDispatchState(doneDispatch.id, "succeeded", "已交付");
    seeded.setTaskStatus(failedTask.id, "failed", "已报告失败");
    seeded.setDispatchState(failedDispatch.id, "failed", "已报告失败");
    seeded.setTaskStatus(completedTask.id, "done", "已交付但会话刚结束本轮");
    seeded.setDispatchState(completedDispatch.id, "succeeded", "已交付但会话刚结束本轮");
    seeded.close();

    const restored = new OrchestrationStore(home);
    const sessions = new RecoverySessions();
    sessions.live.set("done-still-live", session("done-still-live", "idle"));
    sessions.live.set("failed-still-live", session("failed-still-live", "running"));
    sessions.live.set("completed-still-live", session("completed-still-live", "completed"));
    const result = await new DispatchService(restored, sessions).reconcilePersistedSessions();

    expect(result).toEqual({ settled: [], resumed: [] });
    expect(sessions.killed).toEqual([
      "done-still-live",
      "failed-still-live",
      "completed-still-live",
    ]);
    expect(sessions.killOptions).toEqual([
      { preserveHistory: true },
      { preserveHistory: true },
      { preserveHistory: true },
    ]);
    expect(restored.getDispatch(doneDispatch.id).state).toBe("succeeded");
    expect(restored.getDispatch(failedDispatch.id).state).toBe("failed");
    expect(restored.getTask(doneTask.id).status).toBe("done");
    expect(restored.getTask(failedTask.id).status).toBe("failed");
    expect(restored.getDispatch(completedDispatch.id).state).toBe("succeeded");
    expect(restored.getTask(completedTask.id).status).toBe("done");
    restored.close();
  });

  it("存活会话把遗留 starting 恢复为 running，自动编排保持运行而不重复派发", async () => {
    const home = temporaryHome();
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "恢复存活 worker" });
    const task = store.createTask({ runId: run.id, title: "继续执行", spec: "" });
    const dispatch = store.createDispatch({ taskId: task.id, sessionId: "live-worker" });
    store.setRunAutomation(run.id, {
      state: "running",
      agent: "codex",
      approvalPolicy: "standard",
      workspace: "current",
      cwd: home,
      workspacePath: home,
      branch: null,
      startedAt: 1,
      updatedAt: 1,
      lastError: null,
    });
    const sessions = new RecoverySessions();
    sessions.live.set("live-worker", session("live-worker", "idle"));
    const service = new DispatchService(store, sessions);
    const automation = new AutomationService(store, service);

    expect(await service.reconcilePersistedSessions()).toMatchObject({
      settled: [],
      resumed: [{ id: dispatch.id, state: "running" }],
    });
    automation.resumePersisted();
    await automation.advance(run.id);

    expect(store.getTask(task.id).status).toBe("dispatched");
    expect(store.getDispatch(dispatch.id).state).toBe("running");
    expect(store.getRun(run.id).automation).toMatchObject({ state: "running", lastError: null });
    expect(sessions.created).toHaveLength(0);
  });

  it("丢失 worker 后恢复自动编排会暂停并留下失败原因，而不是伪装继续运行", async () => {
    const home = temporaryHome();
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "恢复自动暂停" });
    const task = store.createTask({ runId: run.id, title: "会丢失", spec: "" });
    store.createDispatch({ taskId: task.id, sessionId: "missing-auto-worker" });
    store.setRunAutomation(run.id, {
      state: "running",
      agent: "codex",
      approvalPolicy: "standard",
      workspace: "current",
      cwd: home,
      workspacePath: home,
      branch: null,
      startedAt: 1,
      updatedAt: 1,
      lastError: null,
    });
    const automation = new AutomationService(store, new DispatchService(store, new RecoverySessions()));
    const dispatch = new DispatchService(store, new RecoverySessions());

    await dispatch.reconcilePersistedSessions();
    automation.resumePersisted();
    await automation.advance(run.id);

    expect(store.getTask(task.id).status).toBe("failed");
    expect(store.getRun(run.id).automation).toMatchObject({
      state: "paused",
      lastError: expect.stringContaining("failed"),
    });
  });
});

describe("Goal 协调者首提示恢复", () => {
  it("首次投递失败会保留 pending 账本，并在重启后的重试中成功投递", async () => {
    const home = temporaryHome();
    const store = new OrchestrationStore(home);
    const run = store.createRun({
      objective: "修复可靠性",
      coordinatorSessionId: "coordinator",
      coordinatorPrompt: true,
    });
    let shouldFail = true;
    const sent: Array<{ sid: string; text: string }> = [];
    const sessions = {
      async chatSend(sid: string, text: string): Promise<void> {
        if (shouldFail) throw new Error("adapter reconnecting");
        sent.push({ sid, text });
      },
    };
    const prompt = (runId: string, objective: string) => `Goal ${runId}: ${objective}`;
    const first = new GoalInitializationService(store, sessions, prompt);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(first.deliver(run.id)).resolves.toBe(false);
    expect(store.getRun(run.id).coordinatorPrompt).toMatchObject({
      state: "pending",
      attempts: 1,
      lastError: "adapter reconnecting",
    });
    first.close();
    store.close();

    shouldFail = false;
    const restarted = new OrchestrationStore(home);
    const retry = new GoalInitializationService(restarted, sessions, prompt);
    await retry.retryPending();

    expect(sent).toEqual([{ sid: "coordinator", text: `Goal ${run.id}: 修复可靠性` }]);
    expect(restarted.getRun(run.id).coordinatorPrompt).toMatchObject({
      state: "delivered",
      attempts: 2,
      lastError: null,
    });
    retry.close();
    restarted.close();
  });
});
